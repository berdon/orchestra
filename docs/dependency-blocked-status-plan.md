# Dependency-blocked status sync plan

## Problem summary

Today Orchestra computes `dependency_blocked` and `ready_for_dispatch` dynamically, but it does **not** consistently synchronize the persisted task `status` with that blocker state.

That leaves a few mismatches:

- `src-tauri/src/services/tasks.rs` derives `dependency_blocked` / `ready_for_dispatch` from unresolved dependency edges and unfinished child tasks, but `tasks.status` stays whatever it was previously.
- `src-tauri/src/services/task_runtime.rs` prevents dispatch when `dependency_blocked` is true, yet `cancel_dispatch_for_dependency_block()` currently resets a newly blocked task back to `ready`, which is the opposite of the requested behavior.
- Runtime completion paths only auto-dispatch dependents that are already `status in ('ready', 'in_progress')`, so a blocker completing cannot restore a dependent from `blocked` to `ready` unless we explicitly reconcile status first.
- `src-tauri/src/commands/tasks.rs` emits task-change events for the blocker task plus auto-dispatched tasks, but not for dependents/parents whose status may change without being auto-dispatched.
- The mock layer in `src/lib/tauri.ts` mirrors the same derived-only behavior, so tests and non-Tauri UI flows would diverge from the real backend if we only patch Rust.

## Design goal

Make persisted task status reflect the same blocker semantics the runtime already uses:

- unresolved dependency or unfinished child blocker => task should surface as `blocked`
- fully unblocked after being auto-blocked => task should surface as `ready`
- terminal states (`completed`, `canceled`) must never be clobbered
- manually/failure-blocked tasks must not be silently restored to `ready` just because dependency blockers cleared

## Key design choice: track blocker-driven status provenance

A pure status-only approach is ambiguous:

- if a task was manually set to `blocked`, then later receives a dependency, and that dependency clears, we cannot safely know whether to restore it to `ready`
- lane failure also uses `blocked`, which should not be auto-converted back to `ready`

Because of that, the implementation should add a small internal provenance field for auto-managed blocked state.

### Proposed persistence

Add an internal task column such as:

- `auto_blocked_by_dependencies INTEGER NOT NULL DEFAULT 0`

This field does **not** need to be exposed in the public `TaskDetail` API. It is only needed by backend/mock reconciliation logic.

`src-tauri/src/services/database.rs` should create the column for new databases and backfill it with an `ALTER TABLE` for existing ones.

For the mock layer, store the same concept in mock-only state (for example via a private `StoredMockTask` shape that extends `TaskDetail`).

## Central reconciliation helper

Introduce one helper in `src-tauri/src/services/tasks.rs` that is the single source of truth for blocker-driven status updates.

Suggested shape:

- `sync_auto_blocked_status(connection, task_id, now)`
- plus a small wrapper for batches / affected task sets

The helper should reuse the same blocker predicate already used for `dependency_blocked`:

- unresolved dependency edges
- unfinished non-archived child tasks

### Reconciliation rules

For each affected task:

1. If status is terminal (`completed`, `canceled`):
   - do not change status
   - clear `auto_blocked_by_dependencies`

2. If blockers currently exist:
   - if status is `ready`, `in_progress`, or `in_review`, set status to `blocked` and set `auto_blocked_by_dependencies = 1`
   - if status is already `blocked`:
     - preserve status
     - only keep `auto_blocked_by_dependencies = 1` if the task was previously auto-blocked
     - do **not** claim manual/failure-blocked tasks as auto-blocked just because blockers now exist
   - leave `draft` unchanged

3. If blockers do not exist:
   - if status is `blocked` and `auto_blocked_by_dependencies = 1`, set status to `ready` and clear the flag
   - otherwise leave status unchanged and clear the flag

This gives us the requested ready/blocked automation without incorrectly unblocking tasks that were blocked for another reason.

## Where reconciliation must run

## 1. Dependency add/remove flows

### `src-tauri/src/services/tasks.rs`

- `add_task_dependency()`
  - after inserting the edge, reconcile the blocked task
- `remove_task_dependency()`
  - after deleting the edge, reconcile the previously blocked task

### `src-tauri/src/commands/tasks.rs`

- `add_task_dependency`
  - keep canceling open assignments when the task becomes dependency-blocked
  - but update `cancel_dispatch_for_dependency_block()` so it no longer resets status to `ready`
- `remove_task_dependency`
  - emit task changes for both endpoints, and for the unblocked task after reconciliation

## 2. Task updates that can resolve blockers

### `src-tauri/src/services/tasks.rs`

`update_task()` should reconcile:

- the task itself, because explicit edits should clear stale auto-block flags
- direct dependents when the task crosses the unresolved/terminal boundary
- ancestor parents when child completion/reopen changes unfinished-child blocking
- old/new parent chains if `parent_task_id` changes

This is the main path that handles manual status edits from the task editor, not just workflow completion tools.

## 3. Task creation / subtask creation

### `src-tauri/src/services/tasks.rs`

- `create_subtask()` (and any parent-setting create flow) should reconcile the parent chain after insertion
- this keeps parent blocking semantics aligned with the already-existing `dependency_blocked` + auto-dispatch behavior for unfinished child tasks

## 4. Workflow completion / approval transitions

### `src-tauri/src/services/task_runtime.rs`

After `transition_task_after_completion()` / approval success but **before** collecting auto-dispatch candidates:

- reconcile affected dependents of the completed/canceled task
- reconcile affected parents when a child became terminal

This ordering matters because `maybe_auto_dispatch_task()` only considers tasks already in `ready` / `in_progress`. Newly unblocked tasks must be restored to `ready` first or they will never enter the existing auto-dispatch pipeline.

## Event / refresh propagation

UI components already render `task.status`; the missing piece is making sure status-changing side effects emit the right task IDs.

### `src-tauri/src/commands/tasks.rs`

Expand emitted task-change sets so they include:

- blocker task
- blocked/unblocked dependents whose status changed
- affected parent tasks whose status changed
- any auto-dispatched tasks (existing behavior)

That lets the existing task queries and subscriptions refresh immediately without requiring bespoke UI component changes.

### `src/lib/tauri.ts`

Mirror the same behavior in the mock layer:

- add the mock-only auto-block flag
- reconcile status inside mock `addTaskDependency`, `removeTaskDependency`, `updateTask`, `createTask`/`createSubtask`, and lane completion/approval helpers
- emit mock task-change events for every affected task ID, not just the task directly acted on

## Specific runtime fix

### `src-tauri/src/services/task_runtime.rs`

`cancel_dispatch_for_dependency_block()` currently cancels assignments and then runs:

- `UPDATE tasks SET status = 'ready' ... WHERE status IN ('in_progress', 'blocked')`

That should be replaced with logic that preserves the reconciled blocked state:

- cancel/close queue + assignment runtime as today
- leave status `blocked` (or explicitly set it to `blocked`) when the task is dependency-blocked
- never bounce a blocked task back to `ready` during the cancellation path

## Test plan

## Rust unit/service tests

### `src-tauri/src/services/tasks.rs`

Add focused tests for:

1. **dependency add auto-blocks a ready task**
   - `ready -> blocked`
2. **dependency removal restores a fully auto-blocked task to ready**
   - `blocked(auto) -> ready`
3. **multi-blocker removal keeps task blocked until the final blocker resolves**
   - add two blockers, resolve/remove one, task stays `blocked`
4. **manual/failure-blocked task is not auto-restored**
   - blockers clear, task remains `blocked` when the auto-block flag is not set
5. **subtask creation/completion updates parent status consistently**
   - if we keep parent-child blocker parity with `dependency_blocked`

### `src-tauri/src/services/task_runtime.rs`

Add/extend tests for:

1. **completing a blocker restores dependent task status to ready before auto-dispatch**
2. **dependent remains blocked when another unfinished blocker still exists**
3. **completion events include non-auto-dispatched dependents in refresh/update handling**
4. **dependency blocking cancels an active assignment without resetting task status to ready**

## Frontend/mock coverage

### `src/lib/tauri.ts` tests or desktop e2e

Extend `tests/desktop-e2e/task-auto-dispatch-on-blocker-completion.test.ts` with explicit status assertions:

1. adding a dependency moves the blocked task status to `blocked`
2. completing/removing the sole blocker restores status to `ready` before/without auto-dispatch
3. multi-blocker case: one blocker completes, dependent stays `blocked`
4. parent/subtask path stays aligned if we keep child blockers in scope

## Expected code touch points

- `src-tauri/src/services/database.rs`
- `src-tauri/src/services/tasks.rs`
- `src-tauri/src/services/task_runtime.rs`
- `src-tauri/src/commands/tasks.rs`
- `src/lib/tauri.ts`
- `tests/desktop-e2e/task-auto-dispatch-on-blocker-completion.test.ts`
- relevant Rust unit tests in `src-tauri/src/services/tasks.rs` / `task_runtime.rs`

## Notes for implementation lane

- Prefer one shared reconciliation helper over scattered status mutations.
- Run reconciliation **before** auto-dispatch candidate collection.
- Treat emitted task-change IDs as part of the feature, not as cleanup; without them the UI will look stale even if backend state is correct.
- Keep the provenance field internal so the public task API stays simple unless a future feature actually needs blocked-reason visibility.
