# ORC-163 task detail mobile section select plan

## tl;dr
- Replace only the mobile task-detail bottom tab row with a compact native select.
- Keep the desktop/non-mobile bottom tab dock and existing tab button data roles intact.
- Reuse the current `activeTab` + `handleTabSelect(...)` path so section state, comments-read behavior, repo-file loading, and scroll behavior stay centralized.
- Scope visibility with CSS at the app mobile breakpoint (`@media (max-width: 900px)`), not viewport-specific React state.
- Add focused Playwright coverage for mobile section switching and keep/adjust desktop dock coverage to prove non-mobile behavior stays unchanged.

## Executive summary
`src/pages/tasks/TaskDetailPage.tsx` already has a clean section model: `TaskDetailTab`, `TAB_OPTIONS`, `activeTab`, `handleTabSelect(...)`, and `renderTabPanel()`. The poor mobile UX comes from the fixed bottom dock rendering every section as a horizontal tab button row. ORC-163 should add a mobile-only select control backed by the same `TAB_OPTIONS` and `activeTab`, while preserving the existing desktop dock markup for non-mobile layouts.

The lowest-risk implementation is to render both navigation variants inside the existing dock container and let `src/styles.css` swap them by breakpoint. On desktop/tablet, show the current `role="tablist"` button row. On mobile, hide that button row and show a labeled select with one option per `TAB_OPTIONS` entry. The select value must be `activeTab`; changing it should call `handleTabSelect(nextTab)` so all current side effects remain shared.

## Current-state findings
- `src/pages/tasks/TaskDetailPage.tsx` defines `TaskDetailTab` and `TAB_OPTIONS` for the detail sections.
- `activeTab` defaults to `"repo-files"` and drives `renderTabPanel()`.
- `handleTabSelect(tabId)` updates `activeTab` and scrolls `tabBodyRef` into view.
- Other flows already update `activeTab` directly or via `handleTabSelect(...)`, including:
  - summary "View all comments"
  - file mention links returning to `repo-files`
  - comments-read tracking when `activeTab === "comments"`
  - repo-file content loading when `activeTab === "repo-files"`
- The bottom nav is rendered in `.task-detail-tab-dock` as `.task-detail-tabs.task-detail-tabs--dock` with a `role="tablist"` and `data-role="task-detail-tab-*"` buttons.
- CSS currently gives the task detail surfaces enough bottom padding for the fixed dock via `padding: 0 0 112px`.
- Existing Playwright coverage relies on desktop tab buttons in `tests/e2e/tasks.spec.ts`, including the bottom dock scrolling test and many `task-detail-tab-*` clicks.

## Recommended implementation

### 1. Keep the current tab model
Do not introduce a second source of truth for the selected section.

Use:
- `TAB_OPTIONS`
- `activeTab`
- `handleTabSelect(...)`
- `renderTabPanel()`

Add a small derived helper if useful:

```tsx
const activeTabOption = TAB_OPTIONS.find((tab) => tab.id === activeTab) ?? TAB_OPTIONS[0];
```

### 2. Add a mobile-only select inside the existing dock
In `TaskDetailPage.tsx`, render a new control adjacent to the existing desktop tablist, for example:

```tsx
<label className="task-detail-section-select" data-role="task-detail-section-select-mobile">
  <span className="task-detail-section-select__label">Section</span>
  <select
    className="select-input task-detail-section-select__control"
    aria-label="Task detail section"
    value={activeTabOption.id}
    onChange={(event) => handleTabSelect(event.target.value as TaskDetailTab)}
  >
    {TAB_OPTIONS.map((tab) => (
      <option key={tab.id} value={tab.id}>{tab.label}</option>
    ))}
  </select>
</label>
```

Recommended data roles:
- wrapper: `task-detail-section-select-mobile`
- optional select-specific role if tests prefer it: `task-detail-section-select-control`

### 3. Preserve desktop/non-mobile markup
Keep the current desktop tablist intact:
- `role="tablist"`
- `aria-label="Task detail panels"`
- `data-role="task-detail-tab-summary"`
- `data-role="task-detail-tab-${tab.id}"`
- `aria-selected` on active tab buttons

This avoids rewriting the existing desktop e2e paths.

### 4. Scope the change with CSS only
In `src/styles.css`:
- default: hide `.task-detail-section-select`
- mobile (`@media (max-width: 900px)`):
  - hide `.task-detail-tabs--dock`
  - show `.task-detail-section-select`
  - keep `.task-detail-tab-dock` fixed at the bottom with safe-area padding
  - make the select full width/min-width 0 so it does not overflow narrow screens

Recommended shape:

```css
.task-detail-section-select {
  display: none;
}

.task-detail-section-select__control {
  width: 100%;
  min-width: 0;
}

@media (max-width: 900px) {
  .task-detail-tab-dock .task-detail-tabs--dock {
    display: none;
  }

  .task-detail-section-select {
    display: grid;
    gap: 6px;
    width: 100%;
    min-width: 0;
  }
}
```

Use the existing app mobile breakpoint unless implementation testing shows a stronger reason to align with a narrower task-detail-specific breakpoint.

### 5. Be careful with the "Task details" jump button
The current dock has a `Task details` jump button that scrolls to the summary, but it is not a real `TaskDetailTab`. The mobile select should only represent the active section tabs so it can truthfully reflect `activeTab`.

If mobile still needs a summary jump after hands-on testing, add it as a separate small button near the select, not as a fake select option, unless scroll-position tracking is also added. Avoid a select option that snaps back to a different value after selection.

### 6. Keep comments and repo-files side effects intact
Because the select calls `handleTabSelect(...)`, these behaviors should remain correct:
- selecting Comments marks unread comments viewed through the existing effect
- selecting Repo files loads/maintains the selected file reference through the existing effect
- clicking summary comment/file affordances still updates `activeTab`, causing the select to reflect the new section

## Regression coverage plan

Update `tests/e2e/tasks.spec.ts`.

### Add focused mobile coverage
Add a mobile viewport test around task detail navigation:
1. `page.setViewportSize({ width: 390, height: 844 })`
2. open Tasks through the mobile nav and open a task detail
3. assert `task-detail-section-select-mobile` is visible
4. assert the desktop tablist (`getByRole('tablist', { name: 'Task detail panels' })`) is hidden or absent from the visible mobile UI
5. select `comments`; assert:
   - select value is `comments`
   - `task-detail-tabpanel-comments` is visible
6. select `todos` or `attachments`; assert the matching panel is visible and the select value updates
7. click the summary `open-task-comments` button if visible/reachable on mobile; assert the select reflects `comments`

### Preserve desktop coverage
Keep the existing desktop-oriented tab tests unless they need selector scoping. The existing "task detail keeps the bottom tab dock visible while scrolling" test should continue to assert:
- desktop tablist is visible
- bottom dock stays near the viewport bottom
- tab button switching still works

Optionally add a small desktop assertion that `task-detail-section-select-mobile` is not visible at desktop width.

### Suggested targeted verification
After implementation, run at least:
- `npm run build`
- `npx playwright test tests/e2e/tasks.spec.ts -g "task detail"`

If time allows, also run the full `npm run test:e2e` or the broader tasks spec.

## Implementation checklist
1. Add the mobile section select markup to `TaskDetailPage.tsx` inside the existing dock.
2. Wire select `value` to `activeTab` and `onChange` to `handleTabSelect(...)`.
3. Add CSS for hidden-by-default mobile select and mobile-only dock swap.
4. Add mobile Playwright coverage for section switching.
5. Confirm desktop tablist behavior and existing `task-detail-tab-*` selectors still pass.
6. Run build and targeted e2e verification.
