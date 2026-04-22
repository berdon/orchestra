# OD-23 task-detail tag placement plan

## Problem summary

Task detail currently renders tags in their own overview card instead of alongside the title/context they describe. In `src/pages/tasks/TaskDetailPage.tsx`, the read-only summary includes a dedicated `data-role="task-overview-tags"` section with its own heading, count badge, and empty state. That adds visual weight and forces users to scan two separate places for closely related task metadata.

OD-23 should simplify that layout by removing the standalone tags card and rendering tags directly under the task title in the primary task-detail header.

## Current-state findings

### Primary task-detail header

`src/pages/tasks/TaskDetailPage.tsx`
- The main header already renders the task eyebrow, `h2` title (`data-role="task-title-heading"`), and the compact metadata row (`.session-detail__meta`).
- This is the right placement for tags because it is the first persistent context block in the detail view and sits immediately above the description card.

### Separate tags card to remove

`src/pages/tasks/TaskDetailPage.tsx`
- The read-only summary currently renders a standalone `<section className="task-history-card" data-role="task-overview-tags">`.
- That section contains the `Task tags` heading, a count badge, read-only tag chips, and the `data-role="task-tags-empty"` empty placeholder.
- Removing this section is the core UI change for the ticket.

### Existing regression coverage that assumes the old layout

`tests/e2e/tasks.spec.ts`
- The existing task-tag flow asserts tags inside `[data-role="task-overview-tags"] [data-role="task-tag-chip"]` after save/edit.
- Those selectors will need to move to the new header placement, and the regression should also assert that the old standalone section no longer renders.

### Styling constraint to account for

`src/styles.css`
- There are shared task-tag chip/list styles already in the app.
- The task detail implementation should not rely on the compact overview/card/table defaults alone, because the title area needs wrap-friendly spacing and should remain readable for multi-tag tasks.
- A detail-specific header tag row is safer than trying to reuse the removed card layout verbatim.

## Recommended implementation

### 1. Move read-only tag rendering into the primary header

Update `src/pages/tasks/TaskDetailPage.tsx` so the left side of the primary header becomes a small stacked block:

1. eyebrow
2. task title
3. tag row (only when tags exist)
4. existing metadata row

Recommended structure:
- add a dedicated header copy wrapper, e.g. `.task-detail-primary-header__copy`
- add a dedicated tag row container, e.g. `data-role="task-title-tags"`
- keep chip-level selectors stable with `data-role="task-tag-chip"` and `data-tag-value`

This preserves testability while moving the tags into the correct visual context.

### 2. Remove the standalone overview tags section entirely

Delete the dedicated `task-overview-tags` card from the read-only summary. After this change, the summary should begin with the description card rather than a separate tags block.

Recommended empty-state behavior:
- when a task has no tags, render no tag row under the title
- do not replace the removed card with a new `No tags` line under the title, because that would recreate unnecessary visual noise

### 3. Reuse canonical tag ordering/normalization

If the detail header keeps custom rendering instead of using `TaskTagList`, derive the displayed list from the same normalized tag helper used elsewhere (`getTaskTags(...)`) so the detail view stays consistent with board/table rendering and existing tag expectations.

### 4. Keep the floating compact header unchanged

`TaskDetailPage.tsx` already has a compact floating header used while scrolling. That surface should stay compact:
- keep task number/title/status there
- do not duplicate the full tag row into the floating header

This keeps the always-visible chrome dense while still putting tags in the main detail header where users first read task context.

## CSS/layout plan

Update `src/styles.css` with detail-header-specific styles instead of reviving the removed card styles:
- `.task-detail-primary-header__copy`
- `.task-detail-primary-header__tags`
- optional detail-specific chip adjustments if the existing generic tag chip spacing feels too tight under the `h2`

Layout goals:
- tags should wrap cleanly onto multiple lines
- spacing between title, tags, and metadata should remain tighter than a full content card
- long tag sets should not push header actions into overlap

## Regression coverage plan

Update `tests/e2e/tasks.spec.ts` in the existing tag flow test to verify:

1. tags render in the new header container, e.g. `[data-role="task-title-tags"] [data-role="task-tag-chip"]`
2. the standalone section is gone: `[data-role="task-overview-tags"]` has count `0`
3. tags still update correctly after editing
4. chip ordering remains stable (`api`, `backend`, `ops` in the current test scenario)

A lightweight additional assertion in the draft/no-tag flow is also worthwhile:
- confirm that a task without tags does not render the old overview section
- optionally confirm the new header tag row is absent when there are no tags

## Files expected to change

- `src/pages/tasks/TaskDetailPage.tsx`
- `src/styles.css`
- `tests/e2e/tasks.spec.ts`

## Validation

Run focused coverage for the affected surfaces:

```bash
npm run test:e2e -- --grep "task create and detail flows support free-form tags"
```

If the implementation introduces any helper extraction or component-level logic beyond markup movement, run the relevant Vitest coverage too.
