# ORC-301 — idle/stale session pending-send recovery plan

## tl;dr
- The most likely root cause is a gap between **“prompt command accepted”** and **“run actually began streaming”**: idle/stale runtimes can acknowledge a `prompt`, while the frontend keeps the optimistic pending row forever because no stream activity ever arrives.
- Backend already has a watchdog for **queued non-prompt deliveries**, but not for the initial **prompt delivery** that starts an idle session.
- Fix the runtime layer first: detect an accepted prompt that never starts, clear the active-run bookkeeping, tear down the stale runtime, and emit a `delivery_error`/refresh so the UI recovers without requiring `Stop`.
- Add a dedicated fake-Pi desktop regression and run it through the supported Podman desktop path.

## Executive summary
I audited the send/pending flow across the shared client and the live runtime.

The strongest diagnosis is:

1. `src/App.tsx` adds an optimistic pending run immediately when the user sends.
2. `src-tauri/src/commands/sessions.rs` marks the session run active before any model output exists.
3. `src-tauri/src/services/live_sessions.rs` only times out **queued** follow-up deliveries (`spawn_queued_delivery_watchdog(...)`), not the initial idle-session `prompt` delivery.
4. If an older runtime accepts the `prompt` RPC command but never emits `agent_start`/stream activity, nothing clears the optimistic pending state until the operator presses `Stop`.
5. The UI already has the right settlement path once a `delivery_error` is emitted (`src/lib/sessionTranscriptReducer.ts`).

That means the fix should be centered on the runtime/session layer, not just frontend cosmetics. A client-only patch could hide the pending row while still leaving Orchestra’s backend run state wedged; `Stop` currently works because it clears that backend state. The real recovery path should do the same automatically when the accepted prompt never actually starts.

## Confirmed likely fault line

### Frontend behavior today
- `src/App.tsx`
  - `queueSessionMessage(...)` creates a pending optimistic run before `sendMessage(...)` settles.
  - That pending state is only removed when:
    - the send request rejects immediately, or
    - later stream/reducer events settle the run.
- If the send request succeeds but no stream events ever arrive, the optimistic row can sit indefinitely.

### Backend behavior today
- `src-tauri/src/commands/sessions.rs`
  - `send_session_message_with_optional_run_id(...)` calls `begin_session_run(...)` and then `runtime.start_delivery(...)`.
- `src-tauri/src/services/live_sessions.rs`
  - `start_delivery(...)` activates `prompt` deliveries immediately and returns success once the RPC command is accepted.
  - `spawn_queued_delivery_watchdog(...)` only covers queued `steer` / `follow_up` deliveries.
  - There is no equivalent watchdog for the first accepted `prompt` on an idle session.

### Existing recovery path we should reuse
- `src/lib/sessionTranscriptReducer.ts`
  - `delivery_error` already clears optimistic rows and surfaces an actionable send failure.
- `tests/sessionTranscriptReducer.test.ts`
  - already proves the `delivery_error` reducer path works.

## Why immediate send-time detection is not sufficient
Yes — the backend should detect this failure mode. The reason I am proposing a watchdog instead of only a synchronous send-time check is that the bad state appears to be **post-acceptance**, not just **pre-send invalidity**.

What the backend can already detect synchronously on send:
- no runtime / failed respawn
- closed stdin / broken transport
- immediate RPC command failure

Those cases already fail the send request directly and do **not** create the “pending forever until Stop” symptom.

The bug we are targeting is narrower:
1. Orchestra successfully begins the run bookkeeping.
2. The runtime successfully accepts the `prompt` RPC command.
3. The session then never emits `agent_start` or any other stream activity.

At that point, a pure send-time validity check has already passed. The backend therefore still needs a **post-send liveness check** that says “this run was accepted, but it never actually started.”

So the intended direction is:
- keep ordinary send-time validation/failure behavior as-is
- add backend detection for the accepted-but-never-started case
- recover automatically by clearing the wedged run and resetting the stale runtime

## Recommended implementation

### 1. Add an accepted-prompt start watchdog in `live_sessions.rs`
Extend the runtime so an accepted active delivery can be distinguished from one that has actually begun processing.

Recommended direction:
- track active delivery acceptance metadata for the current run
- mark that active delivery as “started” on the first real stream activity for the run
- start a watchdog for initial `prompt` deliveries, not just queued deliveries
- if the same run is still active after the timeout and still has no activity:
  - clear `current_run_id` / prompt message state
  - clear the app-level active session run bookkeeping
  - emit a `delivery_error`
  - tear down the stale runtime so the next send respawns cleanly
  - emit a session-change refresh signal so the authoritative record returns to a non-stuck state

Important nuance: this should be treated as **“accepted but never started”**, not as a normal in-flight run failure. It should not require `Stop`, and it should avoid incorrectly failing unrelated task/workflow ownership state when the message never actually started processing.

### 2. Keep the user-facing result recoverable without manual Stop
The post-timeout state should be:
- no stuck pending transcript row
- no wedged active session run bookkeeping
- runtime reset/retired so resend works immediately
- an actionable message telling the user to retry/resend, without instructing them to press `Stop`

This likely means updating the current timeout copy away from the existing queued-delivery wording (`"Stop the session and retry."`) if the runtime is now auto-reset for them.

### 3. Only add frontend glue if the backend signal is still insufficient
The reducer already knows how to handle `delivery_error`, so frontend changes should stay small unless testing shows a second gap.

Most likely frontend touchpoints, if needed:
- `src/lib/sessionTranscriptReducer.ts`
  - adjust timeout copy and/or resulting session status fields
- `src/App.tsx`
  - only if we need an explicit session record refresh after `delivery_error`

## Regression strategy

### Use a dedicated fake Pi fixture
A real idle-timeout reproduction is too slow and flaky for the supported suite. The deterministic regression should simulate the exact bad contract instead:

- new fixture, e.g. `tests/desktop-e2e/fixtures/fake-pi-stale-prompt-fixture.mjs`
- behavior:
  - first `prompt` command for a session returns RPC success but emits no stream activity
  - after Orchestra times the run out and tears the runtime down, the next spawned fixture instance behaves normally
  - second send replies deterministically with a known token

This directly reproduces the dangerous state: **send accepted, no activity, pending would hang forever without the fix**.

### Add a dedicated desktop spec
Prefer a new file instead of extending the real-model lifecycle spec, so the runner can switch Pi executables per-file.

Suggested file:
- `tests/desktop-e2e/session-idle-send-recovery.test.ts`

Suggested assertions:
1. create/open a session
2. send message #1
3. observe optimistic pending state appear
4. wait for the watchdog recovery
5. assert:
   - pending UI clears without pressing `Stop`
   - a send-failed/system message appears
   - the composer remains usable
   - the session is no longer stuck in an in-progress state
6. resend message #2 on the same session
7. assert the second message succeeds on the respawned runtime
8. optionally assert logs contain the timeout/teardown markers

### Wire the fixture into the supported runner
- update `scripts/run-desktop-e2e.sh` with a file-specific fake-fixture mapping, similar to the existing auth-error and resume-continuation fixtures
- if the watchdog timeout needs to stay conservative in production, add a test-only env override so the dedicated Podman regression does not spend ~90s waiting

## Validation
Minimum implementation-lane validation should be:
- targeted unit coverage for any reducer/helper changes
  - likely `tests/sessionTranscriptReducer.test.ts`
- targeted desktop Podman regression
  - `./scripts/run-desktop-e2e-podman.sh tests/desktop-e2e/session-idle-send-recovery.test.ts`
- adjacent session lifecycle regression to ensure normal message flow still works
  - `./scripts/run-desktop-e2e-podman.sh tests/desktop-e2e/session-message-lifecycle.test.ts`

If the fix touches shared send/recovery state more broadly, also run the affected desktop subset or suite.

## Likely file touch list
- `src-tauri/src/services/live_sessions.rs`
- `src-tauri/src/commands/sessions.rs` (only if helper boundaries move)
- `src/lib/sessionTranscriptReducer.ts`
- `src/App.tsx` (only if explicit frontend refresh is still needed)
- `tests/sessionTranscriptReducer.test.ts`
- `tests/desktop-e2e/session-idle-send-recovery.test.ts`
- `tests/desktop-e2e/fixtures/fake-pi-stale-prompt-fixture.mjs`
- `scripts/run-desktop-e2e.sh`

## Expected handoff
Implementation notes should explicitly call out:
- the exact accepted-but-never-started runtime gap
- why backend recovery is required instead of a frontend-only pending-row cleanup
- whether the fix auto-resets the runtime, auto-retries, or fails-fast for resend
- the exact Podman desktop command(s) that now protect the regression

## Implemented outcome
The landed implementation follows the plan with one small generalization: the runtime now tracks **accepted active deliveries** (not just prompts) so it can tell the difference between:
- accepted but still waiting in the queue
- accepted and promoted active but never started
- accepted and clearly started because real stream activity arrived

What shipped:
- `src-tauri/src/services/live_sessions.rs`
  - tracks active-delivery acceptance metadata
  - marks the active delivery started on first non-response runtime event
  - times out accepted-but-never-started active deliveries
  - clears active-run bookkeeping, emits `delivery_error`, tears down the stale runtime, and emits `session.change`
- `src/lib/sessionTranscriptReducer.ts`
  - uses updated copy that tells the user Orchestra reset the stale runtime and they can retry, instead of telling them to press `Stop`
- `tests/desktop-e2e/fixtures/fake-pi-stale-prompt-fixture.mjs`
  - deterministically simulates the bad contract by ACKing the first prompt and then emitting no activity at all
  - persists that first stalled-send state outside the runtime process so the respawned runtime can answer the retry normally
- `tests/desktop-e2e/session-idle-send-recovery.test.ts`
  - proves the first send clears without `Stop`
  - proves the composer stays usable
  - proves the second send succeeds on the respawned runtime
- `scripts/run-desktop-e2e.sh`
  - wires the stale-prompt fixture to that test file
  - applies the test-only `ORCHESTRA_SESSION_DELIVERY_START_TIMEOUT_MS=2500` override so the supported regression runs quickly without shrinking the production timeout

Validation completed:
- `cargo test --manifest-path src-tauri/Cargo.toml live_sessions:: -- --nocapture`
- `npx vitest run tests/sessionTranscriptReducer.test.ts`
- `./scripts/run-desktop-e2e-podman.sh tests/desktop-e2e/session-idle-send-recovery.test.ts`
- `./scripts/run-desktop-e2e-podman.sh tests/desktop-e2e/session-message-lifecycle.test.ts`
