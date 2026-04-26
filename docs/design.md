# Orchestra Design Draft

## Overview

Orchestra is an agent orchestration framework focused on getting project work done. It coordinates projects, repositories, worktrees, agents, roles, policies, sessions, tasks, and workflows in a single desktop application.

### Initial stack

- Tauri
- TypeScript
- `pi-agent-core` / `pi`

## Product goals

- Make agent work visible and manageable at the project level
- Treat repositories and worktrees as first-class operational primitives
- Support both persistent named agents and transient role-based workers
- Drive work through explicit workflows instead of ad hoc prompting
- Keep humans in the loop at key review and decision points

## Core design principles

1. **Project-centered orchestration**  
   Everything executes in the context of a project, even when definitions are shared globally.
2. **Sessions are execution, not identity**  
   Sessions come and go; agents and roles define the working context.
3. **Global definitions, project-scoped execution**  
   Agents, roles, and workflows should be reusable across projects, but their runtime state belongs to the active project.
4. **Repositories must be safe for concurrent work**  
   Worktrees isolate agent and role activity.
5. **The UI should optimize for situational awareness**  
   Users should quickly see who is working on what, what is blocked, and where intervention is required.

## Domain model

### Projects

Projects are the top-level execution context.

A project owns:
- repositories
- sessions
- tasks
- project-local runtime state for agents and roles
- project settings and prompt overlays
- the default model/provider
- the default workflow for new tasks

Suggested project fields:
- `id`
- `slug`
- `name`
- `description`
- `repositoryIds[]`
- `defaultProvider`
- `defaultModel`
- `defaultWorkflowId`
- `createdAt`
- `updatedAt`

Suggested filesystem layout:

```text
~/.orchestra/projects/{project-slug}/
  project.json
  settings.json
  sessions/
  repositories/{repo-slug}/
    repository/              # primary git clone
    worktrees/
      agents/{agent-slug}/
      roles/{role-instance-slug}/
```

Notes:
- `defaultWorkflowId` references a global workflow definition.
- project settings can add project-specific behavior for shared agents/roles without changing the global definition.

### Repositories

Repositories should be modeled explicitly instead of only as a string list on the project.

Suggested repository fields:
- `id`
- `projectId`
- `slug`
- `name`
- `remoteUrl`
- `defaultBranch`
- `localPath`
- `createdAt`
- `updatedAt`

Rationale:
- repository metadata will likely grow
- multiple repos per project are a core concept
- repo-specific worktree state and health need a home

### Sessions

Sessions correspond to active `pi` sessions managed by Orchestra.

A session may optionally be associated with:
- an agent runtime binding
- a role instance
- a task
- a workflow lane

Suggested session fields:
- `id`
- `projectId`
- `agentId?`
- `roleInstanceId?`
- `taskId?`
- `workflowId?`
- `laneId?`
- `status` (`starting`, `active`, `idle`, `paused`, `completed`, `failed`)
- `subscribedClientCount`
- `createdAt`
- `updatedAt`

Key behavior:
- sessions are resumable
- frontend subscriptions to session output should be transient
- unsubscribed sessions may continue running without streaming output to the UI
- Orchestra-managed pi session files should be stored under `~/.orchestra/projects/{project-slug}/sessions/` via a custom `sessionDir`, not under pi's default global session directory

### Agents

Agents are named persistent workers with configured context, memory, and access grants.

Characteristics:
- persistent identity
- persistent memory
- reusable across projects
- project-scoped execution state
- project/repo worktrees
- many sessions over time, but one main session per project/repository binding
- a queue of deferred work when the main session is busy
- optional workforce role association
- policy attachments and direct permissions that define tool access

Suggested global filesystem layout:

```text
~/.orchestra/agents/{agent-slug}/
  agent.json
  AGENTS.md
  IDENTITY.md
  SOUL.md
  MEMORY.md
  TOOLS.md
  memory/
```

Suggested global agent fields:
- `id`
- `slug`
- `name`
- `description`
- `systemPrompt`
- `provider`
- `model`
- `thinkingLevel`
- `roleId?`
- `policyIds[]`
- `directPermissions[]`
- `system`
- `immutable`
- `queuePolicy`
- `archived`
- `createdAt`
- `updatedAt`

Suggested project-scoped agent runtime fields:
- `agentId`
- `projectId`
- `repositorySlug`
- `mainSessionId?`
- `status`
- `currentQueueEntryId?`
- `worktreePath?`
- `lastHeartbeatAt?`
- `lastError?`
- `createdAt`
- `updatedAt`

Project settings may also attach prompt additions or operating constraints for a global agent.

### Roles

Roles are workforce templates for transient workers.

Characteristics:
- globally defined
- not memory-bearing in the same way agents are
- spin up role instances on demand
- operate under a concurrency limit
- use disposable project-scoped worktrees rather than agent-owned persistent worktrees
- remain distinct from authorization policies
- can attach default policies and direct permissions for spawned instances

Examples:
- Developer
- QA
- Planner
- Reviewer

Suggested global role fields:
- `id`
- `slug`
- `name`
- `description`
- `systemPrompt`
- `provider`
- `model`
- `thinkingLevel`
- `capacity`
- `policyIds[]`
- `directPermissions[]`
- `createdAt`
- `updatedAt`

Suggested project-scoped role instance fields:
- `id`
- `roleId`
- `projectId`
- `displayName`
- `sessionId`
- `status`
- `currentTaskId?`
- `createdAt`
- `updatedAt`

### Policies

Policies are reusable authorization bundles that can be attached to agents and roles.

Characteristics:
- separate from workforce roles
- define permissions rather than runtime behavior
- may be system-defined and immutable
- can coexist with direct permissions on agents and roles

Suggested policy fields:
- `id`
- `slug`
- `name`
- `description`
- `permissions[]`
- `system`
- `immutable`
- `createdAt`
- `updatedAt`

Built-in system policy:
- `supervisor` with full access

Important boundary:
- there is no supervisor workforce role
- Orchestra instead ships with a protected system `supervisor` agent that is permanently attached to the `supervisor` policy

### Tasks

Tasks are workflow-driven work items, but they also need to model planning structure and execution constraints.

Suggested task fields:
- `id`
- `projectId`
- `number`  # project-local human-readable id such as `<PROJECT_PREFIX>-42`
- `title`
- `description`
- `type` (`task`, `bug`, `feature`, `chore`, `epic`)
- `status` (`draft`, `ready`, `in_progress`, `blocked`, `in_review`, `completed`, `canceled`)
- `priority` (`P0`-`P4`)
- `workflowId?`
- `currentLaneId?`
- `assigneeType` (`user`, `agent`, `role`, `unassigned`)
- `assigneeId?`
- `repositoryId?`
- `parentTaskId?`
- `comments[]`
- `laneRuns[]`
- `createdAt`
- `updatedAt`

Important behavior:
- comments on an assigned task should be delivered to the currently responsible entity
- the comment UI should offer an `Interrupt agent` checkbox so the user can choose whether a new comment should interrupt the currently active session immediately
- each lane run should record which session worked that lane
- when a task re-enters a lane, Orchestra should always resume the previously recorded session for that lane
- hierarchy and dependency must remain separate concepts: parent tasks/epics group work, while dependency edges block work
- epics should act as planning containers and progress rollups in the first pass, while child tasks own workflow execution
- dependency-blocked tasks should remain visible but must not be dispatchable until their blockers complete
- tasks should support project-scoped attachments that can be surfaced to both humans and agents

Suggested lane run model:
- `id`
- `taskId`
- `laneId`
- `sessionId`
- `startedAt`
- `completedAt?`
- `result` (`success`, `failure`, `needs_user`, `canceled`)
- `notes?`

Suggested task dependency model:
- `id`
- `projectId`
- `blockerTaskId`
- `blockedTaskId`
- `kind` (`blocks`)
- `createdAt`

Suggested task attachment model:
- `id`
- `projectId`
- `taskId`
- `commentId?`
- `fileName`
- `originalPath?`
- `storedPath`
- `mediaType`
- `byteSize`
- `sha256?`
- `caption?`
- `createdAt`

### Workflows

Workflows are reusable global definitions.

A workflow contains ordered lanes. Each lane defines:
- who works the lane
- what happens on success
- what happens on failure
- whether the user must intervene

Suggested workflow fields:
- `id`
- `slug`
- `name`
- `description`
- `lanes[]`
- `createdAt`
- `updatedAt`

Suggested lane fields:
- `id`
- `name`
- `assignedEntityType` (`user`, `agent`, `role`)
- `assignedEntityId`  # should evolve toward stable global worker refs/slugs, not fragile row ids
- `entryPromptTemplate?`
- `successTargetLaneId?`
- `failureTargetLaneId?`
- `userInterventionMode?`

Default workflow example:

```text
Development
  1. Plan
  2. User Review
  3. Implement
  4. Validate
  5. User Review
```

## Queueing and execution semantics

This is one of the most important parts of the system.

### Agent queues

When an agent has an active project-scoped main session:
- new task assignments should enqueue work
- new comments should enqueue notifications or messages
- the comment composer should include an explicit `Interrupt agent` checkbox
- when `Interrupt agent` is checked, the active session should receive the comment immediately as an interrupting message
- when `Interrupt agent` is unchecked, the message should remain queued until the session is ready to process it

### Role queues

For roles:
- tasks queue against the role definition
- if active instances are below capacity, a new role instance may be created
- if capacity is exhausted, the task waits in the role queue
- queue processing is FIFO by default
- the UI should eventually allow manual reordering via drag-and-drop without changing the default dispatch policy

### Periodic dispatch

Orchestra should run a periodic dispatcher tick while the app is open.

It should:
- scan queued agent work
- scan queued role work
- detect workers that have become dispatchable
- deliver eligible work without requiring manual refresh
- log all dispatch decisions

## Tooling model

Sessions can use predefined `pi` tools plus Orchestra-specific tools.

Tool access should be granted by permissions resolved from attached policies and direct permissions on the acting agent or role.

Recommended rules:
- workforce roles describe how transient workers behave; they do not replace policy-based authorization
- the built-in `supervisor` system agent gets the immutable `supervisor` policy and therefore the full Orchestra tool surface
- regular agents and role instances should receive only the tool calls their effective permissions allow
- backend authorization checks must remain authoritative even if the visible tool manifest lags behind a permission change

Initial Orchestra tool surface:
- `create_task`
- `comment_on_task`
- `complete_lane_as_success`
- `complete_lane_as_failure`

Recommended refinement:
- name tools around task/lane semantics, not UI semantics
- map tools to explicit `resource.action` permissions such as `tasks.create` or `roles.dispatch`
- consider `transition_task_lane` as a lower-level primitive
- keep success/failure helpers as convenience wrappers

Suggested tool set:
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
- `dispatch_role_queue`
- `create_session`
- `send_session_message`

Task-specific expectations:
- `get_task_context` should return workflow state, lineage, dependency summaries, recent comments, and an attachment manifest with absolute stored paths for agent-readable files
- `add_task_attachment` should import a local file into Orchestra-managed project storage rather than reference arbitrary mutable paths in place
- task tools should be permission-gated with explicit grants such as `tasks.create`, `tasks.comment`, `tasks.attachments.write`, and `tasks.transition`

## Backend design

The backend should manage sessions and expose an application API to the frontend.

### Initial commands

Session management:
- create session
- resume session
- list sessions
- subscribe to session events
- unsubscribe from session events

Entity management:
- create/update/delete project
- create/update/delete task
- create subtask / set task parent
- add/remove task dependency
- add/remove task attachment
- get task context
- create/update/delete agent
- list agents
- list agent queues
- list roles
- list role queues
- create/update/delete workflow
- list policies
- resolve effective permissions for an actor

### Suggested backend refinement

Split the backend into clear service areas:
- `ProjectService`
- `RepositoryService`
- `WorkflowService`
- `TaskService`
- `TaskGraphService`
- `TaskAttachmentService`
- `AgentService`
- `RoleService`
- `PolicyService`
- `AuthorizationService`
- `SessionService`
- `DispatchService`

This should reduce coupling versus putting workflow advancement logic directly inside session management, keeps permission resolution separate from workforce/runtime behavior, and prevents task hierarchy/dependency/attachment logic from collapsing into one monolithic task module.

## Event model

For the initial implementation, prefer straightforward application logging over a durable event system.

Initial approach:
- log important backend actions and session lifecycle events
- expose the log in the Settings area of the UI
- use logs for debugging and validating orchestration behavior during early development

Examples of things worth logging:
- `task.created`
- `task.updated`
- `task.commented`
- `task.comment.interrupt_requested`
- `task.dependency.added`
- `task.dependency.removed`
- `task.blocked`
- `task.unblocked`
- `task.attachment.added`
- `task.attachment.removed`
- `task.lane.entered`
- `task.lane.completed`
- `session.created`
- `session.resumed`
- `session.message.sent`
- `session.message.received`
- `agent.queue.updated`
- `role.queue.updated`
- `dispatcher.tick.started`
- `dispatcher.tick.completed`
- `role.worktree.created`
- `role.worktree.disposed`

Later, if needed, this logging layer can evolve into a more structured event store or timeline model.

## Frontend design

The frontend should support:
- viewing and managing projects
- viewing and managing agents
- viewing and managing roles
- viewing and interacting with sessions
- viewing and managing tasks
- viewing and managing workflows

### Proposed information architecture

Primary nav:
- project switcher at top
- Tasks
- Agents
- Sessions
- Settings at bottom

Refinement:
- roles can likely live under Agents as a paired workforce view instead of a top-level nav item
- workflows belong in Settings unless they become heavily used day-to-day
- global definitions (agents, roles, workflows) may still be edited from Settings while project-scoped runtime state is inspected from project views

### Page concepts

#### Tasks
- kanban or lane-centric workflow view
- explicit scan filters such as ready, blocked, in review, and epics
- task detail panel with comments, lane history, current assignee, lineage, dependencies, and attachments
- clear controls for advancing, retrying, requesting user intervention, creating subtasks, and attaching files
- blocked-by state should be visible in both the scan surface and the task detail pane

#### Agents
- secondary nav lists agents and roles
- roles should be visually distinct from agents
- detail pane shows:
  - idle/busy status in the current project
  - current task
  - queue
  - active sessions
  - project-specific runtime info
  - attached policies / direct permissions
  - ability to subscribe/chat with an active session

#### Sessions
- session list in secondary nav
- selected session shows transcript/event stream
- active subscription state displayed clearly
- ability to send messages back into the session
- this should be one of the first fully working vertical slices of the app

#### Settings
- workflow management
- agent and role definition management
- policy management
- application log viewer for backend/session logs during early development
- later, reusable policy management if direct grants prove insufficient

## Visual design direction

- crisp, clean light interface
- avoid blue as the primary accent
- avoid deeply nested cards and grouped boxes
- left navigation with slim entries
- navigation remains fixed while content scrolls

Additional suggestions:
- prefer subtle separators and whitespace over card-heavy layouts
- use one accent color plus semantic status colors
- make queue depth, busy state, and required user action visually obvious
- optimize for dense operational views rather than marketing-style spaciousness

## Open questions and suggestions

### 1. Persistence boundaries

Question:
- what must survive app restarts?

Suggestion:
- persist projects, repos, agents, roles, workflows, tasks, comments, lane runs, queue state, and project-scoped runtime state
- treat frontend subscriptions as ephemeral

### 2. Agent vs role overlap

Question:
- when should a user create an agent instead of a role?

Suggestion:
- agents are for named long-lived collaborators with memory
- roles are for elastic labor pools with shared configuration and no long-term memory

### 3. Role vs policy boundary

Decision:
- keep workforce roles and authorization policies separate
- allow agents and roles to both attach policies and direct permissions
- ship a built-in immutable `supervisor` policy plus a protected system `supervisor` agent
- do not create a supervisor workforce role

### 4. Worktree ownership

Decision:
- store canonical repo clones under projects
- let agents have durable project worktrees for continuity
- let role instances use disposable project-scoped worktrees

### 5. Session resumption policy

Decision:
- when a task returns to a previously used lane, always resume the previously recorded session for that lane

### 6. Notifications and intervention

Decision:
- elevate user-required decisions into a dedicated inbox/to-review surface instead of only inline task state
- allow comments to explicitly request interruption of the assigned agent via a checkbox in the comment UI

### 7. Workflow flexibility

Question:
- should workflows allow branching beyond success/failure?

Suggestion:
- start with success/failure plus explicit user intervention
- add richer branching only after real usage proves it necessary

### 8. Tool/API boundary

Question:
- should sessions mutate workflow state directly?

Suggestion:
- use narrow backend commands/tools that validate transitions centrally
- avoid letting session prompts encode core state machine logic on their own

## Recommended near-term milestones

### Milestone 1: App scaffolding
- scaffold the Tauri + TypeScript application structure
- establish frontend routing, layout shell, and shared UI primitives
- establish the backend command structure and service boundaries
- add a Settings page with a visible application log panel

### Milestone 2: Session-first vertical slice
- implement create/resume/list sessions through backend commands
- implement session event subscription and unsubscription
- implement a Sessions UI that can create a session, resume a session, view output, and send messages back into the session
- prioritize this milestone so session creation and interaction can be tested as early as possible

### Milestone 3: Core project/task data
- define persisted models for projects, repositories, tasks, task dependencies, task attachments, workflows, agents, roles, policies, and lane runs
- implement project/repository/task/workflow CRUD
- implement task hierarchy, dependency validation, and attachment import/storage
- implement policy persistence, permission resolution, and direct permission attachment on agents and roles
- implement lane transitions and lane run history
- wire task comments, including interrupt-vs-queue behavior
- expose a task tool/API surface centered on `get_task_context`

### Milestone 4: Agent and role dispatch
- add persistent agents with queues
- add role definitions and capped role instance spawning
- implement FIFO role queues with future manual reorder support
- implement the periodic dispatcher
- implement disposable role worktree lifecycle
- attach tasks and lanes to resumed sessions

### Milestone 5: Operational UX
- build task workflow UI with blocked, ready, and review-focused scan surfaces
- build task detail flows for lineage, dependencies, comments, and attachments
- build agent/role workload views
- build intervention inbox and queue health indicators

## Summary

Orchestra has a strong conceptual foundation: projects own execution context, workflows define progression, sessions execute work, agents provide continuity, and roles provide scalable transient labor.

The biggest design opportunities are:
- modeling repositories explicitly
- clarifying queue/dispatch behavior
- defining resumption rules for sessions and lanes
- separating global definitions from project-scoped runtime state
- keeping workflow state transitions centralized and auditable
- focusing the UI on operational visibility rather than generic dashboards

---

# Task Comment Deletion (ORC-171)

## Summary

Adds support for deleting task comments with cascade deletion of reply threads, attachments, and file references.

## Design Decisions

### 1. Permission Model

A **new dedicated permission** `tasks.comment.delete` was added to the permissions model (not `tasks.delete`). This is a `risk: "sensitive"` permission, consistent with other destructive operations.

- `tasks.comment` — grants ability to add comments (read-write for creating)
- `tasks.comment.delete` — grants ability to delete comments and cascade-delete their descendants

Rationale: Separating delete from create gives fine-grained control. Not everyone who can add comments should be able to delete them.

### 2. Cascade Deletion Model

Deleting a task comment **always succeeds** by cascading — there are no blockers. The comment and all its descendant replies, plus any attachments and file references tied to those comments, are deleted atomically in a single database transaction.

Cascade scope:
- The target comment itself
- All descendant reply threads (recursive, via `parent_comment_id`)
- Attachments associated with the target and descendant comments
- File references associated with the target and descendant comments

### 3. Impact Inspection

Before deletion, the UI fetches `get_task_comment_delete_impact` which returns:
- `commentId` — the target comment ID
- `taskId` — the task the comment belongs to
- `replyCount` — number of descendant replies
- `attachmentCount` — number of attachments on affected comments
- `fileReferenceCount` — number of file references on affected comments
- `cascadeDeletedCount` — total records that will be destroyed (1 + replyCount)

### 4. UI Confirmation Flow

1. User clicks "Delete" on a comment
2. System fetches delete impact (loads reply/attachment/reference counts)
3. Confirmation modal shows:
   - "Delete this comment?" heading
   - Impact details: reply count, attachment count, file reference count, total
   - Warning: "This will permanently delete the comment and all related data."
4. User clicks "Delete comment" (always enabled — no blockers)
5. System performs cascade delete
6. UI refreshes to reflect deletion

### 5. Transport Layer Coverage

| Layer | Command/API | Authorization |
|-------|------------|---------------|
| Tauri command | `get_task_comment_delete_impact` | `tasks.comment` |
| Tauri command | `delete_task_comment` | `tasks.comment.delete` |
| Remote API GET | `/api/v1/task-comments/:id/delete-impact` | Remote auth |
| Remote API DELETE | `/api/v1/task-comments/:id` | Remote auth |
| Tool bridge | `get_task_comment_delete_impact` | `tasks.comment` |
| Tool bridge | `delete_task_comment` | `tasks.comment.delete` |
| Client bindings | `getCommentDeleteImpact(commentId)` | — |
| Client bindings | `deleteComment(commentId)` | — |
| Mock bindings | `getCommentDeleteImpact` | — |

### 6. Database Implementation

The `delete_task_comment` service function:
1. Loads the target comment to get its task_id
2. Recursively collects all descendant comment IDs (target + replies)
3. Begins a database transaction
4. Deletes all comments in the cascade via `WHERE id IN (...)`
5. Deletes all attachments tied to those comment IDs
6. Deletes all file references tied to those comment IDs
7. Commits the transaction

The `get_task_comment_delete_impact` service function:
1. Validates the comment exists
2. Recursively counts all descendant replies
3. Counts attachments and file references on affected comments
4. Returns the impact report without performing any deletions

### 7. Test Coverage

- Playwright test: comment deletion impact modal with reply count display
- Playwright test: cancel confirmation preserves the comment
- Backend: cascade deletion removes all descendant comments atomically
- Backend: impact inspection returns accurate counts
