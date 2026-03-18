# Orchestra Implementation Plan

## Planning intent

This plan narrows the immediate focus to the fastest path toward a usable Orchestra prototype.

Priority order:
1. Scaffold the app
2. Implement session support first and foremost
3. Validate creating, resuming, viewing, and interacting with sessions as soon as possible
4. Plan and build the rest of the orchestration model after the session slice works

## Guiding principle

**Sessions are the first real product surface.**

Before building full task/workflow orchestration, Orchestra should prove that it can:
- start a `pi-agent-core` session
- resume that session
- subscribe to session output
- send messages into the session
- show the interaction cleanly in the desktop UI

That vertical slice will de-risk the backend/frontend integration and give a concrete platform for layering tasks, agents, and workflows later.

## Phase 1: Scaffold the app

Goal: create a clean application shell with just enough structure to support rapid iteration.

### Deliverables

#### Repository/application setup
- initialize the Tauri app
- set up TypeScript frontend structure
- establish the Rust backend/Tauri command layout
- define folders/modules for:
  - `commands/`
  - `services/`
  - `models/`
  - `state/`
  - `ui/components/`
  - `ui/pages/`

#### Base UI shell
- left navigation layout
- project switcher placeholder at top
- primary nav entries:
  - Tasks
  - Agents
  - Sessions
  - Settings
- fixed nav with scrollable content area
- initial light theme and design tokens

#### Shared application state
- app bootstrapping
- backend connection utilities
- simple query/state management for sessions
- error and loading patterns

#### Logging surface
- simple backend logger
- in-memory or file-backed log buffer for development
- Settings page log panel to inspect backend/session activity

### Acceptance criteria
- app launches successfully
- frontend can call backend commands
- navigation shell works
- Settings page shows backend logs

## Phase 2: Session-first vertical slice

Goal: make sessions real and testable end to end.

### Backend scope

Implement Tauri commands for:
- `create_session`
- `resume_session`
- `list_sessions`
- `send_session_message`
- `subscribe_session`
- `unsubscribe_session`

Backend responsibilities:
- manage `pi-agent-core` session lifecycle
- create and resume sessions with an Orchestra-managed `sessionDir` under `~/.orchestra/projects/{project-slug}/sessions/`
- track active subscriptions per session
- translate session events into frontend-consumable events
- log all major session actions

Suggested initial session model:
- `id`
- `status`
- `createdAt`
- `updatedAt`
- `title?`
- `agentId?`
- `roleInstanceId?`
- `taskId?`

### Frontend scope

Build the Sessions page first.

#### Sessions list
- list known sessions
- show basic status
- show selected/active session

#### Session detail pane
- transcript/event stream
- active subscription chip/state
- input box for sending messages
- buttons/actions for:
  - create session
  - resume session
  - subscribe/unsubscribe

#### Test UX
The user should be able to:
1. create a new session
2. watch events/messages arrive
3. send a message to the session
4. leave and return to the session
5. resume the session later

### Acceptance criteria
- a session can be created from the UI
- session output can be viewed live
- user messages can be sent into the session
- an existing session can be resumed from the UI
- backend logs make failures diagnosable

## Phase 3: Stabilize session architecture

Goal: turn the first session slice into a durable foundation for orchestration features.

### Scope
- define subscription lifecycle rules
- decide how session metadata is persisted
- define transcript/event retention approach
- add better session statuses and error handling
- confirm how sessions map to projects even before full project/task orchestration exists

### Suggested design choices
- keep subscriptions ephemeral and client-bound
- store Orchestra-managed pi session files in project-scoped directories under `~/.orchestra` rather than pi's default global session location
- persist session metadata even if transcript persistence remains minimal at first
- use logs plus transcript stream before designing a richer audit/event store

### Acceptance criteria
- sessions survive app reload/reopen at the metadata level
- resume behavior is reliable
- session state is understandable from UI + logs

## Phase 4: Plan and implement core orchestration data

Only after the session-first slice is working should the rest of the orchestration system be layered in.

### Next planning target
- projects
- repositories
- tasks
- workflows
- lane runs
- comments
- agents
- roles

### Initial implementation order after sessions
1. projects + repositories
2. tasks + workflows + lane history
3. comments with interrupt checkbox behavior
4. agents + queues
5. roles + FIFO queues + manual reorder UI later
6. disposable role worktrees

## Concrete task breakdown

### Track A: App scaffold
1. initialize Tauri app structure
2. choose frontend stack details and UI foundation
3. create base layout and nav shell
4. add Settings page with log viewer

### Track B: Session backend
1. wrap `pi-agent-core` session creation
2. add session registry/state in backend
3. expose Tauri commands for create/resume/list/send
4. implement subscription streaming to frontend
5. add structured logging around session lifecycle

### Track C: Session frontend
1. create Sessions page layout
2. render session list and detail pane
3. wire create session action
4. wire subscribe/unsubscribe
5. wire send message input
6. support resume flow from existing sessions

### Track D: Hardening
1. improve loading/error states
2. test reconnect/resume cases
3. verify behavior when no frontend is subscribed
4. validate logs are sufficient for debugging

## Out of scope for the first build slice

Do not block the initial prototype on:
- full task workflow management
- agent queueing
- role spawning
- drag/drop role queue ordering
- durable event sourcing
- advanced worktree lifecycle management

These should be planned next, but only after session interaction is working.

## Summary

The immediate implementation strategy is:
- scaffold the Tauri app
- make the Sessions page and session backend the first real feature
- prove create/resume/subscribe/message flows quickly
- use logs in Settings for visibility while the system is still young
- only then expand into tasks, agents, roles, workflows, and worktrees
