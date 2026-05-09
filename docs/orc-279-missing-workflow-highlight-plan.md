# ORC-279 missing-workflow highlight plan

## tl;dr
- Stop treating every workflow-less task as a normal draft in `src/pages/tasks/taskBoardModel.ts`; keep true drafts separate and introduce a dedicated **Needs workflow** board bucket for non-draft tasks with `workflowId == null`.
- Add an unmistakable warning treatment on the task board and in task detail whenever a task has no workflow configured, instead of letting it read like a normal empty lane/runtime state.
- Reuse existing task data (`workflowId`, `currentLaneId`, `readyForDispatch`, `status`) and existing warning tokens/styles; this should stay a frontend-only change.
- Make the missing-workflow state actionable from the same surfaces by pointing users to the workflow field in task detail edit mode.
- Cover the change with task-board model tests plus focused e2e coverage for the board section, card badge, and task-detail warning state.

## Executive summary
Right now the dev UI collapses two different states into one:

- a real **draft** task
- a non-draft task that is simply **missing a workflow**

That makes workflow-less tasks easy to miss, especially because the task board drops them into the Drafts section and task detail mostly falls back to neutral copy like **No lane** or **No active runtime assignment**. Those are technically true, but they do not clearly communicate that the task is misconfigured.

The recommended fix is to make missing workflow a first-class warning state in the UI. On the board, non-draft workflow-less tasks should move into a dedicated warning section instead of Drafts. In task detail, the header/detail/runtime surfaces should show explicit warning copy like **No workflow configured** and explain that the task cannot participate in workflow lanes until a workflow is assigned. This keeps the change tightly scoped to the frontend while making the state hard to confuse with a normal empty workflow view.

## Current-state findings
- `src/pages/tasks/taskBoardModel.ts` currently defines `isDraftTask(task)` as `task.status === "draft" || !task.workflowId`, so every workflow-less task is grouped with drafts.
- `src/pages/tasks/TasksOverviewPage.tsx` renders that combined bucket as the neutral `Drafts` section, which hides the distinction the ticket cares about.
- `src/pages/tasks/TaskCompactCard.tsx` does not surface any workflow-specific warning badge or styling.
- `src/pages/tasks/TaskDetailPage.tsx` resolves a workflow-less task’s lane label to `No lane`, and the runtime tab falls back to `No active runtime assignment for this task.` That reads like an empty runtime state, not a missing configuration problem.
- `src/pages/tasks/TaskEditorForm.tsx` already exposes the workflow selector and the `No workflow selected` option, so the remediation path exists; it just is not emphasized enough when the current task is already in this state.

## Recommended implementation

### 1. Separate drafts from missing-workflow tasks in the board model
Update `src/pages/tasks/taskBoardModel.ts` so the board model distinguishes:
- `draftTasks`: `status === "draft"`
- `missingWorkflowTasks`: `status !== "draft" && !workflowId`
- normal workflow sections: tasks with a workflow

This is the core semantic fix. A ready/in-progress/blocked task without a workflow is not a draft and should not be rendered as one.

### 2. Render a dedicated warning section on the tasks overview
Update `src/pages/tasks/TasksOverviewPage.tsx` to render a separate board section for `missingWorkflowTasks`, with warning-forward copy such as:
- eyebrow: `Workflow`
- heading: `Needs workflow`
- supporting copy: `These tasks are missing a workflow and will not appear in workflow lanes until one is assigned.`

Presentation guidance:
- use warning styling/tokens, not the neutral Drafts treatment
- keep true drafts in their existing section
- add a stable selector such as `data-role="task-missing-workflow-section"`

### 3. Add a visible missing-workflow badge/treatment on task cards
Extend `src/pages/tasks/TaskCompactCard.tsx` so workflow-less tasks can render a warning badge and/or warning border treatment, e.g.:
- badge text: `No workflow`
- warning accent on the card chrome

This makes the problem visible even when the card appears inside other filtered views.

### 4. Make task detail explicitly say “No workflow configured”
Update `src/pages/tasks/TaskDetailPage.tsx` so workflow-less tasks stop reading like a normal empty lane state.

Recommended detail changes:
- header metadata should resolve to `No workflow` instead of generic `No lane` when `!task.workflowId`
- add a warning card near the top of the overview/details content explaining that the task has no workflow configured and is not participating in workflow lanes
- the runtime tab should show a workflow-missing warning state instead of only `No active runtime assignment for this task.`
- the todos composer should explain that lane-scoped todos cannot be added until a workflow is assigned

This gives users an unmistakable signal on the main task-detail surfaces where they would otherwise assume the workflow view is just empty.

### 5. Make the remediation path obvious in edit mode
In `src/pages/tasks/TaskEditorForm.tsx`, add inline warning/helper copy when `draft.workflowId` is empty, especially in detail edit mode. Suggested copy:

> This task has no workflow configured. It will not appear in workflow lanes or be dispatchable until a workflow is assigned.

This keeps the fix close to the existing workflow selector instead of requiring users to infer the next step.

## Validation
- Update `tests/task-board-model.test.ts` to assert that non-draft workflow-less tasks are no longer treated as drafts.
- Add focused e2e coverage in `tests/e2e/tasks.spec.ts` for:
  1. a non-draft task with `workflowId: null` appearing in the dedicated warning section
  2. a task card showing the missing-workflow badge/treatment
  3. task detail showing explicit missing-workflow warning copy instead of a neutral empty workflow state
- Run targeted frontend checks (`npm test -- task-board-model`, relevant Playwright task-detail/task-board specs, and project build/test commands used for normal UI changes).

## Non-goals
- Do not add new backend task fields; existing `workflowId` state is sufficient.
- Do not block saving workflow-less tasks unless a separate product decision asks for validation changes.
- Do not redesign the broader task board or task detail layout beyond the missing-workflow warning treatment.