# ORC-242 stale role-dispatch session leak plan

## tl;dr
The stray-session leak is not primarily in `role_dispatch::dispatch_role_queue()`: that path already rejects invalid queued role-work sources before provisioning a session. The leak comes from task dispatch reusing a stale open role assignment, then `ensure_assignment_runtime()` / `recover_missing_assignment_session()` creating a replacement role session before re-validating that the task/workflow/lane source is still current. Fix it in two layers: (1) clean stale open assignments before `dispatch_task_lane()` reuses them, and (2) refuse missing-session recovery for stale assignments so no code path can create a new session from invalid role-work source data.

## Executive summary
Investigation points to `src-tauri/src/services/task_runtime.rs` rather than `src-tauri/src/services/role_dispatch.rs` as the source of the leaked session.

`role_dispatch::dispatch_role_queue()` already calls `role_runtime::queue_entry_is_valid()` before it creates a role instance or session, so a directly queued stale role-work item should be canceled without provisioning anything new.

The gap is higher up the stack:
- `dispatch_task_lane_in_transaction()` reuses the first open assignment for the current task/lane without checking whether that assignment is stale.
- `dispatch_task_lane_via_app()` immediately calls `start_assignment_run()` on the returned assignment.
- `ensure_assignment_runtime()` treats a missing canonical session as recoverable and calls `recover_missing_assignment_session()`.
- `recover_missing_assignment_session()` creates a fresh role session from the stale assignment/role-instance linkage without validating that the assignment’s task/workflow/lane source is still valid.

That is how invalid role-work source data survives long enough to create a new stray session. The implementation should reuse the existing `stale_assignment_reason()` logic to (a) clean stale claims before dispatch reuse and (b) block missing-session recovery from creating a new session when the assignment is already stale.

## Current-state findings

### 1. Direct role-queue dispatch already validates before session creation
Relevant file:
- `src-tauri/src/services/role_dispatch.rs`

`dispatch_role_queue()` loads the next queued entry, calls `role_runtime::queue_entry_is_valid()`, and cancels invalid queued entries before `create_role_instance()`, `claim_queue_entry_for_instance()`, or `ensure_instance_session()` run.

Implication: the observed leak is unlikely to come from the low-level queued-role provisioning path itself.

### 2. Task dispatch reuses open assignments without stale validation
Relevant file:
- `src-tauri/src/services/task_runtime.rs`

`dispatch_task_lane_in_transaction()` currently does:
1. load current task/workflow/lane
2. reject obviously undispatchable task states
3. call `find_open_assignment_for_task_lane()`
4. immediately return that assignment after duplicate cleanup

It does **not** call `stale_assignment_reason()` before reusing the assignment.

Implication: an open role assignment can survive a workflow/lane/source drift and still be treated as the canonical dispatch target.

### 3. Missing-session recovery can create a fresh role session from stale assignment data
Relevant file:
- `src-tauri/src/services/task_runtime.rs`

`dispatch_task_lane_via_app()` calls `start_assignment_run()`. For active assignments, `ensure_assignment_runtime()` recreates the runtime cwd and, if the referenced session is missing, calls `recover_missing_assignment_session()`.

`recover_missing_assignment_session()` creates a new role session record and rebinds it to the role instance/assignment, but it does not validate whether:
- the assignment is still runnable for the task’s current workflow/lane
- the assignment’s queue entry still represents a valid task/workflow/lane source
- the role instance/queue/session linkage is still coherent

Implication: a stale role assignment can manufacture a new canonical session even though the runtime claim should have been canceled.

### 4. The stale-detection logic already exists and is strong enough to reuse
Relevant file:
- `src-tauri/src/services/task_runtime.rs`

`stale_assignment_reason()` already checks the important invariants for this bug class, including:
- task no longer runnable for the assignment’s task/workflow/lane source
- missing assignment session
- missing/mismatched role queue entry
- missing/mismatched role instance ownership
- mismatched role-instance session binding

Implication: the fix should route both dispatch reuse and missing-session recovery through this existing validator instead of adding a second bespoke source-check path.

## Recommended implementation

### 1. Guard `dispatch_task_lane_in_transaction()` before reusing an open assignment
In `src-tauri/src/services/task_runtime.rs`:
- after `find_open_assignment_for_task_lane()` returns an assignment, call `stale_assignment_reason()`
- if it returns `None`, keep today’s reuse behavior
- if it returns `Some(reason)`, call `clear_task_runtime_claims_preserving_status(task_id, Some(reason))` and continue normal dispatch instead of returning the stale assignment

Why this shape:
- it repairs recoverable stale state in-band during the dispatch the user already asked for
- it reuses the existing cleanup path that already cancels assignments, queue entries, role instances, and open sessions together
- it prevents `dispatch_task_lane_via_app()` from ever trying to run a stale assignment in the common path

### 2. Refuse missing-session recovery for stale assignments
Also in `src-tauri/src/services/task_runtime.rs`:
- make `recover_missing_assignment_session()` call `stale_assignment_reason()` before it creates any new session record
- if the assignment is stale, return an error such as `Refusing to recover missing session for stale assignment ...`
- only proceed to `create_session_record()` when the assignment is still valid and the missing session is the only thing that needs repair

Why this second guard matters:
- it closes the exact stray-session leak even if another call path reaches recovery without coming through `dispatch_task_lane()` first
- it gives the system a defense-in-depth invariant: invalid runtime claims must not create new sessions

### 3. Keep recovery behavior for valid assignments
Do **not** remove missing-session recovery entirely.

A valid agent/role assignment whose canonical session file was lost should still be recoverable. The change should narrow recovery from:
- “session missing ⇒ always create a replacement session”

to:
- “session missing **and assignment still valid** ⇒ create a replacement session”

## Regression tests

### 1. Stale role assignment is cleaned and redispatched instead of reused
Add a `task_runtime.rs` test that:
- creates a role-owned lane assignment with a real role queue entry/role instance/session
- mutates the task so the old assignment workflow/source becomes stale but the task is still dispatchable on its current lane
- re-dispatches the task
- asserts the stale assignment was canceled and a fresh assignment/queue entry/session was created for the current source

Expected invariant:
- the user-requested dispatch repairs stale source state instead of reusing it

### 2. Missing-session recovery refuses stale role assignments
Add a `task_runtime.rs` test that:
- creates a stale active role assignment whose canonical session is missing
- calls the missing-session recovery helper path
- asserts it returns an error
- asserts no new session row/file was created

Expected invariant:
- invalid role-work source data cannot create a replacement session

### 3. Optional: lock the lower-level queue behavior explicitly
Add a `role_dispatch.rs` test that seeds an invalid queued workflow-lane role entry and verifies:
- `dispatch_role_queue()` cancels it
- no new role instance is provisioned
- no new session is created

This is partly documentation-by-test: it makes clear that the leak was in stale assignment reuse/recovery, not direct queue provisioning.

## Recommended implementation order
1. Add the recovery guard first (`recover_missing_assignment_session()`), because that directly blocks the session leak.
2. Add stale-assignment cleanup in `dispatch_task_lane_in_transaction()` so user-triggered dispatch repairs recoverable stale claims automatically.
3. Add regression tests for both layers.

## Risk notes
- `clear_task_runtime_claims_preserving_status()` cancels all open runtime claims for the task, so the dispatch-side cleanup should only run when `stale_assignment_reason()` positively identifies stale state.
- Prefer reusing the existing stale reason strings in errors/comments so future debugging clearly explains why the old claim was not recoverable.
- If implementation touches assignment reuse ordering, keep the existing duplicate-cleanup behavior for valid assignments unchanged.
