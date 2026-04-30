# ORC-187 dependency tree view plan

## tl;dr

- Keep the existing dependency list as the default `TaskDetailPage` presentation.
- Add an opt-in list/tree toggle in the Dependencies tab and only load tree data when tree mode is active.
- Build the tree from the existing `tasks.get(...)` detail payloads by recursively loading dependency and hierarchy neighbors in `TasksPage` and shaping them with a small pure helper.
- Render a root-centered, branch-labeled tree that shows blockers, subtasks, and downstream blocked tasks with clear status badges and click-through navigation.
- Cover it with a pure tree-builder test plus the existing task-detail e2e dependency flow extended to verify default list mode, toggle behavior, and representative nested relationships.

## Executive summary

The current dependency UI in `src/pages/tasks/TaskDetailPage.tsx` is a two-column direct-edge list. It shows only the selected task’s immediate `blockedBy` and `blocking` arrays, so nested blocker chains and subtask context are easy to miss even though the detail model already exposes enough to derive them. The lowest-risk implementation is a frontend-only tree mode: keep the list as-is, add a toggle in the Dependencies tab, and lazily assemble a small task graph from existing `orchestraClient.tasks.get(...)` detail calls only when tree mode is requested. That avoids Rust/API contract churn while giving the build lane a clear place to add the tree model, renderer, styling, and regression coverage.

## Current findings

- Dependency UI lives in `src/pages/tasks/TaskDetailPage.tsx` and is currently a static two-column list under `data-role="task-detail-tabpanel-dependencies"`.
- Detail state and dependency mutations live in `src/pages/TasksPage.tsx`; it already owns the selected task detail plus dependency add/remove flows.
- `TaskDetail` already includes the direct edges and hierarchy needed to walk the graph:
  - `blockedBy[]` / `blocking[]`
  - `parent`, `lineage[]`
  - `children[]`
  - summary counts on `TaskSummary` to decide which neighbors may need expansion
- No dedicated dependency-tree endpoint exists today. Using the current `tasks.get(...)` contract keeps mock/tauri/remote behavior aligned and avoids touching the backend unless performance proves unacceptable.
- Existing regression coverage already includes a dependency management flow in `tests/e2e/tasks.spec.ts`; that is the best anchor for the new UI toggle/tree assertions.

## Implementation shape

### 1. Keep list mode as the default

- Add a local `dependencyViewMode: "list" | "tree"` state in `TaskDetailPage`.
- Default to `"list"` and reset to `"list"` when `task.id` changes so the current experience remains the default presentation.
- Reuse the existing `task-view-toggle` styling pattern for a compact list/tree switch in the Dependencies header.

### 2. Load tree data only when tree mode is active

- Keep async graph loading in `src/pages/TasksPage.tsx`, not the presentational detail component.
- Add a small dependency-tree loader that starts from the current `taskDetail` and recursively fetches neighbor details through `orchestraClient.tasks.get(...)`.
- Expand these relations for each loaded task:
  - upstream blockers via `blockedBy`
  - downstream blocked tasks via `blocking`
  - hierarchy context via `children` and direct `parent`/`lineage`
- Guard against duplicate visits and stale route changes with a visited set plus request-token/cancel protection.
- No backend/API changes in the first pass.

### 3. Shape the data with a pure helper

- Add a helper module such as `src/pages/tasks/taskDependencyTree.ts`.
- Build a render-friendly tree model with explicit branch types, e.g. `blocked_by`, `subtasks`, `blocking`, and `reference`.
- Sort siblings deterministically by task number/title so the view is stable and testable.
- When the same task is encountered through multiple paths, render a short reference leaf instead of recursing forever.

### 4. Render a scan-friendly hierarchy

- Add a dedicated tree container in the Dependencies tab, e.g. `data-role="task-dependency-tree"`.
- Show the selected task as the highlighted root node.
- Under each node, render labeled nested branches in this order:
  1. `Blocked by`
  2. `Subtasks` when relevant
  3. `Blocking`
- Each node should use the same task-card language users already know: task number, title, status badge, priority/type metadata, and click-through navigation via `onOpenTask`.
- Keep add/remove dependency controls available in the tab; list mode remains the editing-oriented default, tree mode becomes the scanning-oriented alternative.
- On narrow layouts, keep the tree vertical and stacked instead of forcing a dense left-right diagram.

### 5. Styling/layout

- Extend `src/styles.css` with tree-specific branch/node styles instead of overloading the current two-column list classes.
- Reuse existing surface tokens (`task-history-card`, status badges, `task-view-toggle`) so the tree looks native to the task-detail pane.
- Add responsive rules alongside the current task-detail breakpoints so tree branches collapse cleanly in one column.

### 6. Regression coverage

- Extend `tests/e2e/tasks.spec.ts` to:
  - verify the Dependencies tab still opens in list mode
  - verify the new toggle switches into tree mode
  - seed a representative graph with a blocker chain plus parent/child context and assert the tree shows the selected task, nested blocker relationship, and subtask context
  - verify switching back to list still shows the original list UI
- Add a focused unit test for the pure tree builder/helper to cover:
  - nested blocker chains
  - child-task branches
  - duplicate/reference handling
  - stable sibling ordering

## Proposed file plan

- `src/pages/TasksPage.tsx` — tree data loading/caching for the selected task
- `src/pages/tasks/TaskDetailPage.tsx` — toggle UI plus tree rendering
- `src/pages/tasks/taskDependencyTree.ts` — pure tree builder/types
- `src/styles.css` — tree/toggle styles
- `tests/e2e/tasks.spec.ts` — dependency toggle/tree regression
- `tests/task-dependency-tree.test.ts` — pure helper coverage

## Notes / build-lane guardrails

- Prefer the frontend-only tree first; only add a backend tree endpoint if the opt-in recursive fetch proves too slow in practice.
- Do not replace or heavily restyle the existing list view; acceptance requires it to remain the default.
- Keep tree mode read-optimized. Editing actions can stay concentrated in list mode if that keeps the first implementation smaller and clearer.
