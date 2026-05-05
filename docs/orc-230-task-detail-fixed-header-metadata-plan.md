# ORC-230 task-detail fixed-header metadata plan

## tl;dr
- Add one shared header-metadata model in `src/pages/tasks/TaskDetailPage.tsx` that resolves the viewed task’s **assignee**, **current lane**, and **status**.
- Render that same metadata in both the main task-detail header and the compact floating header so the sticky header always matches the visible task.
- Reuse existing task status badge styling/helpers and existing assignee/lane lookup data instead of inventing a second presentation path.
- Remove the compact header’s current assignment-status badge (`active` / `queued`) from the primary metadata row; it is not the requested ticket status and is easy to confuse with it.
- Add targeted task-detail e2e coverage that proves the header metadata is accurate on first render and updates after relane/status-changing actions.

## Executive summary
`src/pages/tasks/TaskDetailPage.tsx` already owns both the primary task header and the compact floating header, which makes this a good scoped UI cleanup. Today the floating header shows the task number, title, lifecycle status, and sometimes the active assignment status, but it does **not** surface the task assignee or current lane. The primary header also lacks a clear, dedicated assignee/lane/status row and instead uses a generic counts-oriented meta list.

The lowest-risk fix is to derive one small header metadata view-model directly from the live `task`, `workflowLanes`, `agents`, and `roles` props, then render that model in both header variants. This keeps header values reactive with normal task-detail refreshes, keeps the two header surfaces visually aligned, and avoids introducing new fetches or stateful synchronization logic.

## Current-state findings
- `TaskDetailPage.tsx` renders both header variants:
  - primary header near `data-role="task-detail-primary-header"`
  - compact floating header near `data-role="task-detail-compact-header"`
- The primary header currently shows title, tags, and a generic `taskHeaderMeta` list (`task.number`, comments, todos, lane runs, dispatchability, etc.).
- The compact header currently shows:
  - task number + title
  - lifecycle status badge
  - assignment status badge (`active` / `queued` / etc.) when an active assignment exists
- Existing task data already provides what ORC-230 needs:
  - assignee label can be resolved with `resolveTaskAssigneeLabel(...)` in `src/pages/tasks/taskBoardModel.ts`
  - current lane name can be resolved from `workflowLanes`, which `TasksPage.tsx` already derives from the task workflow and passes into `TaskDetailPage`
  - status label/tone already follows existing task badge semantics in `src/pages/tasks/taskStatusBadges.tsx`
- Because these values already flow through the live `taskDetail` render path, the header should update automatically after save, relane, dispatch, retry, approve, or completion actions as long as the display is derived directly from props.

## Recommended implementation

### 1. Build a shared header metadata model in `TaskDetailPage.tsx`
Derive a small structure such as:
- `assigneeLabel`
- `laneLabel`
- `statusLabel`
- `statusTone`

Implementation notes:
- resolve assignee via `resolveTaskAssigneeLabel(task, agents, roles)`
- resolve lane name from `workflowLanes.find((lane) => lane.id === task.currentLaneId)` with fallback to `task.currentLaneId ?? "—"`
- use the same status label/tone logic already used elsewhere for task lifecycle badges

Prefer this as pure derived data, not component state.

### 2. Render the metadata in both task-detail header variants
Update both header surfaces so they expose the same three requested values:
- **Assignee**
- **Lane**
- **Status**

Recommended approach:
- primary header: add a dedicated metadata row above or alongside the existing counts-oriented `session-detail__meta`
- compact header: replace the current meta row contents so it shows assignee, lane, and lifecycle status instead of lifecycle status plus assignment-status badge

This keeps the floating header aligned with the primary header and avoids showing two different meanings of “status.”

### 3. Keep the presentation compact and readable
In `src/styles.css`:
- add task-detail-header-specific metadata layout classes rather than overloading the generic counts row
- use existing badge tokens for lifecycle status
- render assignee and lane as compact labeled pills or compact key/value items that can wrap cleanly on narrow widths
- preserve title truncation behavior in the floating header so long titles do not push metadata off-screen

Design guidance:
- the compact header should prioritize stability over density
- lifecycle status should remain the most visually emphasized item
- assignment runtime state (`active`, `queued`, etc.) should stay in runtime/task action surfaces unless explicitly needed later

### 4. Add stable selectors for regression coverage
Add specific `data-role` hooks for the new metadata values in both headers, for example:
- `task-detail-header-assignee`
- `task-detail-header-lane`
- `task-detail-header-status`
- `task-detail-compact-header-assignee`
- `task-detail-compact-header-lane`
- `task-detail-compact-header-status`

This will make the tests precise and avoid brittle text-only header assertions.

### 5. Extend task-detail e2e coverage
Update `tests/e2e/tasks.spec.ts` with focused assertions that:
1. open a task detail and verify the primary header shows assignee, lane, and status
2. scroll until the compact header is visible and verify it shows the same values
3. perform a relane action and verify the lane label updates in header UI
4. verify a status-changing transition updates the displayed status value

The existing task-detail header/relane coverage around the floating header is a good place to extend rather than creating a completely separate long scenario.

## Validation
- `npm run build`
- targeted Playwright around task detail headers, especially `tests/e2e/tasks.spec.ts`

## Non-goals
- Do not redesign the task-detail action layout.
- Do not add new task transport fields if existing task/workflow props already resolve the needed labels.
- Do not treat assignment runtime state as the requested ticket status in the header.