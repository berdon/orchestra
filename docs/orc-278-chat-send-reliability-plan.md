# ORC-278 — Chat send reliability and real-model multi-message regression plan

## tl;dr
- The send path already waits for an RPC acknowledgement, so this is not a pure fire-and-forget transport bug.
- The fragile part is Orchestra’s runtime-side delivery bookkeeping: only the currently active prompt has a durable run identity, while queued `follow_up` / `steer` deliveries do not.
- That mismatch can leave the UI with optimistic sends that never transition cleanly into observable processing, especially after stale busy state or multiple queued sends.
- Fix this by giving the runtime an Orchestra-owned per-session delivery ledger, promoting queued deliveries into the active run slot deterministically, and surfacing an explicit stuck-send error when a send is accepted but no progress follows.
- Lock the fix with a repo-managed desktop Podman regression that uses a real configured model and sends multiple messages through the same session, expecting a response for each.

## Executive summary
The current code already verifies transport-level acceptance when sending a session message: `src-tauri/src/services/live_sessions.rs` writes the RPC command, waits for a response, and `send_session_message` only returns success once that response arrives. The intermittent “send does nothing until Stop is pressed” symptom therefore points higher up the stack: Orchestra can accept a send locally while still failing to move that send into a clearly tracked processing lifecycle.

The main weakness is that runtime bookkeeping is still centered on a single `current_run_id`. Prompt deliveries claim that slot, but queued `follow_up` and `steer` deliveries do not get their own durable runtime-tracked run identity. Stream envelopes are emitted with `runId = current_run_id`, so queued work is either attributed to the active prompt or later emitted with `runId: null`. The frontend reducer and optimistic-pending reconciliation depend heavily on stable run ids, with only a best-effort single-pending-run fallback when `runId` is missing.

That leaves two likely user-visible failure modes:
1. a stale busy/runtime state can coerce an ordinary send into a backend `follow_up`, which then appears to do nothing until Stop resets the runtime, and
2. multiple queued sends can lose run attribution, causing optimistic rows to drift, settle late, or appear as no-ops.

The implementation lane should therefore treat this as a delivery-lifecycle/state-accounting bug, not just a UI polish issue. The primary fix is a runtime-owned queued-delivery ledger plus a send-progress watchdog. The regression coverage should be a real-model Podman desktop test that sends multiple messages through one session and requires a response for each.

## Current code findings

### 1. Transport-level send acknowledgement already exists
- `src-tauri/src/services/live_sessions.rs::send_command(...)`
  - writes the RPC command to Pi stdin
  - waits for a matching RPC response with `recv_timeout(...)`
- `src-tauri/src/commands/sessions.rs::send_session_message_with_optional_run_id(...)`
  - only returns `QueuedSessionMessage` after `runtime.start_delivery(...)` succeeds

So the current code does check for a transport/RPC acknowledgement. The missing guarantee is not “did the runtime receive the command?” but “did this accepted send become an observable, correctly tracked session turn?”

### 2. Busy/idle resolution is driven by a single active prompt slot
- `src-tauri/src/commands/sessions.rs::send_session_message_with_optional_run_id(...)`
  - uses `AppState::begin_session_run(...)`
  - then consults `runtime.has_active_prompt()`
  - resolves delivery mode with `resolve_session_delivery_mode(...)`
- `src-tauri/src/services/live_sessions.rs`
  - stores only one `current_run_id`
  - `has_active_prompt()` is just `current_run_id.is_some()`

This means default send semantics depend on whether Orchestra believes one prompt is still active, not on a richer queue model.

### 3. Queued deliveries do not own a stable runtime run identity
- `src-tauri/src/services/live_sessions.rs::start_delivery(...)`
  - `prompt` sets `current_run_id`
  - `follow_up` and `steer` do not
- `src-tauri/src/services/live_sessions.rs::emit_stream_event(...)`
  - emits `SessionStreamEnvelope { run_id: self.current_run_id(), ... }`

That means:
- while a prompt is active, queued follow-up/interrupt traffic is attributed to the active prompt’s run id
- after the active prompt ends, later queued-turn events can arrive with `runId: null`

This is the strongest root-cause candidate for silent or confusing send behavior.

### 4. The frontend’s optimistic reconciliation still depends on stable run ids
- `src/App.tsx::handleSessionStreamEvent(...)`
  - looks up pending runs by `payload.runId`
  - only falls back to “the sole pending run” when exactly one optimistic run remains
- `src/lib/sessionTranscriptReducer.ts`
  - reduces stream events around a single run id at a time
  - synthesizes a client id when stream payloads have no run id
- `src/lib/sessionTranscriptReducer.ts::reconcilePendingRunsWithSession(...)`
  - drops optimistic rows only when authoritative backend rows can be matched by run id or message/timestamp heuristics

This is good enough for one active run plus one fallback case, but it is too weak for “accepted send must always become visible and attributable.”

### 5. Existing coverage is close, but not targeted enough for this task
Existing desktop coverage already helps:
- `tests/desktop-e2e/session-message-lifecycle.test.ts`
- `tests/desktop-e2e/session-controls.test.ts`
- `tests/sessionTranscriptReducer.test.ts`

These protect several multi-send and pending-state paths, but they do not yet give this task exactly what it asked for:
- an explicit real-model Podman regression that sends multiple messages to one session and expects a response for each
- a send-reliability/stuck-send assertion that fails loudly when a send is accepted but never transitions into observable work

## Likely failure modes behind the reported symptom

### A. Stale busy state downgrades a normal send into an invisible follow-up
If Orchestra still thinks a prompt is active, `resolve_session_delivery_mode(...)` will convert default send into `follow_up`. If the runtime is effectively idle or stuck, that accepted follow-up can appear to do nothing. Pressing Stop resets runtime state, so the resend becomes a fresh prompt and appears to work again.

### B. Multiple queued sends lose attribution once more than one optimistic run is pending
Because queued deliveries do not own a stable runtime run id, later stream events may arrive with the wrong run id or no run id at all. The current frontend fallback only safely handles the single-pending-run case. Once there are two or more pending sends, reliable matching becomes heuristic and fragile.

### C. Accepted sends can remain silent when no progress event follows
The current flow treats RPC send acknowledgement as success, but it does not enforce “this accepted send produced visible transcript or backend progress within a bounded time.” That is why the UX can degrade into an apparent no-op instead of a crisp error.

## Recommended implementation approach

### 1. Add a runtime-owned per-session delivery ledger
Introduce explicit Orchestra-side delivery tracking in `src-tauri/src/services/live_sessions.rs`.

Recommended model per session runtime:
- `active_delivery`: `{ runId, deliveryMode, message, acceptedAt, state } | null`
- `queued_deliveries`: ordered list of the same shape

Rules:
- `prompt` while idle => becomes `active_delivery`
- `queue/default while busy` => append as queued follow-up
- `interrupt while busy` => insert ahead of queued follow-ups, but behind the currently executing delivery

Why this matters:
- accepted sends stay represented even before Pi starts the next turn
- stream event attribution can be driven by Orchestra’s own delivery ledger instead of one mutable `current_run_id`
- busy/idle logic stops collapsing “one active prompt” and “several accepted but not yet active deliveries” into the same weak state

### 2. Promote queued deliveries deterministically across turn boundaries
On `agent_end` / equivalent active-turn completion:
- if queued deliveries remain, promote the next queued delivery into `active_delivery`
- keep emitting the promoted delivery’s run id on subsequent stream envelopes
- only clear the session’s active-run bookkeeping once both the active slot and queued-delivery ledger are empty

This should replace the current model where `agent_end` simply clears `current_run_id` and hopes the frontend can infer what queued turn comes next.

### 3. Emit stream envelopes from the active delivery, not just the old prompt slot
Update `emit_stream_event(...)` so `SessionStreamEnvelope.runId` resolves from the promoted `active_delivery` record.

Goal:
- every stream event for an accepted user send is attributed to that send’s Orchestra run id
- frontend optimistic rows settle against durable identifiers instead of fallback heuristics

### 4. Add a stuck-send watchdog and actionable error path
A send should not be allowed to stay silently “accepted” forever.

Recommended behavior:
- when a delivery is accepted, start a watchdog timer
- consider the delivery as having made progress once one of these occurs:
  - stream activity begins for that run
  - the backend session record contains the user event for that send
  - the delivery is explicitly promoted into active processing
- if no progress appears within a bounded grace period:
  - refresh the session record/runtime snapshot once
  - if still no evidence exists, fail that optimistic delivery visibly
  - surface an actionable error such as “Message was accepted but the session did not begin processing. Stop the session and retry.”

This directly answers the task requirement to either transition into processing or surface an actionable error.

### 5. Keep the frontend optimistic model, but harden it around explicit delivery states
Frontend changes should stay incremental:
- keep optimistic user rows immediately on send
- keep them until authoritative backend evidence or explicit failure settles them
- prefer backend-provided/stable run ids over heuristic matching
- treat missing run ids as exceptional once the runtime ledger lands

Primary frontend touchpoints:
- `src/App.tsx`
- `src/lib/sessionTranscriptReducer.ts`
- possibly `src/components/SessionChatPanel.tsx` / send-error copy surfaces

### 6. Strengthen diagnostics and logs for send lifecycle debugging
Recommended additions:
- include resolved `deliveryMode` in `QueuedSessionMessage`
- add structured logs for:
  - accepted send
  - queued position / promoted delivery
  - first observed progress
  - watchdog timeout / forced failure
- optionally expose lightweight DOM/test diagnostics for per-run send state

This will make future no-op reports much easier to triage than today’s “send succeeded but nothing happened” symptom.

## Regression coverage plan

### A. Backend/unit coverage
Add focused tests around the runtime/send ledger:
- `src-tauri/src/commands/sessions.rs`
  - delivery-mode resolution already exists; extend around stale-busy recovery and queued promotion behavior
- `src-tauri/src/services/live_sessions.rs`
  - queued follow-up promotion
  - interrupt priority over queued follow-ups
  - clearing/failing queued deliveries on process end / stop
  - watchdog timeout path

### B. Frontend/unit coverage
Extend existing reducer coverage in:
- `tests/sessionTranscriptReducer.test.ts`

Add cases for:
- multiple queued sends with stable run ids
- queued-send promotion after prior `agent_end`
- missing-progress timeout converting optimistic rows into explicit failure
- no duplicate or orphaned optimistic rows after refresh

### C. Desktop Podman regression using a real model
Use the existing desktop Podman harness and extend `tests/desktop-e2e/session-message-lifecycle.test.ts` (or add a dedicated sibling spec) with a real-model path that:
1. creates a fresh session
2. sends multiple exact-token prompts through the same session
3. expects a distinct assistant response for each prompt
4. verifies final transcript/backend ordering and zero stale pending rows

Minimum scenario:
- send message A
- wait until the session shows active processing
- send message B
- wait for both responses
- optionally send message C to cover `>1` queued delivery if the harness/runtime timing supports it deterministically

Important harness requirement:
- this regression should run only when Orchestra-managed `auth.json` and `models.json` are available in the Podman test home
- follow the same fixture/import pattern already used by the desktop runner and packaged-runtime validation flow, rather than swapping in a fake Pi executable

### D. Optional explicit stuck-send regression
If the implementation introduces a watchdog surface that can be deterministically exercised, add one more desktop spec that verifies the user sees a concrete error instead of a silent no-op when the accepted send never progresses.

## Suggested file touch list
- `src-tauri/src/services/live_sessions.rs`
- `src-tauri/src/commands/sessions.rs`
- `src-tauri/src/state.rs`
- `src-tauri/src/models.rs`
- `src/types.ts`
- `src/App.tsx`
- `src/lib/sessionTranscriptReducer.ts`
- `tests/sessionTranscriptReducer.test.ts`
- `tests/desktop-e2e/session-message-lifecycle.test.ts`
- possibly `scripts/run-desktop-e2e.sh` if the real-model regression needs an explicit opt-in/fail-fast env contract

## Verification targets for the implementation lane
- focused reducer/unit coverage:
  - `npm test -- sessionTranscriptReducer`
- focused desktop Podman regression:
  - `./scripts/run-desktop-e2e-podman.sh tests/desktop-e2e/session-message-lifecycle.test.ts`
- if a dedicated real-model env gate is added, run the same command with that env enabled and valid managed auth/model config present
- adjacent desktop regressions:
  - `./scripts/run-desktop-e2e-podman.sh tests/desktop-e2e/session-controls.test.ts`
  - `./scripts/run-desktop-e2e-podman.sh tests/desktop-e2e/chat-nav.test.ts`

## Recommended implementation sequencing
1. land backend delivery-ledger bookkeeping first
2. wire stream envelope run attribution to the promoted active delivery
3. update frontend optimistic reconciliation to trust that stable run attribution
4. add the stuck-send watchdog/error surface
5. extend unit coverage
6. add the real-model Podman multi-message regression
7. run adjacent desktop regressions

## Handoff guidance
This task should be implemented as a reliability/state-model correction, not just as an extra test. The implementation is done only when:
- an accepted send always becomes either visible processing or an explicit actionable error
- queued sends have stable lifecycle attribution across turn boundaries
- the real-model Podman regression proves multiple messages in one session each receive a response
- Stop/resend is no longer the practical recovery path for a silently accepted send
