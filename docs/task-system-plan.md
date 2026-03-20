# Orchestra task system plan

This plan expands Orchestra's task model from a simple workflow work item into a project execution graph that can support real delivery work.

It focuses on four additions that are missing from the current design draft:

- hierarchical tasks and epics
- task dependencies
- task attachments that agents can actually read
- the Orchestra tool/API surface required for tasks to be actionable in live sessions

## Goals

- Keep tasks as the central unit of project planning and workflow progression.
- Preserve the existing session-first and workflow-driven architecture.
- Make blocked work obvious instead of implicit.
- Let users attach source material, screenshots, logs, and notes directly to tasks.
- Give agents and role instances a narrow, explicit task tool surface instead of relying on prompt-only conventions.
- Keep the first version simple enough to ship, test, and extend.

## Non-goals for the first task slice

Do not block the first delivery on:

- generic graph relationships beyond parent/child plus hard dependencies
- OCR, PDF parsing, or office document import
- drag-and-drop dependency editing
- cross-project task dependencies
- full event sourcing
- rich portfolio/reporting views

## Design principles

### Hierarchy is not dependency

A parent task or epic groups work. A dependency blocks work. These should be represented separately in the data model and UI.

### Child tasks own execution

In the first implementation, epics are planning containers and progress rollups, not the primary execution unit. Child tasks move through workflows and own the lane/session history.

### Blocked work must remain visible

A blocked task should still be visible in the workflow/task views, but Orchestra should make it clear why it cannot be dispatched.

### Attachments should be real files

Attachments should be stored as project-scoped files on disk and referenced in the database. This makes them readable by users, agents, tests, and backup tooling.

### Task tools should be narrow and auditable

Agents should operate on tasks through explicit backend-validated commands such as `create_task`, `comment_on_task`, and `get_task_context`, not through hidden prompt conventions.

## Expanded task model

### Task

Suggested first-pass task fields:

- `id`
- `projectId`
- `number` — project-local human-readable sequence such as `ORC-42`
- `title`
- `description`
- `type` (`task`, `bug`, `feature`, `chore`, `epic`)
- `status` (`draft`, `ready`, `in_progress`, `blocked`, `in_review`, `completed`, `canceled`)
- `priority` (`P0`-`P4`)
- `workflowId?`
- `currentLaneId?`
- `assigneeType` (`user`, `agent`, `role`, `unassigned`)
- `assigneeId?`
- `repositoryId?` — primary repository context for the task
- `parentTaskId?`
- `archived`
- `createdAt`
- `updatedAt`

Notes:

- `workflowId` and `currentLaneId` may be null for draft/planning tasks before execution starts.
- `repositoryId` should support a primary repo first; future versions can add multi-repo references without changing the hierarchy model.
- `status` should remain explicit and not be inferred solely from lane position.

### Lane runs

Keep lane runs, but continue treating them as the continuity record for executable work:

- `id`
- `taskId`
- `laneId`
- `sessionId`
- `startedAt`
- `completedAt?`
- `result` (`success`, `failure`, `needs_user`, `canceled`)
- `notes?`

Resumption rule remains unchanged:

- when a task re-enters a lane, Orchestra should resume that lane's previously recorded session if one exists

## Hierarchical tasks and epics

### Model

Use a simple parent/child structure:

- `tasks.parentTaskId` points to the parent task
- any task may have children
- `type = epic` is the primary container concept for grouped work

### First-pass semantics

- Epics can have their own title, description, comments, and attachments.
- Child tasks own workflow execution.
- Epic progress should be derived from child state, not manually duplicated.
- Epic detail should show:
  - child counts by status
  - current in-flight children
  - blocked children
  - completion progress
- Parent/child relationships should support more than one level of nesting, but the UI should default to shallow display and breadcrumb navigation rather than deep tree sprawl.

### Why this shape

This keeps task execution legible:

- epics organize work
- tasks move through workflows
- session continuity remains attached to executable tasks

It avoids confusing states such as an epic appearing to be in a validation lane while its children are still in planning.

## Dependencies

### Model

Dependencies should be represented separately from hierarchy.

Suggested model:

- `id`
- `projectId`
- `blockerTaskId`
- `blockedTaskId`
- `kind` (`blocks`)
- `createdAt`

### Rules

First-pass validation rules:

- dependencies must stay within a single project
- a task cannot depend on itself
- duplicate dependency edges should be rejected
- dependency cycles should be rejected
- the only required relation kind in v1 is a hard blocker (`blocks`)

### Runtime semantics

If task B is blocked by task A:

- B remains visible in task views
- B can still collect comments and attachments
- B is not dispatchable to an agent or role until A is resolved
- B should show an explicit blocked reason such as `Blocked by ORC-12 Set up auth schema`

### Derived readiness

Task readiness for dispatch should consider:

- task status
- current workflow/lane
- whether all blockers are complete
- whether the current lane requires user intervention
- whether the current assignee is dispatchable

This computation should live in backend services, not only in the frontend.

## Attachments

### Goal

Tasks need to carry supporting material such as:

- screenshots
- images and diagrams
- logs
- markdown notes
- JSON payloads
- copied specs or text files

These must be readable by both humans and agents.

### Model

Suggested attachment model:

- `id`
- `projectId`
- `taskId`
- `commentId?` — optional later if attachments become comment-scoped
- `fileName`
- `originalPath?`
- `storedPath`
- `mediaType`
- `byteSize`
- `sha256?`
- `caption?`
- `createdAt`

### Storage layout

Store task attachments under the active project:

```text
~/.orchestra/projects/{project-slug}/attachments/{task-id}/{attachment-id}-{fileName}
```

This keeps ownership explicit and aligns with Orchestra's project-scoped execution model.

### First-pass supported file types

Directly supported in v1:

- text/markdown/json/log files
- images (`png`, `jpg`, `jpeg`, `webp`, `gif`)

Not required in v1:

- OCR
- PDF extraction
- office document parsing
- generated previews/thumbnails

### Agent readability

Attachments should remain real local files, and Orchestra should expose their absolute stored paths in task context so agents can inspect them using ordinary file-reading/image-reading capabilities.

## Task comments and attachment interplay

Comments remain task-local and should continue to support interrupt-vs-queue behavior.

Recommended behavior:

- comments belong to a specific task
- attachments belong to a specific task in v1
- later, comments may reference which attachments were added in the same action
- comment delivery rules still apply when tasks are assigned to agents or roles

## Orchestra task tools and API surface

Yes: Orchestra will need explicit tool support for tasks and related runtime actions.

### Principles

- tools should be named around project/task semantics rather than raw UI actions
- tools should map to permissions such as `tasks.create`, `tasks.comment`, `tasks.attachments.read`, and `tasks.transition`
- backend validation must remain authoritative
- tools should expose enough context for an agent to act without scraping multiple surfaces

### Recommended initial task tool surface

- `create_task`
- `update_task`
- `list_project_tasks`
- `get_task_context`
- `comment_on_task`
- `create_subtask`
- `add_task_dependency`
- `remove_task_dependency`
- `add_task_attachment`
- `list_task_attachments`
- `complete_lane_as_success`
- `complete_lane_as_failure`
- `request_user_intervention`

### Tool details

#### `get_task_context`

This should be the main read surface for agents.

It should return:

- task metadata
- workflow/lane information
- current assignee
- parent lineage and child summaries
- blocker and blocked-by summaries
- recent comments
- lane run history summary
- attachment manifest including absolute path, media type, caption, and readability hints

#### `add_task_attachment`

This should import an existing local file into Orchestra-managed project storage and record its metadata.

Suggested input:

- `taskId`
- `sourcePath`
- `caption?`

#### Transition tools

Keep workflow transitions narrow and validated:

- `complete_lane_as_success`
- `complete_lane_as_failure`
- `request_user_intervention`

These should call backend workflow logic rather than letting sessions mutate workflow state directly.

## Backend/service design

Recommended service split:

- `TaskService`
  - CRUD
  - list/detail queries
  - workflow linkage
- `TaskGraphService`
  - parent/child traversal
  - dependency validation
  - cycle detection
  - readiness/blocking computation
- `TaskAttachmentService`
  - import/store/remove attachments
  - metadata validation
  - attachment manifest generation
- `TaskCommentService`
  - comment persistence
  - interrupt-vs-queue delivery hooks
- `DispatchService`
  - enforce dispatchability checks before assigning work

### Suggested database tables

- `tasks`
- `task_comments`
- `task_dependencies`
- `task_attachments`
- `lane_runs`

## Frontend plan

The Tasks area should become the command center for workflow progress.

### Task navigation / scan views

Support filters such as:

- All
- Ready
- In progress
- Needs review
- Blocked
- Epics

### Main task view

Whether board- or list-based, task scan surfaces should show:

- task number and title
- current lane
- assignee
- blocked state
- child counts
- dependency counts
- attachment counts
- recent activity markers

### Task detail pane

A selected task should show:

- core metadata
- parent breadcrumb / lineage
- child task list
- dependency section (`blocked by`, `blocking`)
- attachments section
- comments
- lane history
- active session/runtime context
- actions for comment, subtask creation, dependency edits, and file attachment

## Delivery order

### Phase 1: Task persistence foundation

- persist tasks, comments, and lane runs
- add task CRUD
- add list/detail queries
- build initial task page shell

### Phase 2: Hierarchy and epics

- add `parentTaskId`
- create subtask flows
- build epic progress rollups
- expose parent/child detail views

### Phase 3: Dependencies

- add dependency persistence
- add cycle validation
- compute blocked/ready state
- prevent dispatch of blocked tasks
- expose blocker data in UI and task context

### Phase 4: Attachments

- add attachment import/storage
- expose attachment manifests in task detail
- expose agent-readable attachment paths in task context
- support image and text attachment rendering in the UI

### Phase 5: Task tools and runtime integration

- expose task tools to agents/roles via permission-gated Orchestra tools
- connect task context to workflow execution
- ensure lane/session continuity survives retries and loop-backs
- add logging around task graph and attachment operations

## Testing strategy

### Backend/unit tests

- task CRUD
- parent/child traversal
- dependency cycle rejection
- dependency blocking computation
- attachment import/storage validation
- task context manifest generation

### Frontend/component tests

- blocked task visibility
- epic child rollup rendering
- attachment lists and image/file affordances
- task detail dependency and lineage sections

### Playwright coverage

Required end-to-end flows should include:

1. create an epic with child tasks
2. add a dependency that blocks a task and verify blocked state is visible
3. resolve the blocker and verify the blocked task becomes dispatchable
4. attach an image/text file to a task and verify it appears in detail
5. inspect task context and confirm attachment metadata is available to the runtime surface

## Summary

The task system should evolve from a flat workflow item list into a workflow-aware task graph with:

- explicit hierarchy
- explicit dependencies
- project-scoped attachments
- agent-readable task context
- permission-gated Orchestra tools for operating on tasks safely

This keeps Orchestra aligned with the core product promise: a human should be able to see what work is in motion, why something is blocked, what context the worker has, and where to intervene next.
