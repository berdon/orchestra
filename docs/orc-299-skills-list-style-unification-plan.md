# ORC-299 — Skills sidebar list-style unification plan

## tl;dr
- Replace the skills sidebar’s bespoke card-style row treatment with the same shared list-row styling already used across settings/app navigation.
- Keep `SkillsPanel` selection behavior and skill-specific badges/metadata, but render them on top of the standard list primitives instead of `skills-list-item*`-only styling.
- Prefer shared classes already used by projects/channels/tasks/agents/roles, with only thin skill-specific modifiers for badge wrapping and description clamping.
- Update the small contract/E2E coverage that currently bakes in the old skills-only list structure.

## Executive summary
The current `SkillsPanel` sidebar is structurally in the right place (`ResizableSidebarLayout`, shared mobile subnav hooks), but its rows still use a custom card treatment defined by `.skills-list-item*` in `src/styles.css`. That makes skills feel visually different from the rest of Orchestra’s navigation surfaces, which mostly converge on the shared list-row language used by `task-list-link`, `role-list-link`, and `session-list-link`.

This task should stay narrow: do not invent a new generic component. Instead, refactor the skills sidebar to consume the existing shared list styling primitives, keep the current button-based selection flow and `data-role` hooks, and leave only minimal skill-specific CSS for layout details that the common list classes do not already cover (badge wrapping, multiline description clamp, narrow-screen alignment).

## Current-state findings
- `src/settings/SkillsPanel.tsx` already uses the shared split-sidebar/mobile-subnav shell, but the list itself is custom:
  - `nav.skills-list`
  - `button.skills-list-item`
  - nested `skills-list-item__header`, `__badges`, `__meta`, `__description`
- `src/styles.css` gives those rows a card treatment: explicit border, filled surface, larger padding, hover border shift, and active background distinct from the standard app list pattern.
- Standard Orchestra navigation rows instead use the shared list primitives:
  - container: `.task-list`, `.role-list`, `.workflow-nav`, `.workforce-agent-nav`
  - rows: `.task-list-link`, `.role-list-link`, `.workflow-nav-link`, `.session-list-link`
  - active/hover states: `var(--color-list-row-hover)` / `var(--color-list-row-selected)` plus the inset accent bar
- Skills need richer row content than roles/workflows, so the closest fit is the `task-list-link` family, not the simpler `role-list-link` text-only layout.

## Recommended implementation
1. **Adopt shared list row classes in `SkillsPanel`**
   - Keep the existing `data-role="skills-list"` and `data-role={`skill-row-${skill.id}`}` hooks.
   - Keep rows as `button` elements so selection semantics do not change.
   - Change the list/container markup to opt into shared list classes, e.g. shared list container + shared row class with optional skills-specific modifiers.
   - Recommended base row class: `task-list-link`, with `task-list-link--active` for selection.

2. **Render skill metadata inside the shared list pattern**
   - Keep the current skill content model:
     - name
     - slug/path metadata from `getSkillListMeta()`
     - source/status/conflict badges
     - optional description
   - Re-map the row internals onto shared utilities where possible:
     - shared row header treatment for title/badges
     - shared muted metadata treatment (`task-list-link__meta` / existing compact-card helpers where useful)
   - Only retain skill-specific sub-classes where the shared system does not already provide the needed behavior.

3. **Delete the bespoke card-like skills row styling**
   - Remove the custom border/background/transform hover model from `.skills-list-item*`.
   - Retain only thin skills-specific CSS for:
     - badge wrapping/alignment
     - description clamp/overflow
     - responsive stacking on narrower widths
   - Leave `.skills-nav-panel` and filter/warning/detail styles intact unless the implementation needs small spacing adjustments.

4. **Prefer reuse over a new shared component**
   - Do not introduce a new generic `ListRow` abstraction for this slice.
   - The main inconsistency here is styling/pattern drift, not missing component infrastructure.
   - Reusing the existing CSS primitives keeps the change low-risk and aligned with the acceptance criteria.

## Regression coverage
- Update `tests/skills-mobile-subnav-contract.test.ts` so it asserts the skills sidebar opts into the shared list styling/classes instead of the old skills-only row structure.
- Update `tests/desktop-e2e/skills-settings.test.ts` only where selectors or row semantics need adjustment.
- Preserve the existing behavioral coverage around:
  - selecting local vs external skills
  - mobile subnav behavior
  - create/save/assignment/detail flows after selecting rows from the sidebar

## Expected files
- `src/settings/SkillsPanel.tsx`
- `src/styles.css`
- `tests/skills-mobile-subnav-contract.test.ts`
- `tests/desktop-e2e/skills-settings.test.ts` (if selector/class expectations need to move)

## Validation
- `npm test -- skills-mobile-subnav-contract`
- targeted desktop/E2E skills coverage if the local environment is available
- app build/test pass for the touched frontend surface

## Non-goals
- Do not redesign the skills detail pane or bindings editor.
- Do not change skills filtering, loading, or selection logic beyond what is required to swap the list presentation.
- Do not broaden this into a new global navigation-list component unless implementation uncovers a genuine shared gap.