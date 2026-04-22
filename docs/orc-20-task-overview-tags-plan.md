# ORC-20 task overview tag filter, sort, and rendering plan

## Problem summary

The current task overview experience has three important gaps relative to the ORC-14 tag plan and the ORC-20 acceptance criteria:

- `src/pages/TasksPage.tsx` only supports the existing board-status filter chips (`all`, `attention`, `review`, `blocked`, `active`, `done`, `epics`) plus a cards/table view toggle.
- `src/App.tsx` persists only the view mode via `orchestra.preferences.task-board-view-mode`; the rest of the overview state is ephemeral and not modeled as a single serializable object.
- `src/pages/tasks/TaskCompactCard.tsx` and `src/pages/tasks/WorkflowTaskBoardSection.tsx` do not render task tags at all.

That means the overview cannot yet:

- filter tasks by exact tags
- switch between `Match any` and `Match all`
- expose explicit tag-aware sorting
- visually scan tags in cards and rows
- persist the combined filter/sort/view state in a future-saved-filter-friendly shape

## Dependencies and scope boundaries

This ticket is downstream of the foundational tag tickets:

- **ORC-17** must land first so `TaskSummary` / `TaskDetail` carry `tags: string[]`.
- **ORC-18** must land first so the shared task-list filter/sort model exists and `listTasks(...)` can accept tag filters plus the `tags` sort option.

This ticket should **not** invent new tag semantics beyond ORC-14 / ORC-18. It should consume them.

Non-goals for ORC-20:

- task create/edit/detail tag editing UX (`ORC-19`)
- backend/tag transport semantics (`ORC-17`, `ORC-18`)
- comprehensive regression hardening beyond the overview slice (`ORC-21`)
- schedule-tagging behavior; the existing **Scheduled tasks** section should remain unchanged because task schedules do not currently expose tags

## Design goals

1. Add tag filtering without replacing the existing board-status filter chips.
2. Reuse the shared sort/filter model from ORC-18 instead of creating UI-only semantics.
3. Keep tag rendering compact enough for dense lane cards and table rows.
4. Persist a single serializable overview-state object per project.
5. Keep the implementation incremental: a small shared state helper plus a reusable tag-list renderer.

## Proposed overview state model

Replace the current one-off persisted `taskBoardViewMode` preference with a single per-project overview state object.

```ts
interface TaskOverviewState {
  boardFilter: TaskBoardFilter;
  viewMode: TaskBoardViewMode;
  sort: {
    field: TaskListSortField;
    direction: TaskListSortDirection;
  };
  tags: string[];
  tagMatch: "any" | "all";
}
```

Recommended defaults:

```ts
const DEFAULT_TASK_OVERVIEW_STATE: TaskOverviewState = {
  boardFilter: "all",
  viewMode: "cards",
  sort: { field: "updatedAt", direction: "desc" },
  tags: [],
  tagMatch: "any",
};
```

### Persistence shape

Persist this as JSON under a per-project storage key such as:

- `orchestra.preferences.task-overview.v1.<projectId>`

Why per-project instead of global:

- tag filters are project-specific
- future saved-filter work will almost certainly be project-scoped
- carrying `tags=["backend"]` from one project into another would be confusing and unstable

### Migration from the current storage key

On first load, if the new JSON key is absent:

- read the existing `orchestra.preferences.task-board-view-mode`
- seed `viewMode` from that legacy value
- fill the rest from defaults

That preserves current user preference behavior while moving to a coherent state object.

## Data-loading model

The overview should keep two task collections in `TasksPage` once ORC-17/18 land:

1. `allTasks`
   - loaded with no tag filter
   - used to derive the available tag universe for the current project
   - can continue to drive workflow-definition loading
2. `tagScopedTasks`
   - loaded via the ORC-18 list/filter/sort API using:
     - `tags: overviewState.tags`
     - `tagMatch: overviewState.tagMatch`
     - `sort: overviewState.sort`
   - used as the input to the existing board-status filter (`all`, `attention`, etc.)
   - used to render cards/tables in the chosen sort order

This split matters because the UI needs a stable set of tag options even after the user narrows the visible result set.

### Filtering order

Use this order consistently:

1. backend/mock shared task-list filtering by exact tags (`tags`, `tagMatch`)
2. backend/mock shared task-list sorting (`sort.field`, `sort.direction`)
3. existing overview-only board filter (`all`, `attention`, `review`, etc.)
4. grouping into drafts / workflow sections / done lanes via `buildTaskBoardModel(...)`

That keeps ORC-18 responsible for canonical tag semantics while preserving the current overview presentation model.

### Filter-count behavior

The board-status counts in `TasksOverviewPage` should be derived from `tagScopedTasks`, not from `allTasks`.

Example:

- user selects `backend` + `urgent`
- `Match all`
- counts should answer “how many matching tasks are active/review/done?” rather than showing counts for the whole project

That is the least surprising behavior once a tag filter is active.

## Tag filter UX

### Available-tag source

Derive available tags from `allTasks`:

- flatten `task.tags`
- de-duplicate
- keep canonical lexicographic order

If the stored state contains a tag that is no longer present in `allTasks`, keep it in the selected state until the user clears it. That makes persisted state resilient and saved-filter-compatible.

## Control layout

Extend `src/pages/tasks/TasksOverviewPage.tsx` so the overview controls become two layers:

1. existing board filter chips + view toggle
2. a secondary overview toolbar containing:
   - tag chips for exact-match filtering
   - `Match any` / `Match all` segmented control
   - explicit sort controls
   - clear/reset affordance for the tag selection

Recommended behavior:

- if the project has no tags at all, hide the tag-filter controls entirely
- if 0 or 1 tags are selected, keep `tagMatch` visible but disabled or visually deemphasized because `all` and `any` are equivalent
- clicking an active tag chip removes it from the selection
- a small `Clear tags` action clears `tags[]` but should not reset sort or view mode

### Why chips instead of a new searchable combobox

This ticket should stay independent from ORC-19’s tag editor work. A chip-based exact-filter surface reuses existing filter-chip patterns in the app, keeps the interaction obvious, and avoids introducing a new dependency on a tag-entry widget just to finish overview filtering.

If the tag universe grows later, the state model still remains valid for a richer saved-filter/search UI.

## Sort UX

ORC-20 should expose explicit sort controls backed by the shared ORC-18 sort model instead of hard-coding a special `tags` sort path.

Recommended UI:

- one field select: `Updated`, `Created`, `Priority`, `Title`, `Status`, `Tags`, etc. (whatever ORC-18 ships as the shared option set)
- one direction toggle/select: `Descending` / `Ascending`

Important rule:

- `Tags` must be just another shared sort field, not a UI-only exception.

The default should remain the current behavior:

- `updatedAt desc`

## Tag rendering plan

Add a small shared renderer, e.g. `src/pages/tasks/TaskTagList.tsx`, so cards and table rows use the same compact rules.

### Shared rendering rules

- render tags in the canonical order already supplied on the task (`task.tags` should already be normalized/sorted by ORC-17)
- show each tag as a compact neutral/accent chip with a `#` prefix for quick scanning
- keep the full comma-separated list available via `title` / `aria-label`
- if a task has no tags, render nothing on cards and render `—` in table cells
- if tags overflow the visible limit, render a final `+N` overflow chip instead of wrapping indefinitely

### Card rules

In `TaskCompactCard.tsx`:

- insert the tag row between the title and the existing meta row
- show up to **2** tags, then `+N`
- keep the row single-line in practice by limiting visible chips instead of letting the card grow unpredictably

This keeps lane columns and compact grids readable.

### Table/list-row rules

In `WorkflowTaskBoardSection.tsx` table mode:

- add a dedicated **Tags** column after **Name**
- render up to **3** visible tags, then `+N`
- increase table min-width as needed so the tag column does not crush the existing metadata columns

A dedicated column is preferable to stuffing tags into the title cell because it keeps scanning and sort expectations clearer in table mode.

## Files to update

### New helper/component files

- `src/pages/tasks/taskOverviewState.ts`
  - default state
  - normalization/parsing helpers
  - storage-key helpers
  - migration from the legacy view-mode-only key
- `src/pages/tasks/TaskTagList.tsx`
  - shared compact tag renderer for cards and rows

### Existing files

- `src/App.tsx`
  - replace the single `taskBoardViewMode` preference plumbing with a persisted `TaskOverviewState`
  - load/save per-project overview state
- `src/pages/TasksPage.tsx`
  - own/use the full overview state rather than only `taskFilter`
  - load both `allTasks` and `tagScopedTasks`
  - derive `availableTags`
  - apply board-status filtering on top of the tag-scoped list
- `src/pages/tasks/TasksOverviewPage.tsx`
  - render tag filter chips, match-mode controls, sort controls, and clear action
- `src/pages/tasks/TaskCompactCard.tsx`
  - render compact tags on cards
- `src/pages/tasks/WorkflowTaskBoardSection.tsx`
  - add the table tags column and reuse `TaskTagList`
- `src/pages/tasks/taskBoardModel.ts`
  - likely no semantic changes beyond ensuring the incoming sorted task order is preserved during grouping
- `src/styles.css`
  - add styles for the overview toolbar, tag chips, overflow chip, and table-column sizing
- `src/types.ts` / `src/lib/tauri.ts`
  - consume the ORC-17/18 additions (`tags`, list filter/sort input types) rather than redefining them locally

## Testing plan

### UI/e2e coverage

Extend `tests/e2e/tasks.spec.ts` with seeded tagged tasks that cover:

1. **card rendering**
   - tagged tasks show compact tag chips
   - overflow renders as `+N`
2. **table rendering**
   - the tags column appears in table mode
   - tagged vs untagged rows render correctly
3. **exact tag filtering**
   - selecting one tag keeps only exact matches
4. **match mode semantics**
   - `Match any` returns tasks with either selected tag
   - `Match all` returns only tasks containing every selected tag
5. **tag sorting**
   - choosing `Tags` produces the deterministic order defined by ORC-18
   - untagged tasks follow the shared sort semantics rather than custom UI weighting
6. **state persistence**
   - tag filter, tag-match mode, sort, and view mode survive reload/new page
   - legacy view-mode migration still preserves prior cards/table preference on first run

### Smaller helper tests

If the overview state helper is extracted cleanly, add focused tests for:

- state normalization from malformed localStorage data
- legacy view-mode migration
- per-project storage-key behavior

## Implementation order

1. Wait for ORC-17 / ORC-18 data-model and list API work.
2. Add the shared overview-state helper and migrate persistence from the legacy view-mode key.
3. Update `TasksPage` data loading to keep both `allTasks` and `tagScopedTasks`.
4. Add the secondary controls in `TasksOverviewPage`.
5. Add `TaskTagList` and wire card/table rendering.
6. Finish with e2e coverage for filter/sort/rendering/persistence.

## Risks and mitigations

### Risk: filter controls become too coupled to editing UI

Mitigation:

- keep ORC-20 on read-only/selectable filter chips
- do not depend on ORC-19’s tag-editor component

### Risk: persisted tag filters leak across projects

Mitigation:

- use per-project storage keys
- normalize invalid/stale stored tags without crashing

### Risk: table width regression

Mitigation:

- add a dedicated tags column but preserve horizontal scroll via `.task-table-wrap`
- slightly raise the table min-width instead of squeezing existing columns

### Risk: duplicated filtering/sorting semantics between UI and backend/mock

Mitigation:

- let ORC-18 own the canonical tag filter/sort semantics
- keep ORC-20’s client-side logic limited to the existing board-status presentation filter

## Recommended completion note for the implementation lane

When ORC-20 is eventually implemented, the durable task comment should explicitly call out:

- which files now own the persisted overview state
- how the legacy view-mode preference was migrated
- which compact tag-rendering limits were chosen for cards vs rows
- that tag filtering uses exact match plus `all`/`any` semantics from ORC-18 rather than a UI-local interpretation
