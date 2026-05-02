# ORC-204 task detail details-nav plan

## tl;dr
- Turn `Details` into the first shared task-detail nav item instead of keeping a special-case `Task details` jump button.
- Keep `activeTab` as the real panel state, but add a small nav selection model that can represent `"details" | TaskDetailTab`.
- Reuse `handleScrollToTaskDetails()` for `Details` and keep `handleTabSelect(...)` for the real tab panels.
- Reorder the remaining items to match the existing task-detail section sequence: Runtime, Hierarchy, Dependencies, Repo files, Todos, Attachments, Comments, Timeline, Lane history.
- Update desktop and mobile task-detail e2e coverage to assert the new label/order and the scroll-to-top behavior.

## Executive summary
`src/pages/tasks/TaskDetailPage.tsx` currently mixes two navigation models: a standalone `Task details` jump button and a separate `TAB_OPTIONS` list that starts at `Repo files`. ORC-204 should unify that into one details-first navigation model shared by the desktop dock and the mobile section select.

The lowest-risk implementation is to preserve the existing panel state and side effects (`activeTab`, repo-file loading, unread-comment marking), while adding a small derived nav value that can truthfully represent the top summary/details region. That gives the UI a real `Details` first entry without restructuring the summary into a fake tab panel.

## Current-state findings
- `TaskDetailTab` only models the lower tab panels.
- The dock renders `Task details` as a one-off button before `TAB_OPTIONS`.
- The mobile select only renders `TAB_OPTIONS`, so it cannot target the top-of-page details region.
- `TAB_OPTIONS` order currently starts `Repo files`, `Comments`, `Todos`, ... even though the detail sections are defined in a different order in `renderTabPanel()`.
- Existing regression coverage in `tests/e2e/tasks.spec.ts` assumes the desktop jump label is `Task details` and the mobile select defaults to `repo-files`.

## Recommended implementation

### 1. Add a shared nav-item model
In `src/pages/tasks/TaskDetailPage.tsx`, introduce a nav type that can include the summary section:

```ts
type TaskDetailNavItem = "details" | TaskDetailTab;
```

Back both the desktop dock and mobile select from one ordered nav list:
- `details`
- `runtime`
- `hierarchy`
- `dependencies`
- `repo-files`
- `todos`
- `attachments`
- `comments`
- `timeline`
- `history`

Keep `activeTab` defaulting to `"repo-files"` so the current repo-file preload path and existing tab-side effects do not change.

### 2. Keep nav selection separate from panel selection
Do **not** make `details` a fake tab panel.

Instead:
- keep `activeTab` as the selected lower panel
- add a derived/current nav selection that can be `details` when the summary/top region is the visible destination
- selecting `details` should call `handleScrollToTaskDetails()`
- selecting a real tab should continue to call `handleTabSelect(tabId)`

This is the key architectural change that lets mobile include `Details` without lying about the visible section.

### 3. Drive `Details` from scroll position, not a one-shot reset
The ORC-163 mobile-select caveat only goes away if `Details` is scroll-aware.

Recommended behavior:
- initial load: nav reads as `Details` because the top summary is in view
- after selecting a lower tab: nav reads as that tab
- after choosing `Details`: the page scrolls to the header/summary and the nav reads as `Details` again
- when the user scrolls back down to the tab body, nav falls back to the current `activeTab`

Implementation-wise, prefer reusing the existing task-detail scroll-root/position logic already present in this component instead of adding a totally separate global scroll path.

### 4. Update the dock/select rendering with minimal churn
- Desktop dock: replace the special-case `Task details` label/button with the shared first nav item labeled `Details`.
- Keep real panel items as tabs; `Details` can remain a button styled like the tabs.
- Mobile select: include `Details` as the first `<option>` and bind the select value to the nav item model, not raw `activeTab`.
- `src/styles.css` should only need light touch-up so the `Details` item shares the same visual treatment as the other dock controls.

If possible, preserve existing data-role hooks for the summary jump control to minimize avoidable selector churn.

## Regression coverage
Update `tests/e2e/tasks.spec.ts`.

### Desktop
- Replace the `Task details` expectation/click with `Details`.
- Assert the dock order starts with `Details` and the remaining labels follow the intended section order.
- Keep the existing scroll-back-to-top assertion.

### Mobile
- Assert the section select includes `Details` as the first option.
- Update the initial expected value to `details` when the summary is in view.
- Keep section switching assertions for `comments`/`todos`.
- Add a `details` re-selection assertion that scrolls back to the top summary area.

## Files expected to change
- `src/pages/tasks/TaskDetailPage.tsx`
- `src/styles.css` (small visual/state follow-up only if needed)
- `tests/e2e/tasks.spec.ts`
