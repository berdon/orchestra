# ORC-284 — Task-associated `New session` handoff plan

## tl;dr
The task/session rebinding path is already mostly correct, but the rotated task session still misses two important handoff semantics: the replacement worker session is not explicitly restarted with the lane prompt, and the client still relies on passive list reconciliation instead of explicitly retiring the superseded source session. Fix the backend rotation flow first, then add a real-model desktop e2e that proves the task follows the new session, the old session is closed, the UI switches, and the new worker transcript starts without manual input.

## Executive summary
Current `create_contextual_session()` behavior already does the hard canonical work for task-owned sessions:
- it creates a distinct successor session,
- rotates the open assignment to the new `session_id`,
- binds the replacement session back to the task/lane/worker context,
- closes and hides the superseded session.

The remaining gaps are in post-rotation behavior:
1. **Backend runtime restart gap** — after the replacement assignment is created, `create_contextual_session()` ensures the new runtime exists but never calls `task_runtime::start_assignment_run(...)`, so an active task lane can land on a fresh session that stays idle until some later manual/system resume path touches it.
2. **Frontend replacement-state gap** — the app now uses `pendingSessionOpenRequest`, but it still does not explicitly retire the source session locally when `New session` replaces it. A fast refresh can therefore preserve the superseded session long enough to interfere with visible selection/fallback state.

## Recommended implementation
### 1. Restart the active assignment on the replacement session
In `src-tauri/src/commands/sessions.rs`, after the new runtime is ensured for a rotated task session:
- resolve the replacement assignment for `prepared.new_session_id`,
- if it is still `active` and has a prompt, call `task_runtime::start_assignment_run(...)`,
- emit the same session/task refresh signals used for normal assignment starts.

This is the key change for “the new session starts immediately and prompts right away.”

### 2. Treat contextual task-session rotation as an explicit replacement in the client
In `src/App.tsx`:
- keep the existing `pendingSessionOpenRequest` successor selection,
- but also immediately retire the replaced source session in local state when `createContextual()` returns from a selected worker session,
- and avoid preserving that source session through the next list reconciliation pass.

This keeps the UI pinned to the successor even during refresh churn.

### 3. Add regression coverage around the exact task-owned flow
Add a desktop e2e regression using a real model and a role-owned task lane.

Suggested test shape:
- create a deterministic role/workflow/task,
- dispatch the task and capture the initial worker session id,
- open that worker session in the Sessions UI,
- click `New session`,
- assert:
  1. a different session id is selected,
  2. `get_task(...).activeLaneAssignment.sessionId` now equals the new id,
  3. `get_session_record(oldId)` is `closed` / hidden,
  4. the sessions UI is showing the new id,
  5. the new session transcript receives the worker’s initial prompt/response without any manual send.

A deterministic token-bearing role prompt is the cleanest way to verify immediate startup.

## Likely file touch list
- `src-tauri/src/commands/sessions.rs`
- `src/App.tsx`
- `tests/desktop-e2e/session-controls.test.ts` or a new focused task-session regression file
- optional supporting Rust/unit coverage if a small backend helper is introduced
