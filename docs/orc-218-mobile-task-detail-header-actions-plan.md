# ORC-218 mobile task-detail header actions plan

## tl;dr
- On mobile, replace the task-detail header’s separate `Open session` / `Re-lane` / lane-action controls with one `Actions` menu in both the primary header and the floating header.
- Keep desktop behavior functionally unchanged.
- Build the unified mobile menu in `TaskDetailPage` from the existing header action list plus a nested `Move to …` re-lane entry, while keeping lower-priority `Open session` access available in a trailing mobile group.
- Add small responsive wrappers in `TaskDetailPage`/`styles.css` so both mobile header variants share the same single-button pattern.
- Update task-detail e2e coverage to assert the consolidated mobile menu while preserving session-open and re-lane access.

## Executive summary
`src/pages/tasks/TaskDetailPage.tsx` already renders both task-detail header variants through the shared `renderHeaderActions(compact)` helper, but today that helper composes three separate controls: a standalone `Open session` button, a standalone `TaskRelaneMenu`, and `TaskActionMenu`. `TaskActionMenu` already collapses into a single dropdown on mobile, but the other two controls remain visible, which is why mobile still shows multiple header actions.

The lowest-risk fix is to keep the existing desktop layout intact and add a dedicated mobile header action surface inside `renderHeaderActions()`. That mobile surface should feed one unified action menu with the existing task/lane actions plus a nested `Move to …` entry that opens the available re-lane targets, while keeping `Open session` accessible in a separate lower-priority mobile group when it exists. This keeps the change scoped to task detail, reuses the existing action-menu pattern, and guarantees the main header and floating header stay aligned because they continue sharing one render path.

## Current-state findings
- `renderHeaderActions(compact)` is the shared render path for both the main task-detail header and the floating header.
- The primary header currently renders an optional standalone `Open session` button above a row containing `TaskRelaneMenu` and `TaskActionMenu`.
- The floating header currently renders `TaskRelaneMenu` and `TaskActionMenu` side by side.
- `TaskActionMenu` already swaps inline buttons for a single dropdown at `@media (max-width: 900px)`, but `TaskRelaneMenu` and the standalone session button do not.
- Existing e2e coverage in `tests/e2e/tasks.spec.ts` explicitly asserts separate relane/action controls at an 820px viewport, so those assertions will need to be updated.
- `src/pages/tasks/taskDetailHeaderActions.ts` already centralizes the ordinary task/lane actions, so the missing work is the mobile-only wrapper for session and re-lane entry points.

## Recommended implementation

### 1. Keep `renderHeaderActions()` as the single source of truth
In `src/pages/tasks/TaskDetailPage.tsx`:
- keep one shared `renderHeaderActions(compact = false)` path for both header variants.
- add a helper/derived list that builds the unified mobile menu from:
  - existing `headerActionMenuActions`
  - one nested `Move to …` entry that opens the existing `availableRelaneTarget` choices and then calls `openRelaneConfirm(lane)`
  - `Open session` when `!compact && activeSessionId`, but grouped after the core workflow actions instead of leading the menu

For approval-paused review states, place `Move to …` below `Approve` / `Needs work`, separated from those review actions and from the trailing `Stop` / `Whip` actions with dividers. Keep `Open session` available, but in a final lower-priority group so the workflow decision actions stay first.

### 2. Split desktop and mobile header action surfaces
Still in `TaskDetailPage.tsx`:
- render desktop-only header controls that preserve today’s layout:
  - primary header: standalone `Open session`, standalone `TaskRelaneMenu`, inline `TaskActionMenu`
  - floating header: standalone `TaskRelaneMenu`, inline `TaskActionMenu`
- render a mobile-only wrapper inside the same header action container that shows a single `TaskActionMenu` with `menuLabel="Actions"`

This keeps desktop stable while making both mobile header variants converge on the same single-button interaction.

### 3. Keep the generic action menu mostly unchanged
Prefer not to broaden `src/components/TaskActionMenu.tsx` unless implementation needs a small testability hook. The task can stay local to `TaskDetailPage` by rendering a task-detail-specific mobile menu wrapper that preserves the shared Actions-button pattern while handling dividers and the nested `Move to …` relane picker.

### 4. Update task-detail mobile styling
In `src/styles.css`:
- add desktop/mobile visibility classes for the task-detail header action wrappers at the existing 900px breakpoint
- ensure the mobile wrapper aligns the single trigger cleanly in both the primary header and floating header
- normalize the mobile trigger label to `Actions` for both header variants

No broad task-detail layout rewrite should be necessary.

### 5. Refresh regression coverage
In `tests/e2e/tasks.spec.ts`:
- keep a desktop assertion that re-lane remains a separate control at wide viewports
- replace the 820px expectations with mobile-specific assertions that:
  - the primary header exposes one visible `Actions` trigger
  - the floating header exposes one visible `Actions` trigger
  - standalone `Re-lane` and `Open session` controls are not visible in the mobile header surfaces
- exercise the mobile menu to prove access is preserved:
  - open a linked session from the main header menu
  - open the nested `Move to …` picker from a mobile `Actions` menu entry and continue into the relane confirmation flow

## Validation
- Run the task-detail Playwright coverage around header actions and relane behavior, centered on `tests/e2e/tasks.spec.ts`.
- Run at least a targeted frontend safety check after implementation.

## Non-goals
- Do not change desktop header behavior beyond any markup reshaping needed for responsive wrappers.
- Do not redesign the runtime-tab `Lane actions` menu or the app-level mobile topbar actions.
- Do not change re-lane semantics; only move the mobile entry points into the consolidated menu.
