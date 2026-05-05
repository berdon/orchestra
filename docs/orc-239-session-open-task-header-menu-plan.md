# ORC-239 — Session/chat Open Task header menu plan

## tl;dr
Move the shared session/task navigation action into a dedicated header overflow menu in `SessionChatPanel`, only show it when the selected session has an `activeTaskId`, and keep it wired to `App.navigateToTask(taskId, projectId)` so the click opens the exact task detail view instead of the generic tasks overview.

## Executive summary
Both Chat and Sessions render the same session detail surface through `src/components/SessionChatPanel.tsx`, so the placement fix should happen once in that shared component. The current task-link semantics already distinguish the live linked task (`activeTaskId` / `activeTaskProjectId`) from older session metadata (`taskId`), and that gate should stay intact so the action only appears for the current associated task.

Navigation should not invent a new path. The exact-task-detail behavior already exists in `src/App.tsx` via `navigateToTask()` and in `src/pages/TasksPage.tsx` via `openTaskRequest -> openTaskDetail()`, including cross-project task opens. The implementation should move the UI entry point, not replace the navigation plumbing.

## Root cause / current shape
- `SessionChatPanel` is shared by both `AgentChatPage` and `SessionsPage`, but its session-level actions are split across multiple UI regions:
  - the panel header/status cluster
  - the composer footer cog menu (`session-actions-menu`)
  - the page-level mobile transcript-controls hamburger
- Because the shared session header does not own a single overflow action model, task navigation placement has drifted and regression coverage only proves the current direct-session control path on the Sessions surface.
- The correct task-detail navigation path already exists centrally; the risk is bypassing it when relocating the action. Any new menu item must continue to call `onOpenTask(activeTaskId, activeTaskProjectId)` rather than a generic tasks-overview helper.

## Recommended implementation
1. **Add a shared session header overflow menu in `SessionChatPanel`**
   - Introduce a small header action menu next to the session title/status area.
   - Put `Open task` in that menu.
   - Remove the standalone header `Open task` button and do not duplicate task navigation inside the composer cog menu.

2. **Keep the visibility gate tied to the live linked task**
   - Show `Open task` only when `session.activeTaskId` is present.
   - Pass `session.activeTaskProjectId ?? session.taskProjectId ?? null` through to the click handler so cross-project task opens keep selecting the correct project and task detail.
   - Do not fall back to stale `session.taskId` for historical/non-current sessions.

3. **Preserve exact task-detail navigation behavior**
   - Reuse the existing `onOpenTask(activeTaskId, activeTaskProjectId)` callback from `SessionChatPanel`.
   - Keep `src/App.tsx::navigateToTask()` as the only session-to-task navigation path.
   - Do not route through `navigateToTasksOverview()` or a bare `setActivePage("tasks")` flow.

4. **Keep the footer cog focused on session maintenance**
   - Leave `New session`, `Compact`, and `Reload` in the composer/footer action menu.
   - Treat the new header overflow menu as the place for header/context navigation actions, starting with `Open task`.

## Regression coverage
- **`tests/e2e/sessions.spec.ts`**
  - Replace the direct button assertion with header overflow-menu assertions.
  - Verify `Open task` appears for a session with `activeTaskId` and is absent for a stale/historical session with only `taskId`.
  - Click the menu item and confirm the task details heading opens for the linked task.
- **`tests/e2e/chat.spec.ts`**
  - Add equivalent coverage on the Chat surface so the shared `SessionChatPanel` behavior is exercised from both routes.
- **`tests/desktop-e2e/task-detail-nav.test.ts`**
  - Update the session-to-task navigation regression to use the new header overflow path while preserving the cross-project exact-detail assertion.

## Likely file touch list
- `src/components/SessionChatPanel.tsx`
- `src/styles.css`
- `tests/e2e/sessions.spec.ts`
- `tests/e2e/chat.spec.ts`
- `tests/desktop-e2e/task-detail-nav.test.ts`

## Guardrails
- Use distinct `data-role` selectors for the new header trigger/menu/item so tests do not collide with the existing composer cog menu selectors.
- Keep menu close behavior consistent on click-outside and item activation.
- Avoid changing the existing session-maintenance action behavior unless needed for the shared menu primitive.
- Validate both Chat and Sessions because both routes share the same detail component but have different page-level wrappers.