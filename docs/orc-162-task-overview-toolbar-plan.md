# ORC-162 task overview mobile filter-row plan

## tl;dr
- The user clarified that the targeted “filter chips” are the board/status chips (`All`, `Attention`, `Needs review`, `Blocked`, etc.), not the expandable tag/sort filter card.
- The requested layout change should apply only to the mobile Tasks overview row, not desktop/non-mobile layouts.
- Keep the existing desktop chip row and the existing tag/sort filter card behavior intact.
- On mobile, replace the board/status chip row with a dropdown/select-style control on the left and keep the existing cards/table toggle on the right in the same row.
- Preserve all current board filtering, tag filtering, sort, and view-mode behavior; regression work should focus on the new mobile control path.

## Executive summary
The current Tasks overview already behaves acceptably on desktop: `src/pages/tasks/TasksOverviewPage.tsx` renders the board/status chip row and the cards/table toggle inside the same `task-overview-controls` container, and the separate `task-overview-filters` card below it handles tags and sort. The clarified problem is specifically the narrow/mobile presentation, where `src/styles.css` currently collapses `.task-overview-controls` to a single column and causes the board/status chips to occupy one row while the cards/table toggle drops below.

Given the user’s clarification, ORC-162 should not redesign the tag filter card and should not change desktop behavior. Instead, it should introduce a mobile-only variant for the board/status filter control: a dropdown-style control on the left side of the row that selects the active board filter, while the cards/table toggle remains on the right. The expandable tag/sort filter card stays below as-is, including its persisted `filtersExpanded` behavior.

## Clarified scope

### In scope
- The board/status chips in `task-nav-filters`
- The mobile/narrow Tasks overview controls row
- Keeping the cards/table toggle on the right side of that mobile row
- Regression coverage for mobile board-filter selection and view switching

### Out of scope
- Replacing the expandable tag/sort filter card with a dropdown
- Removing or redesigning desktop board/status chips
- Removing persisted `filtersExpanded` state
- Broad task-overview control changes on non-mobile layouts

## Current-state findings

### The chips the user means are the board/status chips
In `src/pages/tasks/TasksOverviewPage.tsx`, the relevant chip-like control is:
- `task-nav-filters` with `task-filter-all`, `task-filter-attention`, `task-filter-review`, `task-filter-blocked`, `task-filter-active`, `task-filter-done`, and `task-filter-epics`

This is distinct from the separate `task-overview-filters` card, which handles:
- tag selection
- tag match mode
- sort field and direction

That lower card should remain part of the design.

### The fragmentation is currently a responsive/mobile issue
`src/styles.css` currently includes `.task-overview-controls` in the generic `@media (max-width: 1100px)` rule that flips several grids to one column. That is what causes the board/status filter area and the view toggle to split into separate rows at narrower widths.

### Desktop behavior should be preserved
On desktop/non-mobile layouts, the current top-level structure is still valid:
- board/status filters on the left
- cards/table toggle on the right
- tag/sort filter card below

The requested change is therefore a scoped mobile adaptation, not a full Tasks overview control redesign.

### Existing persisted state should remain intact
Because the tag/sort filter card stays in place, `src/pages/tasks/taskOverviewState.ts` should continue to persist:
- `boardFilter`
- `viewMode`
- `sort`
- `tags`
- `tagMatch`
- `filtersExpanded`

The previous idea of dropping `filtersExpanded` is no longer correct after the clarified scope.

## Recommended implementation

### 1. Keep desktop markup/behavior functionally unchanged
For desktop/non-mobile layouts in `src/pages/tasks/TasksOverviewPage.tsx`:
- keep the existing `task-nav-filters` chip row
- keep the existing `task-view-toggle`
- keep the existing `task-overview-filters` card below

This minimizes risk and aligns with the user’s “not non mobile” instruction.

### 2. Add a mobile-only board-filter dropdown control
Add a second board-filter control specifically for mobile, ideally a native select for simplicity and low UI weight.

Recommended shape:
- `label`: `Filter`
- `select` options backed by the existing `boardFilter` state and counts, for example:
  - `All (24)`
  - `Attention (3)`
  - `Needs review (1)`
  - `Blocked (2)`
  - `Active (8)`
  - `Done (7)`
  - `Epics (3)`

Recommended data role:
- `task-filter-select-mobile`

Implementation note:
- the select should write directly to `overviewState.boardFilter`
- do not change the underlying filtering logic in `src/pages/TasksPage.tsx`

### 3. Keep the cards/table toggle on the right side of the same mobile row
The mobile top row should become:
- left: board filter dropdown/select
- right: existing `task-view-toggle`

Keep existing `task-view-cards` and `task-view-table` data roles unchanged so current view-mode persistence and most existing test coverage keep working.

### 4. Preserve the expandable tag/sort filter card below the row
The existing `task-overview-filters` section should remain below the mobile row and continue to own:
- tag selection chips
- tag match mode
- sort field and direction
- persisted expanded/collapsed state

This means:
- keep `filtersExpanded` in `TaskOverviewState`
- keep `buildTaskOverviewStateForTagNavigation(...)` behavior that expands the card when navigating by tag
- keep the tag-filter regression coverage already in place, adjusting only where the mobile top-row structure changes around it

### 5. Make the responsive logic explicitly mobile-scoped
Recommended CSS strategy in `src/styles.css`:
- remove `.task-overview-controls` from the broad `@media (max-width: 1100px)` rule that forces it into a single column
- keep the current desktop/tablet layout intact above the true mobile breakpoint
- add task-specific mobile rules at the app’s mobile breakpoint (`@media (max-width: 900px)`) to:
  - show the mobile board-filter select
  - hide the desktop chip row
  - keep `.task-overview-controls` as a two-column row (`minmax(0, 1fr) auto`)
  - ensure the view toggle stays right-aligned
  - allow the select to shrink correctly without pushing the toggle off-screen

This is the cleanest way to make the change mobile-only while avoiding regressions on non-mobile widths.

### 6. Prefer duplicate responsive controls over JS viewport state
The lowest-risk implementation is to render both board-filter variants and let CSS choose which one is visible:
- desktop: show `task-nav-filters`, hide `task-filter-select-mobile`
- mobile: hide `task-nav-filters`, show `task-filter-select-mobile`

That avoids introducing viewport listeners or matchMedia-specific UI logic into React state.

## Regression coverage plan

### Keep most existing desktop filter coverage
Existing tests that click `task-filter-done`, `task-filter-all`, etc. should largely remain valid for desktop behavior because the desktop chip row stays intact.

### Add mobile-specific Tasks overview coverage
Update `tests/e2e/tasks.spec.ts` to add or revise narrow/mobile coverage so it verifies:
1. at mobile width, the board/status chip row is not the primary visible control
2. `task-filter-select-mobile` is visible
3. `task-view-cards` / `task-view-table` remain visible in the same row
4. selecting a board filter from the mobile dropdown changes the rendered board content correctly
5. switching to table view still works after selecting a mobile filter
6. persisted `boardFilter` and `viewMode` behavior still survives reloads where applicable

### Keep tag/sort filter-card coverage intact
Because the tag filter card remains in scope unchanged, current tests around:
- `task-overview-filters-toggle`
- `task-tag-filter-chip`
- `task-tag-match-all`
- `task-sort-field`
- `task-sort-direction`

should remain and only need adjustment if nearby mobile layout assertions change.

### Desktop e2e impact should be minimal
Because desktop chip selectors stay in place, the existing desktop e2e tests that click `task-filter-*` should not require a broad rewrite. Only add new coverage if there is a mobile-specific desktop-driver path worth validating.

## Concrete implementation sketch

### `src/pages/tasks/TasksOverviewPage.tsx`
Keep the existing desktop control structure, but add a mobile-only board-filter field alongside it.

Recommended shape:

```tsx
const boardFilterOptions = [
  ["all", "All", filterCounts.all],
  ["attention", "Attention", filterCounts.attention],
  ["review", "Needs review", filterCounts.review],
  ["blocked", "Blocked", filterCounts.blocked],
  ["active", "Active", filterCounts.active],
  ["done", "Done", filterCounts.done],
  ["epics", "Epics", filterCounts.epics],
] as Array<[TaskOverviewState["boardFilter"], string, number]>;
```

Within `.task-overview-controls`:
- keep the existing desktop `task-nav-filters` button group
- add a compact mobile field wrapper, e.g. `task-overview-controls__mobile-filter`
- render a native `<select>` with `data-role="task-filter-select-mobile"`
- keep `task-view-toggle` markup and `task-view-cards` / `task-view-table` data roles unchanged

Recommended mobile select option labels:
- `All (N)`
- `Attention (N)`
- `Needs review (N)`
- `Blocked (N)`
- `Active (N)`
- `Done (N)`
- `Epics (N)`

The mobile select should directly update `overviewState.boardFilter`; no task filtering logic changes are required in `src/pages/TasksPage.tsx`.

### `src/styles.css`
Use CSS-only responsive switching instead of JS viewport state.

Recommended additions:
- desktop default:
  - `.task-overview-controls__mobile-filter { display: none; }`
  - desktop `task-nav-filters` remains visible
- remove `.task-overview-controls` from the generic `@media (max-width: 1100px)` one-column rule
- add task-specific mobile rules under `@media (max-width: 900px)`:
  - show `.task-overview-controls__mobile-filter`
  - hide `.task-nav-filters`
  - keep `.task-overview-controls { grid-template-columns: minmax(0, 1fr) auto; align-items: center; }`
  - ensure the mobile filter field can shrink (`min-width: 0`) while the view toggle stays right-aligned
  - if needed, reduce the select label footprint on mobile so the cards/table toggle does not wrap first

This preserves desktop/tablet behavior and limits layout changes to true mobile widths.

### State model impact
No `taskOverviewState` redesign is recommended.

Specifically, keep:
- `boardFilter`
- `viewMode`
- `sort`
- `tags`
- `tagMatch`
- `filtersExpanded`

No changes should be needed in:
- `src/pages/tasks/taskOverviewState.ts`
- `src/App.tsx`
- `buildTaskOverviewStateForTagNavigation(...)`

other than possible comment/test cleanup if the implementation wants to document the clarified scope.

## Regression mapping

### Tests to preserve as-is
Because desktop behavior remains intentionally unchanged, these existing selector paths should stay valid on non-mobile widths:
- `task-filter-all`
- `task-filter-done`
- `task-filter-attention`
- `task-view-table`
- `task-view-cards`
- the full `task-overview-filters-*` tag/sort filter-card flow

### New mobile helper recommendation
Add a Playwright helper in `tests/e2e/tasks.spec.ts`, for example:

```ts
async function setTaskOverviewMobileBoardFilter(page: Page, value: string) {
  const select = page.locator('[data-role="task-filter-select-mobile"]');
  await expect(select).toBeVisible();
  await select.selectOption(value);
}
```

### Mobile test cases to add
1. **mobile overview keeps filter select and view toggle in one row**
   - set mobile viewport
   - verify `task-filter-select-mobile` is visible
   - verify desktop `task-nav-filters` is hidden
   - verify `task-view-toggle` is still visible in the same controls row

2. **mobile board filter select changes visible board content**
   - seed tasks across multiple statuses
   - select `done` from `task-filter-select-mobile`
   - verify only done tasks/sections render

3. **mobile filter select works with table view toggle**
   - choose a non-default mobile board filter
   - switch to table view
   - verify expected rows are shown and `aria-pressed` remains correct on `task-view-table`

4. **mobile view/filter persistence survives reload**
   - set a mobile board filter and table view
   - reload or open a second page
   - verify the board filter select value and view toggle state persist

### Desktop-driver impact
The current desktop e2e tests that click `task-filter-*` should not need a broad rewrite because the chip buttons remain the desktop control path. Only mobile-targeted tests should use the new select.

## Implementation order
1. Update `TasksOverviewPage.tsx` to derive a single `boardFilterOptions` array that can power both the desktop chip row and the mobile select.
2. Add the mobile select markup with stable data roles.
3. Update `src/styles.css` so the desktop and mobile filter controls swap purely through breakpoint rules.
4. Add focused mobile Playwright coverage.
5. Run the task overview/browser build validation.

## Expected files
- `src/pages/tasks/TasksOverviewPage.tsx`
- `src/styles.css`
- `tests/e2e/tasks.spec.ts`
- possibly a small targeted update in `tests/task-overview-state.test.ts` only if comments/assertions need to reflect the clarified scope, but no state-model redesign is expected

## Validation
```bash
npm run test:e2e -- --grep "tasks overview|task table"
npm run build
```
