# ORC-222 mobile task-detail overflow plan

## tl;dr
- Reproduce the bug in the mobile task-detail `.content` scroller, not only on `document.documentElement`.
- The overflow comes from task-detail cards/panels preserving intrinsic width on mobile when they render long unbroken tokens such as file paths, comment bodies, or titles.
- Tighten mobile task-detail shrink/wrap rules and add task-detail-local `overflow-x: hidden` containment so the inner page scroller cannot pan into empty right-side space.
- Add a mobile Playwright regression that seeds long file-path/comment content and asserts `.content.scrollWidth <= .content.clientWidth` while switching task-detail sections.

## Executive summary
I reproduced the issue in the mobile task-detail content scroller by seeding long task-detail content and measuring the actual scroll container (`.content`). At `390x844`, a seeded long default repo-file path pushed `.content.scrollWidth` to `471px` while `clientWidth` stayed `390px`; a long unbroken comment token pushed `.content.scrollWidth` to `3275px`. In both cases the visible task-detail shell stayed at the expected width, which explains the user symptom: mobile can pan right into blank space even though the document/root layout itself may still look correct.

The underlying problem is task-detail-specific mobile containment. The app already has some mobile overflow guards, but task detail still leaves several grid/flex descendants at their intrinsic width (`min-width: auto`) and does not force wrap-friendly behavior on task-detail headers/text. Long file paths, long comment tokens, and similar metadata can therefore widen cards/panels inside `.content`, and because `.content` uses `overflow: auto`, that width turns into horizontal page panning.

## Reproduction findings
1. Open task detail on mobile (`390x844`) through the existing mobile-nav flow.
2. Seed a task with a long default repo-file path and/or a long unbroken comment token.
3. Measure the page scroller, not just the document:
   - `.content.clientWidth === 390`
   - long repo-file path: `.content.scrollWidth === 471`
   - long unbroken comment token: `.content.scrollWidth === 3275`
4. `document.documentElement.scrollWidth` can remain normal for some cases, so a document-level assertion alone will miss this bug.

## Root cause
The widening comes from task-detail descendants inside the mobile `.content` scroller:
- summary cards and tab-panel cards/grid items keep intrinsic width on mobile
- task-detail headers and card text do not consistently force wraps for long tokens
- the repo-files/default-file surfaces are especially likely to surface long relative paths

The most important task-detail surfaces to harden are in `src/styles.css` around:
- `.task-detail-shell`
- `.task-page.task-detail-page.panel`
- `.task-detail-tabs-panel`
- `.task-detail-summary > *`
- `.task-detail-tabs__body > *`
- `.task-section > *`
- `.task-section-list > *`
- `.task-history-card`
- `.workflow-section__header > *`
- `.task-detail-summary__history-header > *`
- `.task-detail-header-actions` / `.task-detail-header-action-row`
- task-detail text nodes (`h2`, `h3`, `h4`, `strong`, `p`, `span`) plus the mobile topbar task title copy

## Recommended implementation
In `src/styles.css`, inside the existing mobile breakpoint:
1. Add `min-width: 0` / `max-width: 100%` guards to the task-detail-specific grid/flex descendants listed above so cards and headers can actually shrink with the viewport.
2. Add `overflow-wrap: anywhere` plus `word-break: break-word` to task-detail text surfaces that can render long file paths, tokens, or titles.
3. Add task-detail-local `overflow-x: hidden` containment on the mobile task-detail shell/panels (`.task-detail-shell`, `.task-page.task-detail-page.panel`, `.task-detail-tabs-panel`) so any remaining intrinsic-width/native-control oddities cannot widen the outer `.content` scroller.
4. Keep local inner scrollers such as the file viewer untouched so intentional horizontal scrolling remains scoped to the component that needs it.

## Regression coverage
Extend `tests/e2e/tasks.spec.ts` with a focused mobile overflow regression:
1. set viewport to `390x844`
2. open a seeded task detail on mobile
3. seed:
   - a long default repo-file path
   - a long unbroken comment token (or title token)
4. assert the outer task-detail scroller stays contained:
   - measure `.content.scrollWidth`
   - measure `.content.clientWidth`
   - expect `scrollWidth <= clientWidth`
5. switch between at least `repo-files` and `comments` using the mobile section select and repeat the containment assertion so both task-detail surfaces stay protected

## Suggested validation
- `npm run build`
- `npx playwright test tests/e2e/tasks.spec.ts -g "task detail"`
