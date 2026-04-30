# ORC-194 dependency auto-unblocking timing plan

## tl;dr

- The regression is semantic drift, not a missing completion hook.
- ORC-165 changed dependency resolution from **terminal-only** to **lane-advancement** by snapshotting the blocker lane at dependency creation and resolving the edge once the blocker moves downstream.
- Keep the existing reconciliation hooks, but restore the blocker predicate to **unfinished blocker = still blocking** until the blocker is truly `completed` or `canceled`.
- Update Rust, mock, and E2E coverage so intermediate lane/review transitions stay blocked and true completion unblocks.

## Executive summary

Current dependency re-evaluation is already centralized in `src-tauri/src/services/tasks.rs::reconcile_dependency_statuses(...)` and is invoked from the main lifecycle paths that matter: task create/update, dependency add/remove, and workflow completion/approval transitions. The main problem is that the unresolved-blocker predicate no longer means "blocker task is unfinished." After ORC-165 (`ca72c23`, `fix: unblock dependencies after blocker lane advancement`), it now means "blocker task is unfinished and has not advanced beyond the lane snapshot captured when the dependency was created."

That lane-snapshot rule is why some dependents unblock too early on `Implement -> Test/Review`, even though the blocker task is not complete. It also leaves the system with mixed timing semantics: dependencies with a usable snapshot unblock on lane advancement, while legacy/null-snapshot dependencies still wait for terminal completion. The fix should restore one product rule everywhere: **a task dependency remains unresolved until the blocker task reaches true task completion semantics**.

## Current behavior and exact trigger points

### Where re-evaluation happens today

Dependency status reconciliation currently runs from these paths:

- `src-tauri/src/services/tasks.rs`
  - `create_task(...)`
  - `update_task(...)`
  - `add_task_dependency(...)`
  - `remove_task_dependency(...)`
- `src-tauri/src/services/task_runtime.rs`
  - `transition_task_after_completion(...)`
  - `approve_task_review(...)` via `transition_task_after_completion(...)`
- Mock parity mirrors the same flow in `src/lib/tauri.ts`

Important finding: there is **not** a separate "assignment transition" or "dispatch" unblock hook driving the bug. The same reconciler is being called; the predicate it uses is wrong for the desired product semantics. Also, not every lane-movement path re-evaluates dependencies equally: the current early-unblock behavior is coming from status/lane changes that flow through `update_task(...)` or `transition_task_after_completion(...)`, not from a standalone generic lane-transition watcher.

### Why tasks unblock too early

The early unblock is encoded in two places:

- `src-tauri/src/services/tasks.rs::dependency_blocker_lane_snapshot(...)`
- `src-tauri/src/services/tasks.rs::unresolved_blocker_sql(...)`

When a dependency is created, Orchestra stores:

- `blocker_workflow_id`
- `blocker_lane_id`
- `blocker_lane_order`

Then `unresolved_blocker_sql(...)` treats the blocker as resolved once it is non-terminal **and** its current lane order is greater than the captured lane order.

That behavior is reproduced and currently asserted by:

- `src-tauri/src/services/tasks.rs::dependency_resolves_when_blocker_advances_beyond_captured_lane`
- `src-tauri/src/services/task_runtime.rs::blocker_implementation_to_test_transition_restores_dependent_to_ready`
- `tests/blocked-task-runtime-mock.test.ts` (`mock mode unblocks a dependent when the blocker advances to the Test lane`)
- `tests/desktop-e2e/task-auto-dispatch-on-blocker-completion.test.ts` (`auto-dispatches a dependent when the blocker advances from Implement to Test`)

I also re-ran the two Rust tests above in this workspace; both pass, confirming the current backend/runtime behavior is intentionally unblocking on lane advancement.

### Why behavior is inconsistent across tasks

Current behavior is mixed because null/legacy snapshot rows still use terminal-only fallback behavior. That is asserted by:

- `src-tauri/src/services/tasks.rs::dependency_remains_unresolved_without_lane_snapshot_until_terminal_status`

So today Orchestra has two different dependency timing models at once:

1. snapshot present -> unblock on downstream lane advancement
2. snapshot absent -> unblock on terminal completion/cancel

That semantic split is the clearest explanation for the "some tasks unblock too early, some wait until true completion" drift reported in ORC-194.

## Recommended product rule

A dependency edge should remain unresolved until the blocker task reaches task-terminal completion semantics.

Recommended rule:

1. blocker `completed` -> resolve
2. blocker `canceled` -> resolve
3. any other blocker status -> still unresolved
4. intermediate lane transitions, review lanes, and downstream workflow movement do **not** unblock by themselves
5. manually/failure-blocked dependents still rely on `auto_blocked_by_dependencies` and must not be auto-restored incorrectly

## Implementation plan

### 1. Restore a terminal-only blocker predicate

In both backend and mock parity:

- change `src-tauri/src/services/tasks.rs::unresolved_blocker_sql(...)`
- change `src/lib/tauri.ts::mockDependencyHasUnresolvedBlocker(...)`

so unresolved means only:

- dependency exists, and
- blocker status is not in `('completed', 'canceled')`

This keeps all existing reconciliation call sites intact while changing the meaning back to completion-only.

### 2. Remove lane-snapshot semantics from dependency resolution

The simplest low-risk path is:

- stop consulting `blocker_workflow_id` / `blocker_lane_id` / `blocker_lane_order` in resolution logic
- optionally leave the columns in place for compatibility and future cleanup
- optionally stop populating new snapshot fields in `add_task_dependency(...)` if we want to avoid future confusion, but this is not required for the behavioral fix

I do **not** recommend a schema-removal migration in the same patch unless implementation turns out to be trivial; behavior should be fixed first.

### 3. Keep the existing reconciliation lifecycle

Do **not** add a second unblock lifecycle system.

The current trigger points are already good enough once the predicate is corrected:

- `update_task(...)` covers direct status edits to `completed`
- `transition_task_after_completion(...)` covers workflow success/failure transitions
- `approve_task_review(...)` covers completion that only becomes real after user approval
- dependency add/remove and parent/subtask flows keep blocked status in sync

### 4. Update regression coverage to encode the new semantics

Replace the current lane-advancement assertions with completion-timing assertions.

Backend/runtime coverage should explicitly prove:

- one blocker -> one dependent: later lane transition does **not** unblock
- one blocker -> one dependent: terminal completion **does** unblock
- multiple blockers: first completion leaves dependent blocked
- multiple blockers: final remaining completion restores `ready`
- manual/failure-blocked dependent stays `blocked`
- approval/review path stays blocked until the blocker is actually approved into `completed`
- already-blocked tasks remain blocked for non-dependency reasons

Update at least these files:

- `src-tauri/src/services/tasks.rs`
- `src-tauri/src/services/task_runtime.rs`
- `src/lib/tauri.ts`
- `tests/blocked-task-runtime-mock.test.ts`
- `tests/desktop-e2e/task-auto-dispatch-on-blocker-completion.test.ts`

### 5. Audit post-unblock dispatch/session behavior, but keep it mostly unchanged

`collect_post_completion_auto_dispatches(...)` already runs after completion/approval transitions. Once dependents are restored to `ready` only at true completion, that existing auto-dispatch path should continue to work.

The implementation lane should still re-verify:

- dependents become `ready` before auto-dispatch collection
- blocked tasks are not dispatched on intermediate lane movement
- the ORC-161 blocked-session behavior is not regressed by these test updates

## Risks and guardrails

- Do not scatter one-off unblock logic across command handlers; keep `reconcile_dependency_statuses(...)` authoritative.
- Do not auto-restore manually/failure-blocked tasks; preserve `auto_blocked_by_dependencies` behavior.
- Be explicit in test names that **lane transition is not completion**.
- If implementation finds a real completion-path miss beyond the semantic drift above, add a focused regression for that exact path instead of broadening the product rule again.

## Recommended implementation order

1. Update backend blocker predicate and Rust tests.
2. Update runtime tests around completion/approval ordering.
3. Update mock parity logic/tests.
4. Update desktop/E2E coverage to prove no early unblock and correct unblock on true completion.
5. Leave a short code comment near `unresolved_blocker_sql(...)` documenting the product rule so ORC-165-style drift does not reappear.
