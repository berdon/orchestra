# ORC-180 mobile task-detail typography plan

## tl;dr
- The most likely root cause is mobile browser text inflation, not a one-off task-detail component typo: task detail uses many sub-16px text styles on narrow cards/comments, and the app currently does not set `text-size-adjust` / `-webkit-text-size-adjust` anywhere.
- Fix this at the app/base-style level first so dynamically rendered task-detail cards, comments, and markdown blocks stop auto-enlarging on mobile.
- Verify the affected task-detail surfaces end-to-end: overview description, quick-comment summary cards, full comments tab threads/replies, and repo-file inline comment threads/popovers.
- Add a mobile regression test that compares computed font sizes across those surfaces after tab switches / newly rendered content, and keep an explicit desktop sanity check so non-mobile layout is not disturbed.

## Executive summary
`src/pages/tasks/TaskDetailPage.tsx` composes the mobile task view from a small set of reusable surfaces: `task-history-card` summary cards, `transcript-event` comment cards, `MarkdownContent` blocks, and file-comment thread cards rendered by `src/components/CommentableFileViewer.tsx`. In `src/styles.css`, many of those surfaces intentionally use small rem-based text tokens (`0.72rem`–`0.95rem`) for metadata and supporting copy, but there is no global `text-size-adjust` / `-webkit-text-size-adjust` rule. On iOS/mobile browsers, that combination commonly causes selective text inflation inside narrow, multi-line blocks, which matches the report that newly shown cards/comments suddenly render much larger than adjacent task content.

The recommended fix is to treat this as a mobile browser typography-stability issue first, not to chase each task-detail card individually. Add an explicit base text-size-adjust rule at the document/app level, then verify task-detail surfaces that mount later or switch in via tabs. Only add component-level font-size normalization if one surface still diverges after the global fix.

## Current-state findings
- `src/pages/tasks/TaskDetailPage.tsx` renders the affected mobile detail UI in these main surfaces:
  - description / summary cards via `.task-history-card`
  - comments tab and summary comment cards via `.task-comment-thread` + `.transcript-event`
  - markdown text via `src/components/MarkdownContent.tsx` (`.markdown-content`, `.transcript-event__paragraph`, `.transcript-markdown-*`)
  - repo-file inline comment threads via `src/components/CommentableFileViewer.tsx`
- `src/styles.css` defines many small text tokens for task-detail-adjacent content (`0.72rem`, `0.78rem`, `0.82rem`, `0.84rem`, `0.88rem`, `0.9rem`, `0.95rem`), which is fine on desktop but is a known trigger for mobile browser autosizing when blocks are narrow.
- There is currently no `text-size-adjust` or `-webkit-text-size-adjust` rule in the app stylesheet.
- Existing task-detail mobile Playwright coverage in `tests/e2e/tasks.spec.ts` checks navigation/dock behavior at `390x844`, but it does not assert typography consistency across cards/comments after switching sections or rendering new content.

## Recommended implementation

### 1. Reproduce on representative task-detail surfaces
Use a phone-sized viewport and a seeded task with enough content to exercise dynamic task-detail rendering:
- overview description markdown
- quick-comment summary cards on the overview tab
- full comments tab parent comments and replies
- repo-file comment thread popover / inline thread cards if practical

Prefer WebKit or a real iPhone/Safari pass for final confirmation, because Chromium mobile viewport emulation may not reproduce browser text inflation exactly.

### 2. Fix the root cause at the base stylesheet level
In `src/styles.css`, add a document/app-level text sizing rule, e.g. on `html` (and optionally reinforce on `body` / `#root` if needed):
- `-webkit-text-size-adjust: 100%;`
- `text-size-adjust: 100%;`

This should stabilize mobile font sizing across all task-detail surfaces, including content that appears only after tab changes or expanding comment/file-thread UI.

### 3. Only add local normalization if one task-detail surface still diverges
After the global fix, re-check:
- `.task-history-card`
- `.transcript-event`
- `.markdown-content`
- `.file-content-viewer__thread-card`
- `.file-content-viewer__thread-reply`

If one surface still computes differently on mobile, add the smallest explicit local font-size/inheritance correction there instead of broad task-detail-specific overrides.

### 4. Add regression coverage
Update `tests/e2e/tasks.spec.ts` with a mobile typography regression that:
1. sets a mobile viewport (`390x844` is consistent with existing task-detail coverage)
2. opens a task detail with seeded long description/comments/replies
3. records computed `font-size` for representative selectors such as:
   - task description markdown paragraph
   - overview summary comment body
   - comments tab parent comment body
   - comments tab reply body
   - optional repo-file comment thread body
4. switches sections / reveals newly rendered content
5. asserts those body text font sizes remain equal (or within a tight tolerance) instead of jumping larger on later-rendered blocks

Also keep one desktop/non-mobile sanity assertion so the fix does not accidentally alter larger-screen task-detail typography behavior.

## Validation
- `npm run build`
- targeted task-detail Playwright coverage in `tests/e2e/tasks.spec.ts`
- if available, a WebKit-targeted run or manual Safari/iPhone smoke check focused on comments and summary cards

## Non-goals
- Do not redesign task-detail typography tokens.
- Do not enlarge all small metadata text just to mask the issue.
- Do not add broad task-detail-only overrides before confirming the global text inflation fix is insufficient.
