# ORC-273 — Chat/session send steering plan

## tl;dr
- Keep the primary Send action and Ctrl/⌘+Enter mapped to today’s default behavior.
- Add a visible composite Send control with a primary left segment and a send-options right segment; do not rely on long-press as the only affordance.
- Expose one-shot `Queue` and `Interrupt` send actions in the shared chat/session composers.
- Extend session send plumbing so the UI can explicitly request default vs queue vs interrupt delivery.
- Add browser + desktop regression coverage for default send, menu open, queue, interrupt, and resulting delivery behavior.

## Executive summary
The cleanest product change is a composite send affordance. The main Send action should remain the current/default path, while a compact right-side segment on the same control opens a menu for alternate delivery modes. That keeps ordinary send unchanged, makes alternate steering discoverable on desktop and mobile, avoids sticky-mode surprises, and keeps the control from visually wrapping into a separate second button. Long-press can open the same menu as an accelerator if it proves low-risk, but it should not be the primary or only UX because it is weak for discoverability, keyboard users, and accessibility.

Backend support is already close: `send_session_message` currently preserves default Orchestra behavior by sending a `prompt` when idle and auto-queueing a `follow_up` when the session is already active, and the live runtime already supports `steer` deliveries. The implementation should therefore add an explicit send-mode parameter end to end and keep the default path backward-compatible.

## Current-state findings
- `src/components/SessionChatPanel.tsx` owns the shared composer used by both Chat and Sessions pages.
- `src/components/SupervisorQuickChatModal.tsx` has a separate composer and cannot inherit the SessionChatPanel change automatically.
- `src/App.tsx` centralizes send behavior through `handleSendMessage()` / `queueSessionMessage()`.
- `src-tauri/src/commands/sessions.rs`
  - current default send behavior is:
    - idle session => `prompt`
    - busy session => `follow_up`
  - there is no explicit UI-plumbed interrupt mode yet.
- `src-tauri/src/services/live_sessions.rs` already supports `prompt`, `follow_up`, and `steer` delivery types.
- Existing regression coverage already protects:
  - default send on chat/sessions/quick-chat surfaces,
  - multiple queued sends while a prior response is pending,
  - desktop follow-up behavior while streaming.

## Recommended UX

### 1. Use a visible composite send control
Add a single composite send control with a primary left segment and a compact send-options right segment on:
- Chat page (`SessionChatPanel`)
- Sessions page (`SessionChatPanel`)
- Supervisor quick chat (`SupervisorQuickChatModal`)

Recommended behavior:
- left/primary Send segment => default behavior
- right/options segment => open menu with alternate send actions
- Ctrl/⌘+Enter => default behavior only

This keeps the existing fast path unchanged and makes alternate steering explicit.

### 2. Treat long-press as optional enhancement, not the primary path
If implementation cost is modest, long-press/press-and-hold on the Send button may open the same menu.

But the explicit trigger should still ship because:
- long-press is undiscoverable,
- desktop long-click is not a standard convention,
- touch long-press can conflict with platform gestures,
- keyboard and assistive-tech users need a normal focusable control.

### 3. Make alternate actions one-shot, not sticky
Selecting `Queue` or `Interrupt` should send the current draft immediately using that mode. It should not arm a persistent mode for later sends.

Why:
- preserves the guarantee that normal click on Send still means the default path,
- avoids accidental repeated interrupts,
- keeps keyboard submit behavior unchanged,
- reduces state/UI complexity.

### 4. Show enough mode context near the control
Recommended visibility treatment:
- menu items include short descriptions,
- the send-options trigger has an explicit tooltip/aria-label such as `Send options`,
- when the session is currently busy, show lightweight helper copy near the send controls clarifying that the default Send action will queue behind current work.

That gives users clarity without requiring a sticky selected-mode indicator.

## Recommended product semantics

### Default
Default must preserve current Orchestra behavior:
- idle/no active work => send immediately as `prompt`
- work already active or locally pending => queue as `follow_up`

This is the behavior used by:
- primary Send button
- Ctrl/⌘+Enter

### Queue
`Queue` is the explicit non-interrupting path:
- idle/no active work => send immediately as `prompt`
- work active or pending => send as `follow_up`

User-facing copy should make clear that Queue means “wait until current work finishes; sends now if idle.”

### Interrupt
`Interrupt` is the explicit steering path:
- idle/no active work => send immediately as `prompt`
- work active or pending => send as `steer`

Important semantic note: `Interrupt` should **not** hard-stop a running tool call. It should use Pi steering semantics: deliver after the current assistant/tool turn finishes, before queued follow-ups. In practice that means the current tool execution is allowed to complete, then the interrupting instruction becomes the next assistant turn; it can supersede the original pending reply rather than guaranteeing a separate assistant response for the pre-interrupt prompt.

### Relative ordering while busy
When the session is already working:
- `steer` should take priority ahead of queued `follow_up` messages
- `follow_up` should wait until the agent is otherwise done

### Unavailable-state behavior
Do not silently remap an unavailable composer into a different mode.

If the session is not messageable because it is closed, terminal-attached, or Pi setup is unavailable:
- disable the send-options trigger together with the existing Send path,
- preserve existing disabled/error messaging,
- do not expose Queue/Interrupt as enabled actions.

## Implementation plan

### 1. Add an explicit send-mode parameter through the client stack
Extend session send plumbing with a mode such as:
- `default`
- `queue`
- `interrupt`

Touchpoints:
- `src/lib/orchestraClient/client.ts`
- `src/lib/orchestraClient/tauriBindings.ts`
- `src/lib/orchestraClient/remoteApiClient.ts`
- `src/lib/tauri.ts`
- `src-tauri/src/services/remote_api.rs`
- `src-tauri/src/commands/sessions.rs`

Keep the parameter optional so existing callers continue to behave as today.

### 2. Centralize backend delivery-mode resolution
In `src-tauri/src/commands/sessions.rs`, factor the current busy/idle detection into a helper that resolves the actual runtime delivery type:
- default + idle => `prompt`
- default + busy => `follow_up`
- queue + idle => `prompt`
- queue + busy => `follow_up`
- interrupt + idle => `prompt`
- interrupt + busy => `steer`

This helper should also drive logging so desktop regressions can distinguish follow-up vs interrupt delivery.

### 3. Add the shared send-options UI
In `src/components/SessionChatPanel.tsx`:
- keep the current submit button semantics as the default action,
- restyle the send control into a single composite control with left/right segments,
- open a small menu from the right segment reusing the existing lightweight dropdown pattern already used for session actions,
- wire menu actions to `onSendMessage(mode)` or equivalent.

Mirror the same pattern in `src/components/SupervisorQuickChatModal.tsx` so quick chat stays behaviorally consistent.

### 4. Update App-level send handlers
In `src/App.tsx`:
- thread an optional send mode through `handleSendMessage()` / `queueSessionMessage()`,
- keep default callers unchanged,
- pass explicit modes from the new menu actions,
- preserve optimistic pending-run handling for all modes.

### 5. Keep mock/browser behavior aligned
`src/lib/tauri.ts` mock send behavior must understand the explicit mode so browser E2E coverage can exercise the affordance without diverging from desktop semantics.

## Regression coverage

### Browser E2E
Update/add coverage in:
- `tests/e2e/chat.spec.ts`
- `tests/e2e/sessions.spec.ts`

Recommended assertions:
- ordinary Send click remains unchanged,
- send-options trigger opens the menu,
- Queue sends still leave current work undisturbed,
- Interrupt uses the alternate path,
- mobile layouts still expose the affordance cleanly,
- quick chat gets the same send-options behavior.

### Desktop/podman E2E
Extend real-runtime coverage in:
- `tests/desktop-e2e/session-message-lifecycle.test.ts`
- or `tests/desktop-e2e/session-controls.test.ts`

Recommended assertions:
- explicit Queue during an active run logs/behaves as `follow_up`,
- explicit Interrupt during an active run logs/behaves as `steer`,
- interrupt delivery lands ahead of queued follow-up work after the current tool turn finishes,
- default send still behaves exactly as before.

### Lower-level tests
Add focused unit/integration coverage for backend delivery resolution so the default/queue/interrupt matrix is locked down without relying only on UI tests.

## File touch list
- `src/App.tsx`
- `src/components/SessionChatPanel.tsx`
- `src/components/SupervisorQuickChatModal.tsx`
- `src/styles.css`
- `src/lib/tauri.ts`
- `src/lib/orchestraClient/client.ts`
- `src/lib/orchestraClient/tauriBindings.ts`
- `src/lib/orchestraClient/remoteApiClient.ts`
- `src-tauri/src/commands/sessions.rs`
- `src-tauri/src/services/remote_api.rs`
- `tests/e2e/chat.spec.ts`
- `tests/e2e/sessions.spec.ts`
- `tests/desktop-e2e/session-message-lifecycle.test.ts` and/or `tests/desktop-e2e/session-controls.test.ts`

## Guardrails
- Do not change the meaning of ordinary Send click.
- Do not make Queue/Interrupt sticky across later sends.
- Do not ship long-press as the only affordance.
- Do not implement Interrupt as a hard runtime stop; use steering semantics.
- Do not forget supervisor quick chat, which has its own composer implementation.
