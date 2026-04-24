# ORC-132 mobile navigation plan

## tl;dr

- The current `<=900px` shell only stacks the desktop sidebar above content; it does not create a real mobile navigation model.
- Desktop collapse state currently leaks into the narrow layout, so mobile can still render the icon-rail treatment instead of an intentional menu.
- Replace the mobile sidebar presentation with a compact top bar + hamburger trigger that opens a dismissible overlay sheet containing project switching, primary navigation, and the active page's secondary nav when needed.
- Keep the existing desktop/tablet sidebar and collapsed-rail behavior intact, including the persisted `sidebar-collapsed` preference.
- Lock the result down with real viewport Playwright coverage for mobile open/close/navigation flows while preserving the existing desktop navigation tests.

## Executive summary

At `@media (max-width: 900px)`, `src/styles.css` collapses the shell to a single column, but `src/App.tsx` still renders the same desktop sidebar structure, including the desktop collapse affordance and inline secondary nav sections. That gives small screens a squeezed desktop stack instead of a deliberate mobile menu. ORC-132 should introduce a mobile-only navigation model: a compact top bar with a hamburger trigger that opens a backdrop-backed navigation sheet. The sheet should contain the project switcher, the primary destinations, and any active secondary nav for `Chat` or `Settings` so mobile does not lose functionality. Desktop and tablet behavior should stay on the existing sidebar/collapsed-rail path, and automated coverage should explicitly prove both modes at realistic viewport sizes.

## Current-state findings

### 1. The narrow breakpoint changes layout, not navigation semantics

Relevant code:
- `src/styles.css`
- `src/App.tsx`

Current behavior:
- `@media (max-width: 900px)` changes `.app-shell` to one column.
- `.sidebar` becomes a normal top block instead of a sticky left rail.
- The same sidebar contents still render inline: brand/collapse toggle, project switcher, full primary nav, and bottom Settings section.

Result:
- mobile gets a stacked desktop sidebar, not a hamburger/dropdown menu
- active-page secondary nav can make the top-of-page stack much taller than intended
- the responsive state feels accidental rather than designed

### 2. Desktop collapse state still affects the narrow layout

Relevant code:
- `src/App.tsx`
- `src/styles.css`
- `tests/e2e/app-header.spec.ts`

Current behavior:
- `isSidebarCollapsed` is loaded from and persisted to `orchestra.preferences.sidebar-collapsed`.
- The narrow breakpoint forces a single-column shell, but it does not disable the collapsed icon-rail styling.
- The current mobile test only asserts that the shell becomes one column when collapsed.

Result:
- a stored desktop collapse preference can carry an icon-only navigation treatment into mobile
- mobile behavior is coupled to a desktop affordance that should remain desktop-specific

### 3. Page-specific secondary nav is currently embedded in the sidebar stack

Relevant code:
- `src/App.tsx`

Current behavior:
- `Chat` renders the agent tablist inside the primary nav area when active and expanded.
- `Settings` renders the settings tablist in the bottom sidebar section when active and expanded.

Result:
- if mobile simply hides the sidebar without a replacement container, those secondary destinations become harder or impossible to reach
- the mobile menu design needs to account for active secondary nav, not just top-level destinations

### 4. Automated coverage is strong for desktop collapse, weak for mobile behavior

Relevant tests:
- `tests/e2e/app-header.spec.ts`
- `tests/desktop-e2e/navigation-layout.test.ts`

Current behavior:
- desktop coverage already protects collapse/expand persistence and collapsed rail geometry
- mobile coverage only checks that the grid collapses to a single column at `840px`

Gap:
- no automated assertion for a hamburger trigger
- no open/close flow coverage for mobile nav
- no test that mobile navigation closes after choosing a destination
- no test that desktop behavior stays intact while the mobile UX changes

## Intended mobile navigation UX

### 1. Use a dedicated mobile navigation state

Recommended behavior:
- derive `isMobileNavigation` from the existing `900px` breakpoint in `src/App.tsx`
- add ephemeral `isMobileNavigationOpen` state
- close the mobile menu when:
  - the viewport exits mobile width
  - the user chooses a destination or project
  - the user dismisses the menu
- keep `isSidebarCollapsed` as a desktop/tablet preference only
- do **not** persist mobile open/closed state to local storage

Key rule:
- mobile should ignore the desktop collapsed rail presentation even when `orchestra.preferences.sidebar-collapsed === "true"`

### 2. Replace the always-visible mobile sidebar with a compact top bar

Recommended behavior at `<=900px`:
- render a compact header/top bar instead of the full inline sidebar stack
- include:
  - Orchestra brand/app identity
  - concise current-project context if useful
  - a hamburger trigger button

Hamburger trigger requirements:
- accessible name toggles between `Open navigation` and `Close navigation`
- `aria-expanded` reflects menu state
- `aria-controls` points at the mobile nav sheet
- tap target should remain at least ~44px

### 3. Open a real dismissible navigation sheet, not an always-visible stack

Recommended presentation:
- open a backdrop-backed sheet/panel from the top bar area
- use dialog-like semantics (`role="dialog"` / `aria-modal`) with an internal `<nav>` rather than menu-role semantics for the whole structure
- keep the panel readable on very small screens: effectively full-width or nearly full-width within the viewport, not a squeezed desktop rail

Sheet contents:
1. project switcher in expanded/mobile form
2. primary destinations: `Tasks`, `Inbox`, `Agents`, `Chat`, `Sessions`, `Settings`
3. active-page secondary nav section when relevant:
   - Chat agents when `activePage === "chat"`
   - Settings sections when `activePage === "settings"`

Dismissal behavior:
- close on backdrop tap
- close on `Escape`
- close when the trigger is pressed again
- close after a project, top-level destination, or secondary-nav item is chosen

### 4. Keep mobile labels explicit and touch-friendly

Recommended behavior:
- mobile nav should always show full labels
- do not reuse the icon-only collapsed rail treatment on mobile
- use generous vertical spacing and button heights suitable for touch
- retain current active-state semantics (`aria-current`, visible active treatment)

### 5. Make keyboard and focus behavior deliberate

Recommended behavior:
- when opened from the keyboard, move focus into the sheet
- keep keyboard traversal inside the open sheet while it is modal
- restore focus to the hamburger trigger on close
- preserve `Escape` dismissal

This is more appropriate than treating the mobile surface as a passive CSS dropdown because it is obscuring page content and acting like a temporary navigation dialog.

## Recommended implementation outline

### 1. Split desktop and mobile shell rendering in `src/App.tsx`

Plan:
- factor the shared nav item rendering into a helper so desktop and mobile use the same labels, actions, badges, and active-state logic
- keep the current desktop/tablet `<aside className="sidebar">` path for non-mobile widths
- render a separate mobile top bar + mobile nav sheet path for mobile widths
- ensure any navigation action used from the mobile sheet also closes the sheet

Important guardrail:
- desktop collapse persistence should remain unchanged for non-mobile widths

### 2. Reuse `ProjectSwitcher`, but force the mobile presentation to be expanded

Plan:
- do not allow the desktop `collapsed` presentation to drive the mobile sheet
- either pass `collapsed={false}` in the mobile path or add a small explicit mobile variant if layout needs differ
- keep the project-switcher menu readable within the mobile sheet width
- close the mobile sheet after project selection at the app level

### 3. Add mobile-specific shell styles in `src/styles.css`

Plan:
- introduce styles for:
  - mobile top bar
  - hamburger trigger
  - backdrop
  - navigation sheet container
  - mobile nav content sections
- prevent desktop collapsed-rail rules from leaking into the mobile presentation
- keep the existing desktop/tablet sidebar and collapsed-rail CSS intact unless a small selector split is required

### 4. Preserve secondary-nav access on mobile

Plan:
- when `Chat` or `Settings` is active, render the current secondary nav inside the mobile sheet
- keep this scoped to the active primary destination so the mobile sheet does not become a giant always-open sitemap

## Test plan

### Desktop behavior to preserve

Keep or update existing coverage in:
- `tests/e2e/app-header.spec.ts`
- `tests/desktop-e2e/navigation-layout.test.ts`

Desktop assertions that should remain true:
- wide layouts still support collapsing into the icon rail
- the `sidebar-collapsed` preference still persists across reloads
- collapsed desktop project-switcher/menu geometry still behaves as expected
- desktop labels/tooltips/accessibility remain unchanged unless intentionally improved

### Mobile behavior to add

Add viewport-driven Playwright coverage at a realistic phone-sized width such as `390x844`.

Recommended assertions:
- the mobile shell shows a hamburger trigger instead of the desktop collapse toggle
- primary navigation destinations are not always visible before opening the mobile sheet
- opening the trigger reveals the mobile nav sheet with labeled destinations
- the mobile nav closes on `Escape` and on backdrop press
- selecting representative destinations closes the sheet and updates the surface
- the project switcher remains reachable from the mobile sheet
- at least one secondary-nav case remains reachable on mobile:
  - a Settings tab selection, or
  - a Chat agent selection

Recommended file split:
- keep desktop shell assertions near `tests/e2e/app-header.spec.ts`
- add a focused mobile navigation spec such as `tests/e2e/mobile-navigation.spec.ts`

### Scope boundary

This task should **not** redesign the desktop navigation IA or the desktop collapsed rail. The goal is:
- an intentional mobile menu model
- preserved desktop behavior
- tests that lock both modes down
