# ORC-44 bundled Pi runtime plan

## Intent

This follow-on plan narrows ORC-39 to the packaged-runtime slice: Orchestra should ship a pinned Pi runtime pack inside the app bundle, prefer that bundled runtime in packaged builds, stop depending on external `pi`/Node installs in packaged mode, and surface runtime health separately from auth/model setup failures.

The goal of this slice is **not** to redesign the full auth UX. It is to make the packaged app self-contained with respect to the Pi executable/runtime and to move Orchestra-owned Pi state under `~/.orchestra` so later auth/setup work has a stable home.

## Current-state audit

The repo currently has the right session/runtime architecture hooks, but packaged mode still depends on an external Pi install:

- `src-tauri/tauri.conf.json` bundles the Orchestra extension, mobile web assets, and the icon, but no Pi runtime pack.
- `src-tauri/build.rs` has a prebuild fallback only for `mobile/dist-web`; there is no equivalent packaged-runtime preparation or validation step.
- `src-tauri/src/services/pi_sessions.rs` resolves Pi by checking `ORCHESTRA_PI_EXECUTABLE`, a few common install paths, then the user login-shell PATH. That is the exact dependency chain we need to remove for packaged builds.
- `src-tauri/src/services/live_sessions.rs`, `src-tauri/src/services/pi_sessions.rs`, and `src-tauri/src/services/agent_terminal.rs` all spawn Pi processes, so all three surfaces need the same bundled-runtime/environment policy.
- `src-tauri/src/services/agent_terminal.rs` currently seeds a temporary `HOME/.pi/agent` from the user’s legacy `~/.pi/agent`, which keeps Orchestra tied to Pi’s default home instead of an Orchestra-owned agent dir.
- `src-tauri/src/state.rs`, `src-tauri/src/commands/app.rs`, `src/settings/AgentsPanel.tsx`, `src/settings/RolesPanel.tsx`, and `src/pages/SessionsPage.tsx` only expose a raw “PI executable” path/error. That conflates runtime availability with higher-level model/auth setup errors.

## Decision summary

1. **Packaged Orchestra should prefer a bundled Pi runtime whenever one is present.**
   - In packaged mode, Orchestra should stop relying on PATH/login-shell probing for Pi.
   - A manual override via `ORCHESTRA_PI_EXECUTABLE` can remain for developer/support use, but it should not be required for normal packaged operation.

2. **The bundled runtime pack should come from Pi’s standalone-binary build output.**
   - Upstream Pi already exposes a `build:binary` path that emits a compiled `pi` binary plus adjacent runtime assets.
   - Orchestra should bundle that emitted directory structure as an opaque runtime pack rather than reconstructing its contents manually.

3. **All Orchestra-launched Pi processes should receive `PI_CODING_AGENT_DIR`.**
   - Stable Orchestra-owned Pi home: `~/.orchestra/runtime/pi/agent`
   - This path becomes the default credential/settings/model store for live runtimes and RPC helper processes.
   - Temporary terminal isolation can stay, but it should be seeded from the Orchestra-owned agent dir and passed via `PI_CODING_AGENT_DIR`, not by depending on `~/.pi`.

4. **Runtime health should be a structured concept, distinct from auth/model readiness.**
   - “Bundled runtime missing/corrupt/incompatible” is a runtime-health problem.
   - “No credentials/models configured” is an auth/setup problem.
   - The UI should stop collapsing both into the same raw executable error string.

## Recommended bundled pack format

Bundle one platform/arch-specific runtime pack per Orchestra build under app resources.

### App resource layout

```text
Resources/
  extensions/
    orchestra-tools.ts
  mobile-web/
    ...
  pi-runtime/
    manifest.json
    runtime/
      pi
      package.json
      README.md
      CHANGELOG.md
      theme/
      assets/
      export-html/
      docs/
      examples/
      photon_rs_bg.wasm
```

Notes:
- The important rule is to preserve the layout emitted by Pi’s standalone-binary build path.
- The compiled Pi binary expects its bundled assets next to the executable directory, so Orchestra should copy the pack directory as-is instead of flattening it.
- The runtime directory should remain executable after bundling/signing.

### Manifest contents

Add a small manifest at `pi-runtime/manifest.json` so Orchestra can validate what it bundled and report it in diagnostics.

Suggested fields:

```json
{
  "schemaVersion": 1,
  "source": "pi-build-binary",
  "platform": "darwin",
  "arch": "arm64",
  "packageName": "@mariozechner/pi-coding-agent",
  "packageVersion": "0.60.0",
  "runtimeVersion": "0.60.0",
  "orchestraPackVersion": 1,
  "executableRelativePath": "runtime/pi",
  "packageDirRelativePath": "runtime",
  "builtAt": "2026-04-22T00:00:00Z",
  "sourceCommit": "<pi commit or release tag>",
  "notes": "Generated from Pi standalone-binary output"
}
```

Minimum requirements:
- platform
- arch
- packaged Pi version
- executable relative path
- package dir relative path
- source/build metadata for diagnostics

## Build and packaging plan

### 1. Produce the runtime pack before Tauri bundling

Add a small preparation step that copies a prebuilt Pi standalone pack into a stable generated directory inside the Orchestra repo, for example:

```text
src-tauri/gen/pi-runtime/
  manifest.json
  runtime/...
```

Recommended flow:
- release/CI builds produce or download the exact Pi standalone-binary artifact for the target platform/arch
- a helper script such as `scripts/prepare-bundled-pi-runtime.mjs` validates the input and stages it into `src-tauri/gen/pi-runtime/`
- `src-tauri/tauri.conf.json` adds that generated directory to bundle resources as `pi-runtime`
- `src-tauri/build.rs` validates that the generated manifest and executable exist when a packaged build is being created, and fails fast if they are missing or malformed

Why stage into a generated directory:
- `tauri.conf.json` is static, so it needs a stable path
- the binary pack should be build input, not hand-assembled during runtime
- the generated directory can be gitignored while still being deterministic for local release builds and CI

### 2. Keep the repo free of checked-in runtime binaries

The runtime pack should be treated like a release artifact, not committed source.

That keeps the repo smaller and makes it explicit that:
- the pack is platform/arch-specific
- the pack is pinned by build inputs/manifest metadata
- release automation owns provenance and refreshes

### 3. Preserve signing/notarization correctness

For macOS release builds, the nested `pi` executable must be bundled with executable permissions and survive Orchestra’s signing/notarization flow.

Validation should explicitly catch:
- missing executable bit
- missing nested asset files
- wrong platform/arch bundle
- signature/notarization regressions caused by unsigned nested code

## Runtime resolution plan

Introduce a dedicated runtime-resolution service instead of continuing to grow `pi_sessions.rs` directly.

Recommended new backend module:

```text
src-tauri/src/services/pi_runtime.rs
```

This service should own:
- bundled runtime manifest parsing
- bundled resource path resolution
- packaged-vs-dev resolution policy
- Orchestra-owned agent-dir resolution
- structured runtime health diagnostics
- helper methods for applying explicit Pi environment variables to spawned commands

### Resolution order

Recommended precedence:

1. `ORCHESTRA_PI_EXECUTABLE` override, if set and valid
2. bundled runtime from app resources, if present and valid
3. existing PATH/login-shell/system discovery **only in non-packaged development flows**

Packaged mode detection should be explicit, using Tauri’s packaged/dev signal rather than inferring from PATH behavior.

### Bundled runtime validation

Before Orchestra reports a bundled runtime as healthy, validate:
- manifest exists and parses
- manifest `platform`/`arch` match the running app
- bundled executable exists
- bundled executable is runnable
- optional: `pi --version` or equivalent returns successfully for the bundled binary

If any of these fail, surface a **bundled runtime** error category rather than falling through to PATH probing in packaged mode.

## Environment and path ownership plan

### Stable Orchestra Pi home

Add explicit path helpers under `src-tauri/src/services/orchestra_paths.rs` for:

```text
~/.orchestra/runtime/pi/
~/.orchestra/runtime/pi/agent/
```

That gives later auth/setup work a stable Orchestra-owned base and removes packaged-mode dependence on `~/.pi/agent`.

### Process launch contract

Every Orchestra-launched Pi process should use a shared helper that applies explicit runtime env vars after any login-shell environment merge.

That helper should at minimum set:
- `PI_CODING_AGENT_DIR=~/.orchestra/runtime/pi/agent` for normal live/runtime helper processes

Affected spawn surfaces:
- `src-tauri/src/services/live_sessions.rs`
- `src-tauri/src/services/pi_sessions.rs` RPC helper/query processes
- `src-tauri/src/services/agent_terminal.rs`

Important implementation note:
- `apply_user_shell_environment()` currently clears the command environment and rehydrates it from the login shell.
- Because of that, Orchestra-specific env vars like `PI_CODING_AGENT_DIR` must be applied **after** shell env hydration, or they will be lost.

### Terminal isolation update

`agent_terminal.rs` can keep its temporary isolated runtime home, but it should change from:
- copying from `~/.pi/agent`
- spoofing Pi’s default home layout

To:
- seeding from `~/.orchestra/runtime/pi/agent`
- passing the temporary directory via `PI_CODING_AGENT_DIR`
- treating legacy `~/.pi/agent` only as an optional one-time migration source

### Migration rule

For existing users, Orchestra should support a shallow migration/bootstrap rule:
- if `~/.orchestra/runtime/pi/agent` is missing or empty
- and legacy `~/.pi/agent` exists
- copy forward at least `auth.json`, `models.json`, and compatible `settings.json`

That keeps existing installs usable while establishing Orchestra ownership going forward.

## Diagnostics and UI plan

Replace the current “raw executable path/error” model with a structured runtime-health object.

### Proposed backend shape

Introduce a new diagnostic model along these lines:

```text
PiRuntimeHealth {
  source: bundled | override | system,
  mode: packaged | development,
  status: healthy | runtime_error,
  executablePath,
  packageDir,
  agentDir,
  version,
  build,
  manifestPath,
  errorKind,
  errorMessage
}
```

Suggested runtime error kinds:
- `bundled_runtime_missing`
- `bundled_runtime_invalid`
- `bundled_runtime_incompatible`
- `bundled_runtime_unexecutable`
- `override_not_found`
- `system_runtime_not_found`

Auth/setup problems should stay out of this type and be surfaced separately from model discovery / credential readiness.

### UI behavior

Update these surfaces to consume structured runtime health:
- `src/App.tsx` dispatch-blocked banner
- `src/settings/AgentsPanel.tsx`
- `src/settings/RolesPanel.tsx`
- `src/pages/SessionsPage.tsx`
- `src-tauri/src/commands/app.rs` and `src-tauri/src/models.rs`
- `src/types.ts` and `src/lib/tauri.ts`

Expected UX changes:
- packaged builds show **Bundled runtime** path + version/build metadata
- session runtime details identify the runtime source as bundled/override/system
- missing/corrupt bundled runtime errors are labeled as runtime packaging failures
- auth/model problems are shown separately and do not masquerade as “PI executable missing”

### Dispatch gating rule

`dispatchBlocked` should be driven by runtime health only.

That means:
- bundled runtime missing/corrupt => dispatch blocked
- no valid runtime executable => dispatch blocked
- no credentials/models configured => not a runtime-resolution failure, though model selection/setup may still need its own UI warning

## Recommended implementation sequence

1. **Add generated runtime pack input + manifest**
   - preparation script
   - gitignored generated directory
   - `tauri.conf.json` resource entry
   - `build.rs` validation

2. **Add a dedicated `pi_runtime` backend service**
   - bundled manifest parsing
   - packaged-mode resolution rules
   - Orchestra runtime path helpers
   - structured health diagnostics

3. **Route all Pi process spawns through the new runtime service**
   - `live_sessions.rs`
   - `pi_sessions.rs`
   - `agent_terminal.rs`
   - ensure `PI_CODING_AGENT_DIR` is always set explicitly

4. **Split runtime diagnostics from auth/model readiness in the UI/API**
   - replace/expand `PiExecutableDiagnostic`
   - report bundled runtime path/version/build
   - keep auth/model failures distinct

5. **Add validation coverage for packaged mode**
   - runtime resolution precedence tests
   - manifest validation tests
   - PATH-independent packaged launch tests
   - broken bundled pack diagnostics tests

## Validation plan

### Automated

Add or update tests to prove:

1. **Bundled runtime wins in packaged mode**
   - even when PATH also contains a `pi`
   - even when login-shell PATH discovery is disabled or empty

2. **Packaged mode no longer depends on external installs**
   - `PATH` stripped of `pi`
   - no global Node required
   - session/runtime creation still succeeds with bundled runtime

3. **Runtime health reports bundled metadata**
   - source = bundled
   - bundled executable path present
   - bundled version/build metadata present

4. **Bundled runtime failures stay distinct**
   - missing manifest/executable => runtime-health failure
   - auth/model errors do not present as bundled-runtime resolution errors

5. **All Pi process types receive `PI_CODING_AGENT_DIR`**
   - live RPC runtime
   - model listing / session helper RPC calls
   - agent terminal

### Manual release verification

For a packaged macOS build:
- install on a machine without global `pi`
- confirm session creation works
- confirm runtime details show bundled path/version
- confirm dispatch banner stays clear when the bundled runtime is healthy
- confirm a deliberately broken bundled pack produces a runtime-specific error

## Out of scope for this slice

These are related, but should remain separate unless implementation naturally overlaps:
- Orchestra-owned auth entry UX
- device-code/browser OAuth flows
- packaged-mode package installation policy for `npm:` / `git:` add-ons
- broader provider/model onboarding UX

This slice should, however, leave those follow-ons in a better place by moving Pi home ownership under `~/.orchestra/runtime/pi/agent` and by making runtime health a first-class concept.

## Approval target

Approve this plan if the implementation should proceed with:
- a generated, pinned standalone Pi runtime pack bundled into Tauri resources
- packaged-mode runtime resolution that prefers the bundle and avoids PATH probing
- explicit `PI_CODING_AGENT_DIR` ownership under `~/.orchestra/runtime/pi/agent`
- structured bundled-runtime diagnostics that are separate from auth/model setup failures
