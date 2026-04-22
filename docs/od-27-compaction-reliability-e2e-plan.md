# OD-27 — compaction reliability and podman E2E plan

## What I found in the current codebase

### 1. Existing browser E2E coverage is **not** real runtime coverage

There are already browser Playwright tests for the session actions UI:

- `tests/e2e/sessions.spec.ts` — `sessions composer session actions can reload, compact the current session, and create a new one`
- `tests/e2e/chat.spec.ts` — `chat page session actions can reload the current agent chat and rotate a new session in place`

Those tests run without Tauri. In browser mode `src/lib/tauri.ts` uses:

- `isTauriAvailable()` to detect whether the real backend is present
- mock fallbacks for `compactSession()` and `reloadSession()` when Tauri is absent

That means the existing browser E2E tests prove the frontend wiring and mock-state transitions, but they do **not** prove that:

- the UI reaches the real Tauri commands
- Orchestra can drive the Pi runtime successfully
- compaction writes a durable `compaction` entry into the session JSONL
- reload/new-session behavior works through the real desktop runtime path

### 2. We do have partial real desktop coverage today, but not for compaction

`tests/desktop-e2e/chat-nav.test.ts` already exercises the real desktop app and is included in both desktop suite scripts in `package.json`.

Current real-runtime coverage there:

- **new session**: clicks the user-visible session actions menu and verifies the selected chat session id changes
- **reload**: clicks reload, waits for `Session reloaded.`, then sends another message successfully on the same session

Current gaps:

- it does **not** click **Compact**
- it does not assert a durable compaction artifact from the backend/session file
- it does not isolate session-control failures in a focused podman test with targeted diagnostics

### 3. Lower-level coverage exists, but not the user-visible end-to-end path we need

There is already lower-level coverage around the underlying plumbing:

- `src-tauri/src/services/pi_sessions.rs`
  - parses `type: "compaction"` JSONL entries into system transcript events
- `src-tauri/src/services/live_sessions.rs`
  - covers manual/auto compaction and reload control-operation behavior
- `tests/sessionTranscriptReducer.test.ts`
  - covers control-operation UI state shaping

This is useful regression coverage, but it still does not prove that the real desktop UI control triggers a successful compaction through Tauri + runtime + transcript reload.

## Clear answer on prior automated coverage

Before OD-27, we did **not** have automated end-to-end coverage that proved manual compaction worked through the real UI/runtime integration path.

What existed before OD-27:

- browser mock coverage for compact/reload/new-session
- partial desktop coverage for reload and new-session
- no real desktop/podman coverage for manual compaction

So the answer for the acceptance criterion is:

- **Compaction:** no true end-to-end proof existed
- **Reload:** partial real desktop coverage existed
- **New session:** partial real desktop coverage existed
- **Podman regression suite for all three together:** did not exist

## Relevant runtime path to validate

The real manual compaction path currently flows through:

1. UI session action button in `src/components/SessionChatPanel.tsx`
2. frontend call to `compactSession()` in `src/lib/tauri.ts`
3. Tauri command `compact_session` in `src-tauri/src/commands/sessions.rs`
4. runtime control `perform_session_compaction()` / `SessionRuntime::compact()` in `src-tauri/src/services/live_sessions.rs`
5. Pi runtime RPC `type: "compact"`
6. session record reload from disk
7. transcript parsing of `type: "compaction"` in `src-tauri/src/services/pi_sessions.rs`

The important point is that durable compaction evidence comes from the reloaded session record, not from a frontend-only success toast or synthetic transcript line.

## Recommended implementation plan

### A. Reproduce compaction in the real desktop flow first

Use the desktop harness/podman environment and drive the actual session actions menu.

Recommended reproduction sequence:

1. create/subscribe a real session
2. send at least one real prompt so the session has transcript history
3. click **Compact** from the user-visible actions menu
4. inspect both:
   - visible transcript state in the UI
   - `get_session_record(sessionId)` result from Tauri

Diagnosis guide:

- **UI click does nothing** → frontend wiring / action dispatch issue
- **Tauri command fails** → backend orchestration / runtime command issue
- **command succeeds but `get_session_record()` lacks a compaction system event** → session reload/parsing issue
- **UI shows success but durable record does not change** → frontend-only false positive or stale refresh problem

### B. Add a focused desktop E2E test for session controls

Recommended new test file:

- `tests/desktop-e2e/session-controls.test.ts`

Why a dedicated file instead of only extending `chat-nav.test.ts`:

- keeps session-control failures isolated and easier to debug
- makes the podman intent obvious
- allows stronger backend assertions without overloading a navigation-focused test

If a new file is added, also update both script lists in `package.json`:

- `test:desktop-e2e`
- `test:desktop-e2e:host`

### C. Assertions the new podman test should make

#### Manual compaction

Drive the real UI control:

- open `[data-role="session-actions-trigger"]`
- click `[data-role="session-action-compact"]`

Assert real outcomes, not just click success:

- UI transcript shows `Session compacted...`
- `get_session_record(sessionId)` includes a `system` event whose message starts with `Session compacted`
- that event came from the reloaded session record, proving the session JSONL changed and was reparsed
- `controlOperation` ends in `kind: "compact"`, `status: "succeeded"`

#### Manual reload

Drive the real UI control:

- click `[data-role="session-action-reload"]`

Assert real outcomes:

- same `sessionId` remains selected after reload
- UI shows `Session reloaded.`
- `get_session_record(sessionId).controlOperation` reports successful reload metadata
- sending another message after reload still works, proving the runtime/session remains usable

#### New session

Drive the real UI control:

- click `[data-role="session-action-new"]`

Assert real outcomes:

- selected `sessionId` changes
- the old session still exists in `list_sessions()`
- the new selected session is the one restored when returning to the same chat context
- if the flow is contextual/worker-owned, the rotation behavior remains contextual rather than degrading into a detached generic session

### D. Add diagnostics that make failures actionable

When polling for outcomes, include failure context in the thrown error payload:

- current selected session id
- old/new session ids
- transcript text snippet
- `controlOperation`
- recent session event messages from `get_session_record()`
- `controlCapabilities` / runtime details when relevant

That should make it obvious whether a failure is in:

- UI wiring
- Tauri command orchestration
- Pi runtime control support
- session file refresh/parsing

## Validation targets after implementation

Minimum targeted validation:

- the focused desktop test via podman
- any relevant unit/Rust tests touched by the implementation

Recommended commands:

- `./scripts/run-desktop-e2e-podman.sh tests/desktop-e2e/session-controls.test.ts`
- plus the directly affected unit test suites if runtime/parsing code changes

If the test is folded into an existing desktop test instead of a new file, run that specific file under podman and ensure the package scripts still include it in the suite.
