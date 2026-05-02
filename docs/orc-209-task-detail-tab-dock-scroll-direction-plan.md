# ORC-209 task-detail tab-dock scroll-direction plan

## tl;dr
- Reuse the existing task-detail floating-chrome scroll effect to add a dock `shown` state driven by thresholded scroll direction.
- Keep the dock mounted, but animate it off the viewport while scrolling down and bring it back while scrolling up.
- Apply the behavior to both desktop tabs and the mobile section select, since both already live inside the same `.task-detail-tab-dock` container.
- Update task-detail Playwright coverage so downward scroll hides the dock, upward scroll reveals it, and mobile bottom-right FAB space is no longer obstructed.

## Executive summary
The current codebase only renders this floating tab dock from `src/pages/tasks/TaskDetailPage.tsx`; there is not a separate shared floating-tab component elsewhere in `src/` today. The lowest-risk fix is therefore a scoped change in the existing task-detail floating-chrome effect: add dock visibility state beside the compact-header state, drive both from the same accumulated scroll-intent logic, and hide/reveal the dock with CSS transforms instead of unmounting it. That preserves the existing tab/select markup, keeps layout stable, and removes the persistent bottom overlay that can cover the mobile chat FAB.

## Current-state findings
- `src/pages/tasks/TaskDetailPage.tsx` already owns floating chrome measurement through one effect that:
  - finds the nearest scroll root,
  - computes `floatingChromeLayout`,
  - tracks compact-header scroll direction with `COMPACT_HEADER_SCROLL_EPSILON` and `COMPACT_HEADER_DIRECTION_THRESHOLD`.
- The compact header already has separate `eligible` vs `shown` behavior, but the bottom dock does not; `.task-detail-tab-dock` renders whenever `stickyChromeStyle` exists.
- The same dock container serves both breakpoints:
  - desktop/tablet: `.task-detail-tabs.task-detail-tabs--dock`
  - mobile: `.task-detail-section-select`
- `src/styles.css` gives the dock fixed positioning and safe-area padding, but no hidden modifier or transition state.
- Existing E2E coverage in `tests/e2e/tasks.spec.ts` still asserts that the dock stays visible after downward scrolling, so those expectations must change.

## Recommended implementation

### 1. Extend the existing floating-chrome state in `TaskDetailPage.tsx`
- Add a dock-specific boolean such as `tabDockShown`, initialized/reset to `true` when the task changes or when floating layout is unavailable.
- Reuse the current direction-accumulation logic inside the floating-chrome effect instead of creating a second scroll listener.
- On meaningful downward intent, set `tabDockShown` to `false`.
- On meaningful upward intent, set `tabDockShown` to `true`.
- Keep compact-header eligibility separate: the header should still require sentinel eligibility, while the dock can simply default to shown near the top.
- Optional cleanup: rename the existing scroll constants to floating-chrome-generic names if both header and dock will now share them.

### 2. Keep one dock render path and apply state through class/data attributes
In `src/pages/tasks/TaskDetailPage.tsx`:
- continue rendering the dock whenever `stickyChromeStyle` exists,
- add a hidden modifier such as `task-detail-tab-dock--hidden` and/or `data-scroll-state="hidden|visible"`,
- leave the existing tab buttons, mobile select, and data roles intact.

This avoids remount churn, keeps selectors stable, and means both desktop and mobile dock variants inherit the same behavior automatically.

### 3. Add dock hide/reveal styling in `src/styles.css`
Add a transition model parallel to the compact header, but moving downward instead of upward:
- visible state: current fixed dock styling,
- hidden state:
  - `transform: translateY(calc(100% + 12px));`
  - `opacity: 0;`
  - `visibility: hidden;`
  - `pointer-events: none;`
- include a `prefers-reduced-motion: reduce` override,
- keep existing safe-area padding, border, blur, and z-index behavior.

Because the dock stays mounted and only animates out, content spacing and section navigation state remain unchanged.

### 4. Update regression coverage
In `tests/e2e/tasks.spec.ts`:
- replace the existing “dock stays visible while scrolling” expectation with direction-aware assertions:
  1. open a long task detail,
  2. scroll downward and assert the dock reports hidden state,
  3. scroll upward past the threshold and assert the dock reports visible state again,
  4. verify the dock is usable again once shown.
- add a mobile-width variant that confirms the same hide/reveal behavior for the section-select dock.
- if the mobile chat FAB has a stable selector in this harness, add a geometry or clickability assertion while the dock is hidden; otherwise the hidden dock state itself is the core regression guard for the overlap bug.
- keep the existing edit-FAB overlap test, but ensure it measures after the dock is in its visible state.

## Validation
- `npm run build`
- `npx playwright test tests/e2e/tasks.spec.ts -g "task detail"`

## Non-goals
- Do not introduce a new shared floating-tab abstraction unless another real usage site appears during implementation.
- Do not redesign the task-detail tab labels, section select, or edit FAB behavior.
- Do not change the compact-header top-offset/mobile-topbar spacing rules beyond reusing the same scroll-intent signal.
- Do not change unrelated floating action buttons outside task detail.