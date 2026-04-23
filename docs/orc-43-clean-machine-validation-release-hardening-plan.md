# ORC-43 — clean-machine validation and release hardening plan

> Status note: this document audits the current ORC-43 task worktree. ORC-44 and ORC-45 are completed at the task level, but the runtime-pack and Orchestra-managed auth/model changes are not yet present in this checked-out branch, so this plan treats their manifest/setup contracts as required inputs for the eventual implementation branch.

## What I found in the current codebase

### 1. Runtime discovery is still external-install driven

Today Orchestra still resolves `pi` from the user environment instead of from an embedded runtime pack:

- `src-tauri/src/services/pi_sessions.rs` → `resolve_pi_executable()` checks:
  - `ORCHESTRA_PI_EXECUTABLE`
  - a preferred path
  - common user bin locations such as `~/.npm-global/bin/pi`, `~/.local/bin/pi`, `~/.volta/bin/pi`, `~/.pi/agent/bin/pi`, `/opt/homebrew/bin/pi`
  - the user login shell via `command -v pi`
- `src-tauri/src/state.rs` → `sync_pi_runtime_health()` still blocks runtime dispatch when that external lookup fails.
- `src-tauri/src/services/live_sessions.rs` already resolves the Orchestra extension from packaged resources, but the actual `pi` runtime is still expected to come from the outside environment.

That means the current code can package the Orchestra extension, but not a self-contained Pi runtime.

### 2. Current automated desktop coverage does **not** prove clean-machine packaged behavior

The checked-in desktop harness is useful, but it currently validates a development-style runtime environment:

- `scripts/run-desktop-e2e-container-entry.sh` installs `nodejs` and `npm` in the container image and exports `ORCHESTRA_PI_EXECUTABLE=/workspace/orchestra/node_modules/.bin/pi`.
- `scripts/run-desktop-e2e.sh` sets a temp HOME, but then symlinks the real `~/.pi` directory into the test HOME when it exists.
- `tests/desktop-e2e/*` therefore exercise a real Tauri binary, but not a truly clean packaged install with no separately installed `pi`, Node, or npm.

So the current suite is good regression coverage for live runtime wiring, but it is **not** evidence of the product promise from ORC-39.

### 3. Packaged-mode add-on policy is not enforced yet

Current settings/runtime behavior still allows externally sourced add-ons:

- `src-tauri/src/services/harness_settings.rs` accepts arbitrary `extra_extensions` and only trims/deduplicates them.
- `src/settings/GeneralPanel.tsx` explicitly advertises examples like `npm:my-extension`.
- `src-tauri/src/services/live_sessions.rs` blindly appends configured extensions to `--extension` arguments.
- Existing browser/desktop specs (`tests/e2e/general.spec.ts`, `tests/e2e/sessions.spec.ts`, `tests/desktop-e2e/general-session-prompt-template.test.ts`, `tests/desktop-e2e/session-runtime-details.test.ts`) currently encode `npm:` extensions as valid behavior, so the packaged-mode policy change will need coordinated fixture/spec updates instead of just runtime enforcement.

That is incompatible with the bundled-runtime promise for packaged mode, because `npm:` and similar sources implicitly depend on an external package manager/install story.

### 4. Auth/model state still has external-home assumptions in some flows

There are still direct `~/.pi` assumptions in the tree:

- `src-tauri/src/services/agent_terminal.rs` copies `auth.json`, `models.json`, and filtered `settings.json` from `~/.pi/agent` into a temp HOME.
- Desktop harness scripts also preserve `.pi` state from seeded/test homes.

ORC-45 is the dedicated fix for Orchestra-managed auth/model setup, but ORC-43 must assume that clean-machine validation is not complete until those external-home assumptions stop being part of the success path.

### 5. Release settings are still development-oriented

Current packaging/signing setup is intentionally lightweight:

- `src-tauri/tauri.conf.json` bundles only the Orchestra extension, mobile web assets, and icon resources.
- The macOS bundle config is currently:
  - `signingIdentity: "-"`
  - `hardenedRuntime: false`
- `scripts/build-adhoc.sh` is a development helper, not release-grade signing/notarization automation.

There is currently no checked-in flow for:

- signing nested bundled Pi runtime artifacts
- manifest/checksum verification for the embedded runtime
- notarization/stapling
- third-party notices for the embedded runtime payload
- SBOM generation for release artifacts

## Planning decision

Treat **macOS packaged validation** as the authoritative release gate for this task, because the release-hardening scope here is explicitly about app-bundle signing/notarization and embedded-runtime integrity.

Use two layers of coverage:

1. **Fast PR coverage**
   - Rust/unit/integration tests
   - desktop E2E or containerized failure-injection checks
   - verifies the validator/error taxonomy and packaged-mode policy logic

2. **Authoritative release validation**
   - run against the built `.app` / `.dmg` on a clean macOS VM or fresh macOS user profile
   - no global `pi`, Node, or npm on PATH
   - no inherited `~/.pi`
   - proves the actual distribution artifact works as shipped

## Concrete deliverables

The implementation phase should leave behind these durable artifacts:

1. A bundled-runtime validator service with typed diagnostics shared by runtime health checks, live sessions, task workers, and terminal flows.
2. A packaged-app validation runner that exercises the signed `.app` / `.dmg` in a clean macOS environment with PATH/HOME sanitization and log capture.
3. Automated failure-injection coverage for missing/corrupt bundled runtime state, invalid Orchestra-managed auth/model state, and packaged-mode unsupported add-on sources.
4. Release automation for nested-runtime signing/notarization verification, runtime manifest verification, third-party notice generation, and CycloneDX SBOM output.
5. A manual QA checklist that release owners can execute on a fresh machine or VM.

## Prerequisite contracts and merge assumptions

ORC-43 implementation depends on these sibling deliverables being available in the branch that does the actual work:

1. **ORC-44** — bundle and resolve the packaged Pi runtime
   - ORC-43 needs a real bundled runtime pack, packaged-mode resolver, and machine-readable runtime manifest before clean-machine validation can be meaningful.

2. **ORC-45** — Orchestra-managed auth/model setup
   - ORC-43 needs Orchestra-owned auth/model files, migration behavior, and setup failure states before the clean-machine and invalid-auth validation matrix is complete.

If the eventual implementation branch does not already include those changes, the first step should be to merge or cherry-pick them before starting ORC-43 code work.

## Implementation plan

### Workstream 1 — bundled runtime manifest verification and failure taxonomy

Add a dedicated bundled-runtime validator layer, separate from generic spawn failures.

#### Expected behavior

Before Orchestra launches any bundled Pi-backed flow, it should validate the embedded runtime bundle and classify failures into explicit buckets:

- bundled runtime missing
- runtime manifest missing
- manifest parse failure
- checksum mismatch / corruption
- bundled executable missing or not executable
- launch failure after successful verification
- auth/model setup missing or invalid
- packaged-mode unsupported add-on source

#### Recommended code shape

Add a small runtime-bundle service, likely near session/runtime plumbing, for example:

- `src-tauri/src/services/bundled_runtime.rs`

Responsibilities:

- locate the packaged runtime root
- load and parse the runtime manifest produced by ORC-44
- verify required files exist
- verify checksums for the files listed in the manifest
- return a typed `BundledRuntimeStatus` / `BundledRuntimeError`
- expose diagnostics for UI/runtime logs

#### Expected call sites

The validator should become the common prerequisite for:

- `src-tauri/src/state.rs` → `sync_pi_runtime_health()`
- `src-tauri/src/services/live_sessions.rs` runtime spawn
- `src-tauri/src/services/pi_sessions.rs` offline/session command helpers
- `src-tauri/src/services/agent_terminal.rs`

That keeps desktop sessions, task workers, and terminal attachments from drifting into different runtime-resolution behavior.

#### Manifest contract

ORC-44 should emit a manifest that ORC-43 can verify without guessing. Minimum fields:

- Orchestra build/version
- Pi runtime version/build identifier
- target platform + architecture
- relative executable path
- file list with `sha256`
- optional signing metadata / upstream provenance fields
- optional third-party notice and SBOM paths copied into the app resources or release bundle

The validator should key off this manifest rather than hard-coded executable names.

### Workstream 2 — automated clean-machine packaged-runtime validation

Add a release-grade smoke flow that runs the **packaged app**, not the dev binary, in a clean environment.

#### Required assertions

The packaged validation run must prove all of the following together:

1. Orchestra launches from the packaged app bundle.
2. `ORCHESTRA_PI_EXECUTABLE` is **not** required.
3. `pi`, `node`, and `npm` are absent from the environment or intentionally blocked from resolution.
4. Orchestra resolves the embedded runtime from app resources.
5. A Pi-backed flow can create a session, subscribe, and complete a prompt.
6. Runtime diagnostics show the bundled runtime path, not PATH/login-shell discovery.
7. Auth/model setup uses Orchestra-managed state rather than inherited `~/.pi` state.

#### Recommended automation shape

Add a dedicated packaged validation runner, for example:

- `scripts/run-packaged-runtime-validation.sh`

Responsibilities:

- install or mount the built `.app` / `.dmg`
- create a fresh HOME / test user state
- unset `ORCHESTRA_PI_EXECUTABLE`
- sanitize PATH so external `pi`, Node, and npm cannot be found
- launch the packaged app executable directly from the bundle
- drive a smoke flow via Tauri WebDriver or a minimal automation harness
- collect logs, session files, and runtime diagnostics as artifacts

#### Environment rules for the validation run

The runner should fail closed if any of these are detected:

- `command -v pi` succeeds
- `command -v node` succeeds for the shell used by the packaged app
- `command -v npm` succeeds for the shell used by the packaged app
- `~/.pi` exists in the test HOME unless the scenario is explicitly testing migration/import

#### Test coverage split

- keep existing desktop E2E for fast developer feedback
- add a focused packaged smoke spec, for example:
  - `tests/desktop-e2e/packaged-runtime-smoke.test.ts`
- run that spec only from the packaged validation runner so it targets the packaged executable and clean HOME contract

#### Why a macOS VM/fresh account is still required

Containerized Linux coverage is helpful for logic and failure injection, but it does not validate:

- macOS app-bundle resource resolution
- codesign behavior on embedded binaries
- notarization acceptance
- quarantine/first-launch behavior

So the release gate should use a fresh macOS environment, even if PR coverage uses Linux/container tests for speed.

### Workstream 3 — failure-injection coverage

Add a deliberately enumerated failure matrix instead of a single generic “spawn failed” path.

#### Scenario matrix

| Scenario | Injection method | Expected surface |
| --- | --- | --- |
| Bundled runtime directory missing | remove/rename packaged runtime resource | bundled-runtime-specific error banner/log; do not suggest auth repair |
| Manifest missing | remove manifest file | explicit manifest-missing failure |
| Manifest corrupt JSON | write invalid JSON | explicit manifest-parse failure |
| Checksum mismatch | edit bundled file after manifest generation | explicit corruption/integrity failure |
| Executable missing / non-executable | chmod/remove binary | explicit runtime-launch failure after verification |
| Missing auth.json / models.json | start from clean Orchestra-managed runtime dir | setup CTA / missing-auth state, not bundled-runtime corruption |
| Invalid auth.json / models.json | write malformed or incompatible files | explicit repair/reconnect guidance |
| Unsupported `npm:` add-on in packaged mode | save invalid extension config or load it from settings | validation failure that names the unsupported source |
| Unsupported `git:` add-on in packaged mode | same | validation failure that names the unsupported source |

#### Recommended test levels

1. **Rust unit/integration tests**
   - verifier logic
   - manifest parsing
   - checksum mismatch behavior
   - packaged-mode extension-source validation

2. **Desktop/runtime integration tests**
   - runtime diagnostics/log wording
   - setup CTA vs corruption CTA separation
   - packaged-mode unsupported source rejection

3. **Packaged smoke tests**
   - at least one success path on a clean machine
   - at least one representative failure path on a packaged artifact or staged bundle copy

#### Test-only hook recommendation

Add a narrow test override for the bundled runtime root, for example an environment variable only honored in tests/dev automation. That makes corruption/missing-runtime scenarios cheap to inject without mutating the real app bundle under development.

### Workstream 4 — packaged-mode add-on policy enforcement

Packaged mode should explicitly reject add-on sources Orchestra does not own.

#### Policy

In packaged mode:

- allow Orchestra’s built-in extension resource
- allow bundled/local extensions that are inside the packaged runtime/app-controlled locations
- reject `npm:` sources
- reject `git:` sources
- reject any future remote/package-manager sources unless Orchestra owns installation, update, verification, and notice generation for them

#### Recommended enforcement points

1. **Save-time validation** in runtime settings update paths
   - better user feedback early
2. **Spawn-time validation** in runtime launch paths
   - fail closed if invalid config was already persisted or migrated
3. **Runtime details UI**
   - clearly explain why a configured add-on was rejected in packaged mode

That keeps the product behavior intentional instead of silently relying on external tooling.

### Workstream 5 — release hardening for embedded Pi runtime distribution

#### Signing/notarization

Release packaging must move beyond the current adhoc config.

Recommended release flow:

1. sign embedded Pi runtime binaries/libraries first
2. sign the final Orchestra `.app` with hardened runtime enabled
3. verify with `codesign --verify --deep --strict --verbose=2`
4. verify policy acceptance with `spctl -a -vv`
5. submit for notarization with `xcrun notarytool submit --wait`
6. staple the notarization ticket to the app and/or DMG
7. re-run verification after stapling

Development can keep adhoc signing, but release automation should use a separate release config or env-driven override instead of the current always-adhoc baseline.

#### Embedded runtime integrity manifest

In addition to Apple signing, keep Orchestra-side manifest verification as a defense-in-depth measure.

Release artifacts should include a machine-readable manifest containing at least:

- Orchestra version
- git commit
- Pi runtime version/build id
- target platform/arch
- bundled file list + `sha256`
- signing/notarization verification summary
- paths to notice and SBOM artifacts

That manifest should be both:

- embedded alongside the runtime for app-side verification
- emitted into release artifacts for auditability

#### Third-party notices

The release pipeline should generate or assemble a human-readable notice bundle covering:

- Rust dependencies
- Orchestra frontend dependencies
- the embedded Pi runtime payload and anything vendored into it

Concrete recommendation:

- use a Rust notice generator such as `cargo-about` for Cargo dependencies
- use a Node notice/license inventory step for JavaScript dependencies
- require the bundled Pi runtime pack from ORC-44 to carry its own upstream notice/license payload so Orchestra can copy it through instead of guessing at runtime contents after the fact

#### SBOM

Generate a release SBOM for the shipped app artifact, not just the source tree.

Concrete recommendation:

- use `syft` to scan the final app bundle / release directory and emit CycloneDX JSON

This is preferable here because it captures the final packaged contents, including the embedded runtime, instead of only source-declared dependencies.

### Workstream 6 — manual QA checklist

Keep the manual QA checklist in the repo as a durable release artifact, for example within this plan doc or a follow-on runbook such as `docs/release-packaged-runtime-qa.md`.

Minimum checklist:

1. Start from a fresh macOS VM or clean user profile.
2. Confirm `pi`, `node`, and `npm` are not available globally.
3. Install/open the signed packaged Orchestra app.
4. Confirm macOS accepts the notarized app without ad hoc workarounds.
5. Verify runtime diagnostics point at the bundled runtime path.
6. Complete Orchestra-managed auth/model setup from a clean state.
7. Create a real session and complete at least one Pi-backed prompt.
8. Restart the app and confirm the flow still works without reconfiguration.
9. Validate missing-auth behavior from a clean HOME still surfaces a setup CTA instead of a generic runtime failure.
10. Corrupt or remove the bundled runtime in a staged test copy and verify the error clearly identifies runtime corruption/missing files.
11. Configure an unsupported `npm:` or `git:` add-on and verify packaged mode rejects it clearly.
12. Export logs / diagnostics and confirm the bundle includes enough detail to distinguish runtime, auth, and add-on failures.
13. Validate upgrade behavior from a prior Orchestra build preserves Orchestra-managed runtime/auth state correctly.

## Recommended file touchpoints

Likely implementation files for the eventual development phase:

- `src-tauri/src/services/pi_sessions.rs`
- `src-tauri/src/services/live_sessions.rs`
- `src-tauri/src/services/agent_terminal.rs`
- `src-tauri/src/state.rs`
- `src-tauri/tauri.conf.json`
- `scripts/run-desktop-e2e.sh`
- `scripts/run-desktop-e2e-container-entry.sh`
- new packaged validation/release scripts under `scripts/`
- new failure-injection and packaged-runtime desktop specs under `tests/desktop-e2e/`
- a new bundled-runtime verifier service under `src-tauri/src/services/`

## Sequencing

1. **ORC-44 changes are present in the implementation branch**: bundled runtime pack + packaged resolver + manifest format.
2. **ORC-45 changes are present in the implementation branch**: Orchestra-managed auth/model setup and migration contract.
3. **ORC-43 implementation begins** with:
   - validator/error taxonomy
   - packaged-mode add-on policy enforcement
   - failure-injection coverage
   - packaged smoke runner
   - release signing/notarization/notice/SBOM automation
   - manual QA checklist

## Done-when mapping back to the task

### “Release automation exercises bundled Pi flows on a clean machine/VM”

Satisfied by:

- packaged smoke runner against a fresh macOS environment
- PATH/Home sanitization that proves no external `pi`/Node/npm dependency
- a real Pi-backed session prompt succeeding from the packaged app

### “Bundled-runtime corruption/failure modes are covered by tests and surfaced clearly”

Satisfied by:

- manifest verifier unit/integration coverage
- explicit missing/corrupt runtime checks
- separate invalid-auth/model coverage
- packaged-mode unsupported add-on rejection with clear user-facing wording

### “Release artifacts include the required signing/licensing verification for the embedded Pi runtime”

Satisfied by:

- release signing + hardened runtime verification
- notarization + stapling
- emitted runtime manifest with checksums
- third-party notice bundle
- CycloneDX SBOM for the shipped artifact
