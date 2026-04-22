# ORC-45 — Orchestra-managed Pi auth and model setup plan

## Goal

Make Pi credential and model setup fully manageable from Orchestra so packaged Orchestra no longer depends on a separate personal `~/.pi/agent` setup.

This task should deliver:

- Orchestra-owned Pi auth/model UX
- Orchestra-owned Pi-compatible `auth.json` and `models.json` under `~/.orchestra/runtime/pi/agent`
- explicit one-time import from `~/.pi/agent`
- clear blocking/CTA behavior when Pi-backed flows are not ready

## Current state

### What Orchestra does today

Current Orchestra code still treats Pi auth/model state as external user setup:

- `src-tauri/src/services/pi_sessions.rs`
  - resolves `pi` from `ORCHESTRA_PI_EXECUTABLE`, common user bin locations, login-shell `PATH`, and `~/.pi/agent/bin/pi`
  - queries models by launching a fresh Pi RPC process via `get_available_models`
- `src-tauri/src/services/live_sessions.rs`
  - spawns live Pi runtimes with Orchestra’s extension, but does not set an Orchestra-owned Pi config directory
- `src-tauri/src/services/agent_terminal.rs`
  - creates a temporary home directory and explicitly copies `~/.pi/agent/auth.json`, `models.json`, and filtered `settings.json` into it before launching terminal Pi
- `src/settings/AgentsPanel.tsx` and `src/settings/RolesPanel.tsx`
  - load provider/model options by calling `listPiModels()` on mount
  - only show generic “Unable to load PI models” failures
- `src/App.tsx` and `src/components/SessionChatPanel.tsx`
  - session model selection assumes model state is already available and only shows “Loading models…” / “Choose a model”
- `src-tauri/src/services/harness_settings.rs`
  - only persists extra runtime extensions and compaction settings; there is no Orchestra-owned Pi setup state yet

So today Orchestra can use Pi if the user already configured Pi separately, but Orchestra itself does not own:

- credential entry
- OAuth/subscription connect
- model-source authoring
- migration from personal Pi state
- first-class readiness/error UI for missing setup

### What the bundled Pi package already supports

The currently installed Pi package provides the primitives Orchestra needs:

- `dist/config.js`
  - Pi resolves its agent directory from `PI_CODING_AGENT_DIR` and otherwise defaults to `~/.pi/agent`
- `dist/core/auth-storage.js`
  - `auth.json` storage for `api_key` and `oauth` credentials
  - file locking for safe token refresh/update behavior
  - `AuthStorage.create(customPath)` for non-default auth locations
- `dist/core/model-registry.js`
  - `models.json` loading/validation
  - “available models” = models whose providers have configured auth
  - built-in + custom provider support
- `@mariozechner/pi-ai` OAuth providers
  - built-in providers include Anthropic, GitHub Copilot, Google Gemini CLI, Google Antigravity, and OpenAI Codex
  - current login callbacks are `onAuth`, `onPrompt`, `onProgress`, and `onManualCodeInput`
  - browser/callback and device-code-style flows already exist, but today they are exposed for Pi’s own interactive UX, not Orchestra’s UI
- `dist/migrations.js`
  - Pi itself silently migrates older auth formats into `auth.json`

That means the main gap is not file format invention. The gap is Orchestra-side ownership, UX, readiness checks, and safe orchestration of these Pi primitives.

## Planning decisions

## 1) Orchestra should own a separate Pi agent home

Orchestra should stop treating `~/.pi/agent` as its active runtime config directory.

Recommended Orchestra-owned root:

- `~/.orchestra/runtime/pi/agent/auth.json`
- `~/.orchestra/runtime/pi/agent/models.json`
- `~/.orchestra/runtime/pi/agent/settings.json` only if Orchestra intentionally needs Pi-side settings there
- any runtime-managed Pi files under the same Orchestra-owned agent root

All Orchestra-started Pi processes should receive the same Orchestra-owned agent directory via `PI_CODING_AGENT_DIR`.

That applies to:

- model discovery/query processes
- live session runtimes
- terminal-attached Pi sessions
- any helper process used for setup/login/validation

`~/.pi/agent` becomes legacy import source only, not active Orchestra state.

## 2) Do not reimplement Pi auth/model semantics directly in Rust

The safest path is to reuse Pi’s own storage and provider logic rather than hand-maintaining file semantics in multiple places.

Recommended architecture:

- add an Orchestra-owned **Pi setup helper** that runs against the bundled Pi package/runtime
- the helper uses Pi SDK primitives such as `AuthStorage`, `ModelRegistry`, and built-in OAuth provider implementations
- Orchestra’s Rust/Tauri backend calls that helper through a structured JSON interface

Why this is the better boundary:

- `auth.json` writes and OAuth refreshes already use locking in Pi’s `AuthStorage`
- Pi already understands provider/model availability rules
- Pi already knows built-in OAuth providers and credential formats
- Orchestra stays aligned with Pi-compatible file formats without reverse-engineering them in Rust

### Recommended helper responsibilities

The helper should support commands roughly like:

- `get_setup_state`
  - active agent dir
  - auth/model file presence
  - parsed/validation errors
  - built-in provider catalog
  - connected providers
  - available models
  - legacy import availability
- `set_api_key`
  - persist/update an `api_key` credential in Orchestra-owned `auth.json`
- `remove_credential`
- `get_models_json`
- `save_models_json`
  - validate before commit
  - write atomically
- `preview_legacy_import`
- `import_legacy_config`
- `start_oauth_flow`
  - emit structured progress/auth/prompt events
- `submit_oauth_input`
- `cancel_oauth_flow`

### Packaging expectation

This helper should be packaged alongside the Orchestra-managed Pi runtime pack, not assumed to come from an external Node/npm install.

If ORC-39 lands on a standalone Pi binary pack, the recommended solution is to package a companion helper artifact from the same Pi codebase/runtime pack rather than introducing a fresh external Node dependency.

## 3) Orchestra needs a first-class Pi setup state model

Add a dedicated backend/frontend setup state instead of overloading “PI executable available” or raw model-list failures.

Suggested shape:

```ts
interface PiSetupState {
  status: "ready" | "needs_setup" | "invalid" | "legacy_import_available";
  agentDir: string;
  authPath: string;
  modelsPath: string;
  legacyAgentDir?: string | null;
  availableProviders: PiProviderSetupSummary[];
  availableModels: SessionModel[];
  issues: PiSetupIssue[];
  warnings: PiSetupIssue[];
  importState: {
    canImportLegacy: boolean;
    importedAt?: string | null;
    dismissedAt?: string | null;
  };
}

interface PiProviderSetupSummary {
  id: string;
  name: string;
  authModes: Array<"api_key" | "oauth">;
  connected: boolean;
  usingOAuth: boolean;
  modelCount: number;
  usesCallbackServer?: boolean;
}

interface PiSetupIssue {
  code:
    | "no_available_models"
    | "auth_json_invalid"
    | "models_json_invalid"
    | "selected_model_unavailable"
    | "provider_not_connected"
    | "legacy_import_available";
  message: string;
  providerId?: string;
  modelId?: string;
}
```

Important rule:

- **`ready`** means Orchestra can actually present at least one usable Pi model
- **`invalid`** means config files exist but cannot be parsed/validated or cannot satisfy selected provider/model requirements
- **`needs_setup`** means Orchestra-owned config is empty or incomplete
- **`legacy_import_available`** means the user has not configured Orchestra-owned state yet, but a personal Pi setup is available to import explicitly

## 4) Add a dedicated Orchestra Pi settings surface

This work is larger than the current “PI settings” block in `GeneralPanel`.

Recommended product structure:

- add a dedicated **Settings → Pi** tab
- move or duplicate the existing runtime-only settings there so all Pi concerns live together
- keep current General settings focused on general app/runtime behavior

### Recommended Pi settings sections

#### A. Setup status

Show:

- overall readiness badge
- active Orchestra-owned agent directory path
- auth/model file paths
- last validation result
- “Import existing Pi setup” CTA when legacy import is available

#### B. Built-in provider connections

Provider cards for built-in Pi providers with per-provider actions:

- **Connect with API key**
- **Connect subscription / OAuth**
- **Disconnect**
- show currently available model count once connected

This should cover common built-in providers such as:

- Anthropic
- OpenAI
- OpenAI Codex subscription
- GitHub Copilot
- Google Gemini / Antigravity
- other Pi built-ins that expose API key or OAuth auth modes

#### C. Custom model providers

Users still need Orchestra-native setup for provider-backed models configured through `models.json`.

Recommended v1 split:

- **structured wizard** for common custom provider-backed cases
  - provider label
  - base URL
  - API type (`openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai`)
  - API key/header auth fields
  - model ids and names
- **advanced raw `models.json` editor/fallback**
  - needed for imported advanced configs
  - needed for headers, shell-command resolution, compat overrides, and other Pi features Orchestra does not fully model in v1

This keeps the common path user-friendly without losing full Pi compatibility.

#### D. Legacy import

If `~/.pi/agent/auth.json` and/or `models.json` exist and Orchestra-owned files have not been adopted yet, show:

- what can be imported
- overwrite behavior
- explicit confirmation
- a one-time import record

Import should be:

- **explicit**
- **one-time**
- **not live-synced** afterward

## 5) OAuth/subscription connect should be Orchestra-started and event-driven

Orchestra should start OAuth flows itself and render their progress in app UI.

### Backend flow model

Add an ephemeral OAuth flow registry in the Tauri backend.

Suggested lifecycle:

1. frontend calls `start_pi_oauth_flow(providerId)`
2. backend starts helper task for that provider
3. helper emits structured events such as:
   - `open_url`
   - `device_code`
   - `prompt`
   - `progress`
   - `completed`
   - `failed`
   - `cancelled`
4. frontend renders the modal/wizard UI and can submit manual input via `submit_pi_oauth_flow_input(flowId, value)`
5. backend persists credentials through the helper into Orchestra-owned `auth.json`
6. backend emits `pi_setup.updated`

### UX requirements

For browser/callback flows:

- open the provider URL from Orchestra
- show a waiting state
- support manual callback/code paste when the browser is on another machine or callback binding fails

For device-code flows:

- show verification URL prominently
- show the user code as a first-class field, not buried in a generic error string
- provide copy buttons
- keep a visible waiting/progress state while polling

### Important implementation note

Current Pi callback types are generic (`onAuth`, `onPrompt`, `onProgress`, `onManualCodeInput`).

For a good Orchestra UX, the helper should normalize built-in provider flows into structured events instead of making the frontend parse free-form instructions text.

That normalization can be built-in-provider-specific, with a generic fallback for any other OAuth provider.

## 6) Legacy import from `~/.pi/agent` must be explicit and user-controlled

Import rules should be strict:

- only import when the user clicks the CTA and confirms
- default source is `~/.pi/agent`
- only import Pi auth/model artifacts relevant to this task
  - `auth.json`
  - `models.json`
- do not auto-switch back and forth between personal Pi state and Orchestra-owned state
- after import, record that import happened and stop nagging on every launch
- still allow re-import from settings as an explicit action

### Recommended import behavior

- if Orchestra-owned `auth.json`/`models.json` are absent:
  - offer “Import existing Pi setup”
- if Orchestra-owned files already exist:
  - offer “Import and replace” only behind a stronger confirmation
- show what will be copied before committing
- preserve advanced `models.json` content exactly unless the user edits it later inside Orchestra

This is intentionally different from Pi’s internal silent migrations. ORC-45 must keep migration visible and user-approved.

## 7) Pi-backed flows should block with explicit setup CTA, not generic errors

Today most surfaces collapse into “PI unavailable” or “Unable to load PI models.”

Add a second readiness layer beyond executable availability:

- `sync_pi_runtime_health()` continues to answer “can Orchestra start Pi at all?”
- new Pi setup/readiness checks answer “does Orchestra have valid auth/model configuration for this flow?”

### Blocking touchpoints

Add setup/readiness checks and better errors in:

- `src-tauri/src/commands/sessions.rs`
  - session creation / contextual session creation / session model changes when selected provider or model is unavailable
- `src-tauri/src/commands/agent_runtime.rs`
  - opening/ensuring agent sessions
- `src-tauri/src/commands/role_dispatch.rs`
  - queue dispatch
- `src-tauri/src/commands/tasks.rs`
  - task lane dispatch
- `src/settings/AgentsPanel.tsx`
- `src/settings/RolesPanel.tsx`
- `src/components/SessionChatPanel.tsx`
- any session/chat surface that lets the user choose a model or send a prompt through Pi

### UX behavior

Instead of empty selects or opaque errors, show:

- why the flow is blocked
- which provider/model is affected when known
- a CTA that deep-links to **Settings → Pi**

Examples:

- “No Pi models are configured yet. Set up a provider in Settings → Pi.”
- “Anthropic credentials are missing for the selected model. Reconnect Anthropic in Settings → Pi.”
- “`models.json` is invalid. Fix it in Settings → Pi before dispatching Pi-backed work.”

## 8) Setup changes must invalidate model caches and refresh runtimes deliberately

Fresh one-shot model queries already launch a new Pi process, so they can see updated auth/model files immediately once Orchestra starts setting `PI_CODING_AGENT_DIR`.

Live runtimes are trickier:

- Pi live runtimes keep in-memory auth/model registries
- `get_available_models` on a live runtime does not automatically refresh from disk

Recommended behavior after setup changes:

- emit `pi_setup.updated` from the backend
- clear frontend model-state caches
- refresh roles/agents/settings model lists immediately from fresh helper/query state
- for active live runtimes:
  - preferred: add a lightweight config refresh / registry refresh command in the packaged Pi runtime helper path
  - acceptable fallback: mark runtimes stale and reload/respawn them the next time model-dependent interaction occurs while idle
- if a session is busy, do not interrupt the current run; show that new setup applies after reload/next idle refresh

## 9) Preserve Pi compatibility, but keep Orchestra metadata separate from secrets

Pi-compatible source of truth should stay in the Pi files:

- `auth.json`
- `models.json`

Orchestra may keep **non-secret metadata** elsewhere, for example in `~/.orchestra/settings.json`, such as:

- legacy import dismissed/imported timestamps
- last successful validation timestamp
- last non-secret validation summary

Do **not** duplicate raw API keys or OAuth tokens into Orchestra UI settings or local browser storage.

### File handling rules

- `auth.json` should remain user-private (`0600`)
- `models.json` should also be written with restrictive permissions because it can contain literal credentials, header secrets, or shell-command auth resolution
- writes should be atomic
- logs and UI errors must redact secrets

## Recommended implementation sequence

## 1. Path + backend setup groundwork

- add Orchestra path helpers for the Pi runtime root/agent dir in `src-tauri/src/services/orchestra_paths.rs`
- introduce backend services for Pi setup state and Pi helper invocation
- define new types in `src/types.ts` / Rust models for setup state, provider summaries, setup issues, import preview, and OAuth flow state
- add a dedicated settings tab id and route for Pi setup

## 2. Orchestra-owned Pi helper integration

- add the packaged helper entrypoint/artifact
- implement helper commands for state, API-key writes, legacy import, and models.json load/save/validate
- add OAuth flow orchestration between frontend, Tauri backend, and helper

## 3. Runtime/process integration

- update all Orchestra-started Pi invocations to use `PI_CODING_AGENT_DIR=~/.orchestra/runtime/pi/agent`
- update terminal-attached sessions to stop copying from `~/.pi/agent`
- refresh runtime/model caches after setup changes

## 4. Settings UI

- create Settings → Pi tab/panel
- implement provider connection cards
- implement custom model provider authoring plus advanced raw editor fallback
- implement legacy import preview/confirm flow

## 5. CTA/blocking integration

- replace generic model-loading failures with setup-aware empty/error states
- add deep-link CTA wiring from agents/roles/sessions/dispatch flows to Settings → Pi
- add targeted backend error codes/messages for selected provider/model readiness failures

## 6. Test and harden

- unit tests for path resolution, import metadata, setup-state derivation, error mapping
- helper tests for auth/model write behavior and OAuth event normalization
- frontend tests for CTA states and settings flows
- desktop E2E coverage for fresh install, API-key connect, OAuth connect, legacy import, invalid models.json, and active-session refresh behavior

## Concrete Orchestra touchpoints

### Backend

- `src-tauri/src/services/orchestra_paths.rs`
- new service(s), likely something like:
  - `src-tauri/src/services/pi_setup.rs`
  - `src-tauri/src/services/pi_setup_helper.rs`
  - `src-tauri/src/services/pi_setup_settings.rs`
- `src-tauri/src/commands/app.rs`
  - expose setup-state and mutation commands
- `src-tauri/src/services/pi_sessions.rs`
  - stop assuming personal `~/.pi` config
- `src-tauri/src/services/live_sessions.rs`
  - pass Orchestra-owned Pi agent dir to live runtimes
- `src-tauri/src/services/agent_terminal.rs`
  - stop copying from `~/.pi/agent`
- `src-tauri/src/commands/sessions.rs`
- `src-tauri/src/commands/agent_runtime.rs`
- `src-tauri/src/commands/role_dispatch.rs`
- `src-tauri/src/commands/tasks.rs`

### Frontend

- `src/App.tsx`
  - settings-tab routing, Pi setup state loading, CTA deep links
- `src/lib/tauri.ts`
  - new Tauri bindings
- `src/types.ts`
- new panel/component(s), likely something like:
  - `src/settings/PiPanel.tsx`
  - `src/components/PiSetupStatusCard.tsx`
  - `src/components/PiOAuthFlowDialog.tsx`
- `src/settings/AgentsPanel.tsx`
- `src/settings/RolesPanel.tsx`
- `src/components/SessionChatPanel.tsx`

### Tests

- `tests/e2e/agents.spec.ts`
- `tests/e2e/roles.spec.ts`
- `tests/e2e/sessions.spec.ts`
- new Pi setup web/desktop tests
- `tests/desktop-e2e/*` coverage for setup/import/OAuth/CTA paths

## Validation plan

A clean Orchestra install should be able to:

1. open Settings → Pi and see an explicit setup-needed state
2. connect at least one built-in provider using an API key entirely in Orchestra
3. connect at least one OAuth/subscription provider entirely in Orchestra
4. add or import model sources into Orchestra-owned `models.json`
5. create/dispatch Pi-backed work without touching `~/.pi/agent`
6. import a legacy personal Pi setup only after explicit confirmation
7. show a clear CTA instead of a generic failure when config is missing or invalid

## Non-goals / scope guardrails

To keep ORC-45 focused:

- do not silently sync Orchestra state back to `~/.pi/agent`
- do not require full structured editor parity for every advanced `models.json` feature in v1, as long as Orchestra preserves advanced configs and offers an advanced fallback editor
- do not re-solve the bundled Pi executable/package distribution strategy here; consume the ORC-39 runtime-pack direction and make auth/model ownership work with it

## Recommended outcome

The recommended implementation is:

- Orchestra-owned Pi agent home under `~/.orchestra/runtime/pi/agent`
- a packaged Pi setup helper that reuses Pi’s own auth/model/OAuth primitives
- a dedicated Settings → Pi UX for built-in provider connections, custom model setup, and explicit legacy import
- setup-aware blocking/CTA behavior across agent, role, session, and dispatch flows
- deliberate cache/runtime refresh behavior after setup changes

That gives Orchestra full ownership of Pi auth/model setup without forking Pi file semantics or depending on the user’s personal `~/.pi` state.