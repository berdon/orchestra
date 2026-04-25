# ORC-165 dependency unblock on Test-lane transition plan

## tl;dr

- The current blocker predicate is task-terminal-only: a dependency stays unresolved until the blocker is `completed` or `canceled`.
- Encode the product rule as lane-scoped blocking: a dependency blocks only until the blocker finishes the lane that was blocking dependent work.
- Store the blocker lane snapshot on dependency creation, treat downstream lane advancement as resolved, and keep terminal completion/cancel semantics intact.
- Add Rust + mock parity coverage and a real desktop E2E where blocker `Implement -> Test/Verify` unblocks the dependent task.

## Executive summary

`src-tauri/src/services/tasks.rs::unresolved_blocker_sql(...)` and the mock equivalent in `src/lib/tauri.ts` currently define an unresolved dependency as any blocker whose status is not `completed`/`canceled`. That is why a blocker that successfully leaves `Implement` and enters a downstream `Test`/`Verify`/review lane still keeps dependents blocked: the transition updates the blocker to a non-terminal `ready`/`in_review` state, and reconciliation continues to see the edge as unresolved.

The implementation should keep the existing `auto_blocked_by_dependencies` status provenance and reconciliation flow, but replace the blocker-resolution predicate. The intended rule for this bug is: **a dependency blocks while the blocker is still in the blocking work lane; once the blocker advances to a downstream lane such as Test/Verify/review, the edge is resolved for dispatch purposes, even though the blocker task is not fully completed yet.** Completion and cancellation still resolve blockers as before.

## Findings from code audit

- Backend blocker resolution is centralized in `src-tauri/src/services/tasks.rs` through `reconcile_dependency_statuses(...)`, but its unresolved-edge SQL is terminal-only.
- `dependency_blocked` and `ready_for_dispatch` are derived from the same terminal-only predicate, so UI/runtime dispatchability stays blocked after `Implement -> Test`.
- `src-tauri/src/services/task_runtime.rs::transition_task_after_completion(...)` already reconciles the blocker and its dependents after every lane completion. The ordering is good; the predicate is wrong for non-terminal downstream lanes.
- `collect_post_completion_auto_dispatches(...)` already runs after lane completion and checks dependent `ready_for_dispatch`; it should start working once reconciliation marks the dependent ready before auto-dispatch collection.
- Mock mode mirrors the same terminal-only dependency predicate in `src/lib/tauri.ts`.
- Existing coverage proves unblock on `completed`, not unblock on real workflow advancement to Test/Verify.

## Product rule to encode

1. A task dependency is unresolved when the blocker is non-terminal and has not yet advanced beyond the dependency's blocking lane.
2. The blocking lane should be captured when the dependency is created from the blocker's current workflow/lane.
3. The dependency is resolved when any of these are true:
   - blocker status is `completed`
   - blocker status is `canceled`
   - blocker is still in the same workflow and its current lane order is greater than the captured blocking lane order
4. If the edge has no usable lane snapshot, fall back safely to the existing terminal-only behavior.
5. Dependent status restoration must still honor `auto_blocked_by_dependencies`; manually/failure-blocked dependents must not be silently restored to `ready`.

## Implementation plan

### 1. Persist dependency lane snapshots

Update `task_dependencies` storage in `src-tauri/src/services/database.rs`:

- add nullable internal columns such as `blocker_workflow_id`, `blocker_lane_id`, and `blocker_lane_order`
- populate them for new dependencies from the blocker task's current `workflow_id`, `current_lane_id`, and current workflow lane order
- leave public `TaskDependency` API fields unchanged unless implementation finds exposing the snapshot useful

Backfill existing rows as `NULL` so legacy edges keep terminal-only semantics rather than guessing incorrectly.

### 2. Replace the unresolved-blocker predicate

In `src-tauri/src/services/tasks.rs`:

- replace `unresolved_blocker_sql(alias)` with a helper that counts only dependency edges whose blocker is still unresolved under the new rule
- use the same helper everywhere it currently feeds:
  - `dependency_blocked`
  - `ready_for_dispatch`
  - `reconcile_dependency_status(...)`
  - any direct unresolved-blocker count helper
- ensure blocker failure/rework to the same or an earlier lane remains unresolved
- ensure completed/canceled blockers still resolve regardless of lane metadata

Recommended SQL shape: join each edge to its blocker task and current workflow lane; count the edge as unresolved when the blocker is non-terminal and either the edge lacks a valid snapshot or the current lane order is not greater than the captured order.

### 3. Keep reconciliation/auto-dispatch ordering intact

`transition_task_after_completion(...)` already updates the blocker, then calls `tasks::reconcile_dependency_statuses(...)` for the blocker, dependents, and parents. Keep that ordering so dependents become `ready` before command-side `collect_post_completion_auto_dispatches(...)` runs.

Verify both project automation modes:

- auto-dispatch disabled: dependent becomes `ready`, `dependencyBlocked=false`, `readyForDispatch=true`
- auto-dispatch enabled: dependent becomes runnable and is dispatched by the existing post-transition auto-dispatch path

### 4. Mirror in mock mode

In `src/lib/tauri.ts`:

- store equivalent mock-only dependency snapshot metadata
- update `mockTaskHasUnresolvedDependencyBlockers(...)` and enriched task derivation to use lane-order resolution
- keep mock auto-dispatch using `readyForDispatch` after reconciliation
- add/adjust Vitest coverage so mock behavior matches Rust

### 5. Regression tests

Backend/service tests:

- dependency created while blocker is in `Implement`; blocker advances to downstream `Test`/`Verify`; dependent restores to `ready`
- blocker stays in same lane or moves to failure/rework/upstream lane; dependent remains `blocked`
- multiple blockers: dependent stays blocked until every unresolved blocker has either completed/canceled or advanced beyond its captured blocking lane
- manually blocked dependent remains `blocked` after the lane-scoped dependency resolves
- legacy/null snapshot edge keeps terminal-only behavior

Runtime tests:

- `complete_lane_as_success` on blocker `Implement -> Test/Verify` restores dependent before auto-dispatch collection
- auto-dispatch-on-blocker-completion dispatches a newly unblocked dependent after the Test-lane transition
- approval/user-review transition path also unblocks when the blocker advances into a user-owned review lane

Mock tests:

- same `Implement -> Test/Verify` unblock behavior
- auto-dispatch parity when project automation is enabled

Desktop E2E:

- extend `tests/desktop-e2e/task-auto-dispatch-on-blocker-completion.test.ts` or add a focused companion spec
- create a real project, repo, roles, blocker workflow (`Implement -> Test/Verify`) and dependent workflow
- create dependency while blocker is in `Implement`
- verify dependent auto-blocks
- transition blocker with `complete_lane_as_success`
- verify blocker is now in the Test/Verify lane and dependent is unblocked/runnable; with automation enabled, verify it auto-dispatches

## Expected touch points

- `src-tauri/src/services/database.rs`
- `src-tauri/src/services/tasks.rs`
- `src-tauri/src/services/task_runtime.rs` tests and possibly event assertions only
- `src/lib/tauri.ts`
- `tests/blocked-task-runtime-mock.test.ts` or a new focused mock test
- `tests/desktop-e2e/task-auto-dispatch-on-blocker-completion.test.ts`
- Rust tests in `src-tauri/src/services/tasks.rs` and `src-tauri/src/services/task_runtime.rs`

## Risks and guardrails

- Do not add a second status reconciler; keep `reconcile_dependency_statuses(...)` authoritative.
- Do not restore manually/failure-blocked tasks to `ready`; rely on `auto_blocked_by_dependencies`.
- Treat missing dependency lane snapshots conservatively so existing data does not unblock unexpectedly.
- Keep emitted task-change sets including dependents; otherwise backend state may be correct but UI stale.
- If lane-order semantics prove ambiguous for dependencies created before active implementation starts, pause and ask whether dependencies should target a configurable workflow unblock lane instead of the creation-time lane snapshot.
