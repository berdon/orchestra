# ORC-280 — Fix active session selection after `New session` and enforce one current task-linked session plan

## tl;dr
The backend already records session replacement correctly: `New session` rotates the task/worker binding to a new session, marks the old session superseded/closed, and hides it from normal lists. The bug is primarily in frontend session-state reconciliation: after rotation, the old selected session can be preserved in local state and continue to win selection/fallback logic even though the backend has already replaced it. Fix this by treating `New session` as a replacement flow, not a generic session create, and by using successor lineage to prevent superseded sessions from surviving active-list selection.

## Executive summary
- Session lineage **already exists** in the canonical `sessions` table via `supersedes_session_id` and `superseded_by_session_id`.
- For task-linked worker sessions, `create_contextual_session()` already rotates the open assignment to the new `session_id`, so the backend’s canonical task→session association is already singular.
- The old session is marked `lifecycle_state = 'superseded'`, gets `closed_at`, and is hidden from normal lists with hidden reason `superseded`.
- The UI problem is that `src/App.tsx` still handles `New session` like a generic add/merge. `reconcileListedSessions()` can preserve the now-missing old session in local state, and selection/fallback logic can remain pinned to that stale entry.
- Recommended fix: make successor selection explicit in the frontend, optimistically retire the rotated-from session locally, and surface/use successor lineage so refresh races and cross-surface recovery always resolve to the live replacement session.

## Findings / answers to the investigation questions

### 1. Do we track session lineage?
Yes.

Canonical storage already includes:
- `sessions.supersedes_session_id`
- `sessions.superseded_by_session_id`

Relevant code:
- `src-tauri/src/services/database.rs`
- `src-tauri/src/services/session_records.rs::rotate_session_record()`

`rotate_session_record()` creates the new canonical session row, writes the successor link on the new row, and rewrites the old row as superseded.

### 2. When `New session` is called, do we mark the previous session closed?
Yes.

For rotated sessions, the old canonical row is rewritten with:
- `lifecycle_state = 'superseded'`
- `superseded_by_session_id = <new session id>`
- `closed_at = <timestamp>`
- `archived_at = <timestamp>`
- hidden reason `superseded`

Relevant code:
- `src-tauri/src/services/session_records.rs::rotate_session_record()`
- `src-tauri/src/services/session_list.rs`

Separately, normal close/archive flows use `close_session_context()` / `close_active_assignment_session()`.

### 3. Is the active list only showing non-closed sessions, and could that interact badly with rotation?
Yes.

Normal list loading:
- decorates visibility in `src-tauri/src/services/session_list.rs`
- converts hidden sessions to `listVisibility = hidden`
- drops hidden entries in `src-tauri/src/commands/sessions.rs::collect_listed_session_records_from_rows_with_runtime_state()`

So the backend list already excludes superseded sessions. The problem is the frontend can keep a stale superseded session alive in local state even after the backend stops returning it.

### 4. If a user goes back to the old session and sends a message, do we reopen it and end up with two active task-linked sessions?
Not through the current canonical task-binding path.

Important behaviors:
- `resume_session()` only restores **user-dismissed** hidden sessions; superseded sessions are not restored through that path.
- `create_contextual_session()` rotates the open assignment to a new assignment row with the new `session_id`.
- `load_active_task_metadata()` resolves `activeTaskId` from the **open assignment**, not from historical session history.

So the backend already has the right single-current-task-session model. Historical session metadata can still exist for old sessions, but canonical “current linked task” state already lives on the replacement assignment/session.

## Root cause
The highest-confidence root cause is frontend stale-state preservation after rotation.

### Backend behavior is already mostly correct
When `New session` rotates an assigned worker session:
1. `create_contextual_session()` detects the active assignment.
2. `rotate_session_record()` creates the successor session and marks the source session superseded/hidden.
3. `task_runtime::rotate_open_assignment_session()` cancels the old open assignment and creates a replacement assignment with the new `session_id`.
4. `bind_rotated_assignment_session_context()` binds the new canonical session row to the task/lane/assignment.

That already gives the task exactly one open assignment session.

### Frontend behavior is where the stale selection slips in
`src/App.tsx::handleCreateSession()` currently:
- creates the successor session
- merges the new session record
- sets `selectedSessionId` to the new id
- **does not** treat the old session as explicitly replaced in local state
- **does not** open a durable pending session-open request for the successor the way task→session navigation does

At the same time, session refresh uses:
- `src/App.tsx::loadSessions()`
- `src/lib/sessionListMerge.ts::reconcileListedSessions()`

`reconcileListedSessions()` intentionally preserves some sessions that disappear from the latest list response. That is correct for temporary list/detail races, but it is wrong for a session that the backend intentionally removed because it was superseded.

Once the old session is preserved locally:
- it can remain selectable even though the backend hid it
- selection fallback can continue to land on it
- because its stale local metadata still looks active/current, the active list can appear pinned to the old task session

## Recommended implementation

### A. Treat `New session` as a replacement flow in `src/App.tsx`
After a successful contextual rotation:
- record the source session id and successor session id as a replacement pair
- set `pendingSessionOpenRequest` for the **successor** session, not just `selectedSessionId`
- immediately retire the source session in local state
  - either remove it from `sessions`
  - or patch it to `status = closed`, `listVisibility = hidden`, `messageability = closed`, and clear any current-task metadata

This prevents the old session from surviving long enough to win fallback selection.

### B. Tighten missing-session preservation in `reconcileListedSessions()`
Keep the current preservation behavior for:
- explicit pinned sessions
- detail fetches that are temporarily ahead of the list

But do **not** preserve a missing session when:
- it is known to have been replaced by a newer session
- or its last known canonical detail says it is hidden/superseded

If successor lineage is available, the merge layer should prefer the successor and drop the source.

### C. Surface replacement lineage on `SessionRecord`
Recommended small model extension:
- add `supersedesSessionId?: string | null`
- add `supersededBySessionId?: string | null`
- optionally add `lifecycleState?: string | null`

Relevant likely files:
- `src/types.ts`
- `src-tauri/src/models.rs`
- `src-tauri/src/services/session_records.rs`
- `src-tauri/src/commands/sessions.rs`

Why this helps:
- local replacement handling becomes explicit
- cross-window recovery can resolve “old selected session” → “new live session” deterministically
- the UI no longer has to infer intentional removal from list omission alone

### D. Keep `activeTaskId` as the only “current task association” signal
The backend already distinguishes:
- historical task metadata (`taskId`, `taskTitle`, etc.)
- current active task metadata (`activeTaskId`, `activeTaskTitle`, etc.)

That distinction should remain authoritative in the UI:
- “current linked task” behavior should use `activeTaskId`
- historical `taskId` should not be used to re-promote a superseded session as the current one

## Regression coverage

### Unit / state-merge coverage
Add/extend tests in:
- `tests/sessionListMerge.test.ts`

Recommended cases:
1. A missing selected session that is known superseded by a listed successor is **not** preserved.
2. A successor session created by `New session` remains the requested/selected session across a refresh race.
3. Existing pinned-session preservation still works for non-superseded sessions.

### Desktop end-to-end coverage
Extend:
- `tests/desktop-e2e/session-controls.test.ts`
- `tests/desktop-e2e/chat-session-recovery.test.ts`

Recommended assertions:
1. After `New session`, only the successor remains in the active list.
2. Navigating away and back keeps the successor selected.
3. Refreshing sessions after rotation does not resurrect the superseded source session.

### Task-linked worker-session coverage
Add or extend a task-dispatch scenario so this is verified on a real task-linked session, not only chat/agent-main flows:
- dispatch a task to a role/agent lane
- invoke `New session` on the active worker session
- assert the task’s open assignment now points only to the successor session
- assert the old session stays hidden/closed and does not remain in the active list

## Likely file touch list
- `src/App.tsx`
- `src/lib/sessionListMerge.ts`
- `src/types.ts`
- `src-tauri/src/models.rs`
- `src-tauri/src/commands/sessions.rs`
- `src-tauri/src/services/session_records.rs`
- `tests/sessionListMerge.test.ts`
- `tests/desktop-e2e/session-controls.test.ts`
- `tests/desktop-e2e/chat-session-recovery.test.ts`

## Recommended implementation order
1. Fix the frontend replacement flow in `App.tsx`.
2. Tighten `reconcileListedSessions()` so superseded sessions are not preserved.
3. Expose successor lineage on `SessionRecord` if needed for deterministic cross-refresh/cross-window recovery.
4. Add unit coverage.
5. Add/extend desktop regression coverage.

## Bottom line
The canonical backend invariant is already close to the desired one: task-linked worker sessions rotate to a single replacement assignment/session, and superseded sessions are closed/hidden. The remaining bug is that the frontend can preserve and keep selecting the superseded source session after `New session`. The fix should make session rotation explicit in UI state and, ideally, expose successor lineage so the client always resolves a task to exactly one live current session.