# ORC-208 Notes mobile sub-navigation plan

## tl;dr
- Reuse the ORC-201 mobile sub-navigation pattern on `NotesPage`.
- Keep the existing desktop split layout and notes tree sidebar.
- On mobile, hide the sidebar, show a `SettingsMobileSubnavHeader`, and collapse page-level note actions into its hamburger menu.
- Implement against `origin/main` (or a branch that already contains ORC-201 + ORC-202), because this task worktree predates both the shared header and the notes page.

## Executive summary
`NotesPage` from ORC-202 already matches the desktop “settings-style” layout: a resizable left navigation tree plus a right-hand detail/editor pane. What it is missing is the ORC-201 mobile treatment used by Settings pages: a top-of-page selector/dropdown, a compact action menu, and the floating hide-on-scroll / reappear-on-scroll-up behavior.

The implementation should stay narrow: adapt `src/pages/NotesPage.tsx` to consume the shared `SettingsMobileSubnavHeader`, move existing page-level note actions behind a shared action definition that can render as desktop buttons or the mobile hamburger menu, opt the notes sidebar into the shared mobile-hiding classes, and add focused regression coverage for the mobile notes experience.

## Baseline note
The current task worktree is detached at `orc-183-loading-shell`, which is an ancestor of `origin/main` and does **not** include:
- `src/components/SettingsMobileSubnavHeader.tsx` (ORC-201)
- `src/pages/NotesPage.tsx` (ORC-202)

Implementation should begin from `origin/main` or an equivalent refreshed branch before code changes start.

## Plan
1. **Refresh to the correct baseline**
   - Rebase/recreate the implementation worktree from `origin/main` so the existing notes UI and shared mobile subnav component are available.

2. **Add shared mobile header to NotesPage**
   - Update `src/pages/NotesPage.tsx` to render `SettingsMobileSubnavHeader` above `ResizableSidebarLayout`.
   - Use a notes-specific `dataRolePrefix` such as `notes`.
   - Feed the header from a flattened set of selectable note locations derived from the existing tree state:
     - roots
     - directories
     - notes
   - Map the selected option back into the existing `NotesSelection` flow so unsaved-change guards continue to run through `requestSelection`.

3. **Preserve desktop sidebar; replace it on mobile**
   - Keep the current `ResizableSidebarLayout` navigation unchanged for desktop.
   - Opt the notes nav panel into the shared mobile CSS hooks:
     - `settings-mobile-subnav-panel`
     - `settings-mobile-subnav-list` where appropriate
   - This keeps the desktop sidebar intact while letting the shared mobile CSS hide it on narrow screens.

4. **Collapse page-level actions into the mobile hamburger menu**
   - Build a shared `TaskActionMenuAction[]` for Notes page actions using existing handlers.
   - Include the actions that currently live in the sidebar/detail chrome, especially:
     - refresh
     - new note
     - new folder
     - move / rename
     - copy
     - delete
   - Keep editor-toolbar actions like preview/revert/save in the editor itself unless implementation testing shows an additional mobile issue.
   - Mark duplicate desktop-only action clusters with `settings-mobile-subnav-redundant-actions` so the mobile header becomes the single compact control surface.

5. **Keep the ORC-201 floating behavior without page-specific reinvention**
   - Reuse `SettingsMobileSubnavHeader` as-is unless Notes exposes a gap that truly requires a shared-component enhancement.
   - The expected behavior is the same as task details/settings:
     - visible near the top of the page
     - hidden while scrolling down
     - re-shown while scrolling up

6. **Regression coverage**
   - Add a focused Notes-page contract/unit test to confirm the page opts into the shared mobile subnav classes and redundant-action markers.
   - Add/update Playwright coverage for mobile Notes behavior:
     - mobile header renders on Notes
     - desktop sidebar nav is hidden on mobile
     - selector changes the active notes selection
     - floating mobile header hides on downward scroll and reappears on upward scroll
     - hamburger trigger is present for page-level actions

## Expected files
- `src/pages/NotesPage.tsx`
- `src/styles.css`
- tests for Notes mobile behavior (new or existing Notes/page-layout spec)

## Risks / watchouts
- The mobile selector needs stable, unambiguous option values for roots vs directories vs notes.
- Selection changes must still respect the current unsaved-edit confirmation path.
- Because the current local worktree predates Notes entirely, implementation work done without first refreshing to mainline will target the wrong baseline.
