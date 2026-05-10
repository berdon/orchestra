# Task Whip Implementation Plan

## Goal

Ensure agent-owned task lanes do not silently stall when the agent stops responding without completing the lane.

When an agent runtime goes idle and the active task lane is still incomplete, Orchestra should send a follow-up "whip" prompt instructing the agent to keep working and to finish by calling one of the lane completion tools. If repeated whips exceed a per-task threshold, Orchestra should stop re-prompting and automatically escalate the task to user intervention.

## User-facing behavior

### Whip prompt

When a whip is sent, the agent receives the following follow-up prompt:

```text
Keep working until you are done - when you are done use tool `complete_lane_as_success` (with the task ID, required lane summary, and optional notes) unless you truly failed - then use tool `complete_lane_as_failure` (with task ID, required lane summary, required `actuallyFailed`, and optional notes). Pass `actuallyFailed=false` only when you finished this slice but are not actually failed and want Orchestra to guide the next slice. If you truly need the user - use tool `request_user_intervention` (with task ID, required lane summary, required `actuallyBlocked`, and optional notes). Pass `actuallyBlocked=false` only when you finished this slice but are not actually blocked and want Orchestra to guide the next slice.
```

The prompt should also include the canonical task id so the agent can call the completion tools correctly.

### Threshold behavior

Each task gets a `whipMaxAttempts` configuration with a default of `10`.

- If the agent goes idle and the task lane is still active, Orchestra sends a whip and increments the count.
- If the whip count reaches the configured threshold, Orchestra does not send another whip.
- Instead, Orchestra records a task comment explaining the automatic escalation and transitions the task through `request_user_intervention`.

## Scope

### In scope

- Agent-owned task lanes only
- Per-task whip threshold configuration
- Per-assignment whip tracking
- Dispatcher/runtime handling for idle incomplete assignments
- Automatic escalation to user intervention when threshold is exceeded
- Backend regression tests
- Desktop Podman runner E2E coverage for task configuration and whip-driven behavior

### Out of scope

- Role-owned lane whipping
- User-configurable global whip defaults UI
- Rich per-whip analytics beyond basic count/timestamp tracking
- Reworking the full runtime event model

## Design

## Data model changes

### Tasks

Add a task-level configuration field:

- `whip_max_attempts INTEGER NOT NULL DEFAULT 10`

Expose it as:

- backend API/model: `whip_max_attempts`
- frontend API/model: `whipMaxAttempts`

This belongs on the task because it is policy/configuration rather than runtime state.

### Task lane assignments

Add per-assignment runtime tracking fields:

- `whip_count INTEGER NOT NULL DEFAULT 0`
- `last_whip_at TEXT NULL`

This belongs on the assignment because whip counts should reset when a task re-enters a lane and gets a new assignment.

## Trigger point

Whip handling should run from the dispatcher tick after normal queue dispatching.

Reasoning:

- avoids racing directly on `agent_end`
- allows task transition/completion state to settle before evaluating whether the lane is still incomplete
- keeps queue delivery and whip logic centralized in the backend

Sequence inside dispatcher tick:

1. dispatch queued agent work
2. dispatch queued role work
3. process idle task whip candidates

## Candidate selection

A task assignment is a whip candidate when all of the following are true:

- `task_lane_assignments.status = 'active'`
- `task_lane_assignments.worker_type = 'agent'`
- assignment has a `session_id`
- task is not archived
- task status is still executable (`ready` or `in_progress`)
- assignment is still the current active assignment for the task
- the agent runtime state for the same project/agent is `idle`
- `agent_runtime_states.current_queue_entry_id IS NULL`
- there is no queued or dispatched `task_whip` queue entry already pending for the same task/lane/agent

## Delivery mechanism

Use the existing agent queue system.

A whip becomes a normal agent queue entry with:

- `source_type = 'task_whip'`
- `source_task_id = <task_id>`
- `source_workflow_id = <workflow_id>`
- `source_lane_id = <lane_id>`
- `delivery_mode = 'prompt'`
- `title = '<task number> · keep working'`
- `message = <whip prompt + canonical task id>`

Benefits:

- reuses existing dispatch/runtime machinery
- keeps audit trails consistent
- avoids a special direct-to-runtime code path

## Escalation behavior

When `whip_count >= task.whip_max_attempts` for an otherwise valid candidate:

1. do not enqueue another whip
2. add a durable task comment explaining the automatic escalation
3. transition the task via `request_user_intervention`
4. stop whipping the assignment thereafter because the assignment becomes completed

Suggested automatic comment text:

```text
Automatic user intervention requested after <N> whip attempts without lane completion.
```

## Logging and events

Add backend logs for:

- `task.whip.sent`
- `task.whip.skipped`
- `task.whip.escalated`

Emit task/session changes when:

- a whip is sent
- an automatic escalation occurs

## Implementation plan

### Ticket: design

- add this design doc
- document runtime semantics and escalation behavior

### Ticket: backend runtime/dispatcher

- add database columns for task whip config/tracking
- extend task and assignment models
- implement idle whip candidate selection
- enqueue whip prompts through the agent queue
- update whip count / last whip timestamp
- auto-escalate to user intervention when threshold is exceeded

### Ticket: task configuration UI

- expose `whipMaxAttempts` in task create/edit surfaces
- default to 10
- explain that exceeding the threshold automatically escalates to user intervention

### Ticket: tests

- backend regression tests for candidate selection, whip count progression, duplicate suppression, and escalation
- desktop Podman runner E2E for task whip threshold configuration and at least one whip-driven execution path

## Acceptance criteria

- Active agent-owned task lanes that go idle without completing receive a whip prompt.
- Whip prompts stop once the task is completed or escalated.
- Each active assignment tracks whip count and last whip time.
- Tasks default to `whipMaxAttempts = 10` and can override it.
- Once the threshold is exceeded, Orchestra automatically requests user intervention and records why.
- Regression tests cover backend whip behavior.
- Desktop Podman runner E2E covers the task-level configuration and end-to-end whip flow.
