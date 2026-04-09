# Orchestra UX Design Guidelines

## Purpose

This document translates the Orchestra UX north star into concrete visual, interaction, and theming guidance for a future look-and-feel overhaul.

Use it when:
- redesigning shared layout or chrome
- introducing a new component family
- refactoring CSS or design tokens
- planning theme support
- reviewing whether a UI change moves Orchestra toward a clearer, more desktop-grade product feel

This is a companion to:
- [UX north star](./ux-north-star.md) for product/experience intent
- [UX first-pass implementation plan](./ux-first-pass-implementation-plan.md) for rollout sequencing
- [Design draft](./design.md) for domain and information architecture

## Desired product feel

Orchestra should feel closer to **VS Code, Linear, GitHub Desktop, and other crisp desktop workbench tools** than to a generic admin template or a stock CSS starter app.

That does **not** mean cloning VS Code's UI literally.
It means borrowing the qualities that make tools like VS Code feel strong:
- calm, low-drama chrome
- clear selection and focus states
- high information density without visual clutter
- crisp separators instead of pillow-like cards
- surfaces that feel durable and work-oriented
- themeability as a first-class system, not an afterthought

Orchestra should feel like **software for running work**, not browsing marketing content or filling out forms.

## Current UX evaluation

### What is already working

The current UX has several strong foundations:
- the app already has a stable left-hand shell and clear top-level information architecture
- Tasks, Agents, Sessions, Inbox, and Settings are legible product areas
- the Sessions/chat surface already behaves like a real operational tool rather than a mockup
- CSS variables exist, so the UI is not starting from zero on tokenization
- there is already a shared visual vocabulary for panels, fields, badges, and chips

These are good starting points. The overhaul should preserve the product clarity while upgrading the presentation and component discipline.

### Where the current UX falls short

#### 1. The visual language is too soft and card-heavy

Today's UI leans on:
- large corner radii
- soft shadows
- tinted cards
- card-inside-card composition
- pill-heavy controls and filters

That creates a warm, friendly, web-app feel, but it does not read as a crisp desktop orchestration tool.

#### 2. Too much of the UI looks like a generic starter/admin interface

A lot of surfaces reuse the same broad pattern:
- rounded panel
- eyebrow label
- section header
- form body
- soft shadow

This makes many parts of the app feel visually interchangeable. Important surfaces do not always feel structurally distinct.

#### 3. Page chrome is louder than the working content

In a workbench-style app, the main content should feel primary.
Today, borders, shadows, badges, chips, and section containers often compete with the actual task/session/workflow content.

#### 4. The app is effectively single-theme and light-only

The current visual system is centered on a warm light palette and `color-scheme: light`.
That blocks the app from feeling native to different operator preferences and environments.

#### 5. Themeability is incomplete

There are some shared color variables, but many components still depend on fixed RGBA/hex values and accent-derived local color decisions.
That means the system is only partially tokenized and would be hard to scale into true VS Code-style themes.

#### 6. The component language is too uniform

Buttons, chips, pills, list rows, panels, and cards often share similar curvature and styling.
That reduces hierarchy. In a desktop workbench, a list row should not feel like a form card, and a toolbar button should not feel like a primary page CTA.

#### 7. The shell feels more like a website shell than an application workbench

The current shell is serviceable, but it can evolve toward a stronger workbench model:
- tighter chrome
- clearer pane boundaries
- more disciplined toolbars
- more row/list/tree affordances
- less decorative surface treatment

#### 8. Settings/form patterns influence the whole app too much

The current shared styling makes many pages feel like Settings screens, even when they should feel like operational views.
Tasks, Sessions, Inbox, and Workforce need stronger application-specific patterns.

## Overhaul goal

The redesign should move Orchestra from:
- soft, rounded, template-like web UI

to:
- crisp, dense, themeable desktop workbench

Success means a user opening Orchestra thinks:
- "This is a serious tool for supervising work"
- "I can scan the state quickly"
- "The active thing is obvious"
- "The chrome stays out of the way"
- "This theme feels intentional, not painted on"

## Core design principles

### 1. Workbench over dashboard

Prefer:
- panes
- toolbars
- lists
- split views
- inspectors
- editors/transcripts

Avoid:
- hero cards
- marketing-style section framing
- oversized empty-state-first layouts
- decorative dashboard cards unless they provide real operational value

### 2. Density over decoration

Orchestra should be dense enough for daily operation.
Density should come from:
- consistent spacing
- compact typography
- disciplined row heights
- restrained labels
- structural alignment

Not from:
- squeezing controls together randomly
- tiny hit targets
- removing whitespace entirely

### 3. Borders before shadows

Use subtle separators and surface contrast as the primary way to define structure.
Shadows should be reserved mostly for:
- menus
- popovers
- dialogs
- overlays

Do not rely on soft drop shadows to define every panel.

### 4. Selection and focus must be unmistakable

In VS Code-like tools, users always know:
- which pane is active
- which row is selected
- which input has focus
- which tab is current
- which action is primary

Orchestra should adopt that discipline everywhere.

### 5. Color should communicate meaning, not decoration

Accent color is for:
- selection
- focus
- primary actions
- active state

Status colors are for:
- success
- warning
- danger
- info

Do not use tinted backgrounds everywhere just because color is available.

### 6. Surfaces should feel durable and reusable

A task detail pane, workflow editor, session transcript, and inbox thread should all feel like parts of one system.
That requires a tokenized, reusable component model rather than ad hoc page-specific styling.

### 7. Themeability is a product feature

Theme support is not polish after the redesign. It is part of the redesign.
Every shared component should be built against theme tokens from the start.

## Visual system guidelines

### Typography

- Use a neutral UI font for chrome and controls.
- Use monospaced text for code, logs, command output, paths, and transcript payloads.
- Reduce oversized heading treatment.
- Prefer strong medium-weight section titles over large, airy headings.
- Use uppercase eyebrow labels sparingly and only where they materially improve scanning.

#### Recommended scale

- App/page title: 20-24px
- Section title: 15-18px
- Body: 13-14px
- Secondary/meta text: 11-12px
- Dense table/list rows: 12-13px
- Code/log text: 12-13px

### Spacing

Use a tight, predictable spacing scale:
- 4
- 8
- 12
- 16
- 20
- 24
- 32

Guidance:
- default internal control padding should usually land in 8-12px ranges
- pane padding should usually land in 12-20px ranges
- avoid giant pockets of decorative whitespace

### Corner radius

Orchestra should be crisper than it is today.

Recommended default radius scale:
- 4px: tables, inputs, dense buttons, menu items
- 6px: cards/rows needing slight softness
- 8px: larger panels and dialogs
- 10-12px: reserved for occasional featured surfaces only

Avoid:
- ubiquitous 14-20px radii
- pill shapes as the default control treatment

### Borders and separators

- 1px borders and pane dividers should carry most structural separation
- use stronger borders for active/selected/focus states
- allow panels to differentiate by background tone, not just border color
- lists, inspectors, and editors should align to a clear separator rhythm

### Shadows and elevation

- most app surfaces should have little to no shadow
- overlays may use a small controlled elevation scale
- avoid stacking multiple elevated cards inside one another

### Icons

Adopt a consistent icon set and sizing discipline:
- 16px for inline actions and row affordances
- 20px for navigation and prominent actions

Icons should clarify action/state, not add decoration.

## Shell and layout guidelines

### The shell should feel like a workbench

Orchestra's top-level frame should evolve toward:
- calm outer window background
- clearly defined navigation area
- one obvious primary work area
- optional secondary panes for detail/inspectors
- consistent toolbars at pane tops

### Navigation

The current top-level IA is good and should remain stable, but the visual treatment should become crisper.

Guidelines:
- the primary nav should read like application chrome, not like a stack of large buttons
- active navigation should be obvious but restrained
- prefer selection bars, tone shifts, and foreground emphasis over filled pill buttons
- consider a slimmer nav/rail treatment if it improves scan speed without harming discoverability

### Pane model

Prefer a consistent pane system across major pages:
- navigation/list pane
- main content pane
- optional inspector/detail pane

For example:
- Sessions: session list + transcript/composer pane
- Tasks: task scan surface + task detail pane
- Agents: workforce list + activity/detail pane
- Settings: subnav + detail editor

The relationship between panes should be reinforced by:
- separators
- background tone
- active pane state
- sticky pane headers/toolbars

Not by:
- large rounded containers everywhere

### Toolbars

Page and pane headers should increasingly behave like toolbars.

Guidelines:
- compact height
- clear alignment of title, filters, and actions
- primary actions grouped consistently
- low visual weight unless an alert or blocking state is present

### Empty states

Empty states should be calm and compact.
They should not dominate the pane.

Prefer:
- one sentence of context
- one primary action
- optional secondary guidance

Avoid:
- oversized illustrations
- oversized hero messaging
- too much whitespace

## Component guidelines

### Buttons

Buttons should be more desktop-like and less generic-web-app-like.

Preferred direction:
- smaller radii
- lower default height
- less shadow
- less bounce/hover translation
- clearer distinction between toolbar buttons, primary actions, and destructive actions

Button roles:
- **Toolbar button:** low emphasis, compact
- **Primary action button:** solid fill or strong emphasis, used sparingly
- **Secondary button:** bordered/subtle background
- **Danger button:** only for destructive operations

### Inputs and selects

Inputs should feel like tool controls, not soft form cards.

Guidelines:
- slightly inset or panel-matched background
- compact focus ring
- clear disabled state
- clear error state
- consistent heights across input, select, and dense buttons

### Badges, chips, and pills

Current Orchestra likely overuses filled chips.
Use them more selectively.

Guidelines:
- status badges should be compact and mostly neutral by default
- filter chips should not become the dominant visual element in a toolbar
- avoid making every state a brightly tinted capsule
- prefer text + icon + subtle row highlight when possible

### Lists, trees, and rows

This is one of the most important upgrades.
Many Orchestra surfaces should feel closer to list/tree views than to stacks of cards.

Guidelines:
- compact row height
- full-row selection
- hover state lighter than selected state
- clear active/current row treatment
- metadata aligned to predictable columns or zones
- actions revealed cleanly, not scattered

Good candidates:
- session list
- task list
- agent/role list
- inbox list
- workflow lane lists

### Panels and sections

Not every logical grouping needs a card.

Use:
- pane boundaries
- section headers
- inline separators
- subtle background bands

Reserve card treatment for:
- self-contained objects inside a larger canvas
- floating or special emphasis surfaces
- timeline entries where card treatment improves readability

### Tables

Where the content is operational and row-based, prefer tables or table-like list layouts over free-form card stacks.

This is especially relevant for:
- tasks overview
- queue views
- runtime/inbox scans
- repository lists

### Session transcript and chat

The session surface is one of Orchestra's core product differentiators and should feel closer to an editor/log viewer hybrid than a consumer chat app.

Guidelines:
- transcript chrome should be quiet
- the message stream should own the space
- timestamps, sender/type, and state should scan quickly
- tool events should feel like execution records, not decorative chat bubbles
- code/output blocks should feel editor-native
- composer should feel attached to the transcript pane, not like a floating form section

### Task detail

Task detail should feel like an inspector/work item surface, not a document form.

Guidelines:
- metadata should align in compact groups
- status, workflow state, blockers, and assignment should be immediately visible
- long-form description/comments should use readable but dense layout
- attachments, timeline, and related activity should feel like inspectable subsections

### Workflow boards

Workflow visuals should balance board readability with workbench crispness.

Guidelines:
- columns should be structurally clear
- task cards within columns should be calmer and tighter
- lane headers should act like operational headers, not decorative containers
- use state emphasis sparingly so blocked/review/active items stand out

## Theme system guidelines

### Theme goals

Orchestra should support:
- built-in light theme
- built-in dark theme
- built-in high-contrast theme
- user-selectable theme switching
- future custom/importable themes

Theme support should feel similar in spirit to VS Code:
- color is driven by named semantic tokens
- themes swap token values, not component CSS rules
- components do not hardcode palette decisions locally

### Token architecture

Use three layers of tokens.

#### 1. Base tokens

Raw values for:
- gray scale / neutral scale
- accent scale
- semantic scales
- spacing
- radius
- typography
- shadow

These are implementation primitives, not what components should consume directly.

#### 2. Semantic application tokens

These describe what a color or value means in the app.

Examples:
- `app.background`
- `sidebar.background`
- `sidebar.foreground`
- `panel.background`
- `panel.border`
- `toolbar.background`
- `editor.background`
- `input.background`
- `input.border`
- `input.border.focus`
- `text.primary`
- `text.secondary`
- `text.disabled`
- `status.success`
- `status.warning`
- `status.error`
- `selection.background`
- `selection.foreground`
- `list.hoverBackground`
- `list.activeSelectionBackground`
- `list.inactiveSelectionBackground`
- `scrollbar.thumb`
- `focus.ring`

#### 3. Component tokens

Only where necessary, layer component-specific tokens on top of semantic tokens.

Examples:
- `session.transcript.background`
- `session.toolEvent.runningBorder`
- `task.card.blockedAccent`
- `inbox.unreadIndicator`

Component tokens should be exceptions, not the main design strategy.

### Theme categories to support

At minimum, the theme model should cover:

#### Application chrome
- window/app background
- sidebar/nav background
- sidebar active item background/foreground
- toolbar background
- panel background
- overlay/dialog background
- separator/border colors

#### Text
- primary
- secondary
- muted
- disabled
- inverse
- links

#### Interaction
- hover
- pressed
- selected
- focus ring
- drag target
- drop target

#### Inputs and controls
- input background
- input foreground
- input border
- button foreground/background
- button secondary states
- danger states

#### Lists and tables
- row hover
- active row
- inactive selected row
- row separator
- unread or attention markers

#### Status and feedback
- success
- warning
- error
- info
- subtle versions of each for background fills where needed

#### Domain-specific tokens
- task state emphasis
- workflow lane emphasis
- transcript event tones
- tool run states
- markdown/code block colors
- logs/diagnostics colors

### Theme implementation rules

- No component should introduce raw hex/RGBA colors directly in shared CSS once the theme system is in place.
- Shared components should use semantic tokens only.
- If a component needs a new token, define it centrally and document it.
- Support both light and dark values from the first real token pass.
- Theme switching should not require separate component stylesheets.
- Prefer CSS custom properties generated from a typed theme object.

### Theme manifest direction

A future theme format should look something like:

```json
{
  "id": "orchestra-dark-plus",
  "label": "Orchestra Dark+",
  "kind": "dark",
  "colors": {
    "app.background": "#1e1e1e",
    "sidebar.background": "#181818",
    "panel.background": "#252526",
    "text.primary": "#cccccc",
    "text.secondary": "#9da1a6",
    "selection.background": "#264f78",
    "focus.ring": "#007fd4"
  }
}
```

Stretch goal:
- make Orchestra's token names structured enough that importing or mapping VS Code-style theme palettes later is feasible

## Style architecture guidance

The redesign should also improve how Orchestra's styling is organized.

Recommended structure:
- `tokens/` or equivalent source for base + semantic theme tokens
- `foundation/` for typography, spacing, reset, and generic HTML element rules
- `shell/` for app frame, navigation, split panes, and toolbars
- `components/` for shared UI primitives and domain-shared patterns
- `pages/` for layout composition only, not new one-off visual systems

Guidelines:
- apply the active theme via a root attribute such as `data-theme="dark-plus"`
- map theme values to CSS custom properties at the root/app-shell level
- keep page styles structural whenever possible; shared visual treatment belongs in shared layers
- prefer data attributes or explicit variant classes for stateful components over ad hoc descendant selectors
- do not let page-level CSS override shared component tokens except in documented component variants
- treat screenshots/visual QA across multiple themes as part of the styling architecture, not optional polish

## Accessibility and interaction quality

### Accessibility requirements

- meet contrast requirements in light and dark themes
- never rely on color alone to communicate state
- provide visible keyboard focus on all actionable controls
- support full keyboard navigation for list/detail workflows where feasible
- maintain adequate hit targets even in dense layouts
- ensure scroll regions and split panes are visually clear

### Motion and feedback

- keep transitions short and informative
- avoid playful hover lift as a dominant interaction pattern
- prioritize stable layout over motion
- loading and pending states should feel operational, not decorative

## Implementation guidance for the overhaul

### Phase 1 — Audit and token extraction

- inventory current colors, radii, shadows, spacing, and control sizes
- define base and semantic tokens
- remove hard-coded color usage from shared styles
- establish light, dark, and high-contrast theme baselines

### Phase 2 — Shared chrome and component pass

- refactor shell, nav, pane headers, toolbars, buttons, inputs, badges, and list rows
- introduce a consistent row/list pattern for operational surfaces
- reduce radius/shadow usage globally

### Phase 3 — Product surface pass

Apply the new component system to the highest-value pages first:
1. Sessions
2. Tasks
3. Agents/Inbox
4. Settings/editors

### Phase 4 — Theme support productization

- add theme selection in Settings
- persist selected theme
- allow follow-system behavior if appropriate
- validate all major pages across built-in themes

### Phase 5 — Future extensibility

- support custom theme files
- consider community theme import/mapping
- add screenshot-based visual QA across theme variants

## Design review checklist

Use this checklist when reviewing UI changes.

### Structure
- Does this feel like a workbench surface rather than a marketing/admin card?
- Is the active pane/row/control obvious?
- Is the hierarchy clear without needing lots of decorative chrome?

### Density
- Can the user scan it quickly?
- Is it dense enough for repeat use without feeling cramped?
- Is whitespace serving structure rather than decoration?

### Consistency
- Does it reuse established shell, toolbar, row, form, and badge patterns?
- Does it introduce unnecessary one-off styling?

### Themeability
- Does it rely only on theme tokens?
- Will it still work in light, dark, and high-contrast modes?
- Is state communicated beyond color alone?

### Product fit
- Does it help the user direct work more clearly?
- Does it make sessions, tasks, queues, and intervention easier to understand?
- Does it make Orchestra feel more like a serious operator tool?

## Specific anti-patterns to avoid

Do not move the redesign toward:
- soft dashboard cards everywhere
- giant rounded panels as the default layout primitive
- strong shadows on routine surfaces
- bright tinted backgrounds on every status element
- overuse of pills/chips for normal navigation
- oversized hero headers and empty states
- one-off page-specific color choices
- hover animations that make the UI feel playful instead of precise
- generic form styling leaking into every operational page

## Summary

The current Orchestra UX has a solid structural base, but the visual language needs to shift from **soft, warm, generic web app** toward **crisp, dense, themeable desktop workbench**.

The redesign should borrow the best qualities of VS Code-style products:
- strong chrome discipline
- clear pane structure
- restrained visual styling
- high scanability
- first-class theming

That should be the standard for the next UX overhaul.