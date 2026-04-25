# ORC-168 task-comment reply UX plan

## tl;dr
- Keep reply threading one level deep: every reply action targets the top-level thread comment.
- Make `Reply` open the existing inline reply composer, then scroll it into view and focus its message textarea.
- Add the same reply affordance to nested comments, but resolve their submit target to the parent thread id.
- Thread this through the existing composer ref path instead of adding new APIs or backend nesting behavior.
- Cover top-level reply, nested reply, focus/scroll, and parent-thread attachment with Playwright regression coverage.

## Executive summary
`TaskDetailPage` already owns task comment reply state with `replyTargetCommentId` and renders one inline `TaskCommentComposer` after the selected top-level thread. The current `openReplyComposer(comment)` only sets state; it does not move the viewport or focus the textarea, and nested rendered replies do not expose a `Reply` action. Because the backend/mock comment path rejects replies to replies, this change should not introduce deeper threading. It should normalize all reply actions to the top-level thread id, render the one existing inline composer for that thread, and then scroll/focus that composer after React has mounted it.

## Current-state findings
- `src/pages/tasks/TaskDetailPage.tsx` builds `commentThreads` via `buildTaskCommentThreads()` and renders parent comments plus direct replies.
- Top-level comments expose `data-role="reply-task-comment"`; nested comments render message content only.
- `openReplyComposer(comment)` sets `replyTargetCommentId` and `replyDraft.parentCommentId` to `comment.id` without scroll/focus side effects.
- The inline reply composer renders only when `replyTargetCommentId === comment.id`, after any existing replies in that top-level thread.
- Summary cards in the repo-files tab already switch to the comments tab and call `openReplyComposer(comment)`, so they should benefit from the same focus/scroll effect.
- `AutocompleteTextarea` already supports a `textareaRef`, but `TaskCommentMentionsTextarea` and `TaskCommentComposer` do not currently expose it.
- The mock client enforces one-level threading: a `parentCommentId` that points at an existing reply is rejected with `Replies can only target top-level comments.`

## Recommended implementation

### 1. Expose a composer message textarea ref
In `src/components/TaskCommentComposer.tsx` and `src/components/TaskCommentMentionsTextarea.tsx`:
- add an optional `messageRef`/`textareaRef` prop typed as `MutableRefObject<HTMLTextAreaElement | null>`.
- pass it through to the existing `AutocompleteTextarea.textareaRef` prop.
- keep the prop optional so existing composer call sites remain unchanged.

### 2. Normalize reply targets to the top-level thread
In `src/pages/tasks/TaskDetailPage.tsx`:
- replace `openReplyComposer(comment)` with a helper that accepts the top-level thread comment plus, optionally, the clicked comment.
- set `replyTargetCommentId` and `replyDraft.parentCommentId` to the top-level thread comment id only.
- preserve the existing author/default draft behavior.
- use this helper for parent comment actions, repo-file summary actions, and nested reply actions.

### 3. Scroll and focus after the reply composer mounts
In `TaskDetailPage`:
- add refs for the active reply composer container and its message textarea.
- add a small pending-focus state/ref set by the reply action.
- after `replyTargetCommentId` is set and `activeTab === "comments"`, schedule a `requestAnimationFrame`/short timeout effect that:
  - scrolls the reply composer into view (`block: "center"` is a good default for long threads), and
  - focuses the reply message textarea.
- clear the pending focus marker after a successful focus attempt.
- make the effect handle the repo-file summary path where `setActiveTab("comments")` and `openReplyComposer(...)` happen in the same click.

### 4. Add nested-comment Reply affordances
In the nested reply render loop in `TaskDetailPage`:
- add the same visible `Reply` button/action styling used by top-level comments.
- include stable test attributes, preferably reusing `data-role="reply-task-comment"` plus `data-comment-id={reply.id}` and `data-parent-comment-id={comment.id}`.
- call the normalized helper with the top-level thread comment so nested replies still submit with `parentCommentId` equal to the top-level id.

### 5. Regression coverage
Update `tests/e2e/tasks.spec.ts` near the existing task comment tests:
- Seed or create a task with a long enough comment thread that the selected reply composer would otherwise be off-screen.
- Verify clicking `Reply` on a top-level comment makes `[data-role="task-reply-message"]` visible/focused and its composer is in the viewport.
- Verify nested comments expose a `Reply` action and clicking it also scrolls/focuses `[data-role="task-reply-message"]`.
- Submit a nested-comment reply and assert the stored/mock comment has `parentCommentId` equal to the top-level comment id, not the clicked nested reply id.
- Keep the existing repo-file summary reply test passing; optionally extend it to assert focus after switching tabs.

## Validation
- Run the targeted Playwright task-comment coverage, at minimum the affected `tests/e2e/tasks.spec.ts` cases.
- Run `npm run build` for TypeScript coverage after wiring the ref props.
- If time permits, run `npm run test` to ensure comment-thread helper regressions stay green.

## Non-goals
- Do not add nested-nested comment storage, API behavior, or rendering.
- Do not change `buildTaskCommentThreads()` beyond what is needed for tests; the UI should avoid sending nested parent ids.
- Do not redesign task comments or move replies to a different composer model.
