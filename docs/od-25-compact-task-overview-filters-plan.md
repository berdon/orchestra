# OD-25 compact task overview filters plan

## Problem summary

The Tasks overview now starts with its filter controls collapsed by default, but the collapsed presentation is still too tall and card-like. In `src/pages/tasks/TasksOverviewPage.tsx`, the collapsed toggle currently renders an eyebrow (`Filters & sorting`), a second title row (`Task filters`), and a summary-pill row inside the same button. In `src/styles.css`, the surrounding card keeps full 16px/18px padding plus stacked header gaps, so even the minimized state still reads like a small content card instead of a compact toolbar row.

OD-25 should turn that collapsed treatment into a much denser summary/control row while keeping the expand affordance obvious and the active filter state easy to understand.

## Current-state findings

### Collapsed markup is intrinsically multi-line

`src/pages/tasks/TasksOverviewPage.tsx`
- The collapsed toggle always renders:
  1. eyebrow copy (`Filters & sorting`)
  2. bold title copy (`Task filters`)
  3. summary pills or `No active filters`
  4. chevron indicator
- Because the label stack is built into the toggle itself, the collapsed state cannot become truly compact without changing the markup, not just tightening padding.

### The collapsed shell keeps full card weight

`src/styles.css`
- `.task-overview-filters` uses a padded card shell with `padding: 16px 18px`, a border, a tinted background, and a `gap: 14px`.
- `.task-overview-filters__header` and `.task-overview-filters__title-row` both use stacked grid layouts with extra gap.
- `.task-overview-filters__summary-pill` uses filled capsule styling, which adds visual weight even when there are no active filters.
- Hiding only `.task-overview-filters__body` when collapsed removes the controls, but not the visual bulk of the header.

### The expanded body already carries its own labels

`src/pages/tasks/TasksOverviewPage.tsx`
- The expanded controls already label themselves with `Filter by tags`, `Match`, and `Sort`.
- That means the outer collapsed header is duplicating context the user will immediately see after expanding.
- Removing or simplifying the outer title/header content is the safest way to reclaim vertical space without harming comprehension.

### Existing tests protect behavior, not compactness

`tests/e2e/tasks.spec.ts`
- Current coverage verifies that filters start collapsed, that the summary text updates, and that expand/collapse persists.
- There is no regression assertion for the collapsed card height, the removal of stacked header content, or responsive compactness at narrower widths.

## Recommended implementation

### 1. Replace the stacked collapsed header with a toolbar-style summary row

Update `src/pages/tasks/TasksOverviewPage.tsx` so the toggle becomes a compact row rather than a mini card header.

Recommended collapsed structure:
- left label: `Filters`
- optional compact active-state badge, e.g. `1 active` or `2 active`
- inline summary text for selected filters/sort
- trailing chevron affordance

Implementation notes:
- Remove the eyebrow and `Task filters` heading from the collapsed treatment.
- Prefer using the same compact row in both collapsed and expanded states so the control does not jump between two different header designs.
- Keep `aria-expanded` on the button as the primary accessibility affordance.

### 2. Keep active filter state visible, but lighter-weight

The collapsed row still needs to tell users whether filtering is applied.

Recommended summary behavior:
- no active filters: muted inline text `No active filters`
- active tag filters: `Tags: #backend`, `Tags: #backend, #ops +1`, etc.
- multi-tag match mode: append `· match all` only when it changes meaningfully
- non-default sort: append concise sort text after tags

Styling direction:
- move away from filled summary pills in the collapsed state
- prefer inline text plus, optionally, a small neutral count badge
- this aligns with `docs/ux-design-guidelines.md`, which calls for compact toolbar height and warns against filter chips dominating toolbar surfaces

### 3. Make the shell explicitly compact when collapsed

Update `src/styles.css` so the filter card can render as a dense row when the body is hidden.

Recommended CSS direction:
- add an expanded/collapsed state class or data attribute on the filter section/button
- collapsed vertical padding should drop materially from the current card padding
- use a single-row grid/flex layout at normal desktop widths (`label | summary | indicator`)
- keep the click target comfortably usable even after reducing height
- only render the extra body spacing/divider when expanded

A good target is a collapsed desktop height closer to a compact toolbar row than a content card.

### 4. Preserve responsive behavior by degrading to two compact rows, not a full card

Responsive handling should prioritize density without clipping important state.

Recommended responsive behavior:
- at wider widths, keep the collapsed presentation to roughly one line
- at narrower widths, allow the summary to wrap beneath the label while keeping the eyebrow/title stack removed
- avoid reintroducing large vertical gaps, large pills, or extra headings on smaller screens
- ensure the chevron/expand affordance remains visible and aligned at all widths

### 5. Leave the expanded controls mostly intact

The expanded body already has the right controls and labeling. OD-25 should focus on the collapsed shell and summary presentation, not redesign the tag chips or sort inputs.

Expected markup/styling churn should stay concentrated in:
- the filter toggle row
- the collapsed-state modifier styling
- any lightweight helper needed to format a tighter summary string or active-count badge

## Regression coverage plan

Update `tests/e2e/tasks.spec.ts` to cover compactness directly instead of only text behavior.

### Default collapsed-state regression

Extend the existing collapsed-by-default test to verify:
1. the card still starts collapsed
2. the body is absent while collapsed
3. the compact summary row is visible
4. the old stacked eyebrow/title treatment is gone or no longer rendered in collapsed mode
5. the collapsed card height stays below a compact threshold at the default desktop viewport

### Active-filter visibility regression

Keep the current tag-filter summary assertion and strengthen it to verify that, after collapsing:
1. the active tag summary remains visible
2. a non-default sort also appears in the compact summary when changed
3. any active-count badge or compact state cue remains visible

### Responsive compactness regression

Add a targeted narrow-width test (or a viewport phase inside an existing overview test) that:
1. sets a narrower viewport
2. keeps filters collapsed
3. verifies the control remains compact and interactable
4. ensures the height stays within a small wrapped-state budget instead of regressing to the original tall card

### Expand/collapse behavior regression

Retain the current persistence/expand assertions so OD-25 does not accidentally break:
- expand/collapse toggling
- persisted expanded state when the user leaves filters open
- stale tag filter recovery flows

## Files expected to change

- `src/pages/tasks/TasksOverviewPage.tsx`
- `src/styles.css`
- `tests/e2e/tasks.spec.ts`

`src/pages/tasks/taskOverviewState.ts` should not need changes unless the implementation introduces a new persisted display flag, which does not appear necessary for this ticket.

## Validation

Run focused frontend coverage for the affected surface:

```bash
npm run test:e2e -- --grep "tasks overview"
```

If the implementation materially changes shared layout/CSS behavior beyond the overview filter row, also run:

```bash
npm run build
```
