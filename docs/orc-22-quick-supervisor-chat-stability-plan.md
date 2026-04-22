# ORC-22 — quick supervisor chat session stability plan

## Goal

Stabilize the floating supervisor quick chat so it keeps the intended per-project supervisor session through close/reopen, background refreshes, project switching, and page reloads, then add regression coverage for the broken flows.

## Diagnosed failure modes

### 1. The active quick-chat session can fall out of `sessions`

Current quick-chat state in `src/App.tsx` is very thin:

- `supervisorQuickChatOpen`
- `supervisorSessionId`
- `supervisorSession = sessions.find(...)`

That means the modal only works while the full `SessionRecord` stays present in the top-level `sessions` array.

`loadSessions()` already tries to protect session continuity during list refreshes, but it only re-inserts a missing **viewed** session back into state. The quick-chat session id is passed into `reconcileListedSessions(...)` as a `preserveDetailedSessionIds` entry, but that only preserves transcript/detail fields for sessions that are still present in the latest list response. It does **not** keep a missing session record alive.

Impact:

- a transient `listSessions()` omission can make `supervisorSession` become `null`
- the quick-chat transcript and composer stop being bound to a live session
- the modal appears to have “lost” the session even when the backend session still exists

### 2. Quick chat has no dedicated recovery path

The main Chat page already has a stronger recovery model in `src/App.tsx`:

- last-known session refs
- last-known draft refs
- a recovery grace window
- `getSessionRecord(...)` fallback
- `ensureAgentSession(...)` fallback

Quick supervisor chat has none of that. Once its record disappears from `sessions`, there is no effect that rehydrates it automatically.

Impact:

- session loss is sticky instead of self-healing
- the modal can remain open in a broken/loading state
- users can lose confidence that the quick supervisor chat is tied to a stable session

### 3. Quick chat depends on page-level refresh behavior that does not match its UX

The floating quick-chat modal can be opened from anywhere, but the recurring/focus-driven `loadSessions({ background: true })` behavior is only active while the main page is `sessions` or `chat`.

That is a mismatch:

- quick chat is intentionally global
- session refresh behavior is still page-scoped

Impact:

- using quick chat from `tasks`, `settings`, or other pages is more vulnerable to stale or missing session state
- quick chat does not get the same continuity protection as the dedicated chat page

### 4. Project-scoped restore can leave the modal open with no usable session

The current restore key (`orchestra.quick-chat.supervisor.<projectId>`) stores `{ sessionId, draft }` per project, which is the right persistence shape.

However, on project change the app only restores the stored id/draft. It does not also guarantee that an open quick-chat modal rebinds to a usable session for the new project.

Impact:

- a project switch can leave the modal open while `session === null`
- the user sees `Loading supervisor session…` instead of a recovered or freshly ensured supervisor session
- the stored draft/session target is not enough on its own without rehydration logic

## Recommended implementation plan

### 1. Add explicit supervisor quick-chat continuity state in `src/App.tsx`

Mirror the proven chat-page recovery model with supervisor-specific refs/state:

- `lastKnownSupervisorSessionRef`
- `lastKnownSupervisorSessionIdRef`
- `lastKnownSupervisorDraftRef`
- `supervisorSessionRecoveryMissRef`

This keeps the quick-chat path self-contained while following the same continuity strategy that already exists for agent chat.

### 2. Preserve the quick-chat session during session-list churn

Update `loadSessions()` so the active supervisor quick-chat session is treated as a pinned session, not just a detailed session.

Recommended approach:

- generalize the existing “preserve missing viewed session” branch into a helper for pinned session ids
- use that helper for:
  - the currently viewed session
  - the active supervisor quick-chat session

Why this matters:

- it prevents transient list churn from immediately evicting the quick-chat session from memory
- it reduces UI flicker and avoids unnecessary recovery work
- it keeps the continuity rule in one place instead of duplicating fragile special cases

### 3. Add a supervisor quick-chat recovery effect

When quick chat is open, or when a stored `supervisorSessionId` is present, and the session is missing from `sessions`, recover it explicitly:

1. try `getSessionRecord(supervisorSessionId)`
2. if the session is still temporarily missing, allow a short grace window to avoid racey churn
3. if the record truly no longer exists, call `ensureAgentSession(SUPERVISOR_AGENT_ID, activeProjectId)`
4. migrate any unsent draft to the recovered/new session id when needed

This gives quick chat the same self-healing behavior the main chat page already has.

### 4. Make project changes deterministic

When the active project changes and quick chat is open:

- restore the project-scoped stored session id/draft
- immediately hydrate that session if it exists
- if no stored session id exists, ensure the project’s canonical supervisor session on demand instead of leaving the modal open with `null` session state

That keeps the quick chat usable even when the operator changes projects with the modal still visible.

### 5. Keep modal-open persistence out of scope unless product explicitly wants it

This task should preserve:

- session identity
- transcript continuity
- unsent draft continuity

It does **not** need to force the modal to auto-reopen after a full page reload unless product wants that behavior. Restoring the same session when the user reopens quick chat is the safer default and avoids surprising startup UI.

## Regression coverage

Extend `tests/e2e/sessions.spec.ts` with the missing flows.

### 1. Quick chat survives a transient session-list refresh miss

- open supervisor quick chat
- type a draft and capture the session id
- simulate a temporary empty `listSessions()` result plus focus/background refresh
- assert the modal keeps the same session id, transcript, and draft

### 2. Returning after reload restores the same quick-chat session

- send a quick-chat message
- reload the page
- reopen quick chat with `Ctrl+T`
- assert the previous transcript is still present and the draft/session target is restored

### 3. Stored quick-chat sessions recover or fall back safely

- seed a stored quick-chat session id that is absent from the normal list response
- verify the app hydrates the record via `getSessionRecord(...)` when it still exists
- verify the app falls back to `ensureAgentSession(...)` when the id is truly gone
- assert unsent draft text is preserved across that fallback

### 4. Add a helper-level unit test if continuity logic is extracted

If the “keep pinned sessions during list churn” logic moves into a helper, add a small Vitest test that locks in the rule without relying only on end-to-end coverage.

## Files likely to change

- `src/App.tsx`
- `src/lib/sessionListMerge.ts` or a nearby new continuity helper
- `tests/e2e/sessions.spec.ts`
- possibly `src/components/SupervisorQuickChatModal.tsx` if loading/recovery copy needs refinement

## Validation for the implementation lane

Minimum targeted validation:

- `pnpm test -- tests/e2e/sessions.spec.ts`
- `pnpm test -- tests/e2e/chat.spec.ts`
- plus any new/updated unit test command if continuity logic moves into a helper

Success looks like:

- quick supervisor chat always reattaches to the intended supervisor session after transient refresh/list churn
- drafts survive the recovery path
- returning to quick chat after reload reuses the same session instead of silently dropping to a new/blank chat
- the broken flows are covered by automated tests
