# Orchestra UX First-Pass Implementation Plan

## Purpose

This plan turns the Orchestra UX design guidelines into a concrete first implementation pass.

The goal of this pass is to **overhaul the visual design and theming foundation without changing Orchestra's product behavior or information architecture in major ways**.

This is a polish-and-foundation pass, not a workflow rewrite.

Companion docs:
- [UX north star](./ux-north-star.md)
- [UX design guidelines](./ux-design-guidelines.md)
- [Design draft](./design.md)

Related `td` epic and tasks:
- Epic: `td-df9124` — Overhaul Orchestra look and feel with a first-pass workbench UX refresh
- `td-a3c47e` — Plan first-pass Orchestra UX overhaul implementation
- `td-0888aa` — Build Orchestra theme token foundation and built-in themes
- `td-b4b608` — Refresh Orchestra shell, navigation, panes, and toolbars
- `td-d46edf` — Refresh shared controls, lists, badges, and form surfaces
- `td-1b306b` — Apply first-pass workbench styling to core Orchestra pages
- `td-734c5a` — Add theme selection and validate Orchestra across built-in themes
- `td-561545` — Add regression coverage for the Orchestra UX overhaul

## What this pass should achieve

After this pass, Orchestra should:
- feel visually crisper and more intentional
- feel more like a desktop workbench than a stock admin UI
- support a real theme-token architecture
- ship with built-in light, dark, and high-contrast themes
- preserve existing product flows and page responsibilities
- make future page-by-page UX refinement easier, not harder

## What this pass should not do

This pass should **not**:
- redesign Orchestra's domain model
- change task/session/agent/workflow behavior
- add new orchestration concepts
- rework navigation/information architecture in major ways
- rewrite the app into a component library from scratch
- attempt a full product UX rethink beyond visual and structural refinement

Allowed exceptions:
- theme selection/persistence is acceptable because it is directly part of the visual/theming goal
- minor markup reshaping is acceptable where required to support better layout and reusable styling

## Current-state summary

Today Orchestra already has:
- a clear app shell
- recognizable top-level pages
- working session/task/operator surfaces
- some shared CSS variables

But the current UI still trends toward:
- soft rounded cards
- broad panel reuse
- starter/admin-form styling
- light-theme-only assumptions
- incomplete tokenization with hard-coded colors
- inconsistent distinction between chrome, lists, toolbars, and detail panes

This plan addresses those issues in a sequence that minimizes behavioral risk.

## Strategy

Use a **foundation-first, adoption-second** rollout:

1. establish a theme/token system
2. restyle shell and shared patterns
3. apply the new system to core pages
4. expose theme selection and validate the result

This order matters.

If page restyling happens before the token foundation and shared primitives are stable, the result will be another layer of ad hoc styling instead of a maintainable design system.

## First-pass design constraints

### 1. Preserve behavior

The same user tasks should still work the same way:
- same navigation model
- same page responsibilities
- same session/task/agent flows
- same commands and backend behavior

### 2. Prefer markup adjustments over logic changes

When possible:
- move wrappers
- regroup headers/actions
- introduce clearer pane/toolbars/list markup

Avoid logic changes unless needed to support the visual structure.

### 3. Prioritize the highest-visibility surfaces

The most important first-pass targets are:
- app shell and nav
- sessions
- tasks
- shared controls and list rows
- settings/editor surfaces

### 4. Tokenize before specializing

When a page needs a new visual treatment, first ask:
- can this be expressed with existing semantic tokens?
- should a shared token be introduced?
- is a component token justified?

Do not solve page styling with local hard-coded colors.

## Work breakdown

### Slice 1 — Planning and implementation framing

`td-a3c47e`

Deliverables:
- this implementation plan
- ticket breakdown and sequencing
- clear non-goals and acceptance criteria

Notes:
- this slice should remain docs/planning only
- use it to keep subsequent implementation tickets narrow and reviewable

### Slice 2 — Theme token foundation and built-in theme definitions

`td-0888aa`

Goal:
Create the architectural base for all future styling changes.

Deliverables:
- establish a base token layer and semantic token layer
- eliminate hard-coded shared colors from the global styling foundation where practical
- define built-in themes for:
  - light
  - dark
  - high contrast
- apply theme values through root-level CSS custom properties
- define the root theme application mechanism (for example `data-theme` on the root/app shell)

Expected code areas:
- `src/styles.css` or its successor structure
- app root/theme bootstrapping in React
- shared style/token organization

Non-goals for this slice:
- full page-by-page polish
- new page layouts
- exhaustive component restyling

Acceptance criteria:
- the app can render correctly under multiple built-in themes
- shared styles are driven primarily by semantic tokens
- major raw color decisions are no longer duplicated across the shell and shared primitives

### Slice 3 — Shell, navigation, pane, and toolbar refresh

`td-b4b608`

Goal:
Make Orchestra feel like a calmer, crisper workbench without changing the IA.

Deliverables:
- restyle the sidebar/nav to feel more like app chrome and less like stacked buttons
- tighten page header and pane header styling into clear toolbar patterns
- replace card-heavy pane boundaries with cleaner separators/background structure
- improve selected/active/focus states in the shell

Expected code areas:
- `src/App.tsx`
- shared shell and layout markup
- shell-related sections of `src/styles.css`

Acceptance criteria:
- the shell reads as a desktop workbench
- active navigation is unmistakable but restrained
- pane relationships are clearer without relying on large shadows and rounded cards

### Slice 4 — Shared control and list-surface refresh

`td-d46edf`

Goal:
Refine the shared building blocks so pages stop inheriting a generic admin/template look.

Deliverables:
- restyle buttons, inputs, selects, textareas, and dense action controls
- refine badges/chips/filter controls to be calmer and less dominant
- establish clearer list-row, table-row, and selection patterns
- reduce unnecessary pill shapes and oversized radii
- tune spacing, borders, hover states, and focus rings across shared controls

Expected code areas:
- shared CSS primitives
- commonly reused components
- page markup that needs minor structure changes to adopt row/list patterns

Acceptance criteria:
- controls feel consistent across pages
- selection and focus states are visually stronger
- shared patterns support both dense workbench views and settings-style forms

### Slice 5 — Core page adoption pass

`td-1b306b`

Goal:
Apply the refreshed system to Orchestra's highest-value user-facing pages.

Priority order inside this slice:
1. Sessions
2. Tasks
3. Inbox / Agents
4. Settings panels

Deliverables:
- Sessions feels like an editor/log viewer hybrid rather than a soft chat card
- Tasks feels like an operational board/inspector surface rather than stacked forms/cards
- Inbox and Agents adopt the new list/detail language
- Settings adopts the new design system without dominating the visual identity of the whole app

Expected code areas:
- `src/pages/SessionsPage.tsx`
- `src/components/SessionChatPanel.tsx`
- `src/pages/TasksPage.tsx`
- related page/component files under `src/pages/`, `src/components/`, `src/agents/`, and `src/settings/`

Acceptance criteria:
- core pages visibly reflect the new workbench design direction
- functionality remains unchanged
- major views feel like one product rather than several styling eras

### Slice 6 — Theme selection and validation across built-in themes

`td-734c5a`

Goal:
Expose the built-in themes as a usable product capability.

Deliverables:
- add theme selection UI in Settings (likely General)
- persist the selected theme
- decide whether to support a system/default mode in this first pass
- validate main surfaces across light, dark, and high-contrast themes

Acceptance criteria:
- a user can switch themes without breaking layout or readability
- the selected theme survives reloads
- all core pages remain usable and legible in each built-in theme

### Slice 7 — Regression and UX-overhaul coverage

`td-561545`

Goal:
Make sure the new look/feel does not regress existing behavior.

Deliverables:
- update or add browser Playwright coverage where styling/markup changes affect locators or interaction flows
- add targeted coverage for theme switching if implemented in this pass
- validate that session/task/core navigation flows still work as expected

Acceptance criteria:
- existing core browser flows still pass after the visual overhaul
- any changed selectors or structures are covered by updated tests
- theme switching, if included, has basic automated coverage

## Recommended implementation order

Execute the tickets in this order:

1. `td-a3c47e` — planning
2. `td-0888aa` — token/theme foundation
3. `td-b4b608` — shell/nav/panes/toolbars
4. `td-d46edf` — shared controls and list surfaces
5. `td-1b306b` — core page adoption
6. `td-734c5a` — theme selection
7. `td-561545` — coverage hardening

Reasoning:
- token foundation must exist before page-level restyling
- shell and shared primitives should stabilize before deep page adoption
- theme selection should come after themes and page adoption exist
- tests should be refreshed as selectors and structure settle

## Implementation notes

### Styling architecture

As part of this pass, move toward a more deliberate styling structure:
- foundation/tokens
- shell/chrome
- shared controls/components
- page-level layout adoption

If the current single large stylesheet becomes a bottleneck, it is acceptable to split styling into smaller files as part of the refactor, as long as the structure remains discoverable and not over-engineered.

### Token naming

Favor semantic names over raw palette names.

Good:
- `--color-panel-background`
- `--color-list-row-selected-background`
- `--color-text-muted`
- `--color-focus-ring`

Avoid:
- `--brown-200`
- `--sidebar-tan`
- `--card-peach`

### Theme categories that must work early

At minimum, the first pass should correctly theme:
- app background
- sidebar/nav
- pane backgrounds
- toolbars
- text primary/secondary/muted
- borders/separators
- input backgrounds and focus
- button states
- selected/hovered list rows
- success/warning/error status treatments
- code/log/transcript blocks

### Accessibility

The visual overhaul must preserve or improve:
- keyboard focus visibility
- text contrast
- selected-row clarity
- disabled-state clarity
- non-color state communication where needed

## Testing and validation

For implementation slices with code changes, use appropriate quality gates such as:
- `npm run build`
- `npm test`
- targeted browser Playwright coverage for affected UI flows
- targeted desktop coverage when the changes materially affect important desktop-only interaction surfaces

Since this pass is intentionally non-functional, tests should prove:
- existing flows still work
- selectors and markup changes did not break primary interactions
- theme switching does not cause obvious layout/readability regressions

## Definition of done for the overall first pass

The first pass is complete when:
- Orchestra no longer feels like a stock soft-card web admin UI
- the shell and core pages share a crisp workbench design language
- shared styling is driven by semantic tokens
- built-in light/dark/high-contrast themes exist and render well
- core flows remain behaviorally unchanged
- automated coverage has been updated to protect the restyle

## Out of scope for later passes

The following are intentionally deferred:
- major IA/navigation restructuring
- deeper workflow/task UX redesigns beyond visual polish
- custom user-imported themes
- full-blown design-system packaging/documentation site
- per-page feature redesigns disguised as styling work
- advanced responsive/mobile optimization beyond keeping desktop layouts robust

## Summary

The right first pass is not a giant one-shot redesign.
It is a disciplined sequence:
- build the theme/token foundation
- sharpen the shell and shared primitives
- apply the new system to the most important pages
- expose built-in themes
- validate behavior stays intact

That will move Orchestra meaningfully toward the desired VS Code-like workbench feel while keeping implementation risk contained.