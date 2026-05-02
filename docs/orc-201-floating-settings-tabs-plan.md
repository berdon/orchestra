# ORC-201 floating settings tabs rollout plan

## tl;dr

Generalize the Projects/Harness floating section-dock pattern into one reusable settings-section tab scaffold, then apply it to every settings surface with 2+ peer sections. Keep Prompting unchanged because it is still a single-editor page.

## Executive summary

Recent settings work established the target UX on Projects and Harness: a sectioned detail panel with a fixed bottom tab dock that stays available on mobile instead of collapsing to the generic task-detail select control. ORC-201 should extend that exact pattern across the remaining multi-section settings pages so users can move between long settings sections consistently on desktop and mobile.

The cleanest path is to extract the shared dock chrome/layout behavior first, including the fixed-width alignment logic for resizable detail panes and the mobile “keep the dock visible” behavior that is currently hard-coded to Project/Harness selectors. Then migrate the remaining settings pages onto that shared scaffold with page-specific tab ids/data-roles and light page-local grouping only where a page truly has multiple peer sections.

## Current-state findings

- The baseline pattern already exists in mainline settings work on `src/settings/ProjectsPanel.tsx` and `src/settings/HarnessPanel.tsx` via `task-detail-tabs-panel` + `task-detail-tab-dock`.
- The mobile CSS is still brittle: `src/styles.css` preserves the dock on mobile only for Project/Harness-specific classes instead of a reusable settings opt-in.
- The remaining multi-section settings pages still rely on long stacked content without the same docked section navigation:
  - `src/settings/GeneralPanel.tsx`
  - `src/settings/SourceControlPanel.tsx`
  - `src/settings/RemotePanel.tsx`
  - `src/settings/ChannelsPanel.tsx`
  - `src/settings/AgentsPanel.tsx`
  - `src/settings/RolesPanel.tsx`
  - `src/settings/SkillsPanel.tsx`
  - `src/settings/WorkflowsPanel.tsx`
- `src/settings/PromptingPanel.tsx` is still effectively a single-section editor, so adding tabs there would add chrome without improving navigation.

## Scope

Apply the floating section-dock pattern to every settings page/detail surface that has 2 or more peer sections. Do not force it onto single-section screens.

Proposed section maps:

- **General:** Appearance, Notifications, Bridge, Logs
- **Source Control:** Defaults, Variables, Preview
- **Remote:** Server, Pairing, Devices, Clients, Guide
- **Channels:** Basics, Bot, Chat, Behavior, Activity
- **Agents:** Configuration, Access, Skills, Memory, Overlay, Validation
- **Roles:** Configuration, Access, Skills, Validation
- **Skills:** editor/bindings/read-only sections based on selected skill mode
- **Workflows:** Basics, Skills, Lane, Validation
- **Prompting:** no change

## Implementation plan

1. **Extract reusable settings-section dock infrastructure**
   - Add a shared section-tab wrapper/hook under `src/components/` for:
     - tab metadata (`id`, `label`, conditional visibility)
     - fixed bottom dock rendering
     - optional panel-width alignment via `ResizeObserver`
     - active-tab clamping when tabs appear/disappear
   - Reuse existing `task-detail-*` styles where possible instead of inventing a second visual system.

2. **Make the mobile dock opt-in generic instead of page-specific**
   - Replace the current Project/Harness-only mobile CSS exception with a reusable settings class/modifier such as a persistent settings dock class.
   - Keep generic task-detail behavior unchanged; only settings pages opting into the pattern should keep the dock visible on narrow viewports.

3. **Migrate existing Projects/Harness onto the shared scaffold first**
   - This removes duplication before adding more adopters.
   - Preserve existing data-role coverage and lazy-loading/prefetch behavior.

4. **Roll the pattern across remaining settings pages**
   - Use one consistent naming convention per page:
     - tab button: `[data-role="<page>-detail-tab-<id>"]`
     - tab panel: `[data-role="<page>-detail-tabpanel-<id>"]`
   - Keep conditional tabs conditional (for example overlay/activity/validation/lane-specific tabs).
   - For resizable master/detail pages, align the dock to the detail pane width the same way Projects does.

5. **Regression coverage**
   - Add at least one shared/unit test around tab clamping + mobile persistent-dock behavior.
   - Extend the existing page E2E/spec coverage with smoke tests that prove:
     - the dock renders
     - switching tabs changes the visible section
     - the dock remains fixed/visible on mobile
     - no horizontal overflow is introduced on narrow viewports

## Suggested validation

- `npm test -- --runInBand` for the affected panel/unit suites
- `npx playwright test tests/e2e/projects.spec.ts tests/e2e/general.spec.ts tests/e2e/remote.spec.ts`
- Targeted settings specs for any newly tabbed master/detail pages (`channels`, `agents`, `roles`, `skills`, `workflows`)
