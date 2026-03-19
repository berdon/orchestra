# Agent runtime plan

This plan covers persistent Orchestra agents: named global workers with continuity, queueing, persistent memory, durable worktrees, and a long-lived operational surface.

It captures the current direction:
- **Agents are global**
- **Roles are global**
- **Workflows are global**
- execution is still **project-scoped**
- projects provide **project-local settings and prompt overlays** to customize how shared workers behave in a given project

That means worker and workflow definitions can live in a shared catalog, while sessions, worktrees, queue entries, and live execution remain tied to a concrete project.

## Goals

- Keep agents clearly distinct from transient roles.
- Give each agent durable identity, memory, session continuity, and persistent project worktrees.
- Make runtime state durable enough to survive app restarts.
- Preserve the human-in-the-loop model for queued work, comments, and interrupts.
- Keep orchestration logic auditable instead of hiding it inside prompt text.
- Fit cleanly beside the existing roles/workflows planning and runtime work.

## What an agent is

An Orchestra agent is a **named persistent collaborator available across projects**.

Compared to roles:
- **Agents** are persistent, memory-bearing, and continuity-focused.
- **Roles** are reusable, capacity-based, and disposable.

An agent should feel like a stable teammate across projects:
- same name
- same identity
- same long-term memory
- same collaboration style
- project-specific execution context when working inside a given project
- accumulating history, preferences, and lessons over time

## Boundary: static vs runtime

### Static agent definition

Agent definitions are global configuration records managed in **Settings > Agents**.

They should own:
- name / slug
- description
- system prompt
- provider / model defaults
- thinking level default
- archived state
- optional default repository preferences
- optional startup instructions / operating notes

### Runtime agent state

Runtime state is separate from the definition and is mostly **project-scoped**, because the same global agent may be active in one project while idle in another.

Project-scoped runtime state should cover:
- main session id
- current status (`idle`, `running`, `waiting`, `needs_review`, `failed`, `offline`)
- active work item
- queued assignments/messages
- worktree path
- last heartbeat / last event time
- last error
- current turn metadata
- dispatch eligibility

Runtime agent state belongs in the **Agents / workforce** surface next to role operations.

## Global agent storage + project-local execution layout

Because agents are global, their durable identity and memory files should live under a shared `~/.orchestra/agents/` namespace. Project execution state should still live under the relevant project.

Suggested layout:

```text
~/.orchestra/
  agents/
    {agent-slug}/
      agent.json
      AGENTS.md
      IDENTITY.md
      SOUL.md
      MEMORY.md
      TOOLS.md
      memory/
        2026-03-19.md
        2026-03-20.md
  projects/
    {project-slug}/
      settings.json
      agent-overlays/
        {agent-slug}.md
      repositories/
        {repo-slug}/
          repository/
          worktrees/
            agents/
              {agent-slug}/
                ...git worktree...
```

Notes:
- `agent.json` is optional if SQLite remains the canonical metadata store, but the agent directory should exist as the stable home for identity and memory.
- The worktree remains project-local and persistent even though the agent definition is global.
- `IDENTITY.md`, `SOUL.md`, `MEMORY.md`, `memory/YYYY-MM-DD.md`, and `TOOLS.md` stay plain files so they are inspectable, debuggable, and recoverable.
- project-specific behavior should live in project settings / overlay files instead of mutating the agent's global identity.

## Memory model

### Recommendation: file-based memory first

The first pass should use **plain files as the canonical global agent memory model**.

Each agent should get:
- `IDENTITY.md` — stable identity framing: who this agent is, what kind of collaborator it is, and how it should present itself
- `SOUL.md` — durable voice, values, collaboration style, and qualitative guidance that should survive across sessions
- `MEMORY.md` — curated long-term memory
- `memory/YYYY-MM-DD.md` — append-only daily notes
- `TOOLS.md` — durable operational notes, repo commands, environment facts
- generated `AGENTS.md` — instructions for how the agent should use those files

Why this should be the first pass:
- easy to inspect and debug
- survives session restarts naturally
- aligns with existing pi memory conventions
- supports richer persistent agent characterization via `IDENTITY.md` and `SOUL.md`
- keeps Orchestra memory auditable by the human
- avoids inventing a second hidden memory system too early

### Project-specific overlays

Projects should be able to customize a shared agent without forking the agent definition.

Recommended project-local overlay sources:
- project settings record in SQLite or `settings.json`
- optional `agent-overlays/{agent-slug}.md`
- workflow lane entry prompts
- queued work messages / task context

Effective runtime context should look like:
1. global agent identity (`IDENTITY.md`, `SOUL.md`)
2. global long-term memory (`MEMORY.md`, daily logs, `TOOLS.md`)
3. project-local overlay/instructions
4. workflow lane prompt / queued assignment

### Should there be a `save_agent_memory` tool?

**Not in the first slice.**

A dedicated memory tool may sound attractive, but it is not the best initial primitive:
- Orchestra currently launches pi via `pi --mode rpc --no-extensions` in `src-tauri/src/services/pi_sessions.rs`, which blocks extension-provided custom tools.
- plain files already give the agent workable persistence through built-in file tools
- debugging a bad memory write is easier when the artifact is an ordinary Markdown file

First-pass recommendation:
- let agents read and write their global identity/memory files directly
- layer project-specific instructions through project settings / overlay files
- use generated instructions in the agent-local `AGENTS.md` to make the behavior explicit
- consider a helper tool later only if raw file editing proves too error-prone

### Optional later refinement

If Orchestra moves managed agent runtimes away from `--no-extensions` or uses the pi SDK directly, it can add one or both of these:

1. **pi-memory integration**
   - generated `.pi/settings.json` in the worktree points `pi-memory.path` at the agent home
   - this would automatically inject `MEMORY.md` and recent daily logs into the system prompt
   - `IDENTITY.md` and `SOUL.md` should remain explicit Orchestra-managed context files rather than being folded into generic memory

2. **Orchestra memory helper tools**
   - `append_agent_daily_note`
   - `replace_agent_memory_section`
   - `search_agent_memory`

These should be convenience tools on top of file-based memory, not replacements for it.

## Generated agent context files

Each persistent agent worktree should get a generated `AGENTS.md` that describes:
- the agent's global identity plus its project-specific role in the current project
- where its `IDENTITY.md`, `SOUL.md`, memory, tools, and project overlay files live
- startup behavior for reading identity, memory, and project overlay context
- queue/interrupt semantics
- repository/worktree conventions
- Orchestra-specific runtime expectations

This works well with pi's existing context-file behavior:
- pi loads `AGENTS.md` from cwd and parent directories
- agent sessions already have a stable cwd (their worktree)

## Worktree policy

Agents should use **persistent project-local worktrees**, not disposable ones.

### First pass

- each agent binds to one repository worktree per project repo
- worktree path is deterministic
- worktree remains attached to the agent across assignments
- branch state is preserved until the human or a later workflow resets it

Suggested deterministic path:

```text
~/.orchestra/projects/{project-slug}/repositories/{repo-slug}/worktrees/agents/{agent-slug}/
```

### Why persistent worktrees

This gives the agent continuity:
- branch state survives
- local notes/config survive
- repo context survives
- active implementation work is inspectable

This is the main behavioral difference from role instances.

### Lifecycle controls

The operator should be able to:
- provision / repair worktree
- open the worktree path
- reset the worktree to the project default branch
- inspect git status
- rebind the agent to another repository later if needed

## Session policy

### Main rule

A persistent agent should own **one main Orchestra-managed session per project/repository binding**.

That session is reused over time instead of creating a fresh session for every assignment.

Why not one single global session:
- pi sessions are cwd-sensitive
- the worktree is the operational home of the agent during project execution
- session continuity should follow the repo/worktree actually being edited

If Orchestra only supports one repository per active project binding in the first slice, this can appear in the UI simply as the agent's main session for that project.

### Implication for runtime architecture

The current one-shot `pi --mode rpc` bridge is enough for session-first manual interaction, but it is **not the ideal long-term primitive for persistent agents**.

Agents need:
- queue draining
- interrupt delivery
- follow-up delivery
- stable status while work is in flight
- background dispatch from queued work
- eventual custom Orchestra tool support

That points toward a managed long-lived runtime abstraction in the backend, even if the persisted session file format remains the same.

### Recommended agent runtime behavior

For each active project/repository binding:
- keep a durable session file under the project session directory
- keep a live runtime handle when the agent is subscribed or actively working
- support queued command delivery via pi RPC semantics:
  - `prompt`
  - `steer`
  - `follow_up`
- reuse the same session whenever possible

## Queue model

Agents are single-threaded collaborators. Their queue model should reflect that.

### Agent queue entry

Suggested fields:
- `id`
- `projectId`
- `agentId`
- `status` (`queued`, `dispatched`, `completed`, `canceled`, `failed`)
- `sourceType` (`workflow_lane`, `task_comment`, `manual`, `system`)
- `sourceTaskId?`
- `sourceWorkflowId?`
- `sourceLaneId?`
- `sourceSessionId?`
- `deliveryMode` (`prompt`, `follow_up`, `steer`)
- `title`
- `message`
- `interruptRequested`
- `dispatchedAt?`
- `completedAt?`
- `createdAt`
- `updatedAt`

### Dispatch rules

When work targets an agent:
1. create an agent queue entry
2. log `agent.queue.updated`
3. try to dispatch immediately

Dispatch logic:
- if the agent is idle, send the oldest queued work as a normal `prompt`
- if the agent is currently streaming and the new work explicitly requests interruption, send it as `steer`
- if the agent is currently streaming and interruption is not requested, queue it as `follow_up`
- update runtime status and queue state after delivery

### Task comment semantics

This should mirror the earlier design intent:
- task comments addressed to an assigned agent should include `Interrupt agent`
- checked => deliver via `steer` when the agent is actively running
- unchecked => queue as `follow_up`

## Periodic dispatch poll

A periodic dispatcher is required.

The system should have a background poll/tick that checks for queued work that can now be dispatched.

Why:
- an agent may finish a turn and become dispatchable
- a queued `follow_up` may now be eligible
- a session/runtime may have gone idle after the last UI event
- the app should not require a manual refresh button to keep work moving

### First-pass design

Add a lightweight backend dispatcher loop that runs periodically while the app is open.

Responsibilities:
- scan for queued agent work
- scan for queued role work
- check runtime status / active turn state
- dispatch eligible entries
- skip workers already in a terminal or blocked state
- write logs for every decision

Recommended characteristics:
- fixed interval at first (for example every few seconds)
- idempotent logic
- no duplicate dispatch for the same queue entry
- backoff / skip when a dispatch cycle is already running

### Operator experience

The UI should still expose explicit controls:
- `Dispatch now`
- latest dispatcher tick time
- latest dispatch result / error

But the periodic poll should do the normal work automatically.

## Workflow ownership semantics

Because workflows, roles, and agents are all global, workflow lane ownership can resolve against a shared worker catalog.

### Recommendation

Workflow definitions should prefer a **stable worker reference key/slug** over a brittle database primary key.

Examples:
- lane owned by agent slug `data`
- lane owned by role slug `reviewer`

Inside a project:
- resolve the lane owner reference against the global agents or roles catalog
- apply any project-specific worker behavior through project settings / overlay prompts
- surface a validation error if the referenced worker does not exist

This keeps lane ownership readable and portable while still letting projects customize how shared workers behave.

### Implication for current implementation

The current workflow lane `assignedEntityId` field can keep its storage slot for now, but its meaning should evolve from "database row id" to a stable global worker reference.

That avoids coupling workflows to unstable row ids and makes future import/export or synchronization work easier.

## Data model

### Agent definition

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

### Agent runtime state

Suggested fields:
- `agentId`
- `projectId`
- `repositorySlug`
- `status`
- `mainSessionId?`
- `worktreePath?`
- `currentQueueEntryId?`
- `lastHeartbeatAt?`
- `lastDispatchAt?`
- `lastError?`
- `createdAt`
- `updatedAt`

### Agent queue entry

As described above.

### Optional agent memory metadata

Most memory should remain file-based, but a small amount of metadata in SQLite is still useful:
- `agentId`
- `lastMemoryWriteAt?`
- `lastMemoryReviewAt?`
- `memoryRootPath`

This is operational metadata, not the memory content itself.

## Backend service split

Keep persistent-agent logic out of roles and general session CRUD.

Recommended services:
- `agents.rs`
  - definition CRUD
  - list/get/update/archive
- `agent_runtime.rs`
  - runtime state queries
  - queue CRUD
  - workforce snapshots
- `agent_dispatch.rs`
  - dispatch logic
  - prompt / steer / follow-up delivery
  - status transitions
- `agent_worktrees.rs`
  - persistent worktree creation / repair / reset
- `agent_memory.rs`
  - path generation
  - bootstrap memory files
  - optional helpers for safe section updates later
- `dispatcher.rs`
  - periodic poll loop for agents and roles

## Initial command surface

### Agent definitions
- `list_agents()`
- `get_agent(agentId)`
- `create_agent(input)`
- `update_agent(agentId, input)`
- `archive_agent(agentId)`
- `validate_agent(input)`

### Agent runtime inspection
- `list_agent_operations(projectId)`
- `get_agent_operations(projectId, agentId)`
- `get_agent_queue(projectId, agentId)`
- `get_agent_memory_info(agentId)`

### Agent runtime control
- `enqueue_agent_work(input)`
- `dispatch_agent_queue(projectId, agentId?)`
- `send_agent_message(projectId, agentId, message, deliveryMode)`
- `reset_agent_worktree(projectId, agentId)`
- `open_agent_session(projectId, agentId)`

### Later convenience tools
If Orchestra adds extension/SDK-backed custom pi tools later, likely candidates are:
- `list_project_tasks`
- `get_task_context`
- `comment_on_task`
- `complete_lane_as_success`
- `complete_lane_as_failure`
- optional memory helpers, only if file-based memory proves awkward

## Workforce UI shape

The Agents area should become a true workforce view for both persistent agents and transient roles.

### For each agent show
- name
- status
- current work title
- queue depth
- last activity time
- current project binding
- repository binding
- worktree health / git status summary
- session status
- latest error

### Agent detail should show
- identity / prompt summary
- memory file locations
- project overlay locations
- main session link
- current queue
- recent dispatched work
- current branch and worktree path
- controls for interrupt vs queue message delivery
- dispatch history / recent runtime events

### Operator actions
- create / edit / archive agent
- send direct message
- send interrupting message
- enqueue work
- dispatch now
- open session
- open worktree
- inspect memory files
- inspect project overlay
- reset worktree

## Logging

Log these agent events at minimum:
- `agent.created`
- `agent.updated`
- `agent.archived`
- `agent.memory.bootstrapped`
- `agent.project_overlay.loaded`
- `agent.worktree.created`
- `agent.worktree.reset`
- `agent.session.created`
- `agent.session.resumed`
- `agent.queue.updated`
- `agent.queue.dispatched`
- `agent.message.follow_up_queued`
- `agent.message.steer_queued`
- `agent.runtime.idle`
- `agent.runtime.failed`
- `dispatcher.tick.started`
- `dispatcher.tick.completed`

## Delivery order

### 1. Global agent foundations
- expand the agent schema beyond summary rows
- keep definitions global
- add CRUD + validation
- add generated storage paths and bootstrap files
- define stable worker-reference semantics for workflows
- define project settings / overlay structure for worker customization

### 2. Persistent worktree + memory bootstrap
- create deterministic persistent worktrees per project/repository binding
- generate agent `AGENTS.md`, `IDENTITY.md`, `SOUL.md`, `MEMORY.md`, `TOOLS.md`, and daily log directory
- add backend inspection APIs

### 3. Agent runtime + queue persistence
- add project-scoped queue tables and runtime state tables
- add workforce snapshots
- add tests for queue transitions and restart durability

### 4. Dispatch engine + periodic poll
- implement `prompt` / `steer` / `follow_up` dispatch behavior
- add periodic dispatcher tick
- log dispatch decisions
- prevent duplicate dispatch under concurrent ticks

### 5. Workforce UI
- agent management in Settings
- persistent agents in Agents page
- agent detail / queue / worktree / session controls
- direct and interrupting message actions

### 6. Workflow + task integration
- resolve workflow worker refs against the global agent/role catalog
- apply project-local overlay behavior during execution
- create agent queue entries from lane entry
- route task comments to `steer` or `follow_up`
- preserve lane/session continuity rules

### 7. Optional runtime evolution
- move managed agent runtimes to whitelisted extensions or SDK-managed custom tools
- add pi-memory integration
- add Orchestra task tools callable directly by agents

## Explicit non-goals for the first slice

Do not block the first persistent-agent delivery on:
- sophisticated multi-project coordination policies for one agent working across many projects at once
- hidden database-only memory storage
- autonomous memory summarization pipelines
- rich analytics dashboards
- advanced conflict resolution across multiple repositories per agent

## Summary

The right first-pass agent model is:
- **global in definition**
- **project-scoped in execution**
- **persistent**
- **memory-bearing via plain files**
- **backed by a durable worktree and main session per project/repository binding**
- **single-threaded with an explicit queue**
- **kept moving by a periodic dispatcher poll**

That gives Orchestra a concrete, inspectable, controllable persistent-worker system that complements shared roles/workflows while still leaving room for project-specific overlays, later extension-backed tools, and richer automation.
