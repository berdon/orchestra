# OD-26 completed-task unread comment visibility plan

## Problem summary

The current task UI treats `unreadCommentCount > 0` as a universal signal to show unread-comment attention. That means completed tasks can still render warning-style unread badges in overview and detail surfaces, which makes closed work look like it still needs active attention.

This also leaks into the global Tasks navigation badge because `src/App.tsx` currently sums unread comment counts across all tasks without filtering by status.

## Current-state findings

### Overview card rendering

`src/pages/tasks/TaskCompactCard.tsx`
- The compact card meta row renders `data-role="task-card-unread-comments-badge"` whenever `task.unreadCommentCount > 0`.
- `TaskCompactCard` is reused for both active workflow cards and the workflow done grid, so completed/canceled tasks inherit the same unread-attention treatment.

### Table rendering

`src/pages/tasks/WorkflowTaskBoardSection.tsx`
- The table comments cell renders `data-role="task-table-unread-comments-badge"` whenever `task.unreadCommentCount > 0`.
- In table mode, the same component renders both active lane tasks and `section.doneTasks`, so completed tasks can show unread badges there too.

### Detail rendering

`src/pages/tasks/TaskDetailPage.tsx`
- The summary footer renders `data-role="task-unread-comments-footer-badge"` whenever `task.unreadCommentCount > 0`.
- The comments tab button renders `data-role="task-unread-comments-tab-badge"` whenever `task.unreadCommentCount > 0`.
- Those are attention indicators, not historical counts, so they should follow the same completed-task suppression rule as overview surfaces.

### Nav aggregation

`src/App.tsx`
- `countUnreadTaskComments(tasks)` currently reduces every task’s `unreadCommentCount` with no status check.
- That means completed-task unread state can keep the global Tasks nav badge active even if no non-complete task needs attention.

### Underlying unread state already lives separately from UI badges

`src/pages/TasksPage.tsx`
- The current mark-as-read flow (`handleMarkTaskCommentsReadForUser`) only runs when the comments tab is opened and unread comments exist.
- This ticket does not require changing receipt storage, comment history, or unread counting logic in the backend/mock transport.
- The safest change is render-time suppression of attention badges while leaving the underlying unread state intact until the normal read flow clears it.

## Recommended product semantics

1. **Unread comment state remains real data.** Do not zero out or mutate stored unread counts just because a task is completed.
2. **Unread comment attention badges should only show for non-terminal work.** If the task is closed, unread comments are historical context, not active queue pressure.
3. **Use terminal-status semantics, not a one-off component exception.** The recommended rule is to suppress unread-comment attention for `completed` and `canceled` tasks together.
   - The ticket explicitly calls out completed tasks.
   - Including `canceled` keeps behavior consistent for the whole done/closed category and avoids leaving the same bug in adjacent done surfaces.
4. **Neutral comment history stays visible.** `task.commentCount` should continue to render normally on cards, tables, and detail pages.
5. **Existing mark-as-read behavior can remain unchanged.** If a user opens the comments tab on a completed task and the app marks comments read, that is acceptable. The required change is hiding active-attention badges on closed work.

## Recommended implementation

### 1. Centralize unread-attention visibility

Add a small shared helper, for example `src/lib/taskUnreadCommentVisibility.ts`, so every surface follows the same rule.

Recommended helper shape:

```ts
import type { TaskStatus } from "../types";

const TERMINAL_UNREAD_HIDDEN_STATUSES: TaskStatus[] = ["completed", "canceled"];

export function shouldShowUnreadCommentAttention(task: Pick<TaskSummary, "status" | "unreadCommentCount">) {
  return task.unreadCommentCount > 0 && !TERMINAL_UNREAD_HIDDEN_STATUSES.includes(task.status);
}

export function countVisibleUnreadTaskComments(tasks: Array<Pick<TaskSummary, "status" | "unreadCommentCount">>) {
  return tasks.reduce((total, task) => total + (shouldShowUnreadCommentAttention(task) ? task.unreadCommentCount : 0), 0);
}
```

A shared helper is preferable to repeating `task.status !== "completed"` checks in multiple components because it keeps nav, overview, and detail semantics aligned.

### 2. Update overview surfaces to use the helper

Update:
- `src/pages/tasks/TaskCompactCard.tsx`
- `src/pages/tasks/WorkflowTaskBoardSection.tsx`

Both components should render the warning unread badge only when `shouldShowUnreadCommentAttention(task)` is true.

### 3. Update detail attention surfaces to use the helper

Update `src/pages/tasks/TaskDetailPage.tsx` so:
- the summary footer unread badge is hidden for terminal tasks
- the comments tab unread badge is hidden for terminal tasks

This keeps the detail page consistent with the overview surfaces.

### 4. Update nav aggregation to ignore terminal-task unread attention

Update `src/App.tsx` so the Tasks nav badge uses the same shared visibility/counting rule instead of summing every task’s unread count.

This is important because otherwise completed-task unread state would still keep task-level attention visible outside the detail/list/card/table surfaces.

### 5. Do not change transport/read-receipt behavior

Avoid modifying:
- `TaskSummary` / `TaskDetail` unread-count fields
- task comment read-receipt persistence
- comment-count computation in the backend/mock layer

This ticket should be a presentation-semantics change, not a data-model change.

## Regression coverage plan

### Web e2e coverage

Extend the existing unread badge scenario in `tests/e2e/tasks.spec.ts` so it seeds:
- one non-completed task with unread non-user comments
- one completed task with unread non-user comments
- optionally one canceled task with unread non-user comments to lock the terminal-status recommendation

Recommended assertions:

1. **Nav badge**
   - counts only unread comments from non-terminal tasks
2. **Cards**
   - active/non-terminal task shows `task-card-unread-comments-badge`
   - completed task does not show the card unread badge in the done surface
3. **Table rows**
   - active/non-terminal task shows `task-table-unread-comments-badge`
   - completed task does not show the table unread badge in the done surface
4. **Detail page**
   - active/non-terminal task shows footer/tab unread badges before comments are opened
   - completed task detail does not show footer/tab unread badges even if `unreadCommentCount` is still non-zero
5. **Existing clear-on-open behavior**
   - opening the comments tab for the active task still clears the active-task unread badges/nav count as it does today

### Desktop e2e coverage

Update `tests/desktop-e2e/task-comment-unread-badges.test.ts` (or add a sibling scenario) so the desktop shell exercises the same completed-vs-active distinction. The desktop test already covers this UI family and is the best place to keep parity with the web behavior.

### Fast helper test

Add a focused Vitest for the shared helper, e.g. `tests/task-unread-comment-visibility.test.ts`, to verify:
- `in_progress` / `blocked` / `in_review` tasks with unread comments still return visible attention
- `completed` and `canceled` tasks with unread comments do not
- zero unread counts never show attention

That gives a fast regression tripwire in addition to the end-to-end UI coverage.

## Files expected to change in implementation

- `src/App.tsx`
- `src/pages/tasks/TaskCompactCard.tsx`
- `src/pages/tasks/WorkflowTaskBoardSection.tsx`
- `src/pages/tasks/TaskDetailPage.tsx`
- `src/lib/taskUnreadCommentVisibility.ts` (new helper)
- `tests/e2e/tasks.spec.ts`
- `tests/desktop-e2e/task-comment-unread-badges.test.ts`
- `tests/task-unread-comment-visibility.test.ts` (new)

## Validation

Recommended focused validation after implementation:

```bash
npm run test -- tests/task-unread-comment-visibility.test.ts
npm run test:e2e -- --grep "task comment unread badges"
```

If the desktop suite is available in the worker environment, also run the existing desktop unread badge scenario after updating it.
