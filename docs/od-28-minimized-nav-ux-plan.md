# OD-28 minimized navigation UX plan

## Problem summary

The current collapsed left navigation reads like an unfinished fallback state instead of a deliberate compact rail.

In the current implementation:
- primary destinations collapse to two-letter abbreviations (`Ta`, `In`, `Ag`, `Ch`, `Se`, `St`) instead of intentional iconography
- the project switcher loses most of its visible identity when collapsed and can degrade into an ambiguous square/button
- active, hover, and badge treatments are tuned for full-width text buttons, so they feel off-balance in the narrow rail
- the expanded/collapsed transition is abrupt because layout and labels snap between states
- the responsive rules appear to leave the collapsed two-column shell active below the mobile breakpoint because the collapsed selector is more specific than the mobile `.app-shell` override

OD-28 should turn the collapsed state into a compact, legible navigation rail that still clearly communicates orientation and active location.

## Current-state findings

### 1. Collapsed nav uses abbreviations instead of a real compact visual language

`src/App.tsx`
- `NAV_ITEMS` currently define `shortLabel` values like `Ta` and `Ag`.
- Collapsed mode swaps the full label for those abbreviations.

`src/styles.css`
- `.app-shell[data-sidebar-collapsed="true"] .nav-item__label--full { display: none; }`
- `.app-shell[data-sidebar-collapsed="true"] .nav-item__label--short { display: inline; }`

This keeps the rail technically usable, but it looks more like placeholder text than polished product chrome.

### 2. Collapsed controls are visually ambiguous and at risk of weak accessibility

`src/App.tsx`
- Primary nav buttons do not set an explicit `aria-label` or `title`.
- The short label span is marked `aria-hidden="true"`.

`src/styles.css`
- In collapsed mode the full label is hidden with `display: none`.

That means the collapsed buttons are relying on hidden text that is removed from layout/accessibility exposure, while the visible short label is explicitly hidden from assistive tech. The same issue exists for the collapsed project switcher trigger, whose visible project name is hidden in CSS without a replacement accessible name.

Even when the buttons remain operable, this is too fragile for an icon-only compact state.

### 3. Active and unread treatments are designed for wide list rows, not a narrow rail

`src/styles.css`
- Expanded nav items are wide text rows with `justify-content: space-between`.
- Active state uses `box-shadow: inset 2px 0 0 var(--accent)`.
- Collapsed mode simply centers the existing button and reduces padding.

That leaves a few problems:
- the left-edge active bar feels accidental in a square-centered button
- unread badges can visually pull the label off-center
- hover/active emphasis still reads like a squeezed list row rather than a purpose-built rail item

### 4. Brand and project switcher collapse behavior is not intentional enough

`src/App.tsx`
- The brand area always renders the same mark/copy/toggle structure.
- `ProjectSwitcher` always renders the same label/trigger/menu structure.

`src/styles.css`
- Collapsed mode mostly hides copy instead of introducing a compact alternative.
- The project switcher hides its label, trigger text, and chevron, leaving only the remaining trigger chrome and any badge.

The result is functional but not communicative: the top of the rail does not strongly answer “what app/project am I in?” once the nav is collapsed.

### 5. Transition quality is abrupt

`src/styles.css`
- The app shell jumps from `236px` to `72px` columns.
- Labels are swapped with `display: none` rather than transitioning opacity/width.

This produces a pop rather than an intentional compacting motion.

### 6. The responsive breakpoint likely leaves collapsed layout active below 900px

`src/styles.css`
- Collapsed layout is defined with `.app-shell[data-sidebar-collapsed="true"] { grid-template-columns: 72px minmax(0, 1fr); }`
- The responsive override later uses `@media (max-width: 900px) { .app-shell { grid-template-columns: 1fr; } }`

Because the collapsed selector is more specific, the collapsed two-column layout likely still wins under the 900px breakpoint. That should be corrected so small screens do not get stuck with a narrow desktop rail.

## Recommended implementation

### 1. Replace short text abbreviations with explicit nav icons

Update the primary nav model in `src/App.tsx` so each destination has a compact icon treatment instead of a two-letter fallback.

Recommended direction:
- extend `NAV_ITEMS` with an `icon` field or map page ids to inline SVG icon renderers
- use a shared icon slot such as `.nav-item__icon`
- keep the full text label in expanded mode
- keep a stable accessible name in both modes

Because the repo does not currently include an icon library dependency, prefer a small local inline-SVG set for the few top-level destinations instead of adding a package just for this rail.

Likely destinations:
- Tasks
- Inbox
- Agents
- Chat
- Sessions
- Settings

### 2. Make icon-only collapsed controls explicitly labeled

For every control that becomes icon-only or mostly icon-only in collapsed mode:
- add `aria-label` with the full destination/control name
- add `title` for basic pointer tooltip support
- keep the visible text label available only in expanded mode

Apply this to:
- primary nav buttons in `src/App.tsx`
- the settings button in `src/App.tsx`
- the project switcher trigger in `src/components/ProjectSwitcher.tsx`

This addresses both usability and accessibility without requiring a full tooltip system rewrite.

### 3. Give the project switcher a compact identity instead of a hidden-text button

Update `src/components/ProjectSwitcher.tsx` and related sidebar styles so collapsed mode still communicates project context.

Recommended compact treatment:
- render a small project avatar/monogram or folder/project glyph in the trigger
- preserve unread state as a corner badge or dot that does not recenter the whole control awkwardly
- expose the active project name via `aria-label` and `title`
- keep the existing dropdown menu behavior intact

The goal is for the collapsed top section to still answer both:
- which app am I in?
- which project am I operating in?

### 4. Add dedicated collapsed-rail styling instead of squeezing full-width buttons

Refine `src/styles.css` so collapsed mode has its own intentionally designed rail behavior.

Recommended styling changes:
- treat collapsed primary nav items as compact square/near-square controls with a centered icon
- keep hit targets large enough for dense desktop use
- use a restrained hover background and stronger selected state that still works in all themes
- replace or supplement the inset-left active bar with a centered selected pill/outline/dot treatment that makes sense in a narrow rail
- anchor unread indicators in a consistent corner position so they do not distort icon alignment
- tighten vertical spacing and alignment around the brand/toggle area

This should make the collapsed state feel like product chrome rather than a compressed list.

### 5. Smooth the expand/collapse transition

Improve the shell state change so it feels intentional.

Recommended direction:
- move the sidebar width to a CSS variable or otherwise introduce a controlled width transition
- transition icon/text containers with short opacity/transform changes instead of swapping everything with `display: none`
- keep motion subtle and respect `prefers-reduced-motion`

The desired effect is a calm compression/expansion rather than a hard snap.

### 6. Correct small-screen behavior explicitly

Inside the `@media (max-width: 900px)` rules, add an explicit collapsed-state override so the app returns to a single-column shell on smaller widths.

Recommended behavior:
- the top-level shell should stay single-column below the breakpoint regardless of stored collapsed preference
- collapsed styling may still affect internal chrome if desired, but it should not preserve the 72px desktop rail layout on narrow screens

### 7. Preserve page-specific orientation without reopening hidden subnav clutter

Collapsed mode should stay compact, so subnav sections for chat/settings should remain suppressed when the rail is collapsed.

However, the top-level button should still communicate state clearly by:
- keeping an unambiguous active treatment
- exposing full labels via tooltip/accessibility name
- ensuring the selected destination is obvious at a glance

That preserves orientation without reintroducing bulky secondary content into the compact rail.

## Regression coverage plan

Update the existing navigation coverage rather than introducing an entirely new test surface.

### `tests/e2e/app-header.spec.ts`

Expand the existing collapse persistence test to cover the new compact-rail expectations:
- collapsed shell state still persists in local storage
- collapsed nav buttons retain full accessible names, e.g. `Tasks`, `Inbox`, `Agents`, `Chat`, `Sessions`, `Settings`
- collapsed controls expose tooltip/title text where practical
- the old two-letter visual fallback is gone
- the project switcher trigger remains discoverable in collapsed mode

A good assertion pattern here is `toHaveAccessibleName(...)` on icon-only buttons.

### `tests/desktop-e2e/navigation-layout.test.ts`

Keep the existing desktop collapse/expand flow and add a small number of compact-rail assertions that are robust in the desktop harness, such as:
- the shell still toggles collapsed/expanded cleanly
- the compact rail still exposes the collapse/expand control and primary destinations
- the collapsed state does not break follow-on layout interactions (for example, returning to expanded mode before exercising the sessions secondary-nav resize handle)

### Add a viewport-specific web E2E assertion

In `tests/e2e/app-header.spec.ts` or a nearby navigation-focused spec, add a breakpoint check around the current mobile threshold:
- set viewport width below 900px
- collapse the navigation
- verify the shell/sidebar does not remain locked into the desktop 72px rail layout

This closes the regression hole created by the current selector-specificity mismatch.

## Files expected to change

- `src/App.tsx`
- `src/components/ProjectSwitcher.tsx`
- `src/styles.css`
- `tests/e2e/app-header.spec.ts`
- `tests/desktop-e2e/navigation-layout.test.ts`

Possible optional extraction if it keeps `App.tsx` cleaner:
- a tiny shared nav-icon helper/component in `src/components/`

## Validation

Recommended focused checks after implementation:

```bash
npm run test:e2e -- tests/e2e/app-header.spec.ts
npm run test:web-driver:e2e -- tests/desktop-e2e/navigation-layout.test.ts
```

If the implementation uses CSS transitions or viewport-specific fixes, also manually verify:
- expanded -> collapsed -> expanded flow
- unread badge cases
- project switcher collapsed behavior
- widths above and below the 900px breakpoint
- at least one dark theme and one light theme
