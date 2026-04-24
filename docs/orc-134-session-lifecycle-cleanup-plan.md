# ORC-134 — Stale worker-session cleanup and task-completion archive plan

## tl;dr

- The regression is **not just the catalog refresh**; it is the combination of a catalog that now reliably re-lists on-disk sessions plus **session decoration / worker-state reconciliation that still treats stale role+agent bindings as live enough to surface**.
- We should introduce a **durable session-list visibility/archive state** that is separate from transcript storage, and use it as the source of truth for whether a session can appear in the Sessions active/closed surfaces.
- Task completion/cancelation should **write through an auto-archive marker immediately** for the related worker session so later catalog refreshes and cache rebuilds cannot resurrect it.
- The visibility/archive classification should move into a **shared backend helper** so desktop commands and remote API session listing do not drift.

## Executive summary

Recent session-cache/session-catalog work made the session list much more durable and index-driven, which is good, but it also exposed an older assumption in the worker-session lifecycle code: several places still rely on transient task/runtime state to decide whether a file-backed session is “live enough” to show.

That assumption no longer holds once the catalog can rehydrate every non-hidden session file on refresh.

Today:

- `session_catalog` keeps non-dismissed session files easy to rediscover.
- `commands/sessions.rs` decorates records using task/assignment/runtime tables, but it still treats stale role/agent bindings too generously.
- role instances can retain `session_id` after release.
- agent runtime rows can retain `main_session_id` after task completion.
- task completion retires runtime state, but it does **not** persist a list-hidden/archive decision.

So after reload/reindex, old file-backed sessions can come back from the catalog and appear active again.

The fix should make session visibility explicit and durable:

1. classify worker sessions as `active`, `closed`, or `archived/hidden`
2. persist `archived/hidden` in SQLite
3. skip hidden sessions in catalog refresh/list hydration
4. auto-archive completed/canceled worker sessions at transition time
5. auto-hide truly stale role sessions when no valid task/lane relationship remains

## Root cause

### 1. Catalog-backed listing is durable, but stale-state suppression is not

Relevant code:

- `src-tauri/src/services/pi_sessions.rs`
  - `refresh_session_catalog`
  - `load_session_catalog_records`
- `src-tauri/src/commands/sessions.rs`
  - `load_session_list_metadata`
  - `decorate_session_record_with_connection`

The catalog now reliably re-indexes any non-hidden `.jsonl` session file. That means stale file-backed sessions must be explicitly hidden/archived if we never want them to return.

### 2. Worker-state decoration still trusts stale bindings

Current decoration logic will still derive worker metadata from:

- `agent_runtime_states.main_session_id`
- `role_instances.session_id`
- latest `task_lane_assignments` / `task_lane_runs`

Problems in the current code path:

- `role_instances` lookup does not require a currently valid task/lane relationship.
- role release does not clear `session_id`, so stale role bindings linger.
- any `agent_runtime_states.main_session_id` row makes the session look “persistent”, which suppresses the fallback closing logic.
- the list path can therefore surface a session whose task is gone, whose lane is no longer active, or whose task is already completed.

### 3. Completion only retires runtime state; it does not persist list archive state

Relevant code:

- `src-tauri/src/services/task_runtime.rs`
  - `finalize_worker_assignment`
  - `transition_task_after_completion`
  - `transitioned_assignment_session_to_retire`
- `src-tauri/src/commands/tasks.rs`
  - `complete_lane_command`
- `src-tauri/src/services/live_sessions.rs`
  - `schedule_session_retirement`

Current behavior is mostly runtime-oriented:

- role sessions may be retired in-memory after transition
- agent sessions are generally left attached to `main_session_id`
- no durable archive marker is written for completed/canceled task sessions

So the next catalog refresh can re-surface the same transcript file.

## Intended session-lifecycle semantics

### Keep visible as active

A session remains active in the Sessions list only when at least one of these is true:

- it owns an active task lane assignment
- it is awaiting user approval / intervention for that lane
- it is an explicitly live standalone session the user is still working in

### Keep visible as closed

A worker session may remain visible as closed when it is legitimate history, for example:

- a role-owned lane handed off to another lane and the task still exists
- a session has historical task/lane metadata, but it no longer owns the active lane
- the user has not dismissed it and it is not in an auto-archive class

This preserves useful recent history without letting it look active.

### Auto-archive / hide from both active and closed lists

A worker session should be hidden durably when any of the following is true:

- the task was completed
- the task was canceled
- the session is a stale role worker session with no surviving task / valid active-lane relationship
- the session was manually dismissed by the user

Important nuance:

- **auto-archived** should be distinct from **user-dismissed**.
- user-dismissed sessions can keep today’s restore/retention semantics.
- auto-archived task-worker sessions should stay hidden across reload/reindex and should not be restorable through normal “resume from Sessions list” behavior.

### Agent-session nuance

This task should **not require changing agent main-session persistence semantics** for the Agents/Chat surfaces.

Instead:

- a task-completed agent session may remain addressable by direct session id if some other feature still references it
- but it must be **archived/hidden from the Sessions page active+closed surfaces**
- this avoids a larger product change to agent-chat persistence while still satisfying the session-list cleanup requirement

## Proposed implementation

### 1. Make session-list visibility explicit in SQLite

Extend `session_list_entries` so it can represent both manual dismissals and automatic archives.

Recommended shape:

- keep `dismissed_at` for compatibility or rename conceptually to a generic hidden timestamp
- add `hidden_reason` (or equivalent), e.g.
  - `user_dismissed`
  - `task_completed`
  - `task_canceled`
  - `stale_role_session`

Why:

- list code can treat hidden ids uniformly
- resume/restore can remain allowed only for `user_dismissed`
- cleanup can keep deleting old user-dismissed files without accidentally purging auto-archived sessions still referenced elsewhere

### 2. Move session visibility classification into shared backend code

The session lifecycle rules should not live only in `commands/sessions.rs`.

Recommended direction:

- move `load_session_list_metadata` + status/visibility classification into shared session service code
- have both desktop commands and remote API call the same helper

This prevents desktop and hosted-web session surfaces from drifting.

### 3. Add a list-time visibility classifier

For each session record, classify one of:

- `VisibleActive`
- `VisibleClosed`
- `Hidden(reason)`

The classifier should look at:

- active assignment presence/status
- task status (`ready`, `in_progress`, `in_review`, `completed`, `canceled`, etc.)
- whether the session still has a valid task/lane relationship
- role-instance status and whether that role binding is still current
- agent runtime binding, but without treating `main_session_id` alone as sufficient to keep a finished task session visible

### 4. Write through auto-archive on task completion/cancelation

On lane completion that moves the task to `completed` or `canceled`:

- identify the worker session for the just-finished assignment
- persist `Hidden(task_completed|task_canceled)` immediately
- emit the usual session/task change notifications
- optionally retire any live runtime as today

This makes completion cleanup durable instead of best-effort.

### 5. Repair stale role bindings

When a role instance is released or when stale role sessions are detected:

- stop treating `role_instances.session_id` as an authoritative visibility signal after release
- clear the role-instance session binding when appropriate, or at minimum ignore completed/failed/canceled instances during session-list decoration
- if the session has no surviving task/lane relationship, auto-archive it with `stale_role_session`

This is the most direct way to stop stale role sessions from showing as active again.

### 6. Keep catalog refresh hidden-state-aware

`refresh_session_catalog` already skips dismissed sessions early.

After the visibility/archive work:

- load hidden ids for **all** hidden reasons, not just user dismissals
- skip them before summary parsing
- evict catalog rows for newly auto-archived sessions

This keeps cache rebuilds from undoing cleanup.

## Verification plan

### Rust/backend coverage

Add or update tests for:

1. dismissed sessions remain hidden after catalog refresh/reload
2. stale role session with no valid task/lane relationship is auto-hidden and does not appear active
3. role lane handoff while task continues stays visible as `closed`, not `active`
4. completed task auto-archives related role session from the list
5. completed task auto-archives related agent session from the list
6. canceled task auto-archives related worker session from the list
7. hidden/archived session stays hidden after catalog rebuild
8. resume/restore only works for `user_dismissed`, not auto-archived task sessions
9. remote API session list and desktop session list share the same visibility behavior

### Browser/mock coverage

If browser-mode mocks back any of the affected E2E coverage, mirror the same hidden/archive semantics in:

- `src/lib/tauri.ts`
- affected `tests/e2e/sessions.spec.ts`
- affected `tests/e2e/tasks.spec.ts`

## Files likely involved

- `src-tauri/src/services/pi_sessions.rs`
- `src-tauri/src/commands/sessions.rs`
- `src-tauri/src/services/task_runtime.rs`
- `src-tauri/src/commands/tasks.rs`
- `src-tauri/src/services/live_sessions.rs`
- `src-tauri/src/services/database.rs`
- `src-tauri/src/services/remote_api.rs`
- `src/lib/tauri.ts`
- session/task regression tests in `src-tauri` and `tests/e2e`

## Recommended implementation order

1. add hidden/archive reason storage and migration
2. centralize shared session visibility classification
3. switch list paths to filter on shared visibility classification
4. write through auto-archive on task completion/cancelation
5. tighten stale role binding handling
6. add regression coverage for list reload + task completion + stale role cases
