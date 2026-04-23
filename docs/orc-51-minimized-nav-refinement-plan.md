# ORC-51 minimized nav refinement plan

## Context

OD-28 already converted the collapsed sidebar from two-letter labels to an icon rail, but the follow-on implementation still leaves the minimized state feeling like an adapted expanded layout instead of a purpose-built compact rail.

This task should finish that refinement pass by tightening the top section, making badge behavior deliberate in the narrow rail, and giving the collapsed project/menu affordances an explicit sizing and overflow strategy.

## Current-state findings

### 1. Hidden brand and project label rows still consume vertical space in the collapsed rail

The current collapsed styling hides text with `max-width: 0` and `opacity: 0`, but those elements still stay in normal layout flow:

- `src/App.tsx` always renders `.sidebar__brand-mark`, `.sidebar__brand-copy`, and the collapse toggle inside `.sidebar__brand`
- `src/components/ProjectSwitcher.tsx` always renders `.project-switcher__label`
- `src/styles.css` collapses those elements visually, but does not remove the brand-copy row or the project label row from the grid layout

That means the minimized rail still contains:
- the Orchestra mark
- an effectively invisible brand-copy row
- the expand/collapse button
- an effectively invisible `Project` label row
- the project switcher trigger

This explains the remaining empty space and awkward vertical rhythm near the top of the rail.

### 2. The current collapsed top section still communicates two competing identities

The user feedback is directionally correct: the minimized top area should primarily expose the expand affordance, not keep the brand mark plus invisible copy.

Right now the collapsed rail tries to preserve both:
- brand identity via the `O` mark
- structural control via the expand/collapse button

In a 76px rail, that produces clutter without adding much navigational value. The project switcher directly below already provides enough project context.

### 3. Badge placement is still based on the generic pill treatment, not the compact-rail geometry

Collapsed badges currently reuse the standard `.status-badge` with only a small absolute-position override:

- `.app-shell[data-sidebar-collapsed="true"] .project-switcher__badge`
- `.app-shell[data-sidebar-collapsed="true"] .nav-item__badge`

This works for single-digit counts, but it is still fragile for:
- multi-digit unread counts
- the project switcher unread marker
- active-state buttons whose icon needs to stay visually centered

The rail needs a dedicated badge rule set that treats the badge as a corner indicator attached to a compact control, not as a squeezed list-row pill.

### 4. The project switcher already receives `collapsed`, but the menu has no collapsed-specific sizing logic

`src/components/ProjectSwitcher.tsx` already sets `data-collapsed`, but `src/styles.css` does not use that state for menu behavior.

Today the menu always uses the same rule:
- `.project-switcher__menu { left: 0; right: 0; }`

That means the collapsed rail still inherits the expanded-menu positioning model, even though the trigger now lives inside a very narrow sidebar. The result is an awkward fit: either the menu is constrained by the rail when it should be readable, or it visually reads like an accidental overflow case rather than an intentional anchored popover.

### 5. Coverage exists for collapse persistence, but not for the refined layout rules this task needs

Existing tests already cover the broad collapse/expand behavior:
- `tests/e2e/app-header.spec.ts`
- `tests/desktop-e2e/navigation-layout.test.ts`

There is also badge coverage in:
- `tests/e2e/navigation-badges.spec.ts`
- `tests/desktop-e2e/navigation-badges.test.ts`

However, the current coverage does not lock down:
- removal of the collapsed top-area whitespace
- the decision to show only the expand button in the minimized header area
- collapsed badge geometry for icon-only controls
- collapsed menu width/alignment rules
- narrow-width overflow behavior for the collapsed project menu

## Intended collapsed-nav rules

### 1. Top controls

Desktop collapsed rail should use this order and hierarchy:

1. a compact rail header containing only the expand button
2. the project switcher trigger as the first interactive rail item below the header
3. primary nav items
4. bottom settings control

Implementation direction:
- keep the full `.sidebar__brand` treatment only in expanded mode
- in collapsed mode, render a dedicated top-control container that holds only the expand button
- remove the Orchestra mark and brand-copy from the collapsed header entirely
- do not render the standalone `Project` label row in the collapsed switcher state

This turns the minimized top area into a deliberate control stack instead of a partially hidden expanded header.

### 2. Badge placement

Collapsed rail badges should follow rail-specific rules:

- attach badges to compact controls as corner indicators
- keep the icon/avatar visually centered even when a badge is present
- use a smaller collapsed badge style than the default list-row pill
- cap large numeric values to a compact readable form such as `99+`
- preserve the dot-style outside-active-project marker for the switcher when there is unread work elsewhere

Recommended implementation direction:
- add a compact badge formatter/helper for collapsed rail counts
- add rail-specific badge CSS rather than relying only on the shared `.status-badge--compact`
- anchor the badge consistently near the upper-right corner of the control without increasing the control's effective width

### 3. Dropdown/menu width and alignment

Collapsed project/menu behavior should become an intentional popover model instead of an inherited full-width-sidebar menu.

Recommended rules:
- expanded sidebar: keep the menu aligned to the trigger width inside the sidebar column
- collapsed sidebar on desktop: open the menu as a floating panel aligned to the rail, but sized for readable project names
- use an explicit width clamp such as a readable minimum plus a viewport-aware maximum
- keep the menu within the viewport even when the rail sits against the left edge
- avoid a layout where the menu looks clipped to the 76px rail or visually bursts out of it without clear anchoring

The most practical implementation is:
- keep the current in-column menu behavior when expanded
- add a collapsed-only menu rule keyed off `data-collapsed="true"`
- position the menu from the rail edge with a deliberate offset
- constrain width with `min()` / `max()` / `clamp()` and a viewport max-width

### 4. Overflow behavior on narrow widths

Below the existing mobile breakpoint, the app should continue to prefer the single-column shell.

For the minimized-nav follow-up specifically:
- the collapsed project menu should not rely on a desktop popover width when the viewport is narrow
- mobile/narrow layouts should fall back to an in-column menu width that stays within the page width
- badge and trigger sizing should remain readable without causing horizontal overflow

## Recommended implementation plan

### 1. Split expanded and collapsed header markup in `src/App.tsx`

Refactor the sidebar header so the collapsed rail is not produced by partially hiding the expanded brand block.

Recommended approach:
- render the current `.sidebar__brand` only when `isSidebarCollapsed === false`
- render a dedicated collapsed header wrapper when `isSidebarCollapsed === true`
- keep the existing toggle button and accessible names, but move it into the collapsed-only header
- continue to pass `collapsed` into `ProjectSwitcher`

This is the cleanest way to remove the wasted vertical rows instead of fighting them with more CSS.

### 2. Make `ProjectSwitcher` omit collapsed-only dead rows

Update `src/components/ProjectSwitcher.tsx` so the collapsed state does not render the standalone label row.

Recommended changes:
- conditionally render `.project-switcher__label` only when expanded
- keep the trigger accessible name/title in both states
- preserve the avatar/monogram as the collapsed trigger identity
- keep the unread indicator visible in collapsed mode, but switch it to the rail-specific badge treatment

### 3. Introduce rail-specific layout classes in `src/styles.css`

Add dedicated rules for:
- collapsed top header spacing
- compact project-switcher trigger spacing
- rail badge geometry
- collapsed menu anchoring and width constraints

Important detail: prefer explicit collapsed-only layout rules over more `max-width: 0` hiding for elements that create their own grid rows.

### 4. Expand regression coverage for the new layout rules

#### `tests/e2e/app-header.spec.ts`

Add assertions for collapsed mode that verify:
- the brand text is no longer visible in the minimized top section
- the collapse header exposes only the expand button at the top
- the project switcher still has an accessible name/title
- the collapsed project switcher and first nav item do not have unexpected vertical gaps caused by hidden label rows

A simple, robust way to assert the spacing improvement is to compare the bounding boxes of:
- the toggle button
- the project switcher trigger
- the first nav item

#### `tests/e2e/navigation-badges.spec.ts`

Extend badge coverage to collapsed mode:
- collapse the sidebar before asserting badge rendering
- verify that unread badges still render on the icon rail
- verify the project-switcher marker remains understandable in collapsed mode
- update the spec to match the current outside-active-project marker semantics if the UI keeps the dot treatment instead of the old `*`

#### `tests/desktop-e2e/navigation-layout.test.ts`

Add a compact set of geometry assertions that are realistic in the desktop harness:
- the rail still toggles collapsed and expanded
- the collapsed header contains the expand control
- the project switcher menu can open from collapsed mode without an unreadable width

## Files expected to change

- `src/App.tsx`
- `src/components/ProjectSwitcher.tsx`
- `src/styles.css`
- `tests/e2e/app-header.spec.ts`
- `tests/e2e/navigation-badges.spec.ts`
- `tests/desktop-e2e/navigation-layout.test.ts`

## Validation

Recommended focused checks after implementation:

```bash
npm run test:e2e -- tests/e2e/app-header.spec.ts tests/e2e/navigation-badges.spec.ts
npm run test:web-driver:e2e -- tests/desktop-e2e/navigation-layout.test.ts
```

Manual verification should also cover:
- expanded -> collapsed -> expanded transitions
- a badge-free rail and a multi-badge rail
- collapsed project switcher with and without unread counts
- menu alignment above and below the mobile breakpoint
- at least one light theme and one dark theme
