# ORC-34 — packaged-mode Pi runtime UX, migration, and add-on policy plan

## Goal

Make packaged Orchestra self-contained for Pi auth/config ownership and packaged-mode add-on policy.

Specifically, this ticket should:

- separate bundled-runtime failures from auth/config failures in Orchestra diagnostics and banners
- stop depending on the user’s `~/.pi/agent` during normal session and terminal flows
- provide an explicit import path for legacy `auth.json` and `models.json`
- reject packaged-mode add-on sources that still depend on npm/git/package-manager behavior
- keep allowed add-ons explicit as either local filesystem paths or Orchestra-bundled resource paths

## Current state

### Runtime diagnostics are executable-centric, not ownership-centric

Current runtime health only answers “can Orchestra resolve a pi executable?”

Relevant code paths:

- `src-tauri/src/state.rs` — `AppState::sync_pi_runtime_health()`
- `src-tauri/src/services/pi_sessions.rs` — `resolve_pi_executable(...)`
- `src-tauri/src/commands/app.rs` — `build_app_info()`, `get_pi_executable_diagnostic()`
- `src/App.tsx` — global `dispatchBlockedReason` banner
- `src/settings/AgentsPanel.tsx` / `src/settings/RolesPanel.tsx` — "PI executable" diagnostic copy

Today this means:

- the top-level app banner only knows that dispatching is blocked because PI is unavailable
- agent/role settings only show an executable path or executable-resolution error
- auth/config problems are not modeled separately from runtime resolution problems
- packaged-mode failures cannot be described as “bundled runtime missing/corrupt” versus “runtime exists but Orchestra auth/config is missing or invalid”

### Orchestra-managed session files already exist, but Pi config ownership is still split

Orchestra already manages session JSONL files under `~/.orchestra/projects/.../sessions`, but Pi config/auth is still implicitly resolved from the user’s personal Pi home.

Relevant code paths:

- `src-tauri/src/services/pi_sessions.rs` — Orchestra-managed session directories
- `src-tauri/src/services/harness_settings.rs` — Orchestra-managed runtime settings under `~/.orchestra/settings.json`
- `src-tauri/src/services/live_sessions.rs` — live runtime spawn
- `src-tauri/src/services/agent_terminal.rs` — embedded terminal spawn

The biggest remaining packaged-mode leak is the embedded terminal flow:

- `agent_terminal.rs` copies `~/.pi/agent/auth.json`
- copies `~/.pi/agent/models.json`
- copies `~/.pi/agent/settings.json`
- rewrites `HOME` to a temp directory so the terminal session can run against that copied state

That is effectively an accidental migration path and makes packaged mode depend on the user’s personal Pi home.

### Add-on handling is currently too permissive for packaged mode

Current add-on behavior is split across two paths:

1. `src-tauri/src/services/harness_settings.rs`
   - stores `extra_extensions` as free-form strings in Orchestra settings
   - only trims/deduplicates entries
2. `src-tauri/src/services/live_sessions.rs`
   - passes each entry directly as `--extension <value>`
3. `src-tauri/src/services/agent_terminal.rs`
   - copies Pi `settings.json`, which can contain package-driven add-on configuration

This means packaged mode currently has no clear source policy.

It can still inherit package-manager assumptions from legacy Pi config, while the UI copy still suggests inputs like:

- `npm:my-extension`
- `./extensions/local-extension.ts`

## Upstream Pi constraints this ticket should honor

The upstream Pi runtime already provides the primitives Orchestra needs:

- Pi supports `PI_CODING_AGENT_DIR` to override the default `~/.pi/agent` config directory.
- Pi supports custom auth/model locations through `auth.json` and `models.json` ownership.
- Pi package sources (`npm:` / `git:` and related package-manager flows) are tied to `settings.json` package behavior and external package installation/update semantics.

That means Orchestra does **not** need to keep cloning `~/.pi/agent` into temp homes. It can own a stable Pi agent directory directly.

## Planning decisions

### 1) Introduce a canonical Orchestra-owned Pi agent directory

Add Orchestra path helpers for Pi runtime ownership under the Orchestra root.

Recommended layout:

```text
~/.orchestra/runtime/pi/agent/
  auth.json
  models.json
  settings.json
```

Recommended helper additions in `src-tauri/src/services/orchestra_paths.rs`:

- `orchestra_runtime_root(root)` → `~/.orchestra/runtime`
- `orchestra_pi_root(root)` → `~/.orchestra/runtime/pi`
- `orchestra_pi_agent_dir(root)` → `~/.orchestra/runtime/pi/agent`
- `orchestra_pi_auth_path(root)` → `.../auth.json`
- `orchestra_pi_models_path(root)` → `.../models.json`
- `orchestra_pi_settings_path(root)` → `.../settings.json`

This becomes the single Pi config/auth home for all Orchestra-spawned subprocesses.

### 2) Centralize Pi runtime context instead of resolving pieces ad hoc

Introduce one backend helper that resolves the full Orchestra Pi runtime context, not just the executable path.

Suggested shape:

```rust
struct ResolvedPiRuntimeContext {
    executable_path: PathBuf,
    runtime_source: PiRuntimeSource,
    packaged_mode: bool,
    orchestra_extension_path: PathBuf,
    orchestra_root: PathBuf,
    pi_agent_dir: PathBuf,
    pi_auth_path: PathBuf,
    pi_models_path: PathBuf,
    pi_settings_path: PathBuf,
}
```

Suggested `PiRuntimeSource` values:

- `bundled`
- `external_override`
- `external_path_lookup`

This helper should be used by:

- `AppState::sync_pi_runtime_health()`
- `list_available_models()` / model discovery
- live runtime spawn in `live_sessions.rs`
- embedded terminal spawn in `agent_terminal.rs`
- any future auth/setup flows

This keeps packaged-mode detection and resource ownership consistent across the app.

### 3) Separate runtime diagnostics from auth/config diagnostics

Replace the current executable-only diagnostic model with a structured runtime diagnostic contract.

Suggested backend model:

```rust
struct PiRuntimeDiagnostics {
    runtime: PiRuntimeStatus,
    auth: PiAuthStatus,
    add_ons: PiAddOnPolicyStatus,
}
```

Suggested intent:

#### Runtime status

Answers:

- can Orchestra resolve the runtime executable?
- is the runtime expected to be bundled or external?
- what exact executable path/resource path did Orchestra resolve?
- is the failure a bundled-runtime problem or a generic external-resolution problem?

#### Auth status

Answers:

- which Pi agent directory Orchestra is using
- whether Orchestra-managed `auth.json` / `models.json` exist
- whether they parsed successfully
- whether legacy import is available from `~/.pi/agent`
- whether the user is missing Orchestra-managed auth entirely versus already imported/configured it

#### Add-on policy status

Answers:

- whether Orchestra is in packaged mode
- whether current configured add-ons contain unsupported sources
- which entries are blocked, ignored, or allowed

### 4) Drive different UI surfaces from different failure classes

#### Global app banner

Keep the current hard blocking banner for runtime unavailability, but make the copy explicit:

- **Bundled runtime unavailable** when `runtime_source == bundled` and resolution failed
- **PI runtime unavailable** for unbundled/dev external resolution failures

Do **not** reuse this banner for auth/config problems.

#### Separate auth/setup banner

Add a second banner or settings callout for auth/config state, for example:

- “Orchestra Pi auth is not configured yet.”
- “Import existing Pi auth/models from `~/.pi/agent`.”
- “Orchestra is using `~/.orchestra/runtime/pi/agent`.”

This should point users toward setup/import rather than implying the bundled runtime itself is broken.

#### Agent/Role settings diagnostics

Replace the current executable-only text with a richer summary:

- runtime source (`bundled` vs `external`)
- executable path
- Orchestra Pi agent dir path
- auth/model import state

#### Session runtime details

Extend runtime details so the user can see:

- runtime source
- Orchestra Pi agent dir
- loaded extension source classification (`bundled`, `local_path`, `blocked_package_source`)
- notes when packaged mode rejected unsupported sources

### 5) Remove `~/.pi/agent` copy-based assumptions from all Orchestra-spawned Pi flows

Every Orchestra-spawned Pi process should use the Orchestra-owned Pi agent directory via `PI_CODING_AGENT_DIR`.

That includes:

- live RPC sessions
- model discovery
- embedded terminal sessions
- any helper subprocess used to query runtime state

#### Embedded terminal change

`src-tauri/src/services/agent_terminal.rs` should stop:

- creating a temp home just to clone Pi config
- copying `auth.json`, `models.json`, or `settings.json` from `~/.pi/agent`
- treating the user’s Pi home as the implicit source of truth

Instead it should:

- keep the user shell environment for PATH and shell behavior
- set `PI_CODING_AGENT_DIR` to the Orchestra-owned path
- rely on Orchestra-authored `auth.json`, `models.json`, and `settings.json`

#### Session/model discovery change

`src-tauri/src/services/pi_sessions.rs` and `src-tauri/src/services/live_sessions.rs` should use the same Orchestra-owned Pi agent dir so model listing, runtime details, and real sessions all observe the same auth/config state.

### 6) Make legacy import explicit, one-way, and per-file

Add a dedicated import/migration flow for the legacy Pi home.

Rules:

- detect legacy `~/.pi/agent/auth.json`
- detect legacy `~/.pi/agent/models.json`
- offer import only when the Orchestra-managed target file is absent or the user explicitly re-runs import
- never auto-copy during terminal spawn, session spawn, or runtime health checks
- do not delete or mutate the legacy source files

Recommended import behavior:

- import `auth.json` independently
- import `models.json` independently
- surface exactly which files were imported
- record import state in Orchestra-managed settings so the prompt is explicit rather than accidental/repeated forever

Recommended persistence location:

- `~/.orchestra/settings.json`
- under a small `harness.piMigration` or similarly named section

Suggested stored state:

- `legacyAgentDir`
- `authImportedAt`
- `modelsImportedAt`
- `dismissedAt`
- `lastDetectedAt`

### 7) Do not import legacy `settings.json`

This ticket should **not** auto-import `~/.pi/agent/settings.json`.

Reason:

- `settings.json` is where package-manager add-on behavior lives
- importing it blindly would reintroduce the exact packaged-mode policy leak this ticket is supposed to close
- it would also pull unrelated personal Pi behavior into Orchestra by accident

Instead, Orchestra should author its own minimal Pi `settings.json` for the Orchestra-owned agent dir.

That file should contain only the settings Orchestra intentionally owns for this integration slice.

### 8) Gate packaged-mode add-on sources by source kind, not just by raw string reuse

Add a classifier for user-configured add-on entries.

Suggested allowed classes:

- `local_path`
  - relative filesystem paths
  - absolute filesystem paths
  - `~`-expanded filesystem paths
- `bundled_path`
  - app-bundled resource paths resolved by Orchestra to explicit absolute paths before launch

Suggested rejected classes in packaged mode:

- `npm_source`
- `git_source`
- raw remote URLs
- any other non-path package shorthand that still implies package-manager behavior

This is the key product rule:

> packaged mode only allows explicit local filesystem paths and explicit Orchestra-bundled resource paths.

Everything else should fail clearly.

### 9) Enforce add-on policy in two places

#### Save-time validation

When the user saves PI runtime settings:

- classify each entry
- reject unsupported packaged-mode sources immediately
- tell the user which entries are unsupported and why

Touchpoints:

- `src-tauri/src/services/harness_settings.rs`
- `src/lib/harnessSettings.ts`
- `src/settings/GeneralPanel.tsx`
- `src/App.tsx`

#### Spawn-time validation/sanitization

Even with save-time validation, Orchestra should also protect itself from stale or hand-edited config.

Before spawning a runtime or terminal:

- reclassify configured entries
- reject or strip unsupported packaged-mode sources
- include a clear runtime note / log entry / surfaced error

This prevents old invalid data from silently slipping through.

### 10) Keep terminal add-ons explicit too

The embedded terminal path must not bypass the add-on policy.

Because the terminal currently relies on Pi `settings.json`, Orchestra should generate or maintain an Orchestra-owned `settings.json` that contains only allowed, explicit add-ons.

In packaged mode that means:

- no inherited `packages` from the user’s personal Pi home
- no `npm:` / `git:` package sources
- only explicit local or bundled paths that Orchestra resolved itself

## Implementation touchpoints

### Backend

- `src-tauri/src/services/orchestra_paths.rs`
  - add Orchestra Pi runtime/config path helpers
- `src-tauri/src/services/pi_sessions.rs`
  - central runtime context resolver
  - model discovery environment ownership
  - error classification helpers
- `src-tauri/src/state.rs`
  - replace executable-only health with structured runtime diagnostics
- `src-tauri/src/services/live_sessions.rs`
  - use shared runtime context
  - classify add-on sources
  - surface richer runtime details
- `src-tauri/src/services/agent_terminal.rs`
  - remove temp HOME copy strategy
  - use Orchestra-owned Pi agent dir
  - synthesize/minimize Orchestra-owned Pi settings
- `src-tauri/src/services/harness_settings.rs`
  - validate/classify allowed add-on entries
  - record migration state if stored alongside harness settings
- `src-tauri/src/commands/app.rs`
  - expose structured diagnostics + import commands
- `src-tauri/src/models.rs`
  - add richer diagnostics/runtime-detail models

### Frontend

- `src/App.tsx`
  - separate runtime-block banner from auth/setup banner
- `src/settings/GeneralPanel.tsx`
  - explicit import CTA/state
  - packaged-mode add-on validation copy
- `src/settings/AgentsPanel.tsx`
- `src/settings/RolesPanel.tsx`
  - richer runtime/auth diagnostics instead of executable-only text
- `src/pages/SessionsPage.tsx`
  - runtime source, config dir, and add-on source labeling
- `src/types.ts`
  - updated diagnostics/runtime detail types
- `src/lib/harnessSettings.ts`
  - frontend parity for source classification in browser mode tests

## Error-classification guidance

Where Orchestra only receives a raw Pi error string, classify it before surfacing it.

Suggested buckets:

- `runtime_unavailable`
- `bundled_runtime_missing`
- `auth_missing`
- `auth_invalid`
- `add_on_policy_blocked`
- `other`

Preference order:

1. use explicit file/state checks when possible
2. use runtime-source metadata for bundled vs external failures
3. fall back to string classification only when Pi returns a raw auth/provider error

This keeps Orchestra from presenting “bundled runtime is broken” when the real problem is “you have not imported or configured auth yet.”

## Validation plan

### Backend/unit coverage

Add coverage for:

- Orchestra Pi path helpers resolving under `~/.orchestra/runtime/pi/agent`
- runtime context resolution and runtime-source classification
- legacy import detection for `auth.json` and `models.json`
- import copy behavior and persisted migration state
- add-on source classification (`local`, `bundled`, blocked package/remote sources)
- packaged-mode save-time validation
- spawn-time rejection of stale unsupported add-on entries
- terminal/model-discovery subprocess environment using `PI_CODING_AGENT_DIR`
- terminal no longer copying from `~/.pi/agent`

### Frontend/browser coverage

Add/update coverage for:

- runtime-block banner copy vs auth/setup banner copy
- General settings import CTA and packaged-mode validation errors
- session runtime details showing runtime source and add-on source labels

### Desktop end-to-end coverage

Add packaged-mode-focused desktop coverage for:

- missing bundled runtime → runtime banner, not auth banner
- missing Orchestra auth with bundled runtime present → auth/setup banner, not runtime banner
- importing legacy `auth.json` / `models.json` into Orchestra-owned paths
- rejecting `npm:` / `git:` add-ons in packaged mode while allowing explicit local paths
- embedded terminal using Orchestra-owned auth/config after import rather than personal `~/.pi/agent`

## Recommended implementation order

1. add Orchestra Pi path helpers and shared runtime context resolution
2. replace executable-only diagnostics with structured runtime/auth diagnostics
3. switch live sessions, model discovery, and terminal spawn to `PI_CODING_AGENT_DIR`
4. add explicit legacy import detection + import commands/state
5. add packaged-mode add-on classification and save-time/spawn-time enforcement
6. update runtime details, settings copy, banners, and tests

## Coordination notes

This ticket should align with the broader ORC-39 split:

- the bundled-runtime ticket should provide or reuse the shared runtime-source resolver so packaged-mode detection is not duplicated
- the auth/model setup ticket should write into the same Orchestra-owned `auth.json` / `models.json` paths defined here

The important outcome for ORC-34 is not merely “better copy.” It is a change in ownership:

- Orchestra owns the Pi config/auth directory it launches against
- migration from personal Pi state is explicit and optional
- packaged-mode unsupported add-on sources fail clearly instead of leaking through legacy Pi behavior
