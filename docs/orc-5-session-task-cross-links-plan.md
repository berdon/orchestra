# ORC-5 session/task cross-link fix plan

## Problem summary

The recently added cross-links only added surface buttons plus shallow page switches:

- `src/components/SessionChatPanel.tsx` now renders **Open task** and calls `onOpenTask(activeTaskId)`.
- `src/pages/tasks/TaskDetailPage.tsx` now renders **Open session** and calls `onOpenSession(activeSessionId)`.
- `src/App.tsx` handles those callbacks by flipping `activePage` and updating the existing selection state.

That is enough to navigate to the right page shell when the target record is already present in memory and the current project already matches, but it does **not** reliably resolve the exact detail target.

## Observed design gaps

### 1. Session navigation is selection-based, not target-resolution-based

`src/App.tsx` currently does this for task -> session navigation:

- `setActivePage("sessions")`
- `setSessionFilter(...)`
- `setSelectedSessionId(sessionId)`

The selected-session rendering path then computes:

- `selectedSession = filteredSessions.find(...) ?? filteredSessions[0] ?? null`

That fallback means the UI silently lands on the first visible session whenever the requested session is not already in the loaded list. In a live desktop flow, that can happen if the task detail is fresher than the session list, especially right after dispatch/runtime creation.

Worse, `loadSessions()` later preserves whatever session is currently selected if it exists, so once the UI falls back to the wrong session it can stay pinned there even after the intended session appears.

### 2. Task navigation is project-scoped to the current page state, not the target task

`navigateToTask(taskId)` currently stores:

- `{ taskId, token, projectId: activeProjectId }`

`TasksPage` only consumes the request when `openTaskRequest.projectId === projectId`.

That means session -> task navigation depends on the **current** active project already being the target task’s project. The current `SessionRecord` shape exposes `activeTaskId`, `activeTaskNumber`, and `activeTaskTitle`, but not the target task’s `projectId`, so the handler cannot authoritatively switch projects before opening the detail view.

Same-project flows work opportunistically. Cross-project or stale-project flows do not have enough information to resolve the exact target deterministically.

### 3. URL/detail state is not carrying the exact target

The app already uses URL search params for special detached windows (`view=logs`, `view=agent-terminal`, `sessionId=...` for the agent terminal window), but regular task/session detail navigation is still held in ephemeral React state only.

For this bug, that matters because the navigation action should represent an exact target (`taskId` or `sessionId` plus the correct project scope), not just a top-level page switch.

### 4. Existing automated coverage does not exercise the real race

The feature commit added web tests in `tests/e2e/sessions.spec.ts` and `tests/e2e/tasks.spec.ts`, but those tests seed both the task and session records up front in local storage.

That coverage proves the buttons render and work when the target is already loaded. It does **not** cover the Podman/desktop flow where a task dispatch creates or updates the live session and the UI must resolve the correct detail target across async refresh boundaries.

## Root-cause assessment

This is a combination bug:

- **selected-record lookup** is too eager to fall back to the first record,
- **navigation state** does not preserve a durable “open this exact target” request long enough to survive async refresh,
- **project-aware routing/state wiring** is incomplete because the navigation targets do not carry authoritative `projectId` information,
- **URL/detail state** is not representing the selected task/session target.

## Implementation plan

### A. Introduce explicit navigation target types

Create project-aware target payloads instead of passing bare ids through the UI:

- `TaskNavigationTarget = { taskId: string; projectId?: string | null }`
- `SessionNavigationTarget = { sessionId: string; projectId?: string | null; statusHint?: "active" | "closed" | null }`

Use these in:

- `src/App.tsx`
- `src/components/SessionChatPanel.tsx`
- `src/pages/tasks/TaskDetailPage.tsx`
- any intermediate props in `src/pages/TasksPage.tsx` / `src/pages/SessionsPage.tsx`

### B. Extend session metadata so session -> task navigation knows the real target project

Add target-project metadata to `SessionRecord` end-to-end:

- frontend type in `src/types.ts`
- mock/session normalization in `src/lib/tauri.ts`
- Rust `SessionRecord` in `src-tauri/src/models.rs`
- session decoration query in `src-tauri/src/commands/sessions.rs`

Minimum additions:

- `projectId?: string | null` for the session itself
- `activeTaskProjectId?: string | null` for the linked active task

That gives the session-detail link enough information to switch to the correct project before opening the task detail.

### C. Replace best-effort selection with pending exact-target requests

Mirror the task-side `openTaskRequest` pattern for sessions, but make both directions project-aware and durable.

#### Task targets

Keep the tokenized request model in `TasksPage`, but change the request payload to use the **target** project id.

Behavior:

1. If target project differs from `activeProjectId`, switch projects first.
2. After the project switch settles, consume the request and call `openTaskDetail(taskId)`.
3. Let `loadTaskDetail(taskId)` fetch the exact task detail record by id.

#### Session targets

Add a new request state in `App.tsx`, for example:

- `sessionsOpenRequest = { sessionId, projectId, statusHint, token }`

Behavior:

1. If target project differs from `activeProjectId`, switch projects first.
2. Try to resolve the session from the in-memory list.
3. If it is not present yet, fetch `getSessionRecord(sessionId)` directly and merge it into state before selection.
4. Do **not** allow the selection logic to fall back permanently to `filteredSessions[0]` while a pending explicit target is unresolved.
5. After the request resolves, clear the pending target.

This is the key fix for the task -> session direction.

### D. Sync exact detail state into the URL/search params

Add lightweight search-param syncing for the primary app view, without disturbing detached-window params.

Suggested shape:

- `?page=tasks&taskId=<id>`
- `?page=sessions&sessionId=<id>`
- preserve existing `view=logs` / `view=agent-terminal` behavior unchanged

Implementation can use `history.replaceState()` rather than a full router.

Boot behavior should hydrate the initial detail selection from the search params when present.

This keeps the detail target explicit and aligns the app state with the task requirement that URL state and selection state resolve the exact target consistently.

### E. Add stable identity hooks for UI assertions

Desktop coverage needs to assert the actual selected target, not just page presence.

Recommended additions:

- `src/components/SessionChatPanel.tsx` already exposes `data-session-id` on the panel root — keep using that.
- Add `data-task-id={task.id}` on the task detail shell in `src/pages/tasks/TaskDetailPage.tsx` so UI tests can assert the exact opened task id.

## Test plan

### 1. New Podman desktop UI regression spec

Add a dedicated desktop spec, e.g.

- `tests/desktop-e2e/session-task-cross-links.test.ts`

Flow:

1. Create a project/repository/workflow with a role-owned lane.
2. Create a task through the UI.
3. Dispatch the task so Orchestra creates the live active session.
4. Resolve the created task id and active session id via the real backend tools (`get_task`, `list_sessions`, or `get_session_record`).
5. Cover both directions:
   - **task detail -> session detail**
     - open the task in the UI
     - click **Open session**
     - assert `[data-role="session-chat-panel"]` has `data-session-id === <expected session id>`
   - **session detail -> task detail**
     - from the selected session detail click **Open task**
     - assert the task detail root has `data-task-id === <expected task id>`
6. Also assert the user-visible title/heading so the test still checks the visible flow, not only hidden attributes.

### 2. Keep/update the existing web tests

The current web tests are still useful as fast coverage for the render path. Update them if the new `SessionRecord` shape requires fixture changes, but keep the desktop spec as the authoritative regression test for this bug.

## Files likely to change

- `src/App.tsx`
- `src/components/SessionChatPanel.tsx`
- `src/pages/TasksPage.tsx`
- `src/pages/tasks/TaskDetailPage.tsx`
- `src/types.ts`
- `src/lib/tauri.ts`
- `src-tauri/src/models.rs`
- `src-tauri/src/commands/sessions.rs`
- `tests/desktop-e2e/session-task-cross-links.test.ts`
- possibly `tests/e2e/sessions.spec.ts` and `tests/e2e/tasks.spec.ts` for fixture alignment

## Recommended implementation order

1. Add the missing session/task project metadata.
2. Refactor app-level navigation helpers to accept explicit navigation targets.
3. Add pending session target resolution so selection cannot collapse to the wrong detail view during async refresh.
4. Add URL search-param syncing/hydration for session/task detail targets.
5. Add `data-task-id` test hook.
6. Add the Podman desktop regression spec and run it through the desktop runner.

## Handoff notes

The highest-risk part is the session side, because the current selected-session fallback can lock onto the wrong detail view after an async refresh race. The task side already has a tokenized open-request path, so it mostly needs authoritative target project metadata and URL-state alignment rather than a full redesign.
