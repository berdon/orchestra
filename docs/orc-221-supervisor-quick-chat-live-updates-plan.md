# ORC-221 — supervisor quick-chat live updates plan

## tl;dr
- Fix live session subscription ownership for quick chat **and** chat/sessions surfaces opened from command results that already come back with `subscribed: true`.
- The likely bug is specific to hosted-web/mobile remote clients; native desktop is probably not affected because Tauri already marks ensured/sent-to sessions as subscribed on the desktop side.
- Regression coverage should prove the UI now issues explicit `sessions.subscribe(...)` calls for quick chat plus mobile chat/sessions flows before relying on live updates.

## Executive summary
The issue is broader than supervisor quick chat. Remote/mobile clients can open chat/session surfaces from command results that already report `subscribed: true` because the backend marked the desktop/runtime side subscribed. The frontend then trusts that flag and skips its own explicit `orchestraClient.sessions.subscribe(...)` call, even though that specific remote client has not actually joined the per-session websocket stream. The result is the same symptom across quick chat and mobile chat/sessions flows: no live updates until a later navigation-triggered refresh reloads the transcript.

The fix is a frontend subscription-management refactor in `src/App.tsx`: manage live subscriptions for all active session surfaces, not just the viewed Sessions/Chat detail, and do not rely on the returned record’s `subscribed` flag to decide whether the current client still needs to subscribe. Specifically, treat an open supervisor quick-chat modal as a first-class live session surface, subscribe it while open, explicitly subscribe newly created/opened viewed sessions, and unsubscribe sessions when no active surface still needs them. Regression coverage should assert that these mobile/quick-chat flows now produce explicit subscribe activity before the UI depends on live transcript streaming.

## Findings

### 1. Why the bug appears after opening chat from the FAB and in mobile chat/sessions flows
Relevant code paths today:
- `src/App.tsx`
  - `handleOpenSupervisorQuickChat()` / `handleOpenAgentSession(..., { openQuickChat: true })`
  - quick-chat recovery effect for `supervisorQuickChatOpen`
  - viewed-session subscribe effect gated by `activePage === "sessions" || activePage === "chat"`
- `src/lib/orchestraClient/remoteApiClient.ts`
  - remote `sessions.subscribe()` is the path that also confirms websocket session subscription via `eventManager.confirmSessionSubscription(...)`
- `src-tauri/src/services/remote_api.rs`
  - hosted-web `session.stream` events are delivered only to websocket clients subscribed to that specific session

There are two closely related failure shapes:
- quick chat can open while the active page is `tasks`, `inbox`, etc., so the old subscribe effect never ran for that surface at all;
- chat/sessions surfaces can also open a brand-new or ensured session from command results that already report `subscribed: true`, so the old effect incorrectly concluded there was nothing left for the current client to subscribe to.

In both cases the hosted-web/mobile client winds up with a usable session record but without websocket stream delivery for that specific client/session pair.

### 2. Why native desktop is likely different
Native desktop appears less exposed because:
- `src-tauri/src/commands/agent_runtime.rs` `ensure_agent_session(...)` calls `state.set_session_subscription(&session_id, true)`.
- `src-tauri/src/commands/sessions.rs` `send_session_message_with_optional_run_id(...)` also calls `state.set_session_subscription(&session_id, true)`.
- `src-tauri/src/services/live_sessions.rs` emits desktop `orchestra:session-stream` events when the desktop app state says that session is subscribed.

So the shared React quick-chat UI is probably fine on native desktop once the session exists; the missing piece is the remote websocket-client subscription handshake used by hosted-web/mobile.

### 3. Why browser-mock tests are not enough
Browser-mode mock coverage is not a reliable guard for this bug because the mock session transport emits stream events directly and does not require the hosted-web websocket subscription confirmation path. A browser-only e2e can look green while the real hosted-web/mobile path is still broken.

## Implementation plan

### 1. Split live subscription management from viewed-session detail loading
Refactor the current `src/App.tsx` effect that both:
- subscribes the viewed session, and
- loads model state for the viewed session.

Keep model-state loading scoped to the viewed Sessions/Chat detail, but move subscription ownership into a separate effect.

### 2. Track all live session surfaces, not just the viewed page session
Compute the session ids that must receive live stream updates, for example:
- viewed session when `activePage` is `sessions` or `chat`
- supervisor quick-chat session while `supervisorQuickChatOpen`

Use a set/diff approach so the app can:
- subscribe newly required session ids
- unsubscribe session ids that are no longer needed by any active surface
- avoid duplicate subscribe/unsubscribe churn when the same session is used by multiple surfaces

### 3. Preserve current quick-chat state behavior
Keep the existing quick-chat continuity behavior intact:
- stored session id/draft recovery
- hidden-session preservation during refresh misses
- reopen/close continuity

The change should only add missing live subscription ownership for the quick-chat surface.

### 4. Verify platform behavior explicitly
After the fix:
- reproduce/verify hosted-web mobile UX shows streamed updates immediately in the modal
- spot-check native desktop quick chat from the same entry path to confirm it was unaffected or still works after the refactor

## Regression coverage

### Primary regressions
Add/extend regressions that prove explicit subscribe activity for the affected surfaces:
1. supervisor quick chat opened from outside Sessions/Chat
2. mobile chat switching into an agent session
3. mobile sessions creating/opening a fresh session

A practical browser-mock regression can still be valuable here if it asserts the frontend now emits `sessions.subscribe` activity in those flows before relying on live transcript updates. That directly guards the frontend bug even though the browser mock does not enforce remote websocket delivery.

### Optional hosted-web follow-up
A hosted-web/mobile e2e that exercises the real remote websocket handshake would still be ideal follow-up coverage, but it is not strictly required to validate the frontend fix if the browser regression explicitly checks subscribe activity.

## Files likely to change
- `src/App.tsx`
- `tests/e2e/sessions.spec.ts`
- `tests/e2e/chat.spec.ts`
- optionally a small helper file if the live-subscription surface logic is extracted

## Acceptance checks
- Quick supervisor chat opened from the floating entrypoint shows streaming/live assistant updates immediately.
- Mobile chat and mobile sessions flows that open/create a session also issue explicit live-subscribe activity.
- No navigation away/back is required.
- Regression coverage fails before the fix and passes after it.
- Native desktop quick chat still streams correctly after the refactor.
