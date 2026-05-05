# ORC-243 re-lane note comment persistence plan

## tl;dr
- The re-lane note is currently passed through the UI and backend, but it is only written into lane-run / assignment metadata, not into `task_comments`.
- Fix the shared reassign service path so a non-empty note first creates a durable system task comment, then performs the lane move.
- Keep the existing lane-run note writes for continuity, but make the task comment the visible audit trail.
- Update the mock re-lane path so UI/e2e behavior matches the real backend.
- Add one backend regression test for comment creation + move ordering and one UI/mock regression that proves the note appears in comments/activity after re-laning.

## Executive summary
The current re-lane flow already captures the operator’s note from the task-detail confirmation dialog and forwards it through the client into the shared `reassign_task_to_lane` backend path. The note is not actually dropped at input time; it is only persisted into `task_lane_runs.notes` and assignment `completion_notes`, so it never becomes a durable task comment and does not show up in the task’s comment trail.

The lowest-risk fix is to change the shared reassign service implementation in `src-tauri/src/services/task_runtime.rs` so that, when `notes` normalizes to a non-empty string, it first creates a system-authored task comment via `tasks::add_task_comment(...)`, then continues the existing assignment finalization and lane-move flow. Because the Tauri command, remote API route, and Orchestra tool bridge already converge on that shared service helper, one backend change fixes all real re-lane entry points. The mock path in `src/lib/tauri.ts` needs the same behavior added so frontend/e2e coverage reflects production semantics.

## Current-state findings
- `src/pages/tasks/TaskDetailPage.tsx` collects the re-lane note in the confirm dialog and calls `onRelane(relaneConfirmTarget.id, relaneNotes.trim() || undefined)`.
- `src/pages/TasksPage.tsx` forwards that note via `orchestraClient.tasks.reassign(route.taskId, targetLaneId, notes)`.
- Real app transports then fan into the same backend action:
  - desktop Tauri: `src/lib/orchestraClient/tauriBindings.ts`
  - remote API: `src/lib/orchestraClient/remoteApiClient.ts` → `POST /api/v1/tasks/:task_id/reassign`
  - Orchestra tool path: `src-tauri/src/services/tool_bridge.rs` → `reassign_task_to_lane`
- All real entry points converge on `src-tauri/src/services/task_runtime.rs::reassign_task_to_lane(...)`.
- That shared service normalizes `notes`, then uses it only in:
  - `update_open_lane_run(...)`
  - `finalize_worker_assignment(...)`
  - `cancel_queued_assignment_for_relane(...)`
- The service never calls `tasks::add_task_comment(...)`, so `task.comments` remains unchanged after a re-lane.
- The mock implementation in `src/lib/tauri.ts::reassignMockTaskToLane(...)` mirrors the same bug: it updates `laneRuns` / `completionNotes` and emits a domain event, but it never appends a task comment.
- UI consequence today:
  - the Comments tab is sourced from `task.comments`, so the note never appears there
  - the Timeline tab merges comments + lane runs, but lane-run timeline items do not render `laneRun.notes`
  - the History tab can show raw lane-run notes, but that is not the durable task comment trail the task asks for

## Root cause
The re-lane note is treated as lane-transition metadata instead of task-comment data. The shared reassign logic persists the note onto runtime/lane bookkeeping records, but there is no explicit comment creation step before the task is moved.

## Recommended implementation

### 1. Persist the note in the shared real backend path
In `src-tauri/src/services/task_runtime.rs`:
- keep `normalize_optional(notes)` as the gate for whether any note exists
- if a normalized note is present, call `tasks::add_task_comment(...)` before assignment finalization or `move_task_to_specific_lane(...)`
- author the comment as a system comment, e.g.:
  - `author: "Orchestra"`
  - `origin_type: Some("system")`
  - message format: `Re-lane note for move to <lane name>:\n\n<note>`
- then continue the existing re-lane flow unchanged
- keep writing the note into lane-run / completion metadata as today so the History tab and runtime bookkeeping do not regress

This makes the task comment the durable audit record while preserving existing lane-history behavior.

### 2. Define the no-note behavior explicitly
- If `notes` is `None`, empty, or whitespace-only after normalization, do not create any task comment.
- Continue re-laning exactly as today for the no-note case.

### 3. Preserve ordering semantics deliberately
- The comment creation must happen in code before `move_task_to_specific_lane(...)`.
- The backend regression should assert both facts:
  - the task comment exists when a note is supplied
  - the task has already moved afterward
- Do not split behavior across multiple entry points; keeping the change inside the shared service guarantees the tool bridge, remote API, and desktop UI all preserve the same ordering.

### 4. Update mock parity for frontend coverage
In `src/lib/tauri.ts::reassignMockTaskToLane(...)`:
- when `notes?.trim()` is non-empty, append a system task comment before saving the re-laned task state
- reuse the same message shape as the real backend so task-detail comments/timeline assertions stay consistent across mock and production
- skip comment creation for empty notes

### 5. Add regression coverage in the two places that matter
1. **Real backend unit coverage** in `src-tauri/src/services/task_runtime.rs`
   - start from a dispatched or approval-paused task
   - reassign with a note
   - assert:
     - `current_lane_id` changed to the requested lane
     - a task comment was created with the note text
     - the comment author/origin are the expected system values
     - reassigning without a note creates no extra comment
2. **UI/mock regression** in `tests/e2e/tasks.spec.ts`
   - extend the existing re-lane task-detail flow
   - after submitting the re-lane dialog with notes, assert:
     - the task moved to the requested lane
     - the task comments UI contains the re-lane note
     - the activity/timeline surface also shows the note via the new comment-backed entry
   - add or extend a no-note re-lane assertion so the mock task remains comment-count stable when the dialog is confirmed without text

## Validation
- Backend: run targeted Rust task-runtime tests covering re-lane behavior.
- Frontend: run the targeted task-detail re-lane Playwright coverage in `tests/e2e/tasks.spec.ts`.

## Non-goals
- Do not redesign general task audit/history rendering beyond what naturally changes once a real task comment exists.
- Do not remove current lane-run note persistence unless follow-up work explicitly wants to deduplicate history surfaces.
- Do not broaden this into a full transition-comment framework for every lane action.