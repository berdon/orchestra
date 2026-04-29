# ORC-178 — bunless managed-model loading hardening plan

## tl;dr

- Treat the fresh-install failure as a Pi runtime/package-resolution problem, not a `models.json` parse problem.
- Hard-code a bundle-safe package-manager environment for Orchestra-launched Pi subprocesses so bundled model discovery does not need external `bun` on `PATH` just to discover install roots.
- If package-source resolution still truly needs an external tool, surface a short setup diagnostic and keep the Pi settings UI usable instead of bubbling a raw RPC stack trace.

## Executive summary

The current failure path is:

- `src-tauri/src/services/pi_setup.rs` calls `pi_sessions::list_available_models()`.
- `src-tauri/src/services/pi_sessions.rs` launches a Pi RPC subprocess for `get_available_models`.
- If that subprocess dies during upstream package-source resolution, `pi_setup.rs` currently relabels the failure as `models_json_invalid` whenever a managed `models.json` exists.

That means a missing external package-manager binary can masquerade as a bad `models.json` and leak a raw `bun pm bin -g` stack into the UI.

The fix should be defense in depth:

1. prevent the bundled/fresh-install path from needing external `bun` lookup in the first place;
2. classify any remaining package-manager failure as a concise dependency/setup diagnostic rather than a malformed-models error;
3. cover the scrubbed-`PATH` case with regression tests.

## Proposed implementation

### 1) Centralize a bundle-safe package-manager environment

Add a small helper in `src-tauri/src/services/pi_runtime.rs` that returns the extra env needed by Orchestra-launched Pi subprocesses.

Recommended behavior:

- keep `PI_PACKAGE_DIR` for bundled runtimes;
- always provide a deterministic writable `NPM_CONFIG_PREFIX` / `npm_config_prefix` for bundled/runtime-managed Pi launches;
- prefer an Orchestra-owned path such as `~/.orchestra/runtime/pi/npm` over ad hoc temp-only discovery.

This avoids upstream fallback code that shells out to `bun pm bin -g` just to derive a global install location.

Use the same helper from:

- `src-tauri/src/services/pi_sessions.rs` RPC/model discovery;
- `src-tauri/src/services/pi_launch.rs` interactive launches;
- `src-tauri/src/services/agent_terminal.rs` embedded terminal launches.

### 2) Stop collapsing runtime dependency failures into `models_json_invalid`

In `src-tauri/src/services/pi_setup.rs`:

- keep `models_json_invalid` only for JSON read/parse/shape failures;
- introduce a distinct issue/warning code for package-manager/package-source resolution problems;
- map the user-facing message to something short and actionable, e.g.:
  - "Pi could not load package-based model sources because Bun is not available on PATH. Install Bun or remove package-based Pi sources in Settings → Pi."

Important rule: do not show the raw `bun pm bin -g` stack in the primary UI message. Preserve the raw stderr/detail only in logs or internal error text where needed for debugging.

### 3) Classify missing-Bun/package-source failures close to RPC startup

In `src-tauri/src/services/pi_sessions.rs`:

- add a small classifier for RPC startup failures that mention package-source resolution / `bun pm bin -g` / `Executable not found in $PATH: "bun"`;
- return a structured/friendly error string upward instead of the raw RPC suffix when the signature matches;
- keep existing behavior for unrelated Pi failures.

This makes the fix resilient even if upstream Pi still emits a verbose internal stack.

### 4) Avoid silently reintroducing package-source state

While touching this flow, verify `src-tauri/src/services/pi_runtime.rs` legacy-agent migration behavior.

Today `ensure_orchestra_pi_agent_dir()` still copies legacy `settings.json` into an empty Orchestra agent dir. If that file contains `packages` entries, Orchestra can silently re-enable package-source behavior on first run.

Recommended guard:

- do not auto-import legacy `settings.json` during runtime resolution, or
- at minimum do not silently carry forward package-source entries in the fresh Orchestra-managed path.

That keeps explicit import/setup rules aligned with the existing packaged-runtime design docs.

## Test plan

### Rust/service tests

1. `pi_runtime.rs`
   - verify bundled/runtime-managed env injection includes deterministic prefix values.

2. `pi_sessions.rs`
   - fake Pi executable emits the current raw missing-Bun stack on `get_available_models`;
   - assert the returned error is classified into the friendly dependency message instead of echoing the raw stack.

3. `pi_setup.rs`
   - with a valid managed `models.json`, assert missing-Bun/package-source failures do **not** become `models_json_invalid`;
   - assert the surfaced issue/warning message is concise and actionable.

### Reproduction/regression coverage

Add a scrubbed-`PATH` regression for the real managed-model discovery path:

- clean Orchestra runtime root;
- bundled/runtime-managed Pi executable;
- `PATH` without `bun`;
- valid minimal managed auth/models fixture;
- assert model loading no longer fails with raw `Failed to run bun pm bin -g` output.

If the real bundled-runtime check is too heavy for the default Rust suite, hang it off the existing packaged-runtime validation path instead of leaving the case untested.

## Acceptance criteria mapping

- **Reproduce with Bun absent from PATH**: scrubbed-`PATH` regression.
- **No raw `bun pm bin -g` crash**: runtime env hardening + error classification.
- **Fallback/guarding added**: centralized package-manager env + distinct diagnostic path.
- **Tests added**: service-level classification tests plus bundled/runtime-managed regression coverage.
- **User-facing error is actionable**: concise Settings → Pi/Bun guidance instead of raw RPC stack output.
