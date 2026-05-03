# ORC-217 mobile notes UX follow-up plan

## tl;dr
- Implement on top of the ORC-202/ORC-208 notes stack (`16cb553`, `1cdf01a`, `01dea01`) or its merged equivalent; this worktree does not currently contain `NotesPage`.
- Make notes preview a true mode switch: the toggle should replace the main note body with preview instead of rendering editor + preview together.
- Remove the mobile nested-scroll treatment so note content/preview live in normal page flow, with the page scroll driving the experience.
- Stop using the shared `SettingsMobileSubnavHeader` behavior for notes mobile chrome; align notes with the `TaskDetailPage` primary-header + sentinel + floating-header model.
- Add focused mobile notes regression coverage for preview replacement, page scrolling, and floating-header behavior.

## Executive summary
The current notes mobile implementation introduced in ORC-208 solves navigation density, but it still behaves like a split-pane app instead of a document page. `NotesPage` mounts a shared mobile subnav shell above a fill-page layout, keeps the editor mounted while preview opens beside/below it, and uses internal overflow regions for the note body and preview. That combination causes the preview/container awkwardness, traps scrolling inside the note surface, and makes the notes header follow the shared floating-shell behavior instead of the task-detail header behavior the rest of mobile UX already uses.

The follow-up should keep the desktop notes tree and action model intact, but give notes its own task-detail-style mobile chrome. On mobile, the note body should become a single page surface: header at the top, toolbar below it, then either editor or preview in normal page flow. The floating header should be a separate compact element that appears/disappears using the same sentinel- and scroll-intent-based rules as `TaskDetailPage`, rather than reusing the generic settings subnav wrapper.

## Baseline note
This task worktree is missing the notes stack entirely. The implementation branch must start from a baseline that already contains:
- `feat(notes): add project notes UI and agent tools` (`16cb553`)
- `feat(notes): apply mobile sub-navigation pattern` (`1cdf01a`)
- `fix(notes): compact mobile subnav follow-up` (`01dea01`)

Use that branch/stack or the merged equivalent before coding.

## Current-state findings
- `src/App.tsx` on the notes branch treats `activePage === "notes"` like chat/sessions and routes it through `content--fill-page`, which keeps notes in the fill-page shell instead of the normal document-style page flow.
- `src/pages/NotesPage.tsx` renders `<SettingsMobileSubnavHeader />` above `ResizableSidebarLayout`, so the mobile header lives outside the page detail content instead of behaving like a normal page header plus compact floating clone.
- `previewVisible` only adds/removes a second pane; the editor always stays mounted, so the toggle does not actually switch the main content surface.
- `src/styles.css` gives the notes editor/preview fixed panel behavior (`flex: 1`, `min-height`, `overflow: auto`), which creates nested scroll regions rather than letting the page own the scroll.
- `src/components/SettingsMobileSubnavHeader.tsx` drives notes floating chrome from the shared shell behavior (`shellRect.top` + shared floating shell), whereas `src/pages/tasks/TaskDetailPage.tsx` uses a page-owned primary header, sentinel, eligibility/shown split, and scroll-direction intent.

## Recommended implementation

### 1. Refresh to the correct notes baseline
- Rebase/recreate the implementation worktree from a branch that already contains ORC-202 + ORC-208.
- Do not implement this follow-up against the current detached task worktree state, because the required notes files are absent.

### 2. Move notes back into page-driven scrolling
In `src/App.tsx` and notes page CSS:
- stop treating notes like chat/sessions in the fill-page route, or otherwise remove the mobile-only fill-page/overflow-hidden behavior for notes;
- let the notes detail live inside the normal `.content` page scroll model used by task details;
- keep desktop split/resizable behavior intact where it still makes sense.

### 3. Make preview replace the main note surface
In `src/pages/NotesPage.tsx`:
- change the preview toggle from “show an extra pane” to “switch the detail body between edit mode and preview mode”;
- keep the save/revert/status toolbar outside that mode-switched body so actions stay stable;
- prefer a single shared detail-body slot that renders either:
  - the markdown editor, or
  - the rendered markdown preview.

This should eliminate the current split/container flow instead of merely collapsing it into a stacked mobile layout.

### 4. Remove nested scrolling from the note body on mobile
In `src/components/SyntaxHighlightedMarkdownEditor.tsx` and `src/styles.css`:
- add an auto-grow/mobile-flow mode for the markdown editor so the editor height follows content instead of forcing an inner scrollable region;
- make the preview surface render inline in page flow on mobile instead of using `overflow: auto` as its main interaction model;
- keep any larger-screen minimum sizing that is still useful for desktop, but mobile should scroll the page, not a child panel.

### 5. Align notes header/floating header with task details
In `src/pages/NotesPage.tsx`:
- replace notes’ reliance on `SettingsMobileSubnavHeader` with a notes-owned mobile header structure that mirrors `TaskDetailPage`:
  - primary header in normal page flow,
  - sentinel immediately after it,
  - separate compact floating header rendered only when eligible,
  - eligible/shown state split,
  - scroll-direction threshold to hide on downward movement and reveal on upward movement;
- base eligibility on the sentinel and page scroll state, not on the shared header shell height;
- ensure the primary notes header keeps its own natural height and does not inherit the floating header’s compact sizing/behavior.

If extracting shared logic is worthwhile, share only the measurement/state helper; do not keep the current shared shell contract as the notes UI surface.

### 6. Preserve desktop notes behavior where it is still correct
- keep the desktop notes tree sidebar and page-level actions;
- keep mobile action density compact via the floating/header action menu;
- avoid broad rewrites to settings pages or the generic mobile subnav unless they are required to support a shared helper extraction.

## Regression coverage
Update/add coverage around the notes stack:
- `tests/e2e/notes.spec.ts`
  - selecting a note on mobile still works,
  - preview toggle swaps the main surface rather than showing both surfaces,
  - long notes scroll via the page/content container instead of a preview/editor sub-container,
  - floating notes header is hidden on downward scroll and visible on upward scroll,
  - primary header spacing stays stable when the floating header appears;
- update any notes contract test to reflect the new notes-owned mobile header structure instead of asserting direct `SettingsMobileSubnavHeader` usage.

## Validation
- `npm run build`
- `npx playwright test tests/e2e/notes.spec.ts`
- targeted Vitest coverage for notes/header/editor contracts if new helper logic is extracted

## Non-goals
- Do not redesign the notes tree or note actions.
- Do not change task-detail header behavior itself beyond borrowing its model.
- Do not broaden this into a settings/mobile-subnav redesign unless notes needs a small shared helper extraction.