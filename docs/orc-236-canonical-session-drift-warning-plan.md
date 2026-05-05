# ORC-236 canonical-session drift warning plan

## tl;dr

- The warning means a normal chat/session UI lookup asked for a session id that is not present in the canonical `sessions` table anymore.
- The raw message is an internal diagnostic from the canonical session read path, not end-user guidance.
- The most likely hot-path trigger is stale UI session state in Chat: the UI intentionally keeps showing `lastKnownChatSessionRef` while recovery runs, but passive stats/model/detail loaders still query the stale id and surface the backend diagnostic.
- This is mostly UX noise unless admin diagnostics also show real orphaned transcripts or stale runtime/task ownership.
- Fix the UX by suppressing passive reloads for fallback-only sessions, clearing stale banners after recovery, and translating any remaining canonical-drift errors into user-safe copy while keeping the raw diagnostic in logs/admin tooling.

## Executive summary

The message is coming from the canonical-session cutover work, where normal session flows now fail fast if a requested session id is missing from the canonical `sessions` rows. That behavior is intentional for admin/repair boundaries, but the current Chat/Sessions UI is surfacing the raw backend diagnostic to end users.

The likely user-facing path is:

1. Chat keeps rendering a cached `lastKnownChatSessionRef` when the live session drops out of the current session list.
2. While that fallback UI is visible, passive background loaders still call `sessions.getStats(...)`, `sessions.getModelState(...)`, and `sessions.get(...)` for the stale id.
3. Tauri resolves those through canonical lookup helpers and returns the explicit reconciliation warning.
4. `toUiErrorState(...)` + `ResourceStatusBanner` display the raw message.
5. `sessionActionError` is shared across chat and sessions surfaces, so one stale lookup can poison both views.

That means the warning is usually telling us more about a stale reference or recovery race than about an immediately user-actionable data loss event.

## What the warning actually means

The text:

> Session `<id>` was not found in canonical session rows for project orchestra; run explicit session reconciliation to inspect legacy drift

means:

- the UI/runtime asked for a specific session id
- the canonical `sessions` table had no matching usable row for that id in the current project context
- the normal read path refused to fall back to legacy discovery/index state
- the backend is pointing operators toward explicit diagnostics (`get_session_diagnostics` / `reconcile_sessions`) instead of silently repairing in the hot path

It does **not** automatically mean the transcript file is gone. It can also mean:

- the UI is holding a stale session id
- an agent/runtime pointer still references a superseded or deleted session
- the canonical row was never backfilled or was removed while older compatibility state still points at it

## Repro / originating code path

### Backend diagnostic origin

The raw warning is emitted by canonical session lookup helpers in `src-tauri/src/services/pi_sessions.rs`, especially:

- `find_session_context_for_session(...)`
- `get_session_path(...)`
- `resolve_session(...)`

Those helpers return errors like:

- `Session <id> was not found in canonical session rows ...`
- `Session <id> is missing canonical project/context metadata ...`
- `Session <id> has a stale canonical transcript path ...`

### UI path that likely surfaces it

The hot-path surfacing is in `src/App.tsx`:

- Chat computes `chatSession` from `liveChatSession` **or** `lastKnownChatSessionRef`
- passive effects still load session stats/model/detail for `viewedSession.id`
- failures are pushed into shared `sessionActionError`
- `AgentChatPage` and `SessionsPage` both render that error through `ResourceStatusBanner`

Relevant passive loaders:

- `orchestraClient.sessions.getStats(...)`
- `orchestraClient.sessions.getModelState(...)`
- `orchestraClient.sessions.get(...)`

Relevant backend commands:

- `get_session_stats`
- `get_session_model_state`
- `get_session_record`

### Concrete repro sequence

1. Open Chat for an agent so the app captures a live session and seeds `lastKnownChatSessionRef`.
2. Make that session disappear from canonical/live state while the UI still remembers it. Practical ways this can happen include a replaced main session, manual cleanup, deleted/missing canonical row, or another stale runtime/UI pointer.
3. Navigate away and back to Chat, or otherwise trigger the passive session reload effects.
4. The page still renders the cached session shell, but the passive loaders query the stale session id.
5. Canonical lookup fails and returns the internal reconciliation warning.
6. The shared banner state makes the message visible in chat/sessions UI.

## Severity / actionability

### For users

Mostly noise.

End users cannot do anything useful with “run explicit session reconciliation to inspect legacy drift”. In the common chat-recovery case, the app should either recover silently or say something simple like “That session is no longer available; refreshing chat…” if recovery fails.

### For operators/admins

Potentially useful, but only through diagnostics.

If admin tooling also shows:

- orphan transcript files
- stale `agent_runtime_states.main_session_id`
- stale task/assignment session links
- missing canonical rows that cannot be rebound/recreated

then there is a real integrity problem worth repairing. The message belongs there, not in normal chat/session banners.

## Why it is surfacing to users

Two design choices combine badly:

1. **The frontend treats passive background lookup failures like user-facing action failures.**
2. **The backend returns operator-grade diagnostic strings on normal missing-canonical-row reads.**

A third multiplier is that `sessionActionError` is shared across surfaces, so a stale chat lookup can keep showing in Sessions too.

## Proposed implementation

### 1. Stop passive reloads for fallback-only chat sessions

In `src/App.tsx`, distinguish between:

- the session being rendered for continuity (`chatSession` / `lastKnownChatSessionRef`)
- the session that is actually live/resolvable in current app state (`liveChatSession` or freshly recovered session)

Only run passive detail/model/stats reloads when the viewed session is live/resolvable. If Chat is temporarily showing fallback transcript state while `ensureAgentSession(...)` recovers, skip those background lookups.

### 2. Clear stale banner state after successful recovery

When chat/session recovery succeeds, clear any prior passive lookup banner so a recovered session does not keep showing an obsolete drift warning.

### 3. Downgrade canonical-drift lookup failures in normal UI flows

For session `get` / `getStats` / `getModelState` lookups, translate canonical-drift/missing-row errors into a user-safe `not_found`-style message or suppress them entirely when the UI already has fallback data.

Keep the raw diagnostic text for:

- logs
- `report_client_error`
- admin diagnostics / reconciliation tools

### 4. Keep the real diagnostic path explicit

Do **not** remove the backend diagnostic entirely. Keep it available for:

- `get_session_diagnostics`
- `reconcile_sessions`
- logs / support bundles

The fix is to route it away from ordinary chat/session banners, not to hide the admin signal.

## Regression coverage

Add at least one frontend regression that proves a stale remembered chat session does **not** show the raw canonical-drift banner while recovery is in progress or after recovery succeeds.

Recommended coverage:

1. **Browser/e2e chat regression**
   - seed a remembered chat session
   - remove it from the live/mock session list
   - navigate away/back or trigger the passive refresh path
   - assert chat stays usable / recovers
   - assert no `agent-chat-status-error` banner contains the canonical-drift message

2. **Optional desktop/Tauri coverage**
   - simulate a missing canonical row for a remembered agent main session
   - assert `ensure_agent_session` recovers or recreates the main session
   - assert normal UI-facing commands do not surface the raw diagnostic in passive flows

3. **Keep existing backend unit coverage**
   - the current `pi_sessions.rs` canonical lookup tests should remain, because the admin diagnostic itself is still valid

## Recommended implementation handoff

- Treat this as primarily a **UX/exposure bug**, with optional consistency hardening if investigation finds a reproducible stale runtime pointer.
- Preferred first fix: frontend gating + error downgrading for passive loads.
- Secondary hardening: clear or refresh stale agent/runtime session references wherever investigation finds a repeatable producer, but do not block the UX fix on proving a deeper integrity bug.
