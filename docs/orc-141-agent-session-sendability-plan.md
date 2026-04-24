# ORC-141 — Agent session closed/sendability semantics plan

## tl;dr

- The current bug is a **state-model mismatch**, not just a rendering bug.
- Backend session decoration currently collapses **Sessions-list visibility** and **chat/detail sendability** into the single `SessionRecord.status` field.
- `list_sessions` hides `Hidden(...)` sessions, but `get_session_record` still decorates those same sessions as `status: "closed"`.
- That is wrong for persistent agent main sessions, because `send_session_message` can still reopen/attach a runtime and accept messages by direct session id.
- Fix by separating **list visibility** from **messageability/detail status**, then update the Sessions/Chat UI and regression tests to use the right signal for each surface.

## Executive summary

The repro path is the combination of three current behaviors:

1. `src-tauri/src/services/session_list.rs` classifies some sessions as `Hidden(...)` so they disappear from the Sessions list.
2. `src-tauri/src/commands/sessions.rs` still maps both `Closed` and `Hidden(...)` to `record.status = "closed"` inside `decorate_session_record_with_connection(...)`.
3. `src/App.tsx` recovers directly opened/missing chat sessions with `orchestraClient.sessions.get(sessionId)`, so a hidden-but-still-addressable agent session comes back into detail state as `closed`.

That means the product currently leaks a list-only archival decision into the chat/detail surface. The backend message path (`send_session_message`) does not actually treat `closed` as authoritative; it resolves the session path and ensures a runtime anyway. So the current model says the session is closed while the runtime layer still treats it as messageable. That mismatch is the real bug.

## Current code findings

### Backend

- `src-tauri/src/services/session_list.rs`
  - `classify_session_visibility(...)` correctly distinguishes `Active`, `Closed`, and `Hidden(...)` for **list visibility**.
  - Persistent agent main sessions are identified through `agent_runtime_states.main_session_id`.
  - Completed/canceled task history can auto-hide a session from the Sessions list.
- `src-tauri/src/commands/sessions.rs`
  - `list_command_sessions_with_connection(...)` already skips `Hidden(...)` sessions entirely.
  - `decorate_session_record_with_connection(...)` then still coerces both `Closed` and `Hidden(...)` to `status = "closed"`.
  - `get_session_record(...)` uses that same decoration path, so direct session fetches inherit list-hidden state as `closed`.
- `src-tauri/src/commands/sessions.rs`
  - `send_session_message_with_optional_run_id(...)` does **not** consult `SessionRecord.status`; it resolves the session and ensures a runtime.

### Frontend

- `src/App.tsx`
  - `loadSessions()` drops hidden sessions because `sessions.list()` omits them.
  - Chat recovery later re-fetches a missing session with `sessions.get(sessionId)`.
  - Session filters and selection still key off `session.status === "closed"`.
- `src/pages/SessionsPage.tsx` and `src/pages/AgentChatPage.tsx`
  - Both depend on the same `SessionRecord` shape, so they currently cannot distinguish:
    - "hidden from the Sessions list"
    - from "not messageable in chat/detail"

## Intended product semantics

### Sessions list semantics

- **Active**: currently owns live work or is otherwise intentionally surfaced as an active session.
- **Closed**: legitimate visible history that should remain browseable from the Sessions page.
- **Hidden**: intentionally absent from the Sessions page, even though the transcript may still exist.

### Chat/detail semantics

- **Messageable** is a separate concern from list visibility.
- A persistent agent main session may be:
  - hidden from the Sessions list, **and still messageable by direct session id**.
- A historical worker session with no intended follow-up path may be:
  - hidden or closed in the list/detail sense, **and not messageable**.
- Composer enablement should be driven by explicit sendability rules, not by list-hidden/closed decoration leaking through `status`.

### Product decision for this task

- Agent chat sessions should **not** appear as `closed` on the chat/detail surface when they are still valid direct-message targets.
- Session-list visibility and chat sendability must be modeled independently.
- Direct navigation to a valid agent session should keep the transcript open and the composer usable even if that session is no longer listed as active.

## Implemented semantics

The implementation landed with two explicit `SessionRecord` fields:

- `listVisibility: "active" | "closed" | "hidden"`
- `messageability: "messageable" | "closed"`

Backend detail decoration now keeps hidden persistent agent main sessions messageable and preserves their runtime/detail status instead of coercing them to `closed`. Non-agent historical sessions still resolve as closed/read-only when appropriate.

Frontend behavior now follows those fields intentionally:

- Sessions list filtering uses `listVisibility`
- Chat/detail composer enablement uses `messageability`
- Directly opened hidden sessions can stay open in detail state without reappearing in the Sessions list

## Implementation plan

1. **Split session visibility from sendability in the backend contract**
   - Add explicit session metadata for list/detail semantics, e.g.:
     - `listVisibility: "active" | "closed" | "hidden"`
     - `messageability: "messageable" | "read_only" | "closed"`
   - Keep `status` focused on runtime/detail activity instead of list archival state.

2. **Stop treating `Hidden(...)` as automatically `closed` for direct fetches**
   - Refactor `decorate_session_record_with_connection(...)` so list decoration and detail decoration do not share the same closed coercion.
   - A hidden persistent agent main session fetched by id should keep a messageable detail state.
   - A truly non-messageable historical worker session should still resolve as closed/read-only in detail.

3. **Update frontend selection/filter logic to use the new signals**
   - Sessions list filtering in `src/App.tsx` / `src/pages/SessionsPage.tsx` should use `listVisibility`, not `status === "closed"`.
   - Chat/session composer enablement should use `messageability` plus existing terminal/Pi-setup checks.
   - Direct-route recovery should no longer force the UI into a misleading closed state just because the session is hidden from the list.

4. **Keep the send path aligned with the new semantics**
   - Ensure `send_session_message` remains valid for messageable persistent agent sessions addressed by direct id.
   - If needed, add a guard that rejects only genuinely closed/non-messageable history so the backend contract matches the UI contract.

## Regression coverage added/updated

- Rust session command tests now cover the hidden persistent-agent detail case explicitly.
- Browser E2E coverage now asserts that a hidden recovered supervisor session remains sendable and can accept a follow-up message after recovery by direct session id.

## Regression coverage to add/update

### Rust/backend

- hidden persistent agent main session is omitted from `list_sessions` but fetched by id as messageable/not-closed
- hidden completed/canceled non-agent worker session remains non-messageable in detail
- list/detail decoration uses the same classification inputs but produces different list-vs-detail outputs intentionally

### Frontend/browser

- direct navigation to a hidden persistent agent session keeps transcript open and composer enabled
- Sessions list no longer uses detail status as the source of active-vs-closed filtering
- chat recovery after a background refresh miss preserves a messageable agent session even when it is absent from the Sessions list

### Desktop E2E

- representative agent-session flow where the session is no longer visible in Sessions but still accepts a direct follow-up message
- explicit assertion that the chat/session composer remains enabled for the valid direct-message case

## Files most likely involved

- `src-tauri/src/services/session_list.rs`
- `src-tauri/src/commands/sessions.rs`
- `src-tauri/src/models.rs`
- `src/types.ts`
- `src/App.tsx`
- `src/pages/SessionsPage.tsx`
- `src/pages/AgentChatPage.tsx`
- affected Rust/browser/desktop session regression tests
