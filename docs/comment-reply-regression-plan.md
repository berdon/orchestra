# Comment reply regression investigation plan

## What exists today

Task comment replies already have end-to-end plumbing across the backend, task detail UI, and desktop E2E harness:

- Backend persistence and validation live in `src-tauri/src/services/tasks.rs`.
- Desktop/web client transport lives in `src/lib/tauri.ts`.
- Task-detail thread rendering lives in `src/pages/tasks/TaskDetailPage.tsx`.
- Default-file anchored thread rendering lives in `src/components/CommentableFileViewer.tsx`.
- Podman desktop coverage already invokes `tests/desktop-e2e/task-comment-replies.test.ts` via `npm run test:desktop-e2e`.

That means the main implementation task is not brand-new runner setup; it is to diagnose the regression, fix the broken reply behavior, and strengthen the existing reply coverage so it validates durable threaded behavior.

## Most likely regression points

### 1. Thread grouping / ordering drift in the UI

Thread-building logic currently exists in two places:

- `groupTaskComments()` in `src/pages/tasks/TaskDetailPage.tsx`
- `buildFileCommentThreads()` in `src/components/CommentableFileViewer.tsx`

This duplication makes regressions likely when comment ordering or rendering rules change in one surface but not the other.

A concrete risk is the current task-detail sort behavior:

- top-level comments are sorted by the parent comment `updatedAt`
- replies are attached under the parent, but reply activity does **not** update the parent comment timestamp
- summary threads on the Repo files tab use the same grouped list

If the intended UX is “recent thread activity stays prominent,” then replying to an older thread will not move that thread forward. That is a strong candidate for the reported “partially regressed” behavior and should be explicitly reproduced first.

### 2. Real backend persistence vs. shallow happy-path assertions

The backend correctly validates `parent_comment_id` and rejects nested replies, but the current E2E coverage is still narrow:

- `tests/desktop-e2e/task-comment-replies.test.ts` verifies creating a reply and checking `parentCommentId`
- it does **not** verify reload/reopen behavior
- it does **not** verify that non-reply comments remain top-level
- it does **not** assert that replies render in the correct thread after task refresh/navigation

So even if persistence is correct, refresh/rendering regressions can slip through.

### 3. Surface inconsistency between task comments and default-file comment threads

The default-file viewer has its own reply UI and thread grouping path. If the root issue is in shared persistence the fix belongs in backend/transport, but if the issue is UI grouping/rendering then both task-detail comments and anchored file-comment threads must be checked together.

## Recommended implementation approach

### Step 1: Reproduce the failure in the real desktop path

Start from `tests/desktop-e2e/task-comment-replies.test.ts` and make the reproduction explicit in the real podman runner path.

Minimum reproduction matrix:

1. create a top-level comment
2. create a reply to that top-level comment
3. confirm the reply is nested under the original parent in the task detail UI
4. navigate away and back to the task, or close/reopen task detail
5. confirm the same parent/reply thread still renders correctly
6. create another top-level comment and verify it is not incorrectly threaded
7. if ordering is part of the bug, assert the intended thread order after reply activity

### Step 2: Consolidate thread derivation if the bug is UI-side

If diagnosis shows a render/threading bug, prefer extracting shared thread-building logic into a single helper used by both:

- `src/pages/tasks/TaskDetailPage.tsx`
- `src/components/CommentableFileViewer.tsx`

That will reduce future drift and make unit coverage easier.

### Step 3: Decide the correct ordering model

If reply activity is expected to affect thread prominence, use a thread-level sort key such as:

- max(parent.updatedAt, ...reply.updatedAt)

rather than sorting purely on the parent comment timestamp.

If reply activity is **not** expected to reorder threads, the E2E tests should still lock down the intended behavior so future regressions are easier to diagnose.

### Step 4: Add supporting lower-level coverage

Add or extend tests close to the failure:

- backend service tests in `src-tauri/src/services/tasks.rs`
  - reply creation on top-level comment
  - nested reply rejection
  - list order / parent-child persistence after reload-style fetches
- frontend unit/integration coverage for thread grouping helper if logic is extracted
- web Playwright coverage in `tests/e2e/tasks.spec.ts` where appropriate for fast feedback

## Podman E2E coverage changes to make

Strengthen `tests/desktop-e2e/task-comment-replies.test.ts` so it verifies all of the following in the podman runner:

- replying to an existing top-level comment
- reply text appears under the correct parent thread
- `list_task_comments` returns the expected `parentCommentId`
- reopening or refreshing the task preserves the same thread relationship
- an unrelated new top-level comment remains top-level
- if applicable, the intended thread ordering after reply activity

Also consider mirroring the same assertions in:

- `tests/e2e/tasks.spec.ts`
- `tests/desktop-e2e/task-default-file-comments.test.ts` when anchored-thread reply behavior is part of the bug

## Files most likely to change

- `src/pages/tasks/TaskDetailPage.tsx`
- `src/components/CommentableFileViewer.tsx`
- `src/lib/tauri.ts`
- `src-tauri/src/services/tasks.rs`
- `tests/desktop-e2e/task-comment-replies.test.ts`
- `tests/e2e/tasks.spec.ts`
- possibly a new shared helper/test file for thread derivation

## Implementation outcome

The implementation lane confirmed that reply persistence and `parentCommentId` handling were still intact in the backend and client transport. The regression was in UI thread ordering on the task detail surfaces:

- `TaskDetailPage` grouped replies under the correct parent comment
- but it sorted threads only by the parent comment `updatedAt`
- replying to an older thread did not change the parent timestamp
- so an active reply thread could remain buried below newer top-level comments or drop out of the repo-files summary slice even though the reply itself existed and reloaded correctly

The fix was to move thread derivation into a shared helper and give each thread a `latestActivityAt` value derived from the parent plus all replies. Task-detail comment threads and the repo-file comment summary now sort by the thread’s latest activity instead of the parent timestamp alone, while anchored file-thread popovers reuse the same grouping logic.

## Validation completed

Validated coverage now includes:

- unit coverage for shared thread grouping and latest-activity sorting in `tests/taskCommentThreads.test.ts`
- strengthened podman desktop E2E coverage in `tests/desktop-e2e/task-comment-replies.test.ts` that verifies:
  - replying to an older top-level comment
  - rendering the reply inside the correct parent thread
  - promoting that thread ahead of newer standalone top-level comments based on reply activity
  - preserving the parent/child relationship after reopening the task
  - keeping a later unrelated top-level comment top-level

## Handoff guidance

The implementation lane should treat this as a diagnose-first bugfix:

1. reproduce on the real desktop path
2. identify whether the failure is persistence, transport, grouping, ordering, or refresh
3. fix the smallest shared layer that explains the behavior
4. expand podman E2E coverage so the exact regression cannot silently return
