# ORC-286 — Podman queue vs interrupt send regression coverage plan

## tl;dr
- Current coverage is split across two places:
  - browser-mock specs click the Queue/Interrupt UI, but those specs are not part of the supported Podman browser suite.
  - supported desktop Podman specs prove busy-session `follow_up` vs `steer` behavior, but the strongest interrupt-ordering test injects `send_session_message` directly instead of using the visible send-options UI.
- Result: we do **not** currently have one supported desktop Podman regression that proves the real composer’s Queue vs Interrupt controls are wired to the correct live-runtime semantics end to end.
- Recommended change: strengthen `tests/desktop-e2e/session-message-lifecycle.test.ts` so it drives the actual send-options UI during an active run and asserts transcript, backend log, and persisted session-record ordering.
- Keep the existing backend/unit coverage; only change product code if the new UI-driven Podman regression exposes a mismatch.

## Executive summary
The runtime plumbing itself looks correct today. `src-tauri/src/commands/sessions.rs` resolves busy-session delivery as `follow_up` for default/queue and `steer` for interrupt, and it already has a unit test covering that matrix. The main gap is the supported end-to-end seam from the desktop send-options UI into the real runtime.

Today, the only tests that actually click the send-options menu live in `tests/e2e/*.spec.ts`, and the relevant browser sessions spec is quarantined out of the supported Podman browser suite. The supported desktop Podman suite does include strong session lifecycle coverage, but its explicit queue-vs-interrupt ordering regression bypasses the UI by calling `invokeCommand("send_session_message")` directly. That means we currently prove backend semantics and UI affordances separately, but not together on the supported desktop Podman path.

Implementation should therefore start by upgrading the desktop lifecycle regression to use the real UI and assert observable outcomes. If that new coverage fails, then the developer lane should fix the broken send-mode plumbing before landing the test.

## Audit findings
- Runtime mapping already exists in `src-tauri/src/commands/sessions.rs`:
  - idle + default/queue/interrupt => `prompt`
  - busy + default/queue => `follow_up`
  - busy + interrupt => `steer`
- Lower-level backend coverage already exists:
  - `src-tauri/src/commands/sessions.rs` has `resolves_session_delivery_mode_matrix()`.
- Supported desktop Podman coverage already includes relevant session specs because `tests/e2e-suite.json` includes all `tests/desktop-e2e/*.test.ts` with no desktop quarantine.
- Current supported desktop findings:
  - `tests/desktop-e2e/session-controls.test.ts` already proves a normal busy-session send queues as `follow_up` and does not duplicate the user row.
  - `tests/desktop-e2e/session-message-lifecycle.test.ts` already proves `steer` is delivered ahead of queued `follow_up` work after the current tool turn finishes.
  - But that explicit queue/interrupt test currently uses `invokeCommand("send_session_message", { sendMode })` instead of `[data-role="session-send-options-trigger"]` and the Queue/Interrupt menu buttons.
- Current UI-menu coverage exists only in browser/mock specs:
  - `tests/e2e/chat.spec.ts`
  - `tests/e2e/sessions.spec.ts`
  - quick-chat interrupt smoke in `tests/e2e/sessions.spec.ts`
- That browser coverage is useful, but it is not sufficient for this task because the supported browser sessions spec is quarantined from the Podman suite.

## Recommended implementation

### 1. Strengthen the desktop lifecycle regression
Update `tests/desktop-e2e/session-message-lifecycle.test.ts` so the queue-vs-interrupt scenario uses the real send-options UI while a live session is busy.

Recommended flow:
1. Create a real desktop session.
2. Send a long-running first prompt that forces one tool turn (`sleep 8` style pattern already used in the spec).
3. While the first turn is still active:
   - enter the queued prompt,
   - open `[data-role="session-send-options-trigger"]`,
   - click `[data-role="session-send-mode-queue"]`.
4. Assert:
   - the queued user message appears while the first turn is still pending,
   - backend logs `sessions.message.follow_up`,
   - the active turn continues rather than being cut off.
5. While the first turn is still active:
   - enter the interrupt prompt,
   - reopen the send-options menu,
   - click `[data-role="session-send-mode-interrupt"]`.
6. Assert:
   - backend logs `sessions.message.steer`,
   - the current tool turn is still allowed to finish,
   - after settling, persisted ordering is: initial tool result, then interrupt reply, then queued reply.
7. Final settled assertions should check:
   - transcript order,
   - persisted session-record order,
   - cleared pending state.

### 2. Keep the existing lower-level coverage
- Keep the delivery-mode matrix unit test.
- Keep any direct-command desktop assertions only if they still add isolated backend value, but do not leave them as the only supported queue-vs-interrupt regression.

### 3. Only fix product code if the new Podman spec fails
If the UI-driven desktop regression exposes a mismatch, inspect these plumbing points first:
- `src/components/SessionSendControls.tsx`
- `src/components/SessionChatPanel.tsx`
- `src/App.tsx`
- `src/lib/orchestraClient/tauriBindings.ts`
- `src-tauri/src/commands/sessions.rs`

Most likely failure classes are:
- UI not passing the intended `sendMode`,
- binding/remoting layer dropping `sendMode`,
- backend resolving busy state incorrectly.

### 4. Determinism fallback if needed
Prefer to keep at least one real-runtime Podman proof because this task is specifically about true interrupt behavior in practice. If that run proves too flaky, add a dedicated fake Pi fixture that distinguishes `prompt`, `follow_up`, and `steer` ordering deterministically — but only as a supplement, not a full replacement, if the real-runtime check remains feasible.

## Validation plan
- `./scripts/run-desktop-e2e-podman.sh tests/desktop-e2e/session-message-lifecycle.test.ts`
- Re-run `tests/desktop-e2e/session-controls.test.ts` if it still owns the default busy-send regression.
- Final confidence pass through the supported Podman path:
  - `./scripts/run-desktop-e2e-suite-podman.sh tests/desktop-e2e/session-message-lifecycle.test.ts tests/desktop-e2e/session-controls.test.ts`
  - or broader `npm run test:e2e:desktop` if the implementation touches shared send plumbing.

## File touch list
- `tests/desktop-e2e/session-message-lifecycle.test.ts`
- maybe `tests/desktop-e2e/session-controls.test.ts`
- only if a bug is exposed:
  - `src/components/SessionSendControls.tsx`
  - `src/components/SessionChatPanel.tsx`
  - `src/App.tsx`
  - `src/lib/orchestraClient/tauriBindings.ts`
  - `src-tauri/src/commands/sessions.rs`

## Guardrails
- Do not reinterpret interrupt as a hard runtime stop; the intended behavior is steering priority after the current turn/tool completes.
- Do not rely on browser-mock UI specs as the sole acceptance proof for this task.
- Do not accept a regression that only proves a menu click happened; require transcript/session-record ordering and busy-state semantics.
