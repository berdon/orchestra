# ORC-9 user-authority task review and session-control plan

## Problem summary

Orchestra already has **partial** support for user review actions, but the support is fragmented and the semantics are still too implicit for a coherent operator/agent tool surface.

Today:

- `src-tauri/src/commands/tasks.rs` already exposes desktop-only Tauri commands for:
  - `approve_lane_completion`
  - `send_lane_back_for_work`
- `src-tauri/src/services/remote_api.rs` already exposes paired-device routes for:
  - `POST /api/v1/tasks/:task_id/approve`
  - `POST /api/v1/tasks/:task_id/needs-work`
- `src/pages/TasksPage.tsx` / `src/pages/tasks/TaskDetailPage.tsx` already render **Approve**, **Needs work**, and **Resume** actions for some paused review states.
- `src/pages/TasksPage.tsx` currently labels a task action as **Pause**, but it actually calls `stopSessionRuntime(sessionId)`.

The orchestration/tool surface does **not** line up with that product behavior:

- `src-tauri/src/services/tool_bridge.rs` does not expose any of the existing review/session-control commands through the bridge command list.
- `src-tauri/src/services/command_authorization.rs` does not list those commands in the Orchestra tool manifest, so `orchestra_help` cannot surface them.
- The current permission model only has coarse grants like `tasks.transition` and `sessions.read`; there is no narrow permission split for user-authority review/control actions.
- `send_lane_back_for_work` currently conflates two different user intents:
  - **Needs work** after approval review
  - **Resume** after user intervention
- There is no first-class task-scoped **pause** action with resumable task semantics.
- There is no first-class task-scoped **stop current work/session** action with explicit behavior for active workers, idle paused sessions, and queued role work.
- Audit/history does not clearly expose that these actions were taken **as user-authority actions** rather than worker lane completions.

## Design goals

1. Expose explicit user-authority review/control actions through the same operational surface as the rest of Orchestra tools.
2. Keep user-authority actions clearly distinct from worker-authority lane completion tools.
3. Define a permission model that is more specific than `tasks.transition`.
4. Make pause vs resume vs stop semantics explicit and testable.
5. Ensure every surface (desktop UI, bridge/tools, remote API, mobile) reuses the same backend action layer.
6. Record durable audit/history data that shows the action, the actor, and that it was taken on behalf of a user.

## Proposed command/tool model

Add a dedicated user-authority action layer with explicit verbs.

### New explicit commands/tools

#### Review actions

- `approve_task_review(taskId)`
  - Valid only when the current lane assignment is paused in `awaiting_user_approval`.
  - Finalizes the pending success outcome and advances the workflow.

- `mark_task_needs_work(taskId, notes?)`
  - Valid only when the current lane assignment is paused in `awaiting_user_approval`.
  - Reactivates the same lane/session for rework.
  - Distinct from re-laning because it stays on the same lane and keeps the same assignment/session when possible.

#### Control actions

- `resume_task_lane(taskId, notes?)`
  - Valid when the current lane assignment is paused in:
    - `awaiting_user_intervention`
    - new `paused_by_user`
  - Reactivates the same lane/session for continued work.
  - Does **not** imply approval or rejection.

- `pause_task_lane(taskId, notes?)`
  - Valid when the current worker-owned lane assignment is `active` or `queued`.
  - Moves the assignment into a resumable paused state under user authority.

- `stop_task_activity(taskId, notes?)`
  - Valid when the task has queued or active worker-owned runtime/activity, including review-paused work with an attached session.
  - Cancels the current assignment/activity and returns the task to a redispatchable state on the same lane.
  - If a live session exists, it is stopped/retired as part of the action.

#### Session action surfaced explicitly

- `stop_session_runtime(sessionId, notes?)`
  - Expose the existing session stop command through the Orchestra operational surface.
  - Keep this session-scoped and separate from task-scoped stop semantics.

## Backward compatibility

Keep the existing desktop-facing commands as compatibility shims during migration:

- `approve_lane_completion` → delegate to `approve_task_review`
- `send_lane_back_for_work` → delegate to:
  - `mark_task_needs_work` when status is `awaiting_user_approval`
  - `resume_task_lane` when status is `awaiting_user_intervention`

That avoids breaking current UI code immediately while letting the new operational surface use explicit names.

## Permission model

The current `tasks.transition` grant is too broad for these actions.

### Add new permissions

- `tasks.review`
  - approve a review-paused lane
  - reject a review-paused lane as needs work

- `tasks.control`
  - pause active/queued task work
  - resume paused task work
  - stop current task activity and reset it to the same-lane ready state

- `sessions.stop`
  - stop a specific Orchestra session runtime

### Keep existing permissions for their current jobs

- `tasks.transition`
  - worker lane completion tools (`complete_lane_as_success`, `complete_lane_as_failure`, `request_user_intervention`)
  - explicit workflow movement (`dispatch_task_lane`, `reassign_task_to_lane`)

### Why this split matters

This prevents over-broad grants such as:

- granting an operator the ability to fully complete or re-lane tasks just because they should be allowed to approve review output
- granting raw session control via `sessions.read`
- conflating worker authority with user authority

## Shared backend action layer

Introduce a shared backend layer for user-authority task/session actions so desktop commands, bridge commands, remote API routes, and any channel/mobile surfaces all call the same code.

Suggested shape:

- `src-tauri/src/services/task_runtime.rs`
  - add explicit helpers for:
    - `approve_task_review`
    - `mark_task_needs_work`
    - `resume_task_lane`
    - `pause_task_lane`
    - `stop_task_activity`
- optionally add a small supporting context struct, for example:
  - `UserAuthorityActionContext { actor_type, actor_id, actor_label, authority_source, on_behalf_of_user }`

That context should flow into audit/domain event payloads so the resulting history can say **who** initiated the action and **which authority model** it used.

## State model and semantics

### Existing review states to preserve

Keep the current review pause states for worker-driven user handoffs:

- `awaiting_user_approval`
- `awaiting_user_intervention`

These already model “worker paused and user now owns the next decision.”

### New paused-by-user state

Add a dedicated assignment status for an explicit manual pause:

- `paused_by_user`

This separates:

- a worker asking for user input (`awaiting_user_intervention`)
- a success awaiting user sign-off (`awaiting_user_approval`)
- a user/operator manually pausing active work (`paused_by_user`)

### Suggested per-action semantics

| Action | Valid from | Assignment result | Task result | Session/queue result |
| --- | --- | --- | --- | --- |
| `approve_task_review` | `awaiting_user_approval` | finalize as success | workflow advances normally | retire/continue according to transition |
| `mark_task_needs_work` | `awaiting_user_approval` | same assignment reactivated | `in_progress`, same lane | same session resumed when possible |
| `resume_task_lane` | `awaiting_user_intervention`, `paused_by_user` | same assignment reactivated | `in_progress`, same lane | same session resumed when possible |
| `pause_task_lane` | `active`, `queued` | mark `paused_by_user` | `in_review`, current lane remains active for user decision | running runtime paused; queued role work held |
| `stop_task_activity` | `queued`, `active`, `awaiting_user_*`, `paused_by_user` | current assignment canceled | `ready` on same lane for fresh dispatch | runtime stopped if present; queued work canceled |
| `stop_session_runtime` | any session with a live runtime | no direct task transition by itself | session-only effect unless task wrapper also used | runtime aborted and session marked stopped/paused |

## Lane run semantics

### Pause / resume

- Do **not** close the current lane run when pausing.
- Resume should continue the same open lane run.
- This mirrors the current approval/intervention pause behavior.

### Needs work after review

- Keep the lane run open.
- Treat the review rejection as a user review event, not as a failed lane completion.
- The worker remains on the same lane and must complete it later.

### Stop task activity

- If the current lane run already exists and is still open, close it as `canceled` with user-action notes.
- If work was only queued and no session/lane run started yet, cancel the queue/assignment without inventing a fake completed run.

This is the cleanest way to make stop semantics visible in history without pretending the lane completed successfully or failed semantically.

## Queue/runtime behavior

### Active lane worker

`pause_task_lane`:

- abort the active runtime run if one is in flight
- move the assignment to `paused_by_user`
- mark any role instance as waiting/idle for user response
- keep the session record linked so the same session can resume later when appropriate

`stop_task_activity`:

- abort active runtime
- cancel the current assignment
- cancel or detach the active role instance / agent runtime link
- return task to `ready` on the same lane

### Idle review-paused session

`stop_task_activity` must also work when the worker session is idle but still attached to a paused assignment:

- cancel the paused assignment
- stop/retire the idle session
- return the task to the same-lane ready state

### Queued role work

`pause_task_lane` on queued work:

- hold the assignment before dispatch
- cancel or pause the queue entry instead of waiting for a session to exist

`stop_task_activity` on queued work:

- cancel the queue entry
- cancel the assignment
- leave the task ready for a future fresh dispatch

This directly addresses the task requirement that stop behavior be well-defined even when no live session exists yet.

## Audit and history plan

The new actions should not only log to runtime logs; they should also show up in durable task/session history.

### Record domain events for each action

Add dedicated topics such as:

- `task.review_approved`
- `task.review_needs_work`
- `task.control_paused`
- `task.control_resumed`
- `task.control_stopped`
- `session.stopped_by_user`

Payload should include at minimum:

- `taskId`
- `assignmentId`
- `sessionId`
- `laneId`
- `actorType`
- `actorId`
- `actorLabel`
- `authoritySource`
- `onBehalfOfUser: true`
- `notes`
- previous and next statuses when relevant

### Surface those events in task history

Extend task detail history so these events are visible to reviewers/operators.

Suggested path:

- add recent task domain events to `TaskDetail`
- render user-authority review/control events in the task timeline alongside comments, lane runs, attachments, and dependencies

This is important because the current task timeline does not show domain events yet, and the acceptance bar here explicitly calls for audit/history visibility.

## Transport/surface changes

### Orchestra tool bridge / agent tool manifest

Update:

- `src-tauri/src/services/tool_bridge.rs`
- `src-tauri/src/services/command_authorization.rs`

Add the new commands to:

- the bridge-supported command list
- the Orchestra tool manifest returned by `list_orchestra_tools` / `orchestra_help`

Required permissions:

- review tools → `tasks.review`
- task control tools → `tasks.control`
- raw session stop → `sessions.stop`

### Tauri desktop commands

Add first-class command entry points in:

- `src-tauri/src/commands/tasks.rs`
- `src-tauri/src/commands/sessions.rs`

Desktop UI should call the new explicit commands rather than overloading `send_lane_back_for_work` and `stop_session_runtime` for task semantics.

### Remote API

Extend `src-tauri/src/services/remote_api.rs` with paired-user routes such as:

- `POST /api/v1/tasks/:task_id/resume`
- `POST /api/v1/tasks/:task_id/pause`
- `POST /api/v1/tasks/:task_id/stop-activity`
- optionally `POST /api/v1/sessions/:session_id/stop`

Keep existing `/approve` and `/needs-work` routes, but route them through the same shared backend action helpers.

### Mobile client

Update:

- `mobile/src/api.ts`
- `mobile/App.tsx`

So mobile can show the same explicit actions the desktop task detail can show.

## UI/UX changes

### Task detail actions

Replace the current implicit/overloaded behavior with explicit buttons:

#### When `awaiting_user_approval`

- **Approve** → `approve_task_review`
- **Needs work** → `mark_task_needs_work`
- optionally **Stop** → `stop_task_activity`

#### When `awaiting_user_intervention`

- **Resume** → `resume_task_lane`
- **Stop** → `stop_task_activity`
- re-lane remains available as a separate workflow move

#### When `paused_by_user`

- **Resume** → `resume_task_lane`
- **Stop** → `stop_task_activity`

#### When `active` or `queued`

- **Pause** → `pause_task_lane`
- **Stop** → `stop_task_activity`

### Important copy changes

The current desktop UI labels a task action as **Pause** while calling raw session stop. That should be corrected.

The new copy should explain:

- **Pause** = hold the current lane and resume it later
- **Stop** = end the current assignment/session and return the task to a same-lane ready state
- **Needs work** = reject review output and keep the worker on the same lane
- **Re-lane** = move the task to a different lane entirely

### Access editor

Update `src/lib/access.ts` and related access editor UI to add labels/descriptions for:

- `tasks.review`
- `tasks.control`
- `sessions.stop`

## Tests

### Rust/service tests

Add/extend unit coverage in `src-tauri/src/services/task_runtime.rs` for:

1. review approval only works from `awaiting_user_approval`
2. needs-work only works from `awaiting_user_approval`
3. resume only works from `awaiting_user_intervention` or `paused_by_user`
4. pause transitions active/queued work into `paused_by_user`
5. stop cancels active worker assignments and returns the task to same-lane `ready`
6. stop cancels queued role work cleanly
7. stop on an idle paused session also returns the task to same-lane `ready`
8. lane runs/domain events record the correct canceled/resumed behavior

### Bridge/authorization tests

Add coverage that:

- tools appear in `orchestra_help` / bridge manifests only when the actor has the new permission
- `tasks.transition` alone does **not** expose review/control tools
- `tasks.review` exposes approval + needs-work but not pause/stop
- `tasks.control` exposes pause/resume/stop-task-activity but not approval
- `sessions.stop` exposes raw session stop only

### Desktop/UI tests

Extend desktop coverage around:

- approval-paused lanes
- intervention-paused lanes
- explicit manual pause/resume
- explicit stop from:
  - active worker session
  - paused idle review session
  - queued role work
- task detail header buttons showing the correct action sets
- task timeline/history entries showing the user-authority action and actor/source

### Remote/mobile tests

Add remote API/mobile coverage for:

- pause
- resume
- stop task activity
- raw session stop if surfaced remotely

## Files likely to change

- `src-tauri/src/services/task_runtime.rs`
- `src-tauri/src/commands/tasks.rs`
- `src-tauri/src/commands/sessions.rs`
- `src-tauri/src/services/tool_bridge.rs`
- `src-tauri/src/services/command_authorization.rs`
- `src-tauri/src/services/remote_api.rs`
- `src-tauri/src/services/domain_events.rs`
- `src-tauri/src/services/tasks.rs`
- `src-tauri/src/models.rs`
- `src/lib/tauri.ts`
- `src/lib/access.ts`
- `src/pages/TasksPage.tsx`
- `src/pages/tasks/TaskDetailPage.tsx`
- `mobile/src/api.ts`
- `mobile/App.tsx`
- desktop/e2e and Rust tests covering review/control behavior

## Recommended implementation order

1. Introduce the new permissions and tool manifest entries.
2. Add explicit backend helpers for review/control actions.
3. Add the new `paused_by_user` state and stop-task-activity behavior.
4. Wire new Tauri commands and keep old command names as aliases where needed.
5. Wire the bridge/orchestra tool surface.
6. Add remote API + mobile endpoints/actions.
7. Update desktop UI buttons/copy.
8. Add audit/domain event plumbing and task timeline rendering.
9. Land tests for service behavior, permissions, bridge exposure, desktop flows, and remote/mobile flows.

## Handoff notes

The most important architectural decision is to avoid treating these actions as “more task transitions.” They are **user-authority review/control actions** with different semantics, different permissions, and different audit expectations.

If implementation keeps that boundary clear, the resulting system will satisfy the review guidance:

- it will not conflate approval with ordinary lane completion
- it will not over-broaden permissions via `tasks.transition`
- it will define reliable pause/resume/stop behavior for live sessions and queued work
- it will expose the actions through the same operational surface as the rest of Orchestra’s tools
