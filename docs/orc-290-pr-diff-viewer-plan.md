# ORC-290 PR diff viewer redesign plan

## tl;dr
- Keep the existing PR data source and unified patch payload; this redesign can stay frontend-only.
- Rebuild `TaskDiffViewer` so each file renders as one continuous side-by-side code surface instead of two bordered cards per line.
- Explicitly render collapsed/skipped separators between hunks, keep normal diff context around each hunk, and move comment threads/composers out of the code cells so the code view stays continuous.
- Update PR diff tests to cover multi-hunk gaps, changed-line highlighting, and the removal of the per-line card presentation.

## Executive summary
The current PR tab already has the right raw data: `TaskDiffViewer.tsx` parses unified patch text into hunks and split rows, and git is already giving us natural changed-region windows with surrounding context. The UX problem is almost entirely in presentation. Each rendered side is wrapped in a padded bordered pane (`task-pr-diff-pane`), so the diff reads like a stack of cards instead of a normal code review surface.

The lowest-risk plan is to keep the existing patch model and refactor the viewer into a continuous diff table inside a single code-style viewport. That means one row per diff line pair, shared gutters, shared background, explicit hunk-gap separators, and inline annotations/colors for add/delete/context rows. Comment buttons should stay attached to changed lines, but comment threads and draft composers should render as supplemental rows below the code row instead of inflating the code cells themselves.

## Current-state findings
- `src/components/TaskDiffViewer.tsx` already parses unified hunks and aligns delete/add pairs with `buildSplitDiffRows(...)`.
- The current DOM makes every rendered side a standalone pane with padding, border radius, and its own nested content stack. That is the core reason the viewer feels card-based.
- Hunk skipping already exists implicitly in the git patch, but the UI does not render a clear “skipped unchanged lines” separator between hunks.
- Review comments are currently rendered inside the same pane as the code line, which further breaks the visual continuity of the diff.
- No backend/API change is required for this task unless we later want tunable context sizes; ORC-290 can ship as a frontend/test pass.

## Proposed implementation

### 1. Reshape the parsed diff model around continuous rows
In `src/components/TaskDiffViewer.tsx`:
- extend `ParsedDiffHunk` to keep numeric hunk metadata (`oldStart`, `oldCount`, `newStart`, `newCount`)
- derive a richer render model for each file, e.g. code rows + meta rows + gap rows
- compute gap rows between adjacent hunks from the hunk ranges so the UI can show a collapsed unchanged-region separator such as “Skipped 24 unchanged lines”
- preserve existing add/delete pairing behavior so modified hunks still align old/new cells correctly

### 2. Replace per-line panes with a single diff surface
Refactor the diff body into a continuous side-by-side viewer:
- one outer `file-content-viewer` shell per file/hunk block, not per line
- each code row should render as a four-column grid:
  - old gutter
  - old code
  - new gutter
  - new code
- gutters should own line numbers and comment buttons
- code cells should be flat line rows with diff background treatments, not padded cards
- hunk headers and meta lines (`\\ No newline at end of file`, etc.) should render as full-width utility rows
- comment threads and open draft composers should render in dedicated full-width follow-up rows beneath the anchored diff row so the code surface remains readable

### 3. Restyle the viewer to match a conventional diff/file review surface
In `src/styles.css`:
- replace `task-pr-diff-pane*` card styling with row/cell styling closer to the existing `file-content-viewer` language
- use subtle continuous row backgrounds for:
  - context
  - additions
  - deletions
  - empty paired cells
- keep the two sides visually distinct but joined in one table-like surface
- keep horizontal overflow on smaller screens instead of collapsing out of side-by-side mode
- make gap separators and hunk headers visually obvious so multi-hunk files are easy to scan

### 4. Keep comment behavior, but move it off the main code cell layout
Preserve the current diff-comment model, but change the rendering pattern:
- changed lines still expose inline comment affordances
- existing/outdated thread detection logic can stay
- current threads should render below their anchored row with a side/line badge
- draft composer should open as a supplemental row, not inside a code card

This keeps the review workflow intact while removing the card-per-line feel.

## Regression coverage
Update `tests/task-pr-tab.test.tsx` to cover:
- multi-hunk diff rendering with an explicit skipped/gap separator
- continuous diff structure for side-by-side rows
- changed-line comment affordances still appearing only on add/delete lines
- outdated comments still surfacing separately
- absence of the old per-line card shell in the rendered diff markup

If a lightweight UI regression is needed beyond SSR assertions, reuse the existing PR tab coverage path rather than adding backend-specific tests.

## Expected file touch list
- `src/components/TaskDiffViewer.tsx`
- `src/styles.css`
- `tests/task-pr-tab.test.tsx`
- `src/pages/tasks/TaskPullRequestTab.tsx` only if small shell/header adjustments are needed during integration

## Notes for implementation
- Treat this as a frontend refactor, not a PR data-model rewrite.
- Git hunks already provide the changed-region jumping behavior; the missing piece is presenting hunk gaps clearly.
- Screenshot capture/attachment should happen in the implementation lane after the redesigned multi-hunk view is running locally.
