# ORC-15 blocked task runtime/capacity plan

## Goal

Stop blocked tasks from retaining live task sessions or consuming agent/role capacity.

This plan builds on the already-implemented blocker provenance work in `docs/dependency-blocked-status-plan.md`. That document fixed status reconciliation (`blocked` vs `ready`). The remaining gap is that blocked tasks can still keep open runtime/queue state that makes workers look busy.

## Reproduced failure modes

### 1. Manual `status = blocked` does not clear runtime state

`src-tauri/src/commands/tasks.rs::update_task()` delegates to `src-tauri/src/services/tasks.rs::update_task()`, which persists the new task status and reconciles dependencies, but it does not close open task assignments, queue entries, or worker runtime state.

That means a task can become `blocked` while all of the following still remain live:

- `task_lane_assignments.status in ('queued', 'active')`
- `role_queue_entries.status in ('queued', 'assigned')`
- `agent_queue_entries.status in ('queued', 'dispatched')`
- `role_instances.status = 'running'`
- `agent_runtime_states.current_queue_entry_id != NULL`

Because the backend still sees those rows as open, blocked tasks continue to surface as active work and keep consuming worker capacity.

### 2. Explicit dispatch still allows initially blocked tasks

`src-tauri/src/services/task_runtime.rs::dispatch_task_lane()` rejects `dependency_blocked`, but it does not reject `task.status == 'blocked'`.

So a task that starts life blocked can still be explicitly dispatched if it has a worker-owned lane. That violates the operator requirement that initially blocked tasks must never be dispatched in the first place.

### 3. Existing queued work remains "valid" after a task becomes blocked

`src-tauri/src/services/task_runtime.rs::task_lane_queue_source_is_valid()` only rejects archived/completed/canceled tasks or lane/workflow mismatches. It does not reject blocked or otherwise non-runnable tasks.

As a result:

- a queued role task can still be claimed after the task was blocked before startup
- an agent queue entry can remain in the dispatchable set after the task was blocked
- role/agent operations views keep counting work that should no longer be runnable

### 4. Dependency-block cleanup only covers one entry point

`src-tauri/src/commands/tasks.rs::add_task_dependency()` already calls `cancel_dispatch_for_dependency_block()`, but that cleanup is tied to one command path.

Auto-blocking can also happen through other flows that already call `reconcile_dependency_statuses()`, including:

- task updates
- task creation / subtask creation
- parent-child blocker changes
- workflow completion / approval paths

Those flows can move a task into `blocked` without clearing live runtime claims.

### 5. Existing stale-assignment recovery cannot be reused as-is

`src-tauri/src/services/task_runtime.rs::reset_task_runtime()` and `stop_task_activity()` force the task back to `ready`.

That is correct for a user-issued stop/reset action, but it is wrong for blocked tasks. Reusing that helper for blocked-task cleanup would accidentally unblock the task while trying to free capacity.

## Product semantics

### Runnable worker-owned task

A task should only consume worker capacity when it is actually runnable. The shared predicate should be:

- not archived
- `status in ('ready', 'in_progress')`
- not `dependency_blocked`
- has a current workflow lane
- current lane owner is `role` or `agent`
- queue/assignment source still matches the task's current lane/workflow

If any of those conditions stop being true, the task must no longer hold worker runtime or queue capacity.

### Blocked tasks

When a task is `blocked`:

- it may keep its current lane pointer so Orchestra knows where work resumes later
- it may keep its lane owner metadata (`assignee_type` / `assignee_id`) as future ownership metadata
- it must not keep any open worker claim
- it must not appear as queued/assigned/dispatched/running work for capacity purposes
- it must not expose an active task session/runtime in task detail

In other words: blocked tasks may remain owned by a lane, but they are not runnable work.

### Active lane assignments

Open worker-owned task assignments (`queued`, `active`, `awaiting_user_approval`, `awaiting_user_intervention`, `paused_by_user`) represent a live claim on a worker/runtime lifecycle.

A task entering `blocked` must close that claim immediately. After cleanup:

- `task.activeLaneAssignment == null`
- no open `task_lane_assignments` row remains for the blocked task

### Queued role work

Queued/assigned role entries are capacity-bearing work, not merely historical artifacts.

Blocked tasks must not leave behind:

- `role_queue_entries.status = 'queued'`
- `role_queue_entries.status = 'assigned'`
- `role_instances.status = 'running'`

Because roles are single-use (`docs/role-runtime-single-use-plan.md`), blocking a role task should cancel that specific instance and retire its session rather than trying to keep it warm.

### Live session/runtime lifecycle

#### Roles

When a role task becomes blocked:

- abort the live run if one exists
- cancel/close the task assignment
- cancel the queue entry
- cancel the spawned role instance
- retire the role session immediately

When the task becomes runnable again, dispatch should create a fresh role instance and fresh session.

#### Agents

When an agent task becomes blocked:

- abort the active task run if one exists
- close the task assignment
- complete/cancel the task-specific queue entry
- clear `agent_runtime_states.current_queue_entry_id`
- return the agent runtime to `idle` unless some other error state applies

The agent's main session may continue to exist because it belongs to the persistent agent, not to the blocked task. But the blocked task itself must no longer retain an active session/assignment or occupy the agent's current queue slot.

### Worker capacity/accounting

The counts that matter should reflect only runnable work:

- role `queuedCount` / `assignedCount` / `activeInstanceCount`
- agent `queuedCount` / `dispatchedCount`
- task detail `activeLaneAssignment`
- task board / inbox / overview surfaces that imply a task is actively running

The fix should make those surfaces correct by cleaning the underlying state, not by adding frontend-only filters that hide stale rows.

### Transitions into and out of blocked

#### Task becomes blocked while active

- close the worker claim
- stop the live run
- preserve task status as `blocked`
- do not silently revert to `ready`

#### Task becomes blocked while queued but not yet running

- cancel the queued assignment / queue entry before it can start
- leave the task `blocked`
- do not spawn or preserve a live session

#### Task starts out blocked

- explicit dispatch must reject it
- queue-source validity must reject it
- dispatcher/queue loops must skip or cancel any stale queue rows tied to it

#### Blocker clears and task becomes runnable again

- if the task was auto-blocked by dependencies/unfinished child work, restore it to `ready`
- if the task was manually blocked, leave it `blocked` until a user/worker explicitly changes it
- once it is back in `ready`/`in_progress` with no blockers, existing dispatch/auto-dispatch rules can create a fresh assignment
- no stale queue entry, role instance, or task-owned live session should be resurrected

## Design

### 1. Introduce one shared runnable/non-runnable predicate

Create a single backend helper for "can this task legitimately occupy worker runtime right now?" and reuse it across:

- `dispatch_task_lane()`
- `maybe_auto_dispatch_task()`
- `task_lane_queue_source_is_valid()`
- any stale-assignment recovery / reconciliation sweeps

The important part is to stop maintaining slightly different dispatchability rules in separate places.

### 2. Generalize dependency-block cleanup into blocked-preserving runtime cleanup

Replace the dependency-specific cleanup shape with a more general helper in `src-tauri/src/services/task_runtime.rs`, for example:

- `clear_blocked_task_runtime_claims(...)`
- or `cancel_task_runtime_for_non_runnable_state(...)`

This helper should:

- locate any current/open assignment for the task
- cancel/complete the assignment without changing the task back to `ready`
- cancel/complete role or agent queue rows tied to the task
- clear role/agent runtime ownership
- return enough metadata for command-layer side effects:
  - session ids to stop/retire
  - worker type
  - changed task ids for refresh/event emission

`cancel_dispatch_for_dependency_block()` should become a thin caller or disappear into this generalized helper.

### 3. Make blocker reconciliation return transitions, not just "something changed"

`src-tauri/src/services/tasks.rs::reconcile_dependency_statuses()` currently reports only changed task ids.

It should instead expose structured outcomes, e.g.:

- changed task ids
- newly blocked task ids
- newly unblocked task ids

That lets command-layer entry points react correctly:

- newly blocked tasks => clear runtime claims immediately
- newly unblocked tasks => emit refreshes and let normal dispatch/auto-dispatch logic resume work

This is important because auto-blocking currently happens in multiple flows, not just `add_task_dependency()`.

### 4. Apply blocked cleanup at every transition into blocked

The cleanup helper should run when a task crosses into blocked through any of these paths:

- manual task edit (`update_task`) to `status = blocked`
- dependency addition
- unfinished child/subtask auto-blocking a parent
- any other reconciliation path that produces a newly blocked task
- startup/dispatcher recovery when legacy data already contains blocked tasks with open runtime claims

This keeps the fix state-based instead of command-specific.

### 5. Add a self-healing sweep for legacy/stale data

Even after fixing forward transitions, existing databases may already contain blocked tasks with open assignments or queue rows.

Add a recovery path so Orchestra cleans those rows automatically on startup/dispatcher tick.

Important detail: this recovery must use the new blocked-preserving cleanup helper, not `reset_task_runtime()`, because a blocked task should remain blocked after recovery.

### 6. Keep frontend/browser-mode state in sync

`src/lib/tauri.ts` currently mirrors the same stale behavior by preserving `activeLaneAssignment` and other runtime state when a task becomes blocked.

Mirror the backend semantics there so:

- browser-mode behavior matches Tauri behavior
- unit tests do not drift from the real runtime
- UI/state surfaces show blocked tasks as non-running in both environments

## Recommended touch points

### Rust backend

- `src-tauri/src/services/task_runtime.rs`
  - dispatch gating
  - queue-source validity
  - blocked-preserving runtime cleanup helper
  - stale recovery updates
- `src-tauri/src/services/tasks.rs`
  - reconciliation outcome struct
  - update/create/subtask dependency reconciliation plumbing
- `src-tauri/src/commands/tasks.rs`
  - invoke cleanup after `update_task`, `add_task_dependency`, `create_subtask`, and any other command that can newly block tasks
  - stop live runtime + retire role sessions when cleanup reports them
- `src-tauri/src/services/dispatcher.rs`
  - legacy/stale blocked-task recovery
- `src-tauri/src/services/agent_runtime.rs`
- `src-tauri/src/services/role_runtime.rs`
  - only if small counting/validation adjustments are still needed after cleanup

### Frontend/mock layer

- `src/lib/tauri.ts`
- any frontend tests that assert assignment visibility or worker counts

## Validation matrix

### Rust/service coverage

Add or extend tests for:

1. **manual block of active role task**
   - task status becomes `blocked`
   - open assignment is removed
   - role queue entry is canceled
   - role instance no longer counts as running
2. **manual block of queued role task before startup**
   - queued assignment/queue entry are canceled before a session starts
3. **manual block of active agent task**
   - task assignment is removed
   - agent queue entry no longer counts as dispatched
   - `current_queue_entry_id` is cleared
4. **initially blocked task cannot dispatch**
   - `dispatch_task_lane()` rejects it
   - queue-source validity rejects it
5. **auto-blocked parent/dependent clears runtime claims**
   - not just the `add_task_dependency()` path
6. **legacy blocked open assignment is cleaned without unblocking the task**
   - recovery path preserves `status = blocked`
7. **unblocking restores normal dispatchability without stale reuse**
   - role path gets a fresh instance/session
   - agent path gets a fresh queue entry and cleared current slot

### Desktop E2E

Extend `tests/desktop-e2e/task-auto-dispatch-on-blocker-completion.test.ts` or add companion coverage for:

1. blocking an already active role task drops `activeLaneAssignment` and role capacity counts
2. blocking a queued role task before it starts leaves it with no session and no role claim
3. an initially blocked task with a role/agent lane never acquires a live assignment when dispatch is attempted
4. blocking an active agent task clears the task's active assignment and frees the agent queue slot
5. unblocking a task restores `readyForDispatch` and allows fresh dispatch/auto-dispatch

### Mock/frontend coverage

Add targeted tests for browser-mode task state so blocked tasks stop showing:

- active lane badges
- queued/dispatched worker counts
- task detail session metadata

## Notes for the implementation lane

- Do not solve this by merely hiding `activeLaneAssignment` in task queries or UI components. The bug is real capacity leakage in runtime/queue tables.
- Reuse the existing `auto_blocked_by_dependencies` provenance instead of inventing a second blocker provenance system.
- Treat agent and role cleanup differently: role sessions should retire; agent main sessions may persist, but the blocked task must release the agent's current work slot.
- Prefer one blocked-preserving cleanup helper over multiple bespoke code paths.
- After the fix, blocked tasks should be legible as blocked-but-not-running, not blocked-and-secretly-occupying-capacity.
