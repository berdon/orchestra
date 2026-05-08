# ORC-271 — Task comment typing performance plan

## tl;dr

- The likely root cause is the React render boundary, not autosize or draft persistence. Comment/reply keystrokes currently rerender a very large task-detail subtree.
- `TasksPage.tsx` hoists the top-level `commentDraft`, and `TaskDetailPage.tsx` keeps `replyDraft` above the default-file preview, history, tabs, and the full comment thread list.
- Every rerender walks existing threads again and reruns markdown rendering for each existing comment/reply via `TaskCommentMessage` → `MarkdownContent` → `marked.lexer(...)`.
- Fix by isolating draft state to the smallest subtree, memoizing thread/message rendering, and keeping static sections like the file viewer/history out of the keystroke path.
- Validate with seeded heavy comment/reply histories in browser + desktop flows, and keep a narrow-layout smoke check in scope.

## Executive summary

This looks like an input-path regression caused by draft state living too high in the tree.

Relevant code paths:

- `src/pages/TasksPage.tsx`
  - top-level comment draft state: `commentDraft`
- `src/pages/tasks/TaskDetailPage.tsx`
  - reply draft state: `replyDraft`
  - thread derivation: `buildTaskCommentThreads(task.comments)`
  - summary view also renders the default-file preview (`CommentableFileViewer`), recent history, and the full task conversation
- `src/components/TaskCommentMessage.tsx`
- `src/components/MarkdownContent.tsx`

That means:

1. typing in the top-level composer rerenders `TasksPage` and `TaskDetailPage`
2. typing in a reply rerenders all of `TaskDetailPage`
3. each rerender re-walks the thread tree and re-renders all existing comment/reply markdown

The expensive part is not the textarea itself. The composer uses a normal `<textarea>` in `AutocompleteTextarea.tsx`; there is no autosize loop here, and there is no per-keystroke draft persistence write in this path. Mention search is also unlikely to be the primary issue because it only does real work when an `@` or `$` token is active, while plain typing still pays the full rerender cost.

## Current diagnosis

### 1. Excessive rerenders are the main structural issue

The top-level composer state is owned by `TasksPage`, so every message keystroke invalidates the entire detail route. The reply composer state is owned by `TaskDetailPage`, so every reply keystroke invalidates the whole detail page summary.

### 2. Markdown rendering amplifies the rerender cost

`TaskCommentMessage` renders `MarkdownContent`, and `MarkdownContent` lexes markdown during render with `marked.lexer(...)` and syntax highlighting for code blocks. Existing comments/replies therefore do repeated parsing work even when only the unsent draft changed.

### 3. Thread derivation is coupled into the same render path

`TaskDetailPage` currently rebuilds and re-sorts comment threads inline on render. That is not the only cost, but it adds more avoidable work to each keystroke.

### 4. Autosize and draft-persistence are not the likely root cause

- No autosizing textarea is in this path; the composer uses a fixed-rows textarea.
- No localStorage or backend persistence happens on ordinary keystrokes.
- Mention/autocomplete should stay in validation scope, but it does not explain severe lag during plain typing.

## Recommended implementation shape

### 1. Move the hot draft state down

Refactor the conversation UI so ordinary typing does not rerender the full task detail shell.

Recommended direction:

- extract a memoized `TaskConversationSection` from `TaskDetailPage`
- keep top-level message draft state inside that section instead of `TasksPage`
- keep reply draft state scoped inside the conversation section or active thread item
- if shared author / interrupt defaults must remain synchronized with file-comment flows, keep only that lightweight meta state above the conversation boundary and keep message text local

### 2. Stop re-rendering static thread content on every keystroke

- memoize `commentThreads` with `useMemo`
- extract memoized thread row / reply row components
- memoize `TaskCommentMessage` and stabilize any callbacks/lookups it receives
- if needed, cache markdown parsing/render output so unchanged messages do not re-lex on unrelated renders

The target outcome is: typing in one composer only rerenders that composer and the minimum active thread UI.

### 3. Keep unrelated heavy sections out of the input path

The summary page also renders:

- `CommentableFileViewer`
- recent activity/history blocks
- other summary metadata

Those sections should not rerender because a comment draft changed. Extract or memoize them so comment typing does not invalidate the default-file preview or other static detail content.

### 4. Preserve existing correctness contracts

While refactoring, explicitly preserve:

- top-level draft reset after successful top-level send
- reply targeting from both parent comments and nested reply buttons
- unsent draft survival across silent task-detail refreshes
- send behavior via button and `Ctrl+Enter` / `⌘+Enter`
- mention/file autocomplete behavior
- unread/read refresh behavior after comment sends and comment-tab viewing

## Validation plan

### Browser / Playwright

Add or extend a task-detail test that seeds a heavier comment history and covers:

- typing a short top-level comment
- typing a long multiline top-level comment
- opening a reply from an existing thread and typing a reply
- reply targeting from a nested reply button
- narrow/mobile-ish viewport smoke check for the same flows if the refactor touches layout behavior

If the implementation supports it cleanly, add a coarse regression guard that proves typing no longer triggers broad thread churn (for example render instrumentation in test/dev mode, or a stable heavy-history typing budget that is generous enough to avoid flake).

### Desktop / Podman runner

Extend the desktop task-comment journey with a representative heavy-thread typing flow so the real desktop runtime path is covered, not just the browser mock path.

### Existing coverage likely to be touched

- `tests/e2e/tasks.spec.ts`
- `tests/desktop-e2e/task-comment-replies.test.ts`
- possibly a new focused comment-typing performance spec
- `tests/ui-coverage-matrix.json` if a new desktop/browser spec is added

## Files most likely to change

- `src/pages/TasksPage.tsx`
- `src/pages/tasks/TaskDetailPage.tsx`
- `src/components/TaskCommentComposer.tsx`
- `src/components/TaskCommentMessage.tsx`
- `src/components/MarkdownContent.tsx`
- `src/components/CommentableFileViewer.tsx` (only if shared draft/meta coupling needs to be split cleanly)
- comment/reply browser + desktop regression specs

## Key risk to watch

The main refactor risk is changing draft-sharing semantics accidentally. Today the task-detail comment composer and default-file comment flows share parts of `commentDraft`. The implementation should decide that behavior intentionally rather than breaking it as a side effect of the performance fix.