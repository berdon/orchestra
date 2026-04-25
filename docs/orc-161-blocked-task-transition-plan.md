# ORC-161 blocked-task transition-time stop plan

## tl;dr

- Keep the existing dependency status reconciler as the single source of truth for `blocked` <-> `ready` status sync.
- Stop auto-killing already-active blocked sessions from command-side cleanup and stale-recovery paths.
- Continue rejecting new dispatch/session spawn for blocked or dependency-blocked tasks.
- When an already-active blocked session tries to transition, close that assignment/session then, keep the task in `blocked`, and do not advance the lane.
- Update Rust, mock, and desktop regression coverage to encode the new semantics.

## Executive summary

The core unblock-to-ready logic already exists in `src-tauri/src/services/tasks.rs::reconcile_dependency_status(...)`, including the `auto_blocked_by_dependencies` provenance needed to restore only auto-blocked tasks to `ready`. A targeted Rust test (`dependency_add_auto_blocks_ready_task_and_completion_restores_ready`) already passes, so the reported regression is unlikely to be in the low-level reconciler itself.

The higher-level regression is in runtime/session policy. `src-tauri/src/commands/tasks.rs` still calls `cleanup_blocked_task_runtime_claims(...)` after create/update/dependency/completion flows, which aggressively cancels blocked assignments and stops live runtimes. `src-tauri/src/services/task_runtime.rs::complete_lane(...)` also hard-errors if the task is now dependency-blocked. Together those paths encode the older ORC-15 behavior (“stop blocked work immediately”), but this task now requires a narrower rule: block new work immediately, but let an already-running session continue until it attempts a transition.

This plan intentionally keeps the blocker-status work from `docs/dependency-blocked-status-plan.md`, but partially reverses the active-session semantics from `docs/orc-15-blocked-task-runtime-capacity-plan.md`.

## Findings

1. `src-tauri/src/services/tasks.rs`
   - `reconcile_dependency_status(...)` already:
     - auto-blocks `ready` / `in_progress` / `in_review` tasks when blockers appear
     - restores `blocked(auto)` tasks to `ready` when blockers clear
     - preserves manual/failure-blocked tasks when blockers clear
   - Existing service coverage proves the raw dependency and subtask status transitions still work at this layer.

2. `src-tauri/src/commands/tasks.rs`
   - `create_task`, `create_subtask`, `update_task`, `add_task_dependency`, `remove_task_dependency`, `approve_task_review`, and `complete_lane_command` all run `cleanup_blocked_task_runtime_claims(...)`.
   - That helper immediately clears assignments, queue claims, role instances, agent queue ownership, and live runtimes for any task whose status is `blocked`.
   - This is the direct cause of the “subtask created mid-run kills the parent session” behavior.

3. `src-tauri/src/services/task_runtime.rs`
   - `dispatch_task_lane(...)` and `task_is_runnable_for_worker_runtime(...)` already reject blocked/dependency-blocked tasks for fresh dispatch.
   - `stale_assignment_reason(...)` currently treats any blocked task assignment as stale, so dispatcher recovery would also kill an active blocked session even if command-side cleanup is removed.
   - `complete_lane(...)` currently returns an error when `task.dependency_blocked` is true, instead of stopping the session cleanly and leaving the task blocked.

4. `src/lib/tauri.ts` and existing tests
   - Mock/browser mode still mirrors the old “becoming blocked clears active assignment immediately” behavior.
   - Existing Rust + desktop + mock tests encode the old semantics and must be inverted.

## Implementation plan

### 1. Preserve and re-verify unblock-to-ready status reconciliation

Keep `tasks::reconcile_dependency_statuses(...)` as the canonical blocker-status engine.

Implementation lane should add path-level coverage for the completion pathways that the low-level service tests do not cover yet:

- blocker completes through `complete_lane_as_success`
- blocker completes through approval flow if applicable
- dependency removal path still restores `ready`
- parent/subtask completion still restores `ready`

Goal: prove the real workflow completion path still drives blocked dependents back to `ready`, not just direct `update_task(status="completed")`.

### 2. Split “blocked” handling into queued-vs-active cases

Replace blanket post-command cleanup with state-aware behavior:

- **Queued / not-yet-running blocked work**
  - must not start
  - should be rejected/canceled as stale or invalid queue work
- **Already-active blocked work with a live session**
  - may continue temporarily
  - must not be killed merely because the task became blocked

This means `cleanup_blocked_task_runtime_claims(...)` should stop being called as a universal follow-up for normal task/dependency transitions, or be narrowed so it only clears non-running claims.

### 3. Move active blocked-session stopping to transition time

Adjust `src-tauri/src/services/task_runtime.rs::complete_lane(...)` so that a blocked task transition attempt is handled as a controlled stop, not as a hard error.

Recommended semantics:

- detect `task.status == "blocked" || task.dependency_blocked` after authorization/unread/todo guards but before normal success/failure/needs-user lane advancement
- update the open lane run as `canceled` with notes explaining that the task became blocked before transition
- finalize/close the assignment and associated worker claim
- leave the task on its current lane with status `blocked`
- return the updated task successfully so the worker/session sees the transition attempt as handled, not rejected
- do **not** run normal lane advancement or approval/intervention transitions

This is the core behavior change for the “active task creates a subtask mid-run” scenario.

### 4. Prevent stale-recovery from immediately undoing the new behavior

Update `stale_assignment_reason(...)` and any related recovery sweep so a live active blocked assignment is not automatically considered stale just because the task is blocked.

Recommended rule:

- blocked **queued** claims are stale
- blocked **active** claims with a live session are not stale solely for being blocked
- blocked active claims with a missing runtime/session can still be recovered as stale

Without this change, dispatcher recovery will keep reintroducing immediate forced termination.

### 5. Keep fresh dispatch/session spawn blocked

Retain the existing dispatchability gates in:

- `dispatch_task_lane(...)`
- `task_is_runnable_for_worker_runtime(...)`
- `task_lane_queue_source_is_valid(...)`
- `maybe_auto_dispatch_task(...)`

Implementation should verify they still cover:

- initially blocked tasks
- dependency-blocked tasks
- parent tasks blocked by unfinished subtasks
- newly unblocked tasks only after status has been restored to `ready`

### 6. Mirror the same semantics in mock/browser mode

Update `src/lib/tauri.ts` so mock mode matches Rust:

- blocked tasks still cannot dispatch or auto-dispatch
- active blocked assignments are not cleared immediately
- transition attempts on blocked active tasks close the assignment and leave the task blocked
- blocked/unblocked status reconciliation stays aligned with backend behavior

## Regression coverage to add/update

### Rust/service coverage

- blocker completion restores dependent from `blocked` to `ready` through runtime completion flow
- blocked tasks cannot dispatch / queue-source validation rejects them
- active task can become blocked mid-session without immediate assignment cleanup
- blocked transition attempt closes the assignment, records a canceled lane run, and leaves the task blocked
- stale recovery still clears truly stale blocked claims without unblocking the task

### Mock/frontend coverage

- replace the current mock test that expects immediate assignment removal on block
- add mock coverage for “becomes blocked while active, remains active until completion tool is used”
- add mock coverage for blocked transition leaving task blocked and closing the assignment

### Desktop E2E

Update `tests/desktop-e2e/task-auto-dispatch-on-blocker-completion.test.ts` (or split it) to cover:

- completing a blocker restores dependent status/dispatchability
- blocked tasks do not dispatch while blocked
- active task blocked mid-run does not immediately lose its session
- that same session stops only when it attempts a transition, and the task remains blocked
- parent/subtask mid-run scenario matches the same rule

## Expected touch points

- `src-tauri/src/services/tasks.rs`
- `src-tauri/src/services/task_runtime.rs`
- `src-tauri/src/commands/tasks.rs`
- `src-tauri/src/services/dispatcher.rs`
- `src/lib/tauri.ts`
- `tests/desktop-e2e/task-auto-dispatch-on-blocker-completion.test.ts`
- Rust tests in `src-tauri/src/services/tasks.rs` and `src-tauri/src/services/task_runtime.rs`
- mock/browser parity tests such as `tests/blocked-task-runtime-mock.test.ts`

## Notes for implementation lane

- Do not reintroduce a second blocker-status system; keep using `auto_blocked_by_dependencies`.
- The old ORC-15 “free capacity immediately” rule should still apply to blocked queued work, but not to an already-live session.
- The completion-tool behavior change is the highest-risk part because it affects lane-run history, assignment lifecycle, and session retirement together.
- The safest shape is a single explicit blocked-transition helper that both success/failure/needs-user completion tools funnel through before normal lane advancement logic runs.
