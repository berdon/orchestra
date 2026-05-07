# ORC-267 delayed task-worktree cleanup plan

## tl;dr

- Task worktrees are created from several runtime roots today, but nothing schedules their removal after task completion.
- Add durable task-level completion/cleanup timestamps, then run cleanup from the existing dispatcher loop so overdue worktrees are reconciled on startup and retried periodically while the app is running.
- Clean task workspaces by deriving the exact `.../tasks/<task-id>` roots from historical lane assignments, removing any git worktrees under those roots with `git worktree remove --force` plus `git worktree prune`, then deleting the leftover task workspace directory.
- Clear live runtime metadata that becomes stale (`role_instances.worktree_path`), but keep historical task/session/assignment records for audit.
- Test the 24-hour retention window, overdue cleanup, reopened-task preservation, and retry behavior on git/filesystem errors.

## Executive summary

The current task-worktree lifecycle is one-way: Orchestra materializes task-scoped repository worktrees when a lane dispatches, but completion only retires the assignment/session state. It does **not** schedule or perform delayed cleanup of the task workspace. As a result, completed-task worktrees accumulate indefinitely.

The cleanest implementation is to treat worktree cleanup as durable task lifecycle state, not as a best-effort side effect of the moment a task completes. Concretely:

1. persist when the task entered `completed`
2. persist when task-worktree cleanup becomes due (`completed_at + 24h`)
3. persist whether cleanup already succeeded and the last failure, if any
4. let the existing dispatcher loop process due cleanups on a periodic tick

That model gives us all of the required safety rules:

- no immediate deletion on completion
- automatic cleanup after the retention window
- no cleanup for non-completed or reopened tasks
- durable retry if cleanup fails because a worktree is still in use or git removal fails

## Current behavior audit

### Where task workspaces are created today

Task-scoped repository worktrees are created from these runtime paths:

- `src-tauri/src/services/task_runtime.rs::resolve_lane_workspace_cwd(...)`
- `src-tauri/src/services/task_runtime.rs::ensure_task_repository_workspaces(...)`
- `src-tauri/src/services/task_runtime.rs::ensure_task_repository_worktree(...)`
- `src-tauri/src/services/role_dispatch.rs::resolve_instance_runtime_cwd(...)`
- `src-tauri/src/services/task_repositories.rs`

Current path shapes:

1. **shared task workspace**
   - `<project-root>/task-workspaces/tasks/<task-id>`
   - repo worktrees under `repos/<repository-slug>`
2. **role separate-worktree lane**
   - `<project-root>/role-runtimes/<role-instance>/tasks/<task-id>`
   - repo worktrees under `repos/<repository-slug>`
3. **agent separate-worktree lane**
   - `<agent-runtime-cwd>/tasks/<task-id>`
   - today that runtime cwd is usually the project checkout root

The important common rule is that task-associated workspace roots end at `.../tasks/<task-id>` even when their parent runtime root differs.

### What happens on completion today

Completion flows through:

- `src-tauri/src/services/task_runtime.rs::complete_lane(...)`
- `src-tauri/src/services/task_runtime.rs::finalize_worker_assignment(...)`
- `src-tauri/src/services/task_runtime.rs::transition_task_after_completion(...)`
- `src-tauri/src/services/task_runtime.rs::approve_task_review(...)`

Current completion behavior:

- marks the lane assignment terminal
- closes or archives the session list entry
- updates task status/lane ownership
- releases role instances / resets agent dispatch state

What it does **not** do:

- schedule a delayed task-worktree cleanup
- remove per-repository git worktrees under the task workspace
- delete the task workspace directory 24 hours later
- clear stale `role_instances.worktree_path` pointers after the workspace is eventually gone

### Existing cleanup helpers are not sufficient

`src-tauri/src/services/git_worktrees.rs` already has helpers for disposable runtime worktrees, but they are not wired into completed-task workspace cleanup.

Also, `role_dispatch::release_role_instance(...)` intentionally leaves completed role-instance worktrees inspectable. That matches the current runtime policy, but it means task-owned workspaces persist until something explicitly disposes them.

## Cleanup scope

### Filesystem scope to remove

For each completed task, cleanup should remove every task workspace root that was actually materialized for that task, including:

- shared task workspaces under `task-workspaces/tasks/<task-id>`
- role separate-worktree task directories under `role-runtimes/.../tasks/<task-id>`
- agent separate-worktree task directories under `<agent-runtime>/tasks/<task-id>`
- all repo worktrees inside each workspace root under `repos/*`
- any non-git generated files left inside that task workspace root

### Git metadata scope to remove

Cleanup must also remove the matching git worktree registrations from the owning repositories, not just the directories on disk.

The safe rule is:

- discover worktrees whose paths live under the candidate task workspace root
- remove them with `git worktree remove --force <path>`
- run `git worktree prune --expire now` on the owning repository afterward

That prevents stale `.git/worktrees/...` metadata from surviving after filesystem deletion.

### Runtime/worktree metadata to clear

Clear operational metadata that would otherwise point at deleted paths:

- `role_instances.worktree_path` when it points inside a cleaned task workspace root

Keep historical metadata for audit/history:

- `task_lane_assignments.runtime_cwd`
- lane runs
- session records/transcripts
- task repository associations

Those are history, not live cleanup ownership, and keeping them preserves provenance even after the worktree no longer exists.

## Proposed implementation

### 1. Persist task completion and cleanup schedule state

Extend `tasks` with durable cleanup state, for example:

- `completed_at TEXT`
- `worktree_cleanup_due_at TEXT`
- `worktree_cleanup_completed_at TEXT`
- `worktree_cleanup_last_error TEXT`

Recommended semantics:

- when a task enters `completed`
  - `completed_at = now`
  - `worktree_cleanup_due_at = now + 24h`
  - `worktree_cleanup_completed_at = NULL`
  - `worktree_cleanup_last_error = NULL`
- while a task remains completed for later edits/comments
  - do **not** rewrite `completed_at`
  - keep the original cleanup due time
- when a task leaves `completed` (reopen / re-lane / manual status edit)
  - clear all cleanup state
- when cleanup succeeds
  - set `worktree_cleanup_completed_at = now`
  - clear `worktree_cleanup_due_at` and `worktree_cleanup_last_error`
- when cleanup fails
  - keep the task eligible for retry
  - store the latest error
  - push `worktree_cleanup_due_at` forward by a retry delay (for example 1 hour)

Why task-level state instead of an ad hoc best-effort hook:

- it survives app restarts
- it cleanly handles reopened tasks
- it gives a simple due-work query for the dispatcher
- it avoids repeatedly re-cleaning already-processed tasks

### 2. Backfill existing completed tasks in migration

Database migration should backfill cleanup state for already-completed tasks so the feature applies to old data too.

Backfill rule:

1. prefer the latest terminal `task_lane_assignments.completed_at`
2. fallback to the latest terminal `task_lane_runs.completed_at`
3. fallback to `tasks.updated_at`
4. set `worktree_cleanup_due_at = completed_at + 24h`

This gives overdue legacy tasks a path into the new sweeper without requiring a one-off manual repair command.

### 3. Add a dedicated task-worktree cleanup service

Add a focused backend service, e.g. `src-tauri/src/services/task_worktree_cleanup.rs`, responsible for:

- listing due cleanup candidates
- deriving candidate task workspace roots
- removing git worktrees safely
- deleting leftover task workspace directories
- clearing stale role-instance worktree pointers
- updating task cleanup state

Keeping this out of `task_runtime.rs` will make testing and retry logic much easier.

### 4. Derive candidate workspace roots from historical assignments

Do **not** assume a single fixed root pattern.

Instead, for each task, load historical `task_lane_assignments` with a non-null `runtime_cwd` and resolve the actual task workspace root using the same lane/workspace rules already used at dispatch time (`resolve_assignment_workspace_cwd(...)`).

Then:

- dedupe the resolved roots
- keep only roots that normalize to a `.../tasks/<task-id>` suffix
- skip anything that fails that safety check

This matters because the same task may have used:

- the shared task-workspaces root in one lane
- a separate role runtime root in another lane
- a reopened run after prior cleanup

### 5. Remove git worktrees before deleting directories

For each candidate task workspace root:

1. enumerate the project’s managed repositories
2. for each repository, inspect `git worktree list --porcelain`
3. select any worktree whose path falls under the candidate task workspace root
4. run `git worktree remove --force <path>`
5. run `git worktree prune --expire now`
6. after git registrations are removed, delete the leftover task workspace root with filesystem cleanup
7. prune empty parent containers when safe (for example an empty `tasks/` directory under a role runtime root)

Why enumerate real git worktree registrations instead of trusting current task repo links alone:

- repository associations may have changed after the workspace was materialized
- a task may have stale repo worktrees under `repos/*` that no longer match the current task repository list
- the git worktree registry is the authoritative source for cleanup semantics

### 6. Clear stale runtime pointers only after successful cleanup

After a workspace root is fully cleaned, clear any matching `role_instances.worktree_path` values that point inside that root.

That prevents the runtime/operations UI from holding a live-looking path to a deleted directory.

Do **not** clear historical assignment/session cwd fields; those are audit history.

### 7. Run cleanup from the dispatcher loop

Use the existing dispatcher loop as the durable execution mechanism.

Recommended hook:

- add a new `process_due_task_worktree_cleanups(...)` step in `src-tauri/src/services/dispatcher.rs`

Why this is the right trigger model:

- the dispatcher already runs periodically in the background
- it already acts as the app’s maintenance/sweeper loop
- it starts on app startup, so overdue cleanups reconcile automatically after restart
- tests can drive it deterministically via `run_dispatcher_tick`

This gives both:

- **periodic maintenance pass** while the app is running
- **startup reconciliation** on the first tick after startup

No separate long-lived daemon is required.

## Eligibility and safety rules

Cleanup is eligible only when all of the following are true:

- `tasks.status == 'completed'`
- `worktree_cleanup_completed_at IS NULL`
- `worktree_cleanup_due_at <= now`
- there is no active/current worker-owned assignment still in a non-terminal state for the task

Cleanup must not run for tasks that are:

- not completed
- completed but still inside the 24-hour retention window
- reopened or otherwise moved out of `completed`
- paused for approval/intervention and not yet actually completed

### Reopened task behavior

If a task is reopened before cleanup runs:

- clear the cleanup schedule state
- preserve the existing worktree
- let later dispatch reuse or recreate the task workspace normally

If a task is reopened after cleanup already succeeded:

- no restoration step is needed
- the next dispatch will recreate the task workspace/worktrees from the usual runtime materialization path

## Failure and retry behavior

### Missing paths

If the task workspace root is already missing:

- treat filesystem deletion as idempotent success
- still run git `worktree prune` on project repositories so stale metadata is cleared
- mark cleanup completed if nothing remains to remove

### Files in use / git removal failure

If `git worktree remove` or filesystem deletion fails:

- do **not** fall back to raw `rm -rf` on repo worktree directories first
- record the error on the task cleanup state
- leave cleanup incomplete
- reschedule a retry for a later dispatcher tick

This keeps cleanup safe and eventually consistent instead of forcing deletion and risking broken git metadata.

### Partial success

If some repo worktrees are removed and others fail:

- leave the task in retryable cleanup state
- on the next retry, already-removed paths should be treated as harmless/idempotent
- only mark the task fully cleaned once all candidate workspace roots are done

## Recommended tests

### Rust/backend tests

Add focused coverage for:

1. **completed task is retained before 24 hours**
   - task enters `completed`
   - cleanup tick before due time does nothing
2. **cleanup runs after threshold**
   - advance timestamps beyond 24 hours
   - dispatcher cleanup removes repo worktrees and the task workspace root
   - task cleanup state is marked completed
3. **non-completed task is preserved**
   - ready / in_progress / blocked / in_review tasks are ignored
4. **reopened task is preserved**
   - task completes, gets a cleanup due time, then reopens before due
   - cleanup state clears and worktree remains
5. **missing path is treated as idempotent success**
   - delete the task workspace manually before the sweeper runs
   - cleanup still clears git metadata/prunes and marks success
6. **git removal failure retries**
   - simulate a failing `git worktree remove` / directory removal
   - verify last error is stored and due time is pushed forward
   - verify a later retry can succeed
7. **multiple workspace roots for one task**
   - same task has historical shared + separate runtime roots
   - cleanup removes both safely
8. **role instance metadata is cleared**
   - `role_instances.worktree_path` is nulled after successful cleanup

### Desktop/E2E coverage

Desktop E2E is optional for the full 24-hour wall-clock lifecycle, but one targeted regression would be valuable if practical:

- create a task with a real task workspace
- force cleanup state due immediately through commands/fixtures
- run `run_dispatcher_tick`
- verify the workspace disappears and the task remains completed

The core correctness should live in Rust tests, because that is where git/filesystem behavior exists.

## Files likely involved

- `src-tauri/src/services/database.rs`
- `src-tauri/src/services/tasks.rs`
- `src-tauri/src/services/task_runtime.rs`
- `src-tauri/src/services/task_repositories.rs`
- `src-tauri/src/services/dispatcher.rs`
- `src-tauri/src/services/role_dispatch.rs`
- `src-tauri/src/services/git_worktrees.rs`
- new `src-tauri/src/services/task_worktree_cleanup.rs`
- related Rust tests in `task_runtime.rs` and/or the new cleanup service

Mock/browser parity in `src/lib/tauri.ts` should only change if any of the new task cleanup timestamps become part of the public task model. The actual cleanup behavior is backend-specific because browser mock mode does not own real git worktrees.

## Non-goals for this task

- changing session archive/list behavior beyond the already-landed worker-session cleanup work
- cleaning canceled-task worktrees; this task should stay scoped to `completed`
- deleting historical task/session/assignment records
- redesigning role-instance disposal semantics outside of completed-task cleanup
