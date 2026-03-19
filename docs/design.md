# Orchestra Design Draft

## Overview

Orchestra is an agent orchestration framework focused on getting project work done. It coordinates projects, repositories, worktrees, agents, roles, sessions, tasks, and workflows in a single desktop application.

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

Agents are named persistent workers with configured context and memory.

Characteristics:
- persistent identity
- persistent memory
- reusable across projects
- project-scoped execution state
- project/repo worktrees
- many sessions over time, but one main session per project/repository binding
- a queue of deferred work when the main session is busy

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

Roles are reusable templates for transient workers.

Characteristics:
- globally defined
- not memory-bearing in the same way agents are
- spin up role instances on demand
- operate under a concurrency limit
- use disposable project-scoped worktrees rather than agent-owned persistent worktrees

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

### Tasks

Tasks are workflow-driven work items.

Suggested task fields:
- `id`
- `projectId`
- `title`
- `description`
- `workflowId`
- `status`
- `currentLaneId`
- `assigneeType` (`user`, `agent`, `role`, `unassigned`)
- `assigneeId?`
- `comments[]`
- `laneRuns[]`
- `createdAt`
- `updatedAt`

Important behavior:
- comments on an assigned task should be delivered to the currently responsible entity
- the comment UI should offer an `Interrupt agent` checkbox so the user can choose whether a new comment should interrupt the currently active session immediately
- each lane run should record which session worked that lane
- when a task re-enters a lane, Orchestra should always resume the previously recorded session for that lane

Suggested lane run model:
- `laneId`
- `sessionId`
- `startedAt`
- `completedAt?`
- `result` (`success`, `failure`, `needs_user`, `canceled`)
- `notes?`

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

Initial Orchestra tool surface:
- `create_task`
- `comment_on_task`
- `complete_lane_as_success`
- `complete_lane_as_failure`

Recommended refinement:
- name tools around task/lane semantics, not UI semantics
- consider `transition_task_lane` as a lower-level primitive
- keep success/failure helpers as convenience wrappers

Suggested tool set:
- `create_task`
- `update_task`
- `comment_on_task`
- `list_project_tasks`
- `get_task_context`
- `complete_lane_as_success`
- `complete_lane_as_failure`
- `request_user_intervention`

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
- create/update/delete agent
- list agents
- list agent queues
- list roles
- list role queues
- create/update/delete workflow

### Suggested backend refinement

Split the backend into clear service areas:
- `ProjectService`
- `RepositoryService`
- `WorkflowService`
- `TaskService`
- `AgentService`
- `RoleService`
- `SessionService`
- `DispatchService`

This should reduce coupling versus putting workflow advancement logic directly inside session management.

## Event model

For the initial implementation, prefer straightforward application logging over a durable event system.

Initial approach:
- log important backend actions and session lifecycle events
- expose the log in the Settings area of the UI
- use logs for debugging and validating orchestration behavior during early development

Examples of things worth logging:
- `task.created`
- `task.commented`
- `task.comment.interrupt_requested`
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
- task detail panel with comments, lane history, and current assignee
- clear controls for advancing, retrying, or requesting user intervention

#### Agents
- secondary nav lists agents and roles
- roles should be visually distinct from agents
- detail pane shows:
  - idle/busy status in the current project
  - current task
  - queue
  - active sessions
  - project-specific runtime info
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
- application log viewer for backend/session logs during early development

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

### 3. Worktree ownership

Decision:
- store canonical repo clones under projects
- let agents have durable project worktrees for continuity
- let role instances use disposable project-scoped worktrees

### 4. Session resumption policy

Decision:
- when a task returns to a previously used lane, always resume the previously recorded session for that lane

### 5. Notifications and intervention

Decision:
- elevate user-required decisions into a dedicated inbox/to-review surface instead of only inline task state
- allow comments to explicitly request interruption of the assigned agent via a checkbox in the comment UI

### 6. Workflow flexibility

Question:
- should workflows allow branching beyond success/failure?

Suggestion:
- start with success/failure plus explicit user intervention
- add richer branching only after real usage proves it necessary

### 7. Tool/API boundary

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
- define persisted models for projects, repositories, tasks, workflows, agents, roles, and lane runs
- implement project/repository/task/workflow CRUD
- implement lane transitions and lane run history
- wire task comments, including interrupt-vs-queue behavior

### Milestone 4: Agent and role dispatch
- add persistent agents with queues
- add role definitions and capped role instance spawning
- implement FIFO role queues with future manual reorder support
- implement the periodic dispatcher
- implement disposable role worktree lifecycle
- attach tasks and lanes to resumed sessions

### Milestone 5: Operational UX
- build task workflow UI
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
