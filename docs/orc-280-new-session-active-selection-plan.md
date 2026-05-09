# ORC-280 — New-session active selection and single task-linked session plan

## tl;dr
The bug is two problems at once: the frontend does not keep a durable “open this new successor session” request after `New session`, and the backend still lets historical task sessions look active again based on runtime state instead of the task’s current assignment. Fix both by treating `task.activeLaneAssignment.sessionId` / the open assignment binding as the only current task-session link, using canonical session lineage (`supersedes_session_id` / `superseded_by_session_id`) to retire predecessors, and reusing the existing pending-session-open flow for successor selection.

## Executive summary
Orchestra already tracks the information needed to solve this cleanly.

- Session lineage exists in the canonical `sessions` table through `supersedes_session_id` and `superseded_by_session_id`.
- Session closure/supersession state is also canonical already: `lifecycle_state`, `closed_at`, `archived_at`, `hidden_reason`, and the current-vs-historical binding split between `task_id`/`assignment_id` and `primary_task_id`/`primary_assignment_id`.
- `create_contextual_session()` already rotates task-owned sessions transactionally by creating a successor row, canceling the old open assignment, creating a replacement assignment bound to the new session, and hiding the predecessor as `superseded`.

The remaining failures come from two places:

1. **Frontend selection race after `New session`**
   - `src/App.tsx::handleCreateSession()` clears `pendingSessionOpenRequest` immediately after `createContextual()` returns.
   - That means a concurrent/background `list_sessions()` refresh can drop the optimistic new session before the selection refs point at it, and the UI falls back to an older visible session.
   - The app already has the right anti-race mechanism for task→session opens (`pendingSessionOpenRequest` + missing-record fetch); `New session` just is not using it.

2. **Historical task sessions can be re-promoted to “active”**
   - `src-tauri/src/commands/sessions.rs::decorate_session_record_with_runtime_state()` currently upgrades a **closed** task session back to visible/active when a runtime exists and the session still has historical task metadata.
   - That promotion is based on historical linkage (`task_id`/`primary_task_id` decoration), not on the task’s current assignment.
   - As a result, Orchestra can show more than one seemingly active session for the same task even though only one assignment session is canonical.

The fix should make the current task assignment authoritative everywhere, keep predecessor sessions historical/closed, and make the UI follow the successor session deterministically.

## Investigation answers
- **Do we track lineage?** Yes.
  - Canonical columns: `sessions.supersedes_session_id`, `sessions.superseded_by_session_id`.
  - Rotation path: `src-tauri/src/services/session_records.rs::rotate_session_record()`.
- **Do we mark the previous session closed when `New session` is used?** Yes.
  - The predecessor is written with `lifecycle_state = 'superseded'`, `closed_at = now`, `archived_at = now`, and `hidden_reason = 'superseded'`.
- **Is the active list only showing non-closed sessions?** Mostly, but visibility is derived.
  - Canonical visibility classification lives in `src-tauri/src/services/session_list.rs`.
  - Frontend list filtering uses `listVisibility` / `messageability` in `src/App.tsx`.
- **Can an old session effectively reopen?** Today, yes in practice for historical task sessions that are not hidden as superseded.
  - The decoration layer treats a runtime-active historical task session as `Active`, even when it is no longer the task’s current assignment session.
  - That is the behavior to remove.

## Recommended implementation

### 1. Make the open task assignment the only current task-session link
Use the open `task_lane_assignments.session_id` (and therefore `task.activeLaneAssignment.sessionId`) as the single source of truth for a task’s current session.

Implementation notes:
- Keep `task_id` / `assignment_id` as the **current binding** fields.
- Keep `primary_task_id` / `primary_assignment_id` as **historical provenance only**.
- For task-owned sessions, derive `activeTaskId` only from an open assignment/current-lane match, not from historical fields.
- Any session without that live assignment binding must stay historical/closed for list/messageability purposes.

### 2. Stop promoting historical task sessions back to active from runtime state alone
Change `decorate_session_record_with_runtime_state()` so runtime activity does **not** reopen a historical task session just because it still has task provenance.

Specifically:
- Remove the heuristic that upgrades `Closed -> Active` when `active_runtime_session_ids.contains(session.id)` and the session merely has task metadata.
- Only treat a task session as active/messageable when `session_list::load_session_list_decoration()` resolves a live assignment (`activeTaskId` present / visibility `Active`).
- Update the completed/reactivated task-session tests to reflect the new invariant.

This is the core behavioral change that enforces “one task-linked session at a time.”

### 3. Use lineage to resolve successor sessions and clean up any inconsistent rows
Add a small canonical helper that can follow `superseded_by_session_id` to the latest reachable successor, then use it where a stale session id is encountered.

Uses:
- Defensive repair for old/stale UI targets.
- One-time duplicate healing in case existing databases already have multiple active-looking task sessions.
- Diagnostics/tests that need to assert “latest live replacement session.”

If a migration/repair step is added, keep:
- the session referenced by the open assignment/current task lane,
- otherwise the tail of the successor chain,
- and close/hide older siblings/predecessors.

### 4. Reuse `pendingSessionOpenRequest` for `New session`
Update `src/App.tsx::handleCreateSession()` so a contextual successor behaves like any other exact session-open request.

Implementation notes:
- After `createContextual()` returns, set `pendingSessionOpenRequest = { sessionId: nextSession.id, projectId: activeProjectId, token }` instead of clearing it immediately.
- Keep `selectedSessionId` pointed at the successor, but let the existing pending-open effect own final selection/filter cleanup once the successor is present in the project-scoped list.
- Preserve the current missing-record fetch path so the app can re-load the successor if `list_sessions()` is briefly stale.

This removes the race where a refresh reselects the predecessor.

### 5. Add defensive list ordering for duplicate task sessions
Even after the backend invariant is fixed, the UI should not prefer the oldest session when duplicate rows temporarily exist.

Recommended tweak:
- In `src/lib/sessionList.ts`, prefer:
  1. current/live task-linked sessions over historical-only ones,
  2. visible active sessions over closed ones,
  3. newer `updatedAt` over older `createdAt` when comparing otherwise-equal task-linked sessions.

This is defense-in-depth, not the primary fix.

## Regression coverage
- **Backend/unit tests**
  - `src-tauri/src/commands/sessions.rs`
    - replace the “reactivated completed task sessions become messageable when runtime is active” expectation with the new closed/historical behavior
    - add coverage proving a rotated predecessor stays closed/hidden even if a runtime is restarted against its transcript
  - `src-tauri/src/services/session_records.rs`
    - add/assert lineage successor chain behavior for rotated sessions
  - `src-tauri/src/services/session_list.rs`
    - add coverage that only the assignment-bound successor is `Active` for a task after rotation
- **Frontend tests**
  - add/update a `New session` regression that forces an async `list_sessions()` refresh between optimistic successor merge and final list hydration, then asserts the successor remains selected
- **Desktop e2e**
  - create a real task-owned worker session, click `New session`, wait for refresh churn, and verify:
    - the new session is selected
    - the task detail points to the new session
    - the predecessor does not remain in the active list as another current task session

## Likely file touch list
- `src/App.tsx`
- `src/lib/sessionList.ts`
- `src-tauri/src/commands/sessions.rs`
- `src-tauri/src/services/session_list.rs`
- `src-tauri/src/services/session_records.rs`
- tests under `src-tauri/src/commands/sessions.rs` and desktop/frontend session coverage

## Guardrails
- Do not use historical `primary_*` session fields as a substitute for the task’s current assignment when computing “active” or “messageable.”
- Keep superseded sessions inspectable in detail/history, but not reopenable as concurrent task-linked active sessions.
- Preserve the existing rotation transaction shape in `create_contextual_session()`; the main change is tightening post-rotation semantics and UI selection.
- If adding a database constraint, repair existing duplicates before enforcing it.