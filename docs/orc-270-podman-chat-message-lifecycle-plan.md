# ORC-270 — Podman chat message lifecycle coverage plan

## tl;dr
- Current podman desktop coverage only proves basic chat/session round-trips and adjacent session controls.
- The biggest unprotected regressions are multi-send ordering, assistant pending-placeholder resolution, failure/interruption cleanup, and refresh/reopen state correctness.
- The likely product fix is to replace the client’s single pending-run-per-session model with an ordered per-session pending-run queue, then add a focused podman lifecycle spec with DOM + backend diagnostics.

## Executive summary
Browser-mock coverage already exercises several message-lifecycle behaviors, but current podman desktop coverage does not. The frontend currently tracks only one `PendingSessionRun` per session (`src/App.tsx`, `src/lib/sessionTranscriptReducer.ts`) even though backend send logic explicitly supports `follow_up` delivery while a prior prompt is still active (`src-tauri/src/commands/sessions.rs`). That mismatch is the strongest likely cause of out-of-order rows, stale pending indicators, and weak multi-send behavior. Implementation should add a dedicated podman desktop lifecycle spec, strengthen transcript/state instrumentation, and fix the pending-run model until the new suite passes reliably.

## What podman coverage exists today

### Real desktop/podman coverage already present
- `tests/desktop-e2e/packaged-runtime-smoke.test.ts`
  - proves bundled runtime wiring and can optionally wait for one assistant reply in the backend record.
- `tests/desktop-e2e/session-controls.test.ts`
  - sends one real message, waits for idle, then exercises compact/new/reload.
- `tests/desktop-e2e/chat-nav.test.ts`
  - sends one supervisor chat message and checks chat-nav/session-nav behavior.
- `tests/desktop-e2e/session-transcript.test.ts`
  - checks fold/copy transcript rendering only.
- `tests/desktop-e2e/bridge-diagnostics.test.ts`
  - sends one message and checks diagnostics/logging.
- `tests/desktop-e2e/lane-approval.test.ts`
  - proves a paused worker session can receive a direct message after unsubscribe, but does not assert transcript lifecycle.

### Browser/mock coverage that already exists but is not podman-backed
- `tests/e2e/sessions.spec.ts`
  - simple send → reply
  - multiple sends while earlier work is pending
  - stop/interruption behavior
  - thinking/tool streaming updates
  - rejoin/refresh behaviors

## Audit: missing or weak cases
- No podman test currently asserts transcript row order across more than one send.
- No podman test asserts assistant pending placeholder creation and later resolution.
- No podman test asserts pending badges/statuses clear after stop/error paths.
- No podman test asserts send-while-pending / follow-up behavior beyond “the UI still accepts input” in browser mock mode.
- No podman test compares DOM transcript order/state against backend session-record state.
- No podman test reopens or refreshes a settled multi-message session and re-validates order + no-stale-pending state.
- Existing desktop assertions are light on per-event diagnostics; failures will be hard to triage if order/pending drift regresses again.

## Likely regression points

### 1. Single pending run per session is too weak for sequential/follow-up sends
- `src/App.tsx` stores `pendingRuns` as `Record<string, PendingSessionRun>`.
- `src/lib/sessionTranscriptReducer.ts` operates on a single `pendingRun`.
- Backend send logic supports `follow_up` delivery while a prior prompt is still active.

That means the client can represent only one in-flight run per session even though the runtime can accept more than one queued message. This is the most likely root cause for:
- out-of-order rendering
- stale/stuck pending state
- incorrect status when a later send supersedes an earlier optimistic run

### 2. Pending placeholder settlement depends on stream/final refresh sequencing
The frontend clears optimistic state only when stream reduction settles the run or when the backend refresh after `agent_end` replaces it. If either path is incomplete or late, the UI can keep a stale pending assistant row even though the backend session is already settled.

### 3. Transcript instrumentation is not specific enough for lifecycle assertions
`TranscriptEventCard` exposes event id/kind, but not run id or explicit pending/thinking data attributes. That makes loud, targeted desktop assertions harder than they need to be.

## Intended message-state model to assert
For each user send/run, the implementation lane should lock down this model explicitly:

1. **queued**
   - optimistic user row exists
   - user row is `pending=true`
   - session display status shows streaming/in-progress
2. **accepted**
   - user row clears `pending`
   - assistant placeholder may not exist yet
3. **assistant pending / thinking / streaming**
   - exactly one assistant row for that run is the active placeholder
   - assistant row remains `pending=true` until settlement
   - `thinking=true` only while the visible state is thought-only
   - tool composition/execution rows may be separate system rows, but they must not reorder the user row behind later sends
4. **completed**
   - pending assistant placeholder resolves into the final assistant row
   - no stale pending badge remains for that run
   - session status returns to idle if no later run is still active
5. **interrupted / failed**
   - optimistic pending state for that run is removed or converted into a settled error/interruption outcome
   - no orphaned pending assistant row remains
   - session status reflects paused/failed appropriately
6. **refresh / reopen**
   - settled transcript order is preserved
   - no previously settled run regains pending state

## Recommended implementation approach

### A. Add a focused podman desktop lifecycle spec
Prefer a dedicated file such as:
- `tests/desktop-e2e/session-message-lifecycle.test.ts`

Recommended scenarios:
1. simple send → assistant reply
2. two sequential sends with distinct exact-token prompts; assert final user/assistant order
3. second send while the first response is still pending; assert both sends remain visible and settle cleanly in order
4. pending assistant placeholder appears, then resolves without leaving a stale pending badge
5. interruption/failure cleanup
   - operator stop during a long response
   - if deterministic in podman, one explicit send failure path as well
6. refresh/reopen after multiple settled turns; assert same order and no stale pending state

### B. Strengthen diagnostics/helpers first
Extract reusable helpers for:
- transcript DOM snapshots with event order/kind/text/pending state
- backend session-record snapshots with recent events/status/logs
- “wait until run settled” polling that dumps DOM + backend diagnostics on failure

Likely helper touchpoints:
- `tests/desktop-e2e/session-controls.test.ts` diagnostics helpers
- shared desktop test helpers near `tests/desktop-e2e/driver.ts`

### C. Fix the product model where the new scenarios expose drift
Primary expected code touchpoints:
- `src/App.tsx`
- `src/lib/sessionTranscriptReducer.ts`
- `src/lib/sessionListMerge.ts`
- `src/components/TranscriptEventCard.tsx`
- possibly `src/components/SessionChatPanel.tsx`
- possibly session/runtime plumbing in `src-tauri/src/commands/sessions.rs` or `src-tauri/src/services/live_sessions.rs`

Expected direction:
- move from one pending run per session to ordered per-session pending runs keyed by run id
- make settlement/removal target a specific run instead of replacing session-wide optimistic state
- expose enough event metadata in the DOM to assert ordering/pending state directly

## Supporting lower-level coverage to add
- `tests/sessionTranscriptReducer.test.ts`
  - multiple pending/follow-up sends
  - stop/error cleanup
  - placeholder resolution ordering
- `tests/sessionListMerge.test.ts`
  - preserve runtime state while more than one pending run exists

## Verification commands for the implementation lane
- focused podman run for the new lifecycle spec:
  - `./scripts/run-desktop-e2e-podman.sh tests/desktop-e2e/session-message-lifecycle.test.ts`
- targeted regressions around adjacent session behavior:
  - `./scripts/run-desktop-e2e-podman.sh tests/desktop-e2e/session-controls.test.ts`
  - `./scripts/run-desktop-e2e-podman.sh tests/desktop-e2e/chat-nav.test.ts`
- final podman suite subset or full suite:
  - `./scripts/run-desktop-e2e-suite-podman.sh`

## Files most likely to change
- `src/App.tsx`
- `src/lib/sessionTranscriptReducer.ts`
- `src/lib/sessionListMerge.ts`
- `src/components/TranscriptEventCard.tsx`
- `src/components/SessionChatPanel.tsx`
- `src-tauri/src/commands/sessions.rs`
- `src-tauri/src/services/live_sessions.rs`
- `tests/desktop-e2e/session-message-lifecycle.test.ts` (new)
- `tests/sessionTranscriptReducer.test.ts`
- `tests/sessionListMerge.test.ts`

## Handoff guidance
Treat this as a diagnose-first regression task, not just a test-addition task:
1. land the shared diagnostics/helpers first
2. reproduce the multi-send/pending-state failures in podman
3. fix the client pending-run model until the new podman lifecycle spec passes
4. only then widen to refresh/reopen and final suite validation
