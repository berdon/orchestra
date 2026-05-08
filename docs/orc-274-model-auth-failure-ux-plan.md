# ORC-274 — Model-auth failure UX + desktop E2E plan

## tl;dr
Current Pi setup gating only blocks obviously bad local setup (`auth.json`/`models.json` invalid, no models, missing Bun). Prompt-time provider-auth failures slip past that gate, then surface as raw Pi/session errors with no Harness CTA. Fix this by classifying model-auth failures in the backend/runtime path, emitting structured session errors, rendering them as an inline session banner with an `Open Settings → Harness` action, and covering the regression with a deterministic Podman desktop E2E fixture that removes `openai-codex` auth before prompting.

## Executive summary
The bad UX is not one bug in one layer; it is a gap between layers:

- `send_session_message` preflight only checks `require_pi_setup_ready()`.
- `PiSetupState` becomes `ready` as soon as Orchestra can parse local setup and see any available models.
- removing or expiring `openai-codex` auth after a session/model is already selected is therefore not blocked up front.
- when Pi later rejects the prompt, Orchestra currently treats that as an opaque/raw runtime error:
  - backend extracts only a string (`extract_rpc_error(...)`)
  - session stream emits a generic `error`
  - frontend turns that into a generic `sessionActionError`
  - the user gets a raw/generic banner with no explicit Harness setup destination

The implementation should normalize these failures into a first-class “model auth/setup required” error, keep the session out of a hanging/pending state, and give the user a direct path to `Settings → Harness → Setup`.

## Findings

### Current repro path
Primary regression scenario:
1. create/open a session using `openai-codex`.
2. remove the managed `openai-codex` credential (`remove_pi_provider_credential` / delete provider entry from managed `auth.json`).
3. send another prompt.

Current behavior from the existing code paths:
- preflight still passes if setup remains broadly `ready`.
- the runtime failure is propagated as a raw Pi/provider string.
- optimistic pending transcript state is cleared, but the surfaced error is still generic/raw and has no Harness CTA.

### Root cause by layer
- **Setup-state gating is too coarse.** `src-tauri/src/services/pi_setup.rs` only models invalid local files / no-model setup / package-source issues. It does not represent “selected provider auth became missing/expired/invalid at prompt time.”
- **Runtime error normalization is missing.** `src-tauri/src/services/live_sessions.rs` and `src-tauri/src/services/pi_sessions.rs` use `extract_rpc_error(...)` and forward only strings.
- **Session error propagation is generic.** `src/lib/sessionTranscriptReducer.ts` maps runtime `error` events to `sessionActionError` text, not a structured actionable state.
- **Frontend rendering has no setup-aware CTA path.** `ResourceStatusBanner` can show retry actions, and `SessionChatPanel` already has a setup banner, but prompt-time auth failures do not flow into either as a setup-specific error.
- **Harness deep-linking stops at the top-level tab.** `navigateToHarnessSettings()` only opens the Harness tab today; there is no explicit `Setup` sub-tab destination.

### Why this is a real product gap
The user-facing failure is not “your request was malformed” and not “Orchestra is offline.” It is “the selected model cannot authenticate right now, and the product knows where you should fix that.” Treating it as a raw session/runtime failure leaves the user to guess whether the problem is the prompt, the app, the model, or Pi itself.

## Intended semantics

### Classification
Introduce a normalized model-auth failure family with a stable code plus a finer-grained reason:
- `model_auth_required` + `reason: "missing"`
- `model_auth_required` + `reason: "expired"`
- `model_auth_required` + `reason: "invalid"`
- fallback: `model_auth_required` + `reason: "unknown"`

Include structured metadata when known:
- `providerId` (`openai-codex`)
- `providerName` (`OpenAI Codex`)
- `modelId` when known
- settings destination: `settingsTab: "harness"`, `detailTab: "setup"`

If the raw provider/runtime message is ambiguous, prefer the generic `unknown` auth-required variant over leaking the raw Pi error as primary UX.

### User-facing copy
Primary copy shape:
- **Missing auth:** `The selected model can’t run because OpenAI Codex isn’t connected in Harness.`
- **Expired auth:** `The selected model can’t run because the OpenAI Codex sign-in has expired.`
- **Invalid auth:** `The selected model can’t run because the OpenAI Codex credentials are invalid.`
- **Fallback:** `The selected model can’t run because Harness couldn’t authenticate OpenAI Codex.`

Support copy:
- `Reconnect OpenAI Codex in Settings → Harness → Setup, then retry.`

CTA label:
- `Open Settings → Harness`

Do not make raw file paths or raw provider error strings the primary user copy for this scenario.

### Presentation
- **Inline session banner/callout** for chat/session prompt failures.
  - place it in the session surface near the existing Pi setup banner / composer, not as a toast-only message.
  - reason: this is session-local, actionable, and should remain visible until the user acts or retries successfully.
- **No hanging state.** Any pending assistant/user placeholder for the failed run must clear.
- **Optional logs/details** can keep the raw provider error for diagnostics, but the main session UI should show normalized copy.

### Destination
The CTA should go to:
- `Settings → Harness → Setup`
- preferably with provider focus/scroll for `openai-codex` if easy

Opening only the top-level Harness tab is acceptable as a fallback, but the target semantics should be the `Setup` subsection.

## Implementation slices

### 1. Add shared backend auth-failure classification
Create a shared classifier for raw Pi/provider auth failures and use it anywhere Orchestra currently forwards raw runtime strings.

Recommended shape:
- new helper/service dedicated to Pi auth failures
- input: raw Pi/provider/runtime error string + optional provider/model context
- output: structured normalized error payload

Seed it with `openai-codex`-relevant pattern coverage for missing / expired / invalid auth, plus a generic provider-auth fallback.

### 2. Apply classification in both immediate and streamed session failures
Use the classifier in:
- `src-tauri/src/services/live_sessions.rs`
  - prompt response `success: false`
  - streamed assistant/runtime `error` events
  - process-end failures during an active run
- `src-tauri/src/commands/sessions.rs`
  - immediate `send_session_message` failures
  - any model-change path that should surface the same semantics

Goal: whether Pi fails immediately or after the run starts, the frontend gets the same normalized meaning.

### 3. Promote prompt-time auth failures to a first-class frontend state
Extend the session UI state so prompt failures can render a setup-aware inline banner instead of a generic page-level error.

Recommended direction:
- keep generic transport/load errors in `ResourceStatusBanner`
- add a session-local actionable error/problem state for prompt/runtime failures
- render that state inside `SessionChatPanel`
- clear it on successful retry, session switch, model switch, or Harness credential change

### 4. Add Harness deep-link support for the Setup subsection
Plumb an explicit Harness destination through the app shell:
- `navigateToHarnessSettings({ detailTab: "setup", providerId?: "openai-codex" })`
- make `HarnessPanel`/`SettingsSectionTabs` accept a controlled active detail tab when needed

### 5. Keep non-session Pi flows aligned
Apply the same normalized error semantics where practical for:
- agent/runtime entry points
- role/task dispatch paths that fail because selected model auth is bad

The chat/session flow is the primary acceptance target, but the classifier should be shared rather than duplicated.

## Podman desktop E2E strategy

### Recommendation
Do **not** make the supported Podman regression depend on the operator’s personal `.codex` / `~/.pi/agent/auth.json` state.

Current runner behavior (`scripts/run-desktop-e2e.sh`, `scripts/run-desktop-e2e-container-entry.sh`) imports host Pi auth/models and hardcodes the normal `pi` executable. That is fine for general desktop smoke coverage, but it is not durable enough for a supported auth-regression test.

### Deterministic regression approach
Add a repo-managed fake RPC Pi fixture for this spec and let the desktop Podman runner select it.

Fixture behavior should:
- advertise an `openai-codex/gpt-5.4` model
- persist session model changes
- inspect managed `auth.json`
- succeed while `openai-codex` auth is present
- fail prompt delivery with a raw provider-auth error once `openai-codex` auth is removed/marked expired/invalid

Then the desktop E2E should:
1. boot the app with the fixture runtime
2. create a session
3. select `openai-codex/gpt-5.4`
4. remove `openai-codex` auth through the real Harness command/path
5. send a prompt
6. assert:
   - the runtime hit the intended auth-failure branch
   - the product shows the normalized user-facing error
   - the CTA opens Harness setup
   - the session settles with no stale pending/spinner state

This keeps the regression deterministic while still exercising Orchestra’s real desktop/runtime/session/UI plumbing.

### Missing vs expired vs invalid coverage
- **Desktop E2E:** one primary removal/missing-auth scenario
- **Backend/unit tests:** explicit missing / expired / invalid string-classification coverage

That split keeps the desktop test durable without multiplying flaky provider-specific cases.

## Likely files
- `src-tauri/src/services/live_sessions.rs`
- `src-tauri/src/services/pi_sessions.rs`
- `src-tauri/src/commands/sessions.rs`
- `src-tauri/src/services/remote_api.rs` (if remote API error payloads are extended)
- `src/lib/sessionTranscriptReducer.ts`
- `src/lib/orchestraData/errors.ts`
- `src/components/SessionChatPanel.tsx`
- `src/pages/SessionsPage.tsx`
- `src/pages/AgentChatPage.tsx`
- `src/settings/HarnessPanel.tsx`
- `src/components/SettingsSectionTabs.tsx`
- `scripts/run-desktop-e2e-container-entry.sh`
- desktop E2E fixture/spec files under `tests/desktop-e2e/`

## Validation target
After the fix:
- missing/expired/invalid model auth no longer surfaces as an opaque Pi/runtime failure in the covered session flow
- the user sees provider-focused actionable copy
- the error includes a Harness CTA
- the UI clears pending state and settles cleanly
- Podman desktop coverage deterministically proves the regression path
