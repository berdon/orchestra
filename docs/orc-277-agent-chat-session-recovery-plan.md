# ORC-277 — agent chat session recovery hardening plan

## tl;dr
- Root cause: backend agent-session open currently trusts `agent_runtime_states.main_session_id` once it can resolve session context, but it does not verify that the session record/file is still loadable. When that pointer drifts to a dead session, the frontend retries the same broken `ensureAgentSession(...)` call and eventually shows the current dead-end not-found banner.
- Fix the primary recovery path in backend session-open/create flows so agent chat never settles on a dead main-session id: reuse the current main session when it loads, rotate/reopen it when it is recoverable, and create a fresh replacement session when it is not.
- Keep a smaller frontend guardrail so agent-chat recovery stays silent to the user, preserves the in-progress chat surface, and migrates any unsent draft if the fallback lands on a replacement session id.
- Add browser + desktop regression coverage for: stale runtime main session, failed reopen that falls back to a fresh session, and “no not-found banner for agent chat” behavior.

## Executive summary
The failure is split across backend and frontend. On the backend, `agent_dispatch::ensure_main_session(...)` only proves that a candidate session still has canonical context metadata; it does not prove that the session can still be loaded as a usable chat session. `ensure_agent_session(...)` later tries to bind/subscribe/load that same id and can fail with canonical-drift or missing-session errors.

On the frontend, `src/App.tsx` treats that `not_found` as a transient recovery miss for a short grace period, but the retry path just replays the same `ensureAgentSession(...)` call against the same broken backend state. Once the grace window expires, the app surfaces the current banner:

> “Not found. This session is no longer available. Refresh the session list or reopen the latest chat to continue.”

That is the wrong UX for agent chat. Agent chat should be self-healing. The implementation lane should therefore move the authoritative fallback logic into the backend open/create path, then keep the frontend focused on continuity: no dead-end banner, no visible drop out of chat, and no lost draft if the session id changes during recovery.

## Diagnosed root cause

### 1. Backend “main session exists” checks are weaker than “main session is openable”
`src-tauri/src/services/agent_dispatch.rs` currently returns an existing `main_session_id` from `ensure_main_session(...)` as soon as `find_session_context_for_session(session_id)` succeeds.

That check only proves that the app can still resolve canonical session context metadata. It does **not** prove that:
- the canonical row is still healthy enough to load detail,
- the transcript path is still valid,
- the file still exists,
- or the session can still be reopened as the agent’s current chat surface.

So the runtime can keep pointing at a session id that is no longer actually usable.

### 2. `ensure_agent_session(...)` fails after the weaker check has already accepted the stale id
`src-tauri/src/commands/agent_runtime.rs` calls `agent_dispatch::ensure_main_session(...)`, then immediately tries to bind, subscribe, and load detail for the returned session id.

That later load step is where the failure finally appears. By then the backend has already committed to the stale `main_session_id`, so the command returns a user-visible error instead of repairing/replacing the bad pointer.

### 3. Frontend retries the same broken open path, then shows the dead-end banner
`src/App.tsx` already has `chatSessionRecoveryMissRef` and a grace period for agent-chat recovery misses. But today the retry path just calls `ensureAgentSession(...)` again.

So the frontend does this:
1. keep the last visible chat surface alive for a short window,
2. retry the same broken backend open call,
3. eventually show the not-found banner when the backend state never heals.

There is no final automatic fallback to:
- rotate/reopen the old main session, or
- create a fresh replacement main session.

### 4. Draft continuity is not wired through replacement-session recovery
`src/App.tsx` tracks `lastKnownChatSessionDraftRef`, but it is not currently used to move an unsent draft onto a replacement chat session when recovery returns a new session id.

That means even after we fix the session-open path, a successful recovery could still drop the user’s unsent text unless we explicitly migrate it.

## Recommended implementation plan

### 1. Add a shared backend helper that resolves an agent’s main session into one of three outcomes
Create a helper used by both agent-session open and explicit agent-session creation flows:
- **usable current main session** → load and return it
- **recoverable current main session** → rotate/reopen it into a successor main session
- **unrecoverable current main session** → create a fresh main session and repoint runtime state

Recommended home:
- `src-tauri/src/services/agent_dispatch.rs`, or
- a small shared helper near `src-tauri/src/commands/agent_runtime.rs` / `src-tauri/src/commands/sessions.rs`

The important part is that both “open chat” and “New session” use the same fallback rules.

### 2. Strengthen backend validation from “context exists” to “session detail can actually load”
Do not stop at `find_session_context_for_session(...)`.

For the candidate `main_session_id`, validate that the session can actually be loaded as a usable detail record. Recoverable failures should include the current canonical-drift / missing-session cases that are already normalized into agent-chat not-found UX.

That gives the backend a reliable branch point:
- if load succeeds, keep the current main session
- if load fails in a recoverable way, repair/replace it instead of returning the error to the UI

### 3. Use the existing agent-main rotation path when the old session is still recoverable
When the old main session still has enough data to rotate, use the existing successor behavior already embodied by `create_contextual_agent_main_successor(...)` and related agent-main session archival/update helpers.

This preserves the current product rule that a replaced agent main session:
- updates `agent_runtime_states.main_session_id`,
- archives/hides the superseded session from normal lists,
- keeps the new successor as the only active main session.

### 4. If rotation/reopen fails, create a fresh main session instead of surfacing not-found
If the old session cannot be rotated because the underlying record/transcript is truly gone, create a fresh agent main session immediately and repoint runtime state to it.

This is the critical product guarantee for this task: agent chat should always land on a usable session, even if continuity to the old record is no longer possible.

### 5. Reuse the same backend fallback for explicit “New session” on agent chat
`create_session(..., agent_id)` currently has similar assumptions about the current main session being loadable.

Harden that path too so explicit session rotation from an agent chat does not fail when the runtime’s current `main_session_id` is already stale. The fallback rules should match the automatic open path:
- rotate when the old session is still recoverable,
- otherwise create a fresh main session cleanly.

### 6. Keep a frontend continuity guardrail for agent chat
Even with the backend fixed, keep a frontend guardrail in `src/App.tsx` so the agent-chat page never reintroduces the dead-end banner during recovery races.

Recommended behavior:
- treat agent-chat `not_found` during session open as recovery-in-progress, not a final user error
- allow the backend recovery path to settle onto the returned session id
- only surface an error if recovery fails with a genuinely non-recoverable/non-session-missing cause

### 7. Migrate unsent draft text when recovery returns a replacement session id
When an automatic recovery lands on a different session id than the currently remembered chat session:
- move the draft text from the prior session id to the replacement session id if the replacement draft is empty
- clear the old draft entry once migrated
- update last-known chat refs to the replacement id

This uses the existing chat draft continuity state instead of leaving it half-wired.

### 8. Keep mock/browser behavior aligned with desktop behavior
Update the browser/mock implementation so automated browser coverage can exercise the same recovery semantics:
- stale or missing stored agent main session should reopen/replace automatically
- explicit new-session on an agent chat should follow the same rotate-or-create fallback
- no agent-chat not-found banner should appear during those flows

## Regression coverage

### 1. Backend command/unit coverage
Add focused coverage around the recovery matrix for agent main sessions:
- usable existing main session loads normally
- stale/missing current main session rotates to a successor when recoverable
- stale/missing current main session falls back to a fresh replacement when rotation fails
- `agent_runtime_states.main_session_id` is updated to the returned replacement session
- superseded sessions remain archived/hidden when a rotation path succeeds

Likely touchpoints:
- `src-tauri/src/commands/agent_runtime.rs`
- `src-tauri/src/commands/sessions.rs`
- nearby session/agent dispatch tests

### 2. Browser E2E coverage
Extend `tests/e2e/chat.spec.ts` with flows that seed a broken agent main-session pointer and verify:
- opening Chat for that agent still lands on a usable session
- the selected chat session id either stays valid or changes to a replacement id automatically
- the page never renders `[data-role="agent-chat-status-error"]` with the not-found copy
- unsent draft text survives if recovery returns a new session id

### 3. Desktop E2E coverage
Extend `tests/desktop-e2e/chat-session-recovery.test.ts` with a real-runtime regression that forces the stored/main agent session to become unavailable, then verifies:
- agent chat automatically reopens or replaces the session
- `mainSessionId` is updated to the recovered/replacement session
- the old dead-end not-found banner is never observed

## Files likely to change
- `src-tauri/src/services/agent_dispatch.rs`
- `src-tauri/src/commands/agent_runtime.rs`
- `src-tauri/src/commands/sessions.rs`
- `src/App.tsx`
- `src/lib/sessionErrorBehavior.ts`
- `src/lib/agents.ts` and/or `src/lib/tauri.ts` for mock/browser parity
- `tests/e2e/chat.spec.ts`
- `tests/desktop-e2e/chat-session-recovery.test.ts`
- backend command/service tests near the touched Rust files

## Validation for the implementation lane
- targeted Rust tests covering the new agent-session recovery helper / command behavior
- `pnpm test -- tests/e2e/chat.spec.ts`
- `pnpm test -- tests/desktop-e2e/chat-session-recovery.test.ts`

Success looks like:
- agent chat always resolves to a usable session
- stale agent main-session pointers self-heal without user intervention
- failed reopen attempts fall through to a fresh replacement session automatically
- the not-found banner is no longer reachable from normal agent-chat recovery flows
- unsent draft text survives replacement-session recovery
