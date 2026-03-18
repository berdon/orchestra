# Orchestra Design Draft

## Overview

Orchestra is an agent orchestration framework focused on getting project work done. It coordinates projects, repositories, worktrees, agents, roles, sessions, tasks, and workflows in a single desktop application.

### Initial stack

- Tauri
- TypeScript
- `pi-agent-core` from `pi-mono`

## Product goals

- Make agent work visible and manageable at the project level
- Treat repositories and worktrees as first-class operational primitives
- Support both persistent named agents and transient role-based workers
- Drive work through explicit workflows instead of ad hoc prompting
- Keep humans in the loop at key review and decision points

## Core design principles

1. **Project-centered orchestration**  
   Everything happens in the context of a project.
2. **Sessions are execution, not identity**  
   Sessions come and go; agents and roles define the working context.
3. **Workflows own task progression**  
   Tasks move through lanes with explicit success/failure transitions.
4. **Repositories must be safe for concurrent work**  
   Worktrees isolate agent and role activity.
5. **The UI should optimize for situational awareness**  
   Users should quickly see who is working on what, what is blocked, and where intervention is required.

## Domain model

### Projects

Projects are the top-level entity.

A project owns:
- repositories
- sessions
- agents
- roles
- tasks
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
  repositories/{repo-slug}/
    repository/              # primary git clone
    worktrees/{worktree-slug}/
```

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

Sessions correspond to active `pi` sessions managed by `pi-agent-core`.

A session may optionally be associated with:
- an agent
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

### Agents

Agents are named persistent workers with configured context and memory.

Characteristics:
- persistent identity
- persistent memory
- their own project/repo worktrees
- many sessions, but only one main session
- a queue of deferred work when the main session is busy

Suggested filesystem layout:

```text
~/.orchestra/agents/{agent-slug}/
  agent.json
  memory/
  worktrees/{project-slug}/{repo-slug}/
```

Suggested agent fields:
- `id`
- `slug`
- `name`
- `description`
- `systemPrompt`
- `provider`
- `model`
- `mainSessionId?`
- `queuePolicy`
- `createdAt`
- `updatedAt`

### Roles

Roles are templates for transient workers.

Characteristics:
- configured but not memory-bearing
- spin up role instances on demand
- operate under a concurrency limit
- use project worktrees rather than agent-owned persistent worktrees

Examples:
- Developer
- QA
- Planner
- Reviewer

Suggested role fields:
- `id`
- `slug`
- `name`
- `description`
- `systemPrompt`
- `provider`
- `model`
- `capacity`
- `createdAt`
- `updatedAt`

Suggested role instance fields:
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
- each lane run should record which session worked that lane
- when a task re-enters a lane, Orchestra can resume the prior session when appropriate

Suggested lane run model:
- `laneId`
- `sessionId`
- `startedAt`
- `completedAt?`
- `result` (`success`, `failure`, `needs_user`, `canceled`)
- `notes?`

### Workflows

Workflows are reusable definitions outside any single project.

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
- `assignedEntityId`
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

When an agent has an active main session:
- new task assignments should enqueue work
- new comments should enqueue notifications or messages
- the session should receive queued items when it becomes available

Open design question:
- should queued comments interrupt the active session if they belong to the current task?

### Role queues

For roles:
- tasks queue against the role definition
- if active instances are below capacity, a new role instance may be created
- if capacity is exhausted, the task waits in the role queue

Open design question:
- should roles support priority scheduling or only FIFO initially?

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

The backend should use `pi-agent-core` to create and manage sessions and expose an application API to the frontend.

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

### Suggested backend refinement

Split the backend into clear service areas:
- `ProjectService`
- `RepositoryService`
- `WorkflowService`
- `TaskService`
- `AgentService`
- `RoleService`
- `SessionService`
- `DispatchService` for queueing and assignment

This will likely reduce coupling versus putting workflow advancement logic directly inside session management.

### Event model

A durable event model would make the system easier to reason about.

Examples:
- `task.created`
- `task.commented`
- `task.lane.entered`
- `task.lane.completed`
- `session.created`
- `session.resumed`
- `session.message.received`
- `agent.queue.updated`
- `role.queue.updated`

This does not require full event sourcing, but event records would help with debugging, timeline views, and auditability.

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

### Page concepts

#### Tasks
- kanban or lane-centric workflow view
- task detail panel with comments, lane history, and current assignee
- clear controls for advancing, retrying, or requesting user intervention

#### Agents
- secondary nav lists agents and roles
- roles should be visually distinct from agents
- detail pane shows:
  - idle/busy status
  - current task
  - queue
  - active sessions
  - ability to subscribe/chat with an active session

#### Sessions
- session list in secondary nav
- selected session shows transcript/event stream
- active subscription state displayed clearly
- ability to send messages back into the session

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
- persist projects, repos, agents, roles, workflows, tasks, comments, lane runs, and queue state
- treat frontend subscriptions as ephemeral

### 2. Agent vs role overlap

Question:
- when should a user create an agent instead of a role?

Suggestion:
- agents are for named long-lived collaborators with memory
- roles are for elastic labor pools with shared configuration and no long-term memory

### 3. Worktree ownership

Question:
- should worktrees belong to projects, agents, or role instances?

Suggestion:
- store canonical repo clones under projects
- let agents have durable worktrees for continuity
- let role instances use disposable project-scoped worktrees

### 4. Session resumption policy

Question:
- when a task goes back to a prior lane, should Orchestra always resume the old session?

Suggestion:
- default to resuming the previous session for that lane when still valid
- fall back to a fresh session if the old session is dead, stale, or bound to incompatible context

### 5. Notifications and intervention

Question:
- how should the system surface user-required decisions?

Suggestion:
- elevate these into a dedicated inbox/to-review surface instead of only inline task state

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

### Milestone 1: Core data and task flow
- define persisted models
- implement project/repository/task/workflow CRUD
- implement lane transitions and lane run history
- implement user-assigned lanes before autonomous dispatch

### Milestone 2: Session integration
- create/resume/list sessions through `pi-agent-core`
- wire session subscriptions and chat
- attach sessions to tasks and lanes

### Milestone 3: Agent and role dispatch
- add persistent agents with queues
- add role definitions and capped role instance spawning
- implement queue processing and assignment

### Milestone 4: Operational UX
- build task workflow UI
- build agent/role workload views
- build intervention inbox and queue health indicators

## Summary

Orchestra has a strong conceptual foundation: projects own the work context, workflows define progression, sessions execute work, agents provide continuity, and roles provide scalable transient labor.

The biggest design opportunities are:
- modeling repositories explicitly
- clarifying queue/dispatch behavior
- defining resumption rules for sessions and lanes
- keeping workflow state transitions centralized and auditable
- focusing the UI on operational visibility rather than generic dashboards
