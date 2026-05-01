# ORC-191 dual-write session-record service plan

## tl;dr

- Add `src-tauri/src/services/session_records.rs` as the single write-path entry point for Orchestra-managed session lifecycle changes.
- Make it own transcript create/rotate, canonical `sessions` row insert/update, and the temporary legacy shadow writes still needed for `session_catalog`, `agent_runtime_states`, `role_instances`, `task_lane_assignments`, `task_lane_runs`, and `session_list_entries`.
- Route these paths through it in order: `commands/sessions.rs` create/rotate, `agent_dispatch.rs` main-session ensure, `role_dispatch.rs` role-session ensure, then `task_runtime.rs` dispatch/completion/re-lane/cleanup/recovery.
- Keep read-path behavior unchanged in ORC-191; ORC-190/192 consume the new rows later.

## Executive summary

Current session writes are split between filesystem helpers and ownership tables. `src-tauri/src/services/pi_sessions.rs::create_session_file(...)` already creates the transcript and upserts `session_catalog`, while callers elsewhere separately mutate `agent_runtime_states.main_session_id`, `role_instances.session_id`, `task_lane_assignments.session_id`, `task_lane_runs`, and session-list archive state.

That means a single lifecycle step is usually implemented as several unrelated writes across several files. The result is predictable drift risk: a transcript can exist without current owner links, an owner link can move to a rotated session without a canonical row update, and cleanup can archive/hide a session without clearing the runtime/task ownership model that still points at it.

ORC-191 should fix that by introducing a shared session-record write service layered on top of the ORC-189 `sessions` table. Callers should stop issuing raw `session_id` ownership SQL and instead request higher-level operations like create, rotate, bind, and close. The new service becomes the first-class writer for canonical session rows while still dual-writing the legacy compatibility surfaces until ORC-190/192/193 cut readers over.

## Findings

1. `src-tauri/src/services/pi_sessions.rs::create_session_file(...)`
   - creates the JSONL transcript file
   - immediately upserts `session_catalog`
   - knows nothing about agent/role/task ownership

2. `src-tauri/src/commands/sessions.rs`
   - `create_session(...)` creates a transcript, then separately seeds agent context and updates `agent_runtime_states`
   - `create_contextual_session(...)` has separate agent-assignment, role-assignment, agent-main, and role-main rotation branches with their own ad hoc rollback logic

3. `src-tauri/src/services/agent_dispatch.rs::ensure_main_session(...)`
   - provisions or recovers the agent main session
   - separately updates `agent_runtime_states.main_session_id`
   - leaves task-assignment ownership to later dispatch code

4. `src-tauri/src/services/role_dispatch.rs::ensure_instance_session(...)`
   - provisions the role-instance transcript
   - separately updates `role_instances.session_id`
   - leaves task-assignment ownership to later queue/dispatch code

5. `src-tauri/src/services/task_runtime.rs`
   - `dispatch_agent_lane(...)` reuses or creates a session, updates agent runtime state, inserts assignment state, and creates/updates lane runs
   - `dispatch_role_lane(...)`, `activate_queued_role_assignments(...)`, and `recover_missing_assignment_session(...)` each manage session binding in different ways
   - `complete_lane(...)`, `finalize_worker_assignment(...)`, `reassign_task_to_lane(...)`, and `clear_task_runtime_claims_preserving_status(...)` close or clear session ownership across several tables independently

6. Some current helpers are patch helpers, not canonical ownership setters
   - `src-tauri/src/services/agent_runtime.rs::update_agent_runtime_dispatch_state_for_project(...)` uses `COALESCE(?4, main_session_id)`, so it cannot act as an explicit “set/clear current main session” primitive
   - `src-tauri/src/services/role_dispatch.rs::release_role_instance(...)` currently does not clear `session_id`

## Proposed service boundary

Add `src-tauri/src/services/session_records.rs` with four top-level operations:

1. `create_session_record(...)`
   - create a new transcript file
   - insert the canonical `sessions` row
   - optionally seed legacy compatibility links for standalone/user, agent-main, or role-instance creation

2. `rotate_session_record(...)`
   - create a successor transcript
   - mark the prior canonical row superseded/closed
   - transfer current owner/task/assignment bindings to the new row
   - keep predecessor/successor linkage for history

3. `bind_session_context(...)`
   - attach an existing session row to its current task/workflow/lane/assignment/runtime ownership
   - used when an agent main session is reused for a task lane and when a role queue assignment becomes active

4. `close_session_context(...)`
   - clear or finalize the current task/assignment binding
   - update lifecycle/archive fields when work ends, re-lanes, pauses, or is canceled/blocked
   - write the temporary legacy cleanup/archive projections still needed before ORC-193

## Canonical fields ORC-191 needs to write

ORC-189 owns the exact schema, but ORC-191 needs a row shape that can persist at least:

- `id`
- `project_id`
- `session_path`
- `session_kind` / source (`user`, `agent_main`, `role_instance`, `task_assignment`)
- current worker owner (`agent_id` and/or `role_instance_id` as applicable)
- current task/workflow/lane/assignment binding fields
- `runtime_cwd`
- lifecycle state (`active`, `closed`, `archived`, `superseded`)
- `superseded_by_session_id` / predecessor linkage for contextual rotation
- timestamps for created/updated/closed/archived state

The important rule is that agent-main and role-instance ownership stay stable on the canonical row even when task/lane assignment bindings come and go.

## Dual-write rules

- Treat the canonical `sessions` row as the first-class write target.
- Keep `session_catalog`, `session_list_entries`, `agent_runtime_states.main_session_id`, `role_instances.session_id`, `task_lane_assignments.session_id`, and `task_lane_runs` as compatibility projections until later cutover tasks land.
- Move the `session_catalog` write out of the implicit `create_session_file(...)` hot path for ORC-191 call sites. The new service should either use a no-side-effect transcript creator or suppress that side effect and re-apply it only after the canonical write succeeds.
- Perform all DB ownership/link updates for one lifecycle action in a single transaction.
- If transcript creation succeeds but the DB transaction fails, delete the newly created transcript before returning an error.
- Keep domain/app event emission outside the service so callers only emit after the transaction commits.

## Call-site mapping

| Flow | Current call sites | New service op |
| --- | --- | --- |
| Standalone session create | `commands/sessions.rs::create_session` | `create_session_record(...)` |
| Contextual rotation | `commands/sessions.rs::create_contextual_session` | `rotate_session_record(...)` |
| Agent main-session ensure/recovery | `services/agent_dispatch.rs::ensure_main_session` | `create_session_record(...)` or `bind_session_context(...)` |
| Role-instance session ensure/recovery | `services/role_dispatch.rs::ensure_instance_session`, `services/task_runtime.rs::recover_missing_assignment_session` | `create_session_record(...)` |
| Task dispatch and queued-role activation | `services/task_runtime.rs::dispatch_agent_lane`, `dispatch_role_lane`, `activate_queued_role_assignments` | `bind_session_context(...)` |
| Lane completion / approval / re-lane / stop / blocked cleanup | `services/task_runtime.rs` completion and cleanup helpers | `close_session_context(...)` |

## Implementation plan

### 1. Add the shared service and remove implicit catalog-side effects from write callers

- Introduce `src-tauri/src/services/session_records.rs`.
- Split transcript creation into a pure file helper plus explicit post-create metadata writes.
- Keep `pi_sessions.rs` focused on transcript parsing/JSONL mutation, not ownership SQL.

### 2. Move `commands/sessions.rs` create + rotate flows first

- Replace the ad hoc branches in `create_session(...)` and `create_contextual_session(...)`.
- Return the same decorated `SessionRecord` shape to callers, but make the session-record service responsible for the canonical row and owner-link updates underneath.
- Preserve current UX semantics; ORC-191 is a write consolidation task, not a behavior redesign.

### 3. Move agent and role provisioning onto the same primitives

- Route `agent_dispatch::ensure_main_session(...)` through the new service so main-session creation/recovery always writes the canonical row and the compatibility pointer together.
- Route `role_dispatch::ensure_instance_session(...)` and `task_runtime::recover_missing_assignment_session(...)` through the same creation path so replacement role transcripts are not a side channel.

### 4. Route dispatch and lifecycle transitions through bind/close helpers

- `dispatch_agent_lane(...)` should stop open-coding “reuse main session + update runtime state + insert assignment + ensure lane run”.
- `dispatch_role_lane(...)` / queued-role activation should bind the chosen session through the service.
- `complete_lane(...)`, approval, re-lane, stop/reset, and blocked cleanup should all close or clear task/assignment bindings through the same helper instead of independently mutating assignment/runtime/list state.

### 5. Hold legacy read compatibility until ORC-190/192

- Keep the current legacy columns/tables populated exactly enough for existing readers.
- Do not retire `session_catalog`, `session_list_entries`, or reverse-inference readers in ORC-191.
- Treat ORC-191 as the write-side prerequisite for ORC-190/192/193, not the cutover itself.

## Regression coverage to add

### Rust/service coverage

- standalone create writes canonical + legacy compatibility state together
- contextual rotation supersedes the old row and moves current owner links to the new row
- agent dispatch reuses the main session and updates canonical task/assignment binding without creating a duplicate row
- role provisioning and queued-role activation write matching canonical + legacy ownership
- completion/re-lane/cleanup clear current bindings and archive when the task ends
- failure after transcript creation compensates by deleting the new file and leaving no partial canonical row

### Existing caller coverage to update

- `src-tauri/src/commands/sessions.rs` tests for create/contextual behavior
- `src-tauri/src/services/agent_dispatch.rs` tests around main-session provisioning
- `src-tauri/src/services/role_dispatch.rs` tests around instance provisioning/release
- `src-tauri/src/services/task_runtime.rs` tests around dispatch, approval, completion, re-lane, and blocked cleanup

## Expected touch points

- `src-tauri/src/services/session_records.rs` (new)
- `src-tauri/src/services/pi_sessions.rs`
- `src-tauri/src/commands/sessions.rs`
- `src-tauri/src/services/agent_dispatch.rs`
- `src-tauri/src/services/agent_runtime.rs`
- `src-tauri/src/services/role_dispatch.rs`
- `src-tauri/src/services/task_runtime.rs`
- tests in the corresponding Rust modules

## Notes for implementation lane

- ORC-189 should land first or provide the canonical `sessions` schema this service writes to.
- `task_runtime::recover_missing_assignment_session(...)` must be included in the ORC-191 sweep even though it is a recovery path; it currently provisions replacement role transcripts and repoints ownership outside the normal create/dispatch flows.
- ORC-190 and ORC-192 should prefer consuming this service-backed canonical state rather than adding more reverse-inference helpers on top of legacy tables.
