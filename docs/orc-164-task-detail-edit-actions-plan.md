# ORC-164 task-detail edit FAB and floating-header plan

## tl;dr
- Add bottom-right floating `Save` and `Cancel` buttons whenever `TaskDetailPage` is in edit mode.
- Make `Cancel` a true edit cancel: discard unsaved draft changes, clear dirty state, and leave edit mode.
- Keep the existing task-detail tab dock usable by lifting edit FABs above the bottom dock/safe area.
- Fix the compact floating header by computing its top offset below the mobile topbar/app content chrome and raising its local z-index above page chrome.
- Cover the behavior with task-detail e2e regressions for mobile edit mode and floating-header non-overlap.

## Executive summary
`src/pages/tasks/TaskDetailPage.tsx` already owns task-detail edit mode through local `isEditing`, while `src/pages/TasksPage.tsx` owns the mutable `taskDraft` and dirty state. Today edit actions live inside the edit shell `TaskActionMenu`; on mobile those actions are hidden behind the menu trigger and are not surfaced as persistent bottom-right actions. The same component also computes the compact header’s fixed position using `.content` top plus a small margin, but it does not explicitly account for the mobile topbar bottom edge and the fixed header uses the same low z-index as the tab dock, which allows top chrome overlap/layering bugs.

Implement this as a scoped task-detail UX cleanup, not a broad Tasks redesign: add a dedicated edit FAB group in `TaskDetailPage`, add an explicit cancel-edit callback from `TasksPage`, and adjust the compact header positioning logic/CSS. Keep existing desktop behavior functionally intact, but make the FABs the canonical `save-task` target while avoiding duplicate visible `data-role="save-task"` buttons in detail edit mode.

## Current-state findings
- `TaskDetailPage` renders edit mode with `isEditing` and an inline `TaskActionMenu` containing `Done editing`, optional `Dispatch`, `Save changes`, `Close`, and `Delete`.
- `TasksPage` tracks `taskDraftDirty`, resets drafts on normal reloads, and saves detail edits through `handleSaveDetailTask()`.
- There is no explicit cancel-edit path that resets `taskDraft` from the loaded `taskDetail`; `Done editing` only hides the editor.
- `TasksPage` intentionally removes mobile topbar task actions while `taskDetailEditing` is true, so edit-mode actions need to be exposed inside the detail page itself.
- `.task-detail-floating-header`/`.task-detail-tab-dock` are fixed at `z-index: 12`; `.mobile-topbar` is sticky at `z-index: 16`.
- The floating-header top calculation uses `.content` top, but not the actual mobile topbar bottom, which is the likely source of the header being obscured by top chrome.

## Recommended implementation

### 1. Add an explicit cancel-edit callback
In `src/pages/TasksPage.tsx`:
- add `handleCancelDetailEdit()` that, when `taskDetail` exists, sets `taskDraft` back to `taskToDraft(taskDetail)` and clears `taskDraftDirty`.
- pass it to `TaskDetailPage` as `onCancelEdit`.

In `src/pages/tasks/TaskDetailPage.tsx`:
- add `onCancelEdit` to props.
- use a shared `handleCancelEdit()` that calls `onCancelEdit()` and `setIsEditing(false)`.
- update the existing edit-menu “Done editing” action to use the same cancel behavior, preserving the existing `close-edit-task` data role for compatibility.

### 2. Add bottom-right edit FABs
In `TaskDetailPage`, render a conditional edit FAB group while `isEditing` is true:
- container data role: `task-detail-edit-fab`
- `Cancel` button data role: `cancel-task-edit`
- `Save` button data role: keep `save-task` as the canonical detail edit save target
- `Save` should call the existing `onSave`, respect `saving || loading || !draft.title.trim()`, and show a saving label/state.
- `Cancel` should be disabled during save/publish work to avoid racing an in-flight update.

Avoid duplicate visible `data-role="save-task"` buttons in detail edit mode. Either remove the inline edit-menu Save action or keep it without that data role. Existing detail tests that click `[data-role="save-task"]` should land on the FAB.

### 3. Position the FABs around bottom chrome
In `src/styles.css`:
- add `.task-detail-edit-fab` as `position: fixed`, bottom-right, with safe-area-aware `right`/`bottom`.
- lift it above `.task-detail-tab-dock` instead of placing it at the absolute viewport bottom.
- give the edit shell/page enough bottom padding so form fields are not hidden behind the FABs.
- tune mobile sizing (`@media (max-width: 900px)`) so both buttons remain reachable on a 390px-wide viewport.

### 4. Fix compact header top offset and layering
In the existing floating-chrome effect in `TaskDetailPage`:
- measure `[data-role="mobile-topbar"]` when present.
- compute `pinnedTop` from the maximum of content top, mobile topbar bottom, and zero, plus a small margin.
- keep scroll visibility logic tied to the sentinel, but compare against the same `pinnedTop`.

In CSS:
- raise `.task-detail-floating-header`/`.task-detail-tab-dock` to a local chrome z-index above ordinary panels while staying below overlays/mobile navigation/dropdowns.
- ensure the compact header cannot cover the mobile topbar because the JS offset keeps its top below the topbar bottom.

### 5. Regression coverage
Update `tests/e2e/tasks.spec.ts` near the existing task-detail mobile/floating-header tests:
- Add a mobile edit-mode test that opens a task, enters edit mode, verifies `task-detail-edit-fab`, `Save`, and `Cancel` are visible at the bottom-right, verifies they do not overlap the bottom tab dock, and verifies cancel exits edit mode after discarding an unsaved title change.
- Extend or add a mobile scroll test that makes task detail content tall, scrolls until the compact header appears, and asserts the compact header top is below the mobile topbar bottom.
- Keep the existing desktop bottom tab dock test and existing detail save tests passing.

## Validation
- Run the targeted Playwright task-detail tests after implementation, at minimum the relevant `tests/e2e/tasks.spec.ts` cases around task detail scrolling/mobile/editing.
- Run the standard frontend validation expected for this repo if time permits: `npm run test -- tests/task-detail-action-state.test.ts` is not directly relevant, so prefer targeted e2e plus `npm run build` for type coverage.

## Non-goals
- Do not redesign the task-detail tab dock or mobile section select.
- Do not change create-task FAB behavior.
- Do not change workflow/lane task action semantics beyond edit-mode Save/Cancel exposure.
