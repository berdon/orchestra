# ORC-16 task-list lifecycle status vs queue-state plan

## Problem summary

ORC-16 is about separating two different concepts that currently feel conflated in task-list presentation:

- **task lifecycle status** — persisted on `tasks.status` (`draft`, `ready`, `in_progress`, `blocked`, `in_review`, `completed`, `canceled`)
- **runtime / dispatch state** — persisted on `task_lane_assignments.status` (`queued`, `active`, `awaiting_user_approval`, `awaiting_user_intervention`, `paused_by_user`, etc.)

The bug report is specifically that queued work can end up reading as if the task status itself is `queued`, which hides the real lifecycle state.

## What the current code says

### 1. The domain model already treats these as separate fields

- `src-tauri/src/services/tasks.rs` builds `TaskSummary.status` directly from the `tasks` table summary query.
- `src-tauri/src/services/task_runtime.rs` dispatch paths call `sync_task_lane_owner(..., "in_progress")`, so dispatching work should move the task lifecycle state to `in_progress` while assignment state may still be `queued`.
- `src/pages/tasks/TaskDetailPage.tsx` already renders the **task status badge** and the **current lane assignment badge** side-by-side in the compact/floating header.

That means the intended product model already exists: task lifecycle status and runtime assignment status are not supposed to be the same thing.

### 2. Task-list summaries currently do not expose queue/runtime state

- `src/types.ts` `TaskSummary` includes `status` and `readyForDispatch`, but not current assignment state.
- `src/lib/tauri.ts` mock `summarizeTask()` mirrors that same summary shape.
- `src/pages/tasks/TaskCompactCard.tsx` and `src/pages/tasks/WorkflowTaskBoardSection.tsx` render only `task.status`.

So the list UI today has no explicit summary-level field for queue/runtime state. If queued is appearing as the only badge in a list row/card, the root issue is that some list-facing path is treating assignment state as if it were the task lifecycle status. The safest fix is to make the distinction explicit in the list data contract and render both concepts deliberately.

## Product semantics to implement

### Primary badge: task lifecycle status

The main status badge in every task list/card/table view should always come from `task.status`.

Examples:

- queued runtime work for a task whose lifecycle state is `in_progress` => primary badge stays **in progress**
- queued runtime work for a task whose lifecycle state is `blocked` => primary badge stays **blocked**
- queued runtime work for a task whose lifecycle state is `ready` => primary badge stays **ready**

### Secondary badge: queue/runtime state

Queue/dispatch state should be surfaced separately from lifecycle status.

For this task, the minimum required behavior is:

- if the current open lane assignment is `queued`, show a separate **queued** badge
- do **not** replace the primary lifecycle badge with that queued badge

Recommended scope for ORC-16:

- show a secondary list badge only for `queued`
- keep other assignment states as future-extensible through the same data field, but do not add extra list noise unless product wants it

This keeps the fix tightly focused on the reported confusion while preserving a clean card/table layout.

### `readyForDispatch` is not a status badge

`readyForDispatch` is a capability/action state, not lifecycle status and not queue status.

It should continue to drive dispatch affordances and counts, but it should not be reused as a replacement badge for status semantics.

## Proposed implementation

## 1. Extend `TaskSummary` with summary-safe assignment state

Add an optional derived field to the task summary contract, for example:

- `activeLaneAssignmentStatus?: string | null`

This keeps task-list views lightweight without requiring the full `activeLaneAssignment` object.

### Real backend

Update:

- `src-tauri/src/models.rs`
- `src-tauri/src/services/tasks.rs`

Implementation approach:

- extend the task summary query with a correlated subquery that returns the current open assignment status for the task, if one exists
- treat open assignment states consistently with the existing runtime model (`queued`, `active`, `awaiting_user_approval`, `awaiting_user_intervention`, `paused_by_user`)
- map the derived value into `TaskSummary`

No schema migration should be needed because this is a derived summary field, not new persisted storage.

### Mock layer

Update:

- `src/types.ts`
- `src/lib/tauri.ts`

Implementation approach:

- extend TS `TaskSummary`
- set `activeLaneAssignmentStatus` from `task.activeLaneAssignment?.status ?? null` inside mock `summarizeTask()` and any related summary builders

This keeps mock/task-list behavior aligned with the Tauri backend.

## 2. Render lifecycle status and queued state together in list views

Update:

- `src/pages/tasks/TaskCompactCard.tsx`
- `src/pages/tasks/WorkflowTaskBoardSection.tsx`

Rendering rules:

- keep the existing lifecycle status badge as the first badge
- when `task.activeLaneAssignmentStatus === "queued"`, render a second compact warning badge labeled `queued`
- use the same badge order everywhere: **lifecycle status first, queued second**

Recommended UI treatment:

- primary lifecycle badge keeps existing task-status tones
- secondary queued badge uses warning tone and compact styling
- render both badges in the same status area/cell instead of adding a dedicated table column

That mirrors the semantics already used in the task detail header: the lifecycle state remains primary, while runtime state is supplemental.

## 3. Share helper logic instead of duplicating badge rules

The current board/card/table components each define their own task-status formatting helpers.

As part of the implementation, it would be worth extracting a small shared helper for:

- task lifecycle status label/tone
- whether a summary assignment badge should render in task lists
- assignment badge tone/label for queued state

Possible location:

- `src/pages/tasks/taskStatusBadges.ts`

This reduces the chance that cards and table rows drift apart again.

## Test plan

## 1. Playwright task-list regression coverage

Extend `tests/e2e/tasks.spec.ts` with a focused task-list rendering test that seeds queued assignments and verifies both card and table views.

### Suggested assertions

Seed tasks where:

- task A: `status = "in_progress"`, `activeLaneAssignment.status = "queued"`
- task B: `status = "blocked"`, `activeLaneAssignment.status = "queued"`

Assert in **card view**:

- task A card contains `in progress`
- task A card also contains a distinct `queued` badge/label
- task B card contains `blocked`
- task B card also contains a distinct `queued` badge/label
- no card shows only `queued` where the lifecycle badge should be

Assert in **table view**:

- the same rows show both lifecycle and queued labels
- the lifecycle label is still the task `status`
- queued appears as a separate indicator, not as the sole status value

Even if some status/assignment combinations are uncommon in live runtime behavior, these are the right regression fixtures because they prove the renderer uses the correct source fields.

## 2. Summary/model-level coverage

If needed, add a small unit test around the summary-building path to confirm queued assignment state survives summarization without mutating `status`.

Likely candidates:

- `tests/task-board-model.test.ts` if the board model needs to preserve the new summary field unchanged
- or a small mock-summary test near `src/lib/tauri.ts` behavior if that is easier to cover directly

## Expected code touch points

- `src-tauri/src/models.rs`
- `src-tauri/src/services/tasks.rs`
- `src/types.ts`
- `src/lib/tauri.ts`
- `src/pages/tasks/TaskCompactCard.tsx`
- `src/pages/tasks/WorkflowTaskBoardSection.tsx`
- optional shared helper such as `src/pages/tasks/taskStatusBadges.ts`
- `tests/e2e/tasks.spec.ts`
- optional supporting unit test(s)

## Notes for the implementation lane

- Treat this as a **presentation-contract fix**, not a task-status-domain change.
- Do not introduce `queued` as a valid `tasks.status` value.
- Keep lifecycle status authoritative for filters, badges, and human understanding of the task’s real state.
- Use queue/runtime state only as a secondary indicator.
- Match task-list semantics to the task detail header so the product stays internally consistent.
