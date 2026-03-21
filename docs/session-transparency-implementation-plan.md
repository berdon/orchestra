# Session Transparency Implementation Plan

## Goal

Make live Orchestra sessions visibly explain what pi is doing in real time so long-running or blocked work no longer feels like silence.

## Current State

Today the Sessions view has partial observability:

- session transcript/user-assistant messages are rendered
- some streamed runtime events are surfaced
- tool calls/results may appear after the fact when transcript parsing succeeds
- backend warnings/errors are mostly only visible in logs
- there is no consistent first-class UI for in-progress tool execution state
- there is no clear session activity model (idle, thinking, running tool, blocked, errored)

This leaves a major UX gap: if the model is thinking for a while, waiting on a long-running tool, or hitting a runtime/protocol issue, the human often cannot tell whether the session is active, stuck, or broken.

## Problems To Solve

### 1. Tool execution is not a first-class lifecycle

We need explicit lifecycle events, not just final transcript artifacts.

Desired phases:

- tool queued/requested
- tool started
- tool streaming output or reporting activity
- tool completed
- tool failed/canceled

### 2. Session activity is not summarized clearly

At any point the UI should be able to answer:

- is the session idle?
- thinking?
- waiting on a tool?
- actively streaming output?
- errored?

### 3. Runtime/protocol failures are too invisible

Malformed RPC output, runtime exits, process restarts, or backend warnings should be visible from the session view without requiring log spelunking.

### 4. Long-running operations feel like silence

Even if we cannot stream every byte of stdout, we should show enough activity metadata that humans know work is progressing.

## Target UX

### Session status header

Each active session should expose a derived status summary:

- Idle
- Thinking
- Running tool: `<tool name>`
- Waiting for tool result
- Streaming response
- Error

Also show:

- last activity timestamp
- current run id (optional diagnostics)
- currently active tool count (if any)

### In-chat tool cards

Render tool calls immediately when they start.

Each card should include:

- tool name
- compact argument summary
- started timestamp
- duration or elapsed time
- status badge: running / completed / failed / canceled
- expandable payload/result/output area

If a tool completes, update the same card instead of appending an unrelated final-only artifact.

### Diagnostics drawer / advanced details

For debugging, sessions should expose a details view with:

- runtime spawn events
- RPC parse errors
- runtime stderr notices
- process exits / reconnects
- any backend warning/error associated with the active session

## Backend Event Model

We should standardize on explicit event types emitted by live session runtimes.

### Required event families

#### Session lifecycle

- `session.runtime.spawned`
- `session.runtime.ready`
- `session.runtime.ended`
- `session.runtime.error`

#### Run lifecycle

- `session.run.started`
- `session.run.completed`
- `session.run.failed`

#### Tool lifecycle

- `session.tool.started`
- `session.tool.progress`
- `session.tool.completed`
- `session.tool.failed`

#### Response activity

- `session.response.started`
- `session.response.delta`
- `session.response.completed`

#### Diagnostics

- `session.rpc.stderr`
- `session.rpc.parse_error`
- `session.rpc.protocol_error`

## Suggested Event Shapes

### Tool started

```json
{
  "type": "session.tool.started",
  "sessionId": "...",
  "runId": "...",
  "toolCallId": "...",
  "toolName": "bash",
  "argumentsSummary": "npm test -- foo",
  "startedAt": "2026-03-21T...Z"
}
```

### Tool progress

```json
{
  "type": "session.tool.progress",
  "sessionId": "...",
  "runId": "...",
  "toolCallId": "...",
  "message": "Still running",
  "outputChunk": "optional stdout/stderr chunk",
  "at": "2026-03-21T...Z"
}
```

### Tool completed

```json
{
  "type": "session.tool.completed",
  "sessionId": "...",
  "runId": "...",
  "toolCallId": "...",
  "toolName": "bash",
  "completedAt": "2026-03-21T...Z",
  "durationMs": 1834,
  "resultSummary": "exit 0"
}
```

### Tool failed

```json
{
  "type": "session.tool.failed",
  "sessionId": "...",
  "runId": "...",
  "toolCallId": "...",
  "toolName": "bash",
  "completedAt": "2026-03-21T...Z",
  "durationMs": 1834,
  "error": "exit 1"
}
```

## Derived UI State

The Sessions page should derive a canonical activity state from the latest event set.

Priority order:

1. runtime/session error
2. active running tool(s)
3. active response streaming
4. active thinking/run started
5. idle

This should be computed from events, not guessed from DOM presence.

## Data Retention Strategy

We likely do not need to persist every progress byte forever. A practical approach:

- keep lifecycle events in session event stream
- cap large output snippets in the main list
- allow expansion for full captured output where feasible
- use logs as lower-level fallback, but keep high-value lifecycle events in the session timeline

## Implementation Sequence

### Ticket 1 — Event model definition (this task)

- document canonical event families and required fields
- identify which existing runtime emissions can be reused vs renamed
- define derived session activity state rules

### Ticket 2 — Backend emissions

- emit explicit tool lifecycle events from live session runtime
- surface runtime stderr / parse errors in structured form
- ensure a stable tool call id exists across start and completion

### Ticket 3 — Sessions UI

- render status header/badges
- render in-progress tool cards
- update cards in place on completion/failure
- expose diagnostics drawer/details

### Ticket 4 — Automated coverage

- add coverage for backend event emission
- add UI/session tests for visible running/completed tool state
- add regression coverage for runtime error surfacing

## Acceptance Criteria

- humans can tell within a few seconds whether a session is actively working or actually stuck
- tool calls appear when they start, not only after completion
- completed/failed tool calls update visibly with duration and outcome
- runtime parse/protocol errors are visible in the session UI
- automated tests cover representative lifecycle cases

## Non-Goals

- full terminal emulator in the session chat
- storing unbounded raw stdout forever
- redesigning all session transcript rendering in one step

## Risks / Notes

- some tool output can be noisy; we should summarize by default and expand on demand
- event ordering/race conditions need careful handling when stream chunks and tool completions interleave
- we should prefer additive event types over breaking existing transcript parsing all at once
