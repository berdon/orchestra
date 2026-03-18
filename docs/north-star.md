# Orchestra North Star

## One-line promise

Orchestra helps a human direct multiple AI workers across a real software project without losing clarity, control, or momentum.

## Product vision

Orchestra should feel like a practical operating surface for getting project work done with agents.

It is not a chatbot wrapper, a toy automation demo, or a dashboard full of abstract telemetry. It is a working environment where a human can:
- choose the project context
- assign work through explicit workflows
- see who is working on what
- interrupt, redirect, or review work when needed
- resume ongoing execution instead of starting over

The product should make parallel agent work legible and manageable.

## The core user outcome

A user should be able to look at Orchestra and immediately answer these questions:
- What project am I looking at?
- What work is in flight?
- Which agent or role is handling it?
- Which sessions are active, idle, blocked, or waiting for me?
- Where do I need to intervene right now?
- If I add a comment, will it interrupt current work or queue for later?

If the interface cannot answer those questions quickly, it is failing the product.

## What Orchestra is optimizing for

### 1. Throughput with control

Orchestra should increase how much useful work gets done without making the human feel disconnected from the process.

The goal is not maximum autonomy at all costs. The goal is managed autonomy.

### 2. Continuity over restart

Sessions, lane history, comments, and worktree context should preserve momentum.

A lane reopening should resume the prior session. A user should not lose context just because a task loops back or a review fails.

### 3. Operational visibility over abstraction

Users should see what is happening in a concrete way:
- sessions
- queues
- lane history
- comments
- logs
- required user actions

This should feel closer to an operations console than a generic productivity app.

### 4. Explicit workflow over improvisation

Tasks should move through defined lanes with visible ownership and outcomes.

Work should feel intentional and inspectable, not like a pile of prompts and transcripts.

### 5. Safe concurrency

Concurrent work is only useful if it stays understandable.

Repositories, worktrees, agent identity, and role capacity exist to make parallelism safe and navigable.

## Product pillars

### Project-centered work

The project is the top-level container for all meaningful work. Repositories, tasks, sessions, agents, and roles all gain meaning from project context.

### Sessions as the unit of execution

Sessions are where work actually happens. This is why session support is the first implementation slice.

A strong Orchestra experience depends on users being able to:
- create sessions easily
- resume sessions confidently
- observe session output live
- message sessions directly

### Agents for continuity, roles for capacity

Orchestra should clearly separate two kinds of workers:
- **Agents** are named long-lived collaborators with memory and continuity
- **Roles** are transient, disposable workers created from a shared template

This distinction should remain obvious in the data model and UI.

### Workflow-driven task movement

Tasks should always have a visible place in a workflow.

Ownership, success, failure, retry, and user review should be modeled directly instead of inferred from conversation.

### Human-in-the-loop by design

The human is not outside the system. They are an explicit participant.

They can:
- review work
- move tasks
- comment on tasks
- interrupt active work when needed
- resolve ambiguity
- inspect logs and session activity

## What good feels like

A strong Orchestra experience should feel:
- calm under parallel activity
- dense but readable
- fast to scan
- explicit about state
- interruptible without being chaotic
- trustworthy when work loops back or fails

The UI should feel like software for running work, not browsing ideas.

## Anti-goals

Orchestra should avoid becoming:

### A chat-first product

Chat matters, but Orchestra is not primarily a chat surface. Chat should serve work execution, not replace the task/workflow model.

### A decorative dashboard

Pretty analytics without actionability are not enough. Every major view should help the user decide what to do next.

### An over-automated black box

Users should not need to guess why something happened. Ownership, queueing, lane transitions, and session resumption should be visible.

### A generic PM tool clone

Orchestra is specialized software for orchestrating AI workers on real project work. It should not flatten itself into a conventional ticket board with AI bolted on.

## The strategic wedge

The first compelling user experience is not full orchestration. It is a session-first control surface.

That means the early product should prove:
- a session can be created quickly
- a session can be resumed reliably
- session output can be observed live
- the human can send a message back into the session
- logs make the system understandable while deeper orchestration features are still maturing

This wedge creates the foundation for everything else.

## The long-term picture

At maturity, Orchestra should let a single human run a software project with a blend of:
- persistent named agents
- transient role workers
- explicit workflows
- resumable sessions
- visible queues
- safe worktree isolation
- fast user intervention when necessary

The user should feel like they are conducting an ensemble, not babysitting a pile of terminals.

## Decision filter

When evaluating a new feature, ask:
1. Does this improve clarity of work in motion?
2. Does it preserve or improve human control?
3. Does it reduce restart/rework by preserving continuity?
4. Does it make parallel work safer or more understandable?
5. Does it help the user act, not just observe?

If the answer is mostly no, it is probably not part of the north star.
