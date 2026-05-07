# ORC-269 — Open Session from task anytime + reopen closed sessions plan

## tl;dr

- The current task-detail `Open session` affordance is wired only to `task.activeLaneAssignment?.sessionId`, so it disappears for completed/paused/history-only task states.
- The current mobile compact/floating-header Actions menu never includes `Open session`, even when the primary header does.
- `App.navigateToSession(...)` can load an exact session record, but it never reopens a closed task-bound session, so closed history lands in a read-only dead end.
- Fix by deriving a single **task open-session target** (`active assignment session` first, otherwise `latest lane-run session`), reopening that target when it is closed, and exposing the same action in the task-detail mobile floating-header menu.

## Executive summary

This feature should make `Open session` mean “take me to the most relevant usable session for this task,” not “open the session only if the current active assignment already has one.”

The intended behavior is:

1. If the task has a current assignment session, open that.
2. Otherwise, if the task has historical lane-run session history, open the most recent lane-run session.
3. If that target session is already active/messageable, navigate directly.
4. If that target session is closed history, explicitly reopen it first, then navigate into the usable session detail/chat state.
5. Show the same action everywhere task-detail actions are exposed, including the mobile floating-header hamburger menu.

## Current findings

### Frontend

- `src/pages/tasks/TaskDetailPage.tsx`
  - `activeSessionId` is derived only from `task.activeLaneAssignment?.sessionId`.
  - The desktop `Open session` button and the primary mobile action-menu entry are both gated on that single value.
  - The compact/floating mobile action menu is built from `compactHeaderActionMenuActions` only, so it omits `Open session` entirely.
- `src/App.tsx`
  - `navigateToSession(...)` sets the Sessions page/filter/selection and uses `pendingSessionOpenRequest` to fetch exact records if they are not already in memory.
  - That flow resolves missing sessions correctly, but it does not attempt `sessions.resume(...)` when the target record is closed/non-messageable.
- `src/components/SessionChatPanel.tsx`
  - Closed/non-messageable sessions intentionally render as read-only history, which is correct for untouched historical sessions but wrong for this reopen flow.

### Backend

- `src-tauri/src/commands/sessions.rs`
  - `resume_session(...)` restores dismissed visibility and ensures a runtime, but task-bound historical sessions still decorate as closed afterward.
- `src-tauri/src/services/session_list.rs`
  - `classify_session_visibility(...)` currently treats task-bound historical sessions as `Closed` whenever they do not have an active assignment, even if they were explicitly resumed.
- `src-tauri/src/commands/sessions.rs`
  - `decorate_session_record_with_connection(...)` then forces detail status/messageability into closed-history semantics for those task-bound sessions.

## Intended product semantics

### When the action should appear

Show `Open session` whenever the task has a meaningful target session:

1. `task.activeLaneAssignment.sessionId`, or
2. the most recent `task.laneRuns[*].sessionId`.

Hide it only when neither exists.

### Target-session selection

Use one deterministic rule everywhere:

1. Prefer `task.activeLaneAssignment.sessionId`.
2. Otherwise choose the latest lane-run session by task lane-run chronology (`task.laneRuns[task.laneRuns.length - 1]`, since task detail lane runs are loaded oldest→newest).

That gives the user the current live worker session when one exists, otherwise the most recent historical task session.

### Open vs reopen semantics

- **Open**: if the chosen target session is already active/messageable, just navigate to it.
- **Reopen**: if the chosen target session is closed history, resume that same session id first, then navigate.
- Reopening a task session should:
  - preserve the original transcript/session identity,
  - make the session detail usable immediately (composer enabled, transcript live),
  - not mutate the task’s workflow/lane outcome by itself.
- When a reopened historical session is later stopped/closed again, it should fall back to normal closed-history behavior.

## Implementation plan

1. **Introduce a shared task open-session target helper**
   - Add a small helper near task-detail/task utilities that returns:
     - `sessionId`
     - `projectId`
     - `source: "active_assignment" | "latest_lane_run"`
   - Use it for desktop header actions, primary mobile actions, and compact/floating mobile actions so all surfaces share the same availability rule.

2. **Add an app-level open-or-reopen flow**
   - Replace direct task-detail calls to `navigateToSession(sessionId, projectId)` with a helper that:
     - resolves the exact record if missing,
     - checks whether the target is closed/non-messageable,
     - calls `orchestraClient.sessions.resume(sessionId)` when reopen is required,
     - merges the returned record,
     - then navigates into Sessions detail with the correct filter/selection state.

3. **Make backend resume semantics truthful for task-bound history**
   - Update session resume/canonical-session handling so an explicitly resumed task-bound historical session comes back as active/messageable detail state instead of staying decorated as closed history.
   - Preserve the default closed/history classification for untouched historical task sessions.
   - Mirror the same behavior in `src/lib/tauri.ts` mock resume logic so browser tests exercise the real contract.

4. **Expose the action in the mobile floating-header menu**
   - Include the same `Open session` action in the compact/floating task-detail mobile Actions menu whenever the helper returns a target.
   - Keep ordering consistent with the primary mobile action menu.

## Regression coverage

Add/update coverage for:

- task detail shows `Open session` for an active assignment session
- task detail still shows `Open session` for a task with no active assignment but with historical lane-run session history
- closed historical task session is reopened before navigation and lands in a usable session detail state
- multiple lane-run history records choose the latest target session deterministically
- mobile primary Actions menu shows and opens the target session when appropriate
- mobile compact/floating-header Actions menu shows and opens the same target session when appropriate
- backend/mock resume semantics distinguish reopened task sessions from untouched closed history

## Files most likely involved

- `src/pages/tasks/TaskDetailPage.tsx`
- `src/pages/TasksPage.tsx`
- `src/App.tsx`
- `src/components/SessionChatPanel.tsx`
- `src/lib/tauri.ts`
- `src-tauri/src/commands/sessions.rs`
- `src-tauri/src/services/session_list.rs`
- `src-tauri/src/services/session_records.rs`
- `tests/e2e/tasks.spec.ts`
- session/backend regression tests around `resume_session` + task-bound historical session decoration
