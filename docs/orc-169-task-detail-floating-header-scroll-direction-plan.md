# ORC-169 task-detail floating-header scroll-direction plan

## tl;dr
- Split compact-header state into **eligible/rendered** vs **shown** so it can animate out while scrolling down and animate back on upward intent.
- Reuse the existing task-detail scroll-root measurement, but add direction tracking with a small accumulated-delta threshold to suppress jitter.
- Hide the floating header with a CSS transform/opacity transition and `visibility`/pointer safeguards; keep the bottom tab dock behavior unchanged.
- Update long task-detail Playwright coverage to assert: down hides, up shows, tiny jitter does not toggle, and mobile topbar spacing still holds when shown.

## Executive summary
`src/pages/tasks/TaskDetailPage.tsx` already measures the task detail scroll container, primary-header sentinel, content bounds, and mobile topbar offset to decide when the compact floating header is eligible. Today `compactHeaderVisible` is derived only from scroll position/sentinel state, so once the user is deep enough in the task, the header stays visible even while downward scrolling. ORC-169 should keep that eligibility logic, but add scroll-direction intent: meaningful downward movement hides the floating header, meaningful upward movement reveals it again. CSS should animate the same fixed header out of the way without changing document layout, while preserving the bottom tab dock and existing task actions.

## Current-state findings
- `TaskDetailPage.tsx` owns floating chrome in one effect near the existing `compactHeaderSentinelRef`.
- The effect finds the nearest vertical scroll root, resets the task detail to the top on task change, computes `floatingChromeLayout`, and sets `compactHeaderVisible` from `scrollPosition > 120 && sentinel.top <= pinnedTop + 4`.
- The compact header is conditionally rendered only when `!isEditing && compactHeaderVisible && stickyChromeStyle`.
- `.task-detail-floating-header` is fixed-position chrome with no transition state; `.task-detail-tab-dock` shares the fixed layout style but must remain independently visible.
- Existing E2E coverage expects the compact header to be visible after jumping deep into a long task detail, so those assertions need to be adjusted for direction-based behavior.

## Recommended implementation

### 1. Separate eligibility from show/hide intent
In `src/pages/tasks/TaskDetailPage.tsx`:
- replace the single `compactHeaderVisible` meaning with two concepts, for example:
  - `compactHeaderPinned` / `compactHeaderEligible`: the sentinel and scroll position say the floating header may be rendered.
  - `compactHeaderShown`: the scroll-direction state says the header should currently be visible.
- render the compact header when eligible and layout exists, then apply a hidden class/data state when it is not shown.
- keep `!isEditing` as an outer guard so edit mode behavior does not change.
- reset both states to the initial top-of-page state on task changes and when no scroll root/layout is available.

### 2. Add thresholded scroll-direction tracking
Inside the existing floating chrome effect:
- keep the current scroll-root discovery, layout calculation, pinned top calculation, and sentinel eligibility check.
- track the last scroll position in effect-local refs/variables.
- ignore tiny deltas, e.g. `Math.abs(delta) < 2`.
- accumulate consecutive movement in the same direction and only toggle after a meaningful threshold, e.g. `24–32px`.
- on meaningful downward movement while eligible, set `compactHeaderShown` false.
- on meaningful upward movement while eligible, set `compactHeaderShown` true.
- when not eligible or near the top, hide/unrender the compact header and clear accumulated direction state.
- avoid treating resize-only remeasurements as scroll intent.

### 3. Animate without layout interference
In `src/styles.css`:
- add a smooth transition to `.task-detail-floating-header` for `transform`, `opacity`, and delayed `visibility`.
- add a hidden modifier such as `.task-detail-floating-header--hidden` or `data-scroll-state="hidden"` that uses:
  - `transform: translateY(calc(-100% - 12px));`
  - `opacity: 0;`
  - `visibility: hidden;`
  - `pointer-events: none;`
- keep the normal visible state at the existing fixed `top` value so mobile topbar spacing logic stays centralized in `floatingChromeLayout.top`.
- add a `prefers-reduced-motion: reduce` override to remove or shorten the transition.
- do not change `.task-detail-tab-dock`; the bottom dock should stay visible while scrolling.

### 4. Preserve sensible initial/top behavior
- On initial load, the primary task header remains visible at the top and the compact header should not render until the sentinel has passed the pinned top threshold.
- If the user scrolls down from the top, the compact header should either stay hidden when it first becomes eligible or animate away immediately after the thresholded downward intent.
- If the user scrolls upward while deep in the page, the compact header should reappear even though the scroll position is still far from the top.
- Programmatic jumps from tab/dock actions should not flicker; they should settle based on the final measured direction and threshold.

### 5. Regression coverage
Update `tests/e2e/tasks.spec.ts` near the existing task-detail dock/header tests:
- Extend the long-detail scenario to assert the bottom tab dock remains visible while the compact header hides on downward scroll.
- Add or update a focused test that:
  1. opens a long task detail,
  2. scrolls downward past the sentinel and verifies `[data-role="task-detail-compact-header"]` is hidden or has `data-scroll-state="hidden"`,
  3. scrolls upward by more than the threshold and verifies it is visible/shown,
  4. applies small alternating scroll deltas below the threshold and verifies the state does not rapidly toggle.
- Update the mobile topbar test to reveal the compact header via upward scrolling before measuring that its top is still below `[data-role="mobile-topbar"]`.

## Validation
- `npm run build`
- Targeted Playwright: `npx playwright test tests/e2e/tasks.spec.ts -g "task detail"`
- If runtime permits, `npm run test` for existing Vitest coverage.

## Non-goals
- Do not redesign the task detail header content or action menu.
- Do not change the bottom tab dock show/hide behavior.
- Do not introduce global app-header scroll behavior; this is task-detail-specific chrome.
- Do not remove the existing sentinel/topbar/layout protections.
