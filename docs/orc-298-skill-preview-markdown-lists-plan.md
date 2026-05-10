# ORC-298 skill preview markdown list rendering plan

## tl;dr
- `SkillsPanel` preview reuses the shared `MarkdownContent` renderer, so the bug is probably in the skills-specific preview wrapper or in list-item recursion edge cases, not in a completely separate markdown path.
- The most likely simple-list regression is `.skills-markdown-preview-shell { overflow: auto; }` clipping `list-style-position: outside` bullets/numbers in the Preview tab even when the `<ul>/<ol>` DOM is correct.
- While fixing that, verify nested list handling too: `MarkdownContent` currently renders list item bodies through the inline-token helper, which is likely to flatten nested block tokens.
- Add a focused Podman desktop regression that opens a skill preview with intro text, unordered items, ordered items, and a nested list sample if nested rendering is supported.

## Executive summary
`src/settings/SkillsPanel.tsx` renders the SKILL.md Preview tab through the shared `MarkdownContent` component. That same renderer is already used by task description/comment surfaces, and the repo already carries task markdown list coverage in both browser and desktop tests. That makes the skills preview shell the main suspect for the reported "lists disappear/flatten" behavior.

The key skills-specific delta is `src/styles.css`, where `.skills-markdown-preview-shell` wraps the markdown surface with `overflow: auto`. The shared markdown list styles use outside markers (`disc outside` / `decimal outside`), so the Preview shell can hide bullets/numbers even when the list structure is present. Separately, the current `MarkdownContent` list branch renders each list item with `renderInlineTokens(item.tokens, ...)`, which is fine for simple inline items but is likely insufficient for nested lists or other block content within an item. The implementation should therefore reproduce with unordered, ordered, and nested samples, fix the shell styling for simple markers, and only refactor the renderer if nested/block list items still flatten.

## Current-state findings
- `src/settings/SkillsPanel.tsx` Preview tab uses `<MarkdownContent dataRole="skill-markdown-preview" message={currentDetail.markdownBody} />` inside `.skills-markdown-preview-shell`.
- `src/components/MarkdownContent.tsx` already has explicit top-level `list` handling and shared ordered/unordered classes.
- `src/components/MarkdownContent.tsx` currently renders list item bodies via `renderInlineTokens(item.tokens, ...)` instead of a recursive block-token renderer.
- `src/styles.css` sets `.skills-markdown-preview-shell { overflow: auto; }`, while shared markdown list styles use outside markers via `.transcript-markdown-list--ordered` / `--unordered`.
- Existing regression coverage already exercises task markdown lists in:
  - `tests/desktop-e2e/task-markdown-lists.test.ts`
  - `tests/e2e/tasks.spec.ts`
  Those tests reduce the likelihood that the main failure is a global markdown parser regression.

## Recommended implementation

### 1. Reproduce with a skills-specific markdown fixture
Use a Preview-tab sample that contains:
- a heading and paragraph before the list,
- an unordered list,
- an ordered list,
- trailing paragraph text,
- a nested list under one parent item (to determine whether nested list support is already broken or just untested).

### 2. Fix the skills preview shell first if the DOM already contains `<ul>/<ol>/<li>`
In `src/styles.css`:
- remove or relax the shell-level `overflow: auto` so outside list markers are not clipped;
- keep scrolling on code/fallback pre blocks, which already have their own `overflow: auto` styling;
- preserve existing paragraph spacing and card layout for non-list markdown.

This is the smallest likely fix for the reported simple-list regression.

### 3. Promote list items to block-aware rendering if nested items still flatten
If reproduction shows nested lists or block content inside list items collapsing into plain text, refactor `src/components/MarkdownContent.tsx` so list items render through a shared recursive block renderer instead of the inline-only helper. The goal is:
- top-level markdown and list-item markdown follow the same token rules;
- nested ordered/unordered lists render as nested `<ol>/<ul>` rather than raw text;
- surrounding paragraphs/formatting around lists remain unchanged.

### 4. Add focused Podman desktop regression coverage
Preferred path: extend `tests/desktop-e2e/skills-settings.test.ts` with a dedicated Preview-tab assertion flow (or add a small adjacent spec if isolation is cleaner).

The regression should:
- create or load a skill whose SKILL.md contains intro text + unordered list + ordered list + trailing paragraph;
- open `Settings` → `Skills` → target skill → `Preview`;
- assert the preview still contains the surrounding heading/paragraph content;
- assert unordered list items render as list items in the preview DOM;
- assert ordered list items render in order, including `value="2"` on the second `<li>` if the renderer continues to set explicit ordered values;
- if nested list support is implemented, assert the nested `<ul>`/`<ol>` is present beneath the parent item.

## Validation
- `npm run build`
- `./scripts/run-desktop-e2e-podman.sh tests/desktop-e2e/skills-settings.test.ts`
- If `MarkdownContent` gets refactored, add a small Vitest/jsdom regression for recursive list rendering and run that targeted test too.

## Non-goals
- Do not redesign the Skills Preview UI beyond the list-rendering fix.
- Do not broaden this into general markdown restyling unless required to keep surrounding content correct.
- Do not replace the Podman desktop regression with a browser-only test; this task explicitly wants the supported desktop Podman path.