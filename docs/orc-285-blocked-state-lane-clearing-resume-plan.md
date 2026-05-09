# ORC-285 blocked-state lane clearing + resume plan

## tl;dr
Treat manual/operator `status = blocked` as a same-lane paused state, not as runtime/assignment deletion. Preserve `currentLaneId` plus the open lane assignment/session in a resumable paused form, wire `Resume` through the existing lane-reactivation path so blocked work returns to `in_progress`, and keep dependency-driven auto-blocking distinct so unresolved blockers still prevent dispatch and cannot be resumed prematurely.

## Executive summary
Current blocked behavior is split across three incompatible models:

- `docs/orc-15-blocked-task-runtime-capacity-plan.md` drove the command layer toward immediate blocked-task cleanup.
- `docs/orc-161-blocked-task-transition-plan.md` then shifted some runtime/service paths toward “keep running until transition time”.
- the UI requirement for this task is stricter than both: a blocked task should stay in its current lane, stop progressing while blocked, and expose a working `Resume` action that returns the same lane/session to `in_progress`.

The cleanest implementation is to reuse the existing paused-lane machinery instead of inventing a new blocked-runtime model. When a task is manually blocked while it has an open worker-owned assignment, Orchestra should pause that assignment in place, preserve the lane/session metadata, and leave the task itself in `status = blocked`. `resume_task_lane` can then reactivate the same assignment and session, while dependency-driven blocked tasks remain non-resumable until their blockers clear.

## Proposed implementation
- **Backend semantics split**
  - Treat **manual/operator blocked** tasks (`status = blocked` without unresolved dependency/child blockers) as resumable paused work.
  - Treat **dependency auto-blocked** tasks (`dependency_blocked` / `auto_blocked_by_dependencies`) as non-runnable blocked work that still waits for blocker resolution.
  - Do not introduce a new public task status; keep using `blocked` plus existing dependency provenance.

- **Pause-on-block instead of clear-on-block**
  - In the real backend, replace the blanket `cleanup_blocked_task_runtime_claims(...)` behavior for resumable blocked tasks.
  - Add a low-level helper in `src-tauri/src/services/task_runtime.rs` that pauses the current assignment/queue/runtime in place without moving the task to `in_review`:
    - assignment -> `paused_by_user`
    - pending outcome -> paused/cleared
    - role queue / agent queue -> `paused_by_user`
    - role instance / agent runtime -> waiting
    - live run -> aborted, but session/assignment ids preserved
    - task row -> stays `status = blocked`, keeps `current_lane_id`, keeps lane-owner metadata
  - Reuse as much of `pause_task_lane(...)` / `reactivate_task_lane_assignment(...)` as possible so pause/resume semantics stay aligned.

- **Resume behavior**
  - Extend `resume_task_lane(...)` / `reactivate_task_lane_assignment(...)` so blocked paused tasks are explicitly supported.
  - Resume should:
    - reject unresolved dependency-blocked tasks
    - set task status back to `in_progress`
    - reactivate the existing assignment/queue/runtime
    - resume the associated session follow-up flow exactly like today’s paused-lane resume path
  - This keeps the implementation on the existing `Resume` control path instead of creating a second blocked-only action.

- **Command-layer cleanup and recovery**
  - Narrow `src-tauri/src/commands/tasks.rs::cleanup_blocked_task_runtime_claims(...)` so it no longer destroys resumable blocked assignments.
  - Keep cleanup/cancel behavior for dependency-blocked or otherwise non-resumable blocked tasks.
  - Update stale-assignment / dispatcher recovery logic so a blocked paused assignment is not treated as stale solely because the task is blocked.
  - Normalize legacy `blocked + active assignment` data into the new paused form rather than preserving the old ORC-161 “keep running until transition” behavior.

- **UI / client behavior**
  - Reuse the existing `paused_by_user`-driven `Resume` header action by ensuring blocked resumable tasks still surface an open `activeLaneAssignment`.
  - Tighten copy in `TaskDetailPage.tsx` / action tooltips so blocked paused work reads as blocked/resumable, not merely “paused by user”.
  - Ensure task detail, task headers, and board placement continue to trust `currentLaneId` for blocked tasks.

- **Mock parity**
  - Update `src/lib/tauri.ts` so browser/mock mode matches Rust:
    - manual blocked active/queued task -> paused resumable assignment
    - blocked `Resume` -> same assignment/session back to `in_progress`
    - dependency auto-blocked task -> still non-dispatchable and non-resumable until blockers clear
  - Remove the current mock/service drift where some blocked paths stay fully active until transition time.

## Expected touch points
- `src-tauri/src/services/task_runtime.rs`
- `src-tauri/src/commands/tasks.rs`
- `src-tauri/src/services/dispatcher.rs` and/or stale-assignment recovery helpers
- `src/lib/tauri.ts`
- `src/pages/tasks/TaskDetailPage.tsx`
- `src/pages/tasks/taskDetailHeaderActions.ts`
- `src/lib/taskReviewState.ts` only if a small blocked-specific derivation tweak is needed
- `tests/blocked-task-runtime-mock.test.ts`
- `tests/task-detail-header-actions.test.ts`
- `tests/task-detail-action-state.test.ts`
- task-detail / tasks E2E coverage for blocked + resume flows
- Rust task runtime/command tests around blocked pause/resume

## Test plan
- **Rust / service / command tests**
  - blocking an active task preserves `current_lane_id` and leaves an open paused assignment
  - blocking a queued role task preserves the assignment in resumable paused form
  - `resume_task_lane` on a manually blocked task restores `in_progress` and the same session/assignment
  - dependency-blocked tasks still cannot resume or dispatch while blockers remain
  - clearing a dependency blocker still restores auto-blocked tasks to `ready`
  - stale recovery does not delete blocked paused assignments, but still cleans truly invalid blocked claims

- **Frontend / mock tests**
  - blocked task header/actions surface `Resume` when a paused assignment exists
  - blocked mock tasks resume the same session and return to `in_progress`
  - dependency-blocked mock tasks do not expose a resumable path prematurely

- **E2E / desktop coverage**
  - start active work, block it from task detail/edit flow, verify lane stays visible and `Resume` appears
  - click `Resume`, verify task returns to `in_progress` and the same session/runtime is resumed
  - verify dependency-blocked tasks remain blocked/non-dispatchable without a false `Resume`

## Notes for implementation lane
- Prefer reusing `paused_by_user` + existing resume machinery over adding new schema/status values.
- This task supersedes the old ORC-161 “keep blocked work running until transition” semantics for manual blocked tasks.
- Preserve the distinction between manual blocked and dependency auto-blocked behavior; `auto_blocked_by_dependencies` remains the key provenance bit.
- The highest-risk area is command-layer cleanup: if that still blanket-cancels all blocked tasks, the UI will never have enough assignment/session state to offer `Resume`.