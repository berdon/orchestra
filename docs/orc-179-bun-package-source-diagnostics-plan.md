# ORC-179 Bun/package-source diagnostics + Harness Bun status plan

## tl;dr
- Treat package-source detection as a backend diagnostic problem, not just a generic Pi setup failure.
- Inventory package-bearing state explicitly, especially runtime-owned `~/.orchestra/runtime/pi/agent/settings.json`, and separate package-aware model probing from package-free probing.
- Only show the Bun/package warning when package-based sources are actually required for the current available-model result.
- Surface exact offending source entries plus Bun status in `Settings → Harness`, and update all remaining `Settings → Pi` copy.

## Executive summary
The current Orchestra UI only audits managed `auth.json` and `models.json` during Pi setup checks, but the bundled runtime can also trip Bun-dependent package resolution from hidden runtime-owned state. A controlled repro against the packaged runtime showed that `get_available_models` fails with a Bun lookup error as soon as `~/.orchestra/runtime/pi/agent/settings.json` contains package entries, even under `--no-extensions`, because the runtime still resolves package sources before returning model availability.

That means the fix should not be limited to copy updates. We need a small backend source-inventory layer that understands which managed files contain package-bearing state, records the exact offending entries, and uses a package-free fallback probe so Orchestra can distinguish:
- genuine package-backed model availability that really requires Bun, from
- false positives caused by stale or non-model package state.

## Current findings
- Current local Orchestra-managed `~/.orchestra/runtime/pi/agent/models.json` contains only direct provider config.
- Current local Orchestra-managed `~/.orchestra/runtime/pi/agent/settings.json` currently has no `packages` array, but legacy `~/.pi/agent/settings.json` still does.
- `pi_setup::get_pi_setup_state()` does **not** inspect runtime-owned `settings.json`; it only parses `auth.json`/`models.json` and then asks the runtime for available models.
- `pi_sessions::list_available_models()` runs the bundled/system runtime in a temp project root, so setup-state warnings are driven by managed agent-dir state, not by the current repo's project-local `.pi` config.
- Controlled repro: adding `packages: ["npm:pi-subagents", ...]` to a temp agent `settings.json` causes the packaged runtime to fail with `Failed to run bun pm bin -g`, proving hidden `settings.json` package state is enough to trigger the Bun path.

## Implementation plan
### 1. Add a shared package-source inventory + Bun-status layer
Create a backend helper that inspects the managed agent directory and returns structured diagnostics for package-bearing state, including at minimum:
- source file path
- source kind (`runtime_settings_packages`, `managed_models_json`, future-proofed for other kinds)
- concrete entry values
- whether the source is managed, legacy, or runtime-owned
- Bun availability/path from Orchestra's effective shell PATH

Recommended consumers:
- `pi_setup::get_pi_setup_state()`
- `pi_runtime::get_pi_runtime_diagnostics()`
- runtime logs / review diagnostics

### 2. Split setup-state probing into package-free and package-aware phases
Replace the single `list_available_models()` dependency with a two-step probe:
1. run a package-free model query against a sanitized temp agent dir with package entries removed from runtime-owned settings
2. only escalate to a package/Bun-specific warning when package-bearing state is present **and** the package-free probe cannot produce the required model availability

Expected behavior:
- no package-bearing state => current ready/needs-setup behavior
- package-bearing state + sanitized probe succeeds => do **not** show the Bun/package warning; instead keep a diagnostic record that stale package state exists
- package-bearing state + sanitized probe cannot satisfy setup => show a Bun/package issue with exact source entries and paths

### 3. Make the warning concrete and current
Update `PiSetupIssue`/`PiSetupState` so the UI can render exact offending sources instead of a generic message. The message path should:
- mention `Harness`, not `Pi`
- name the source file that triggered the warning
- include the concrete package entries when practical
- distinguish “package sources configured but Bun missing” from generic invalid-model errors

Also update `block_message_for_state()` so global dispatch banners stop using stale `Settings → Pi` copy.

### 4. Expose Bun + package-source status in Harness settings
Extend the Harness diagnostics area with a read-only package-source/Bun card that shows:
- Bun available / missing
- resolved Bun path when available
- managed runtime `settings.json` path
- detected package-source entries
- whether current model availability is blocked by those entries or whether they were ignored by the package-free fallback

This gives users a first-class place to understand why Bun matters and what they need to remove or keep.

### 5. Keep runtime-owned settings visible
The current Harness UI shows auth/models paths but not the runtime-owned `settings.json` path where hidden package state lives. Surface that path in the settings UI and setup diagnostics so the actual offending file is discoverable.

## Test plan
### Backend / Rust
- `pi_setup.rs` unit tests for:
  - no package-bearing state => no Bun/package warning
  - package-bearing `settings.json` + Bun failure + successful package-free fallback => no blocking warning, source diagnostics recorded
  - package-bearing `settings.json` + Bun failure + no package-free models => blocking Bun/package warning with exact source path/entries
  - updated `block_message_for_state()` Harness copy
- `pi_sessions.rs` fake-runtime coverage for Bun/package stderr cases and sanitized fallback behavior
- `pi_runtime.rs` diagnostics tests for Bun status + package-source inventory

### Frontend / TS
- type coverage for any new diagnostic fields
- Harness settings/UI tests for Bun status card, offending-source rendering, and `settings.json` path visibility
- copy assertions that `Settings → Harness` replaces `Settings → Pi`

## Risks / open questions
- The bundled runtime is opaque from Orchestra's side, so the reliable fix should happen in Orchestra's preflight/sanitization layer instead of assuming pi will narrow package resolution for us.
- If package-backed models are genuinely the only configured models, sanitized fallback must not silently hide that; it should turn into an explicit, source-specific Bun requirement.
- There is duplication today around filtered settings copies for spawned runtimes (`pi_launch.rs`, `agent_terminal.rs`); implementation may want to consolidate that logic while adding package-source inspection.
