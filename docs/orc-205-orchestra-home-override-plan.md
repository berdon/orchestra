# ORC-205 orchestra-home override + Tauri dev storage isolation plan

## tl;dr

- Add a real `--orchestra-home` process flag that points to the exact Orchestra storage root (example: `~/.orchestra-dev`).
- Parse/apply it before backend bootstrap so the cached SQLite path and all path helpers resolve against the override.
- Keep `ORCHESTRA_STORAGE_ROOT` as compatibility plumbing; let the flag set/override it internally rather than threading a new parameter through services.
- In desktop `cargo tauri dev` runs, default to `~/.orchestra-dev` only when no explicit flag or env override is present, so dev runs stop touching `~/.orchestra`.

## Executive summary

Current storage resolution is already centralized in `src-tauri/src/services/orchestra_paths.rs::default_orchestra_root()` and most backend features flow through that helper. There is also an existing `ORCHESTRA_STORAGE_ROOT` env override, which is the least disruptive place to anchor a new user-facing flag. The main architectural constraint is startup ordering: `database::initialize_database()` caches the resolved SQLite path in a `OnceLock`, so any CLI/runtime override must be applied before backend bootstrap begins.

The safest implementation is to add one small startup-options layer that reads `--orchestra-home` from process args, validates it as an exact Orchestra-home path (do not append another `.orchestra`), and exports it via the existing env override before any service initialization. Then desktop app startup can add one extra dev-only fallback to `$HOME/.orchestra-dev` when running under Tauri dev and no explicit override is present.

## Findings from code audit

- `default_orchestra_root()` already fans out to database, sessions, attachments, runtime skills, Pi setup/runtime, and project settings, so one early override reaches the whole app.
- `database::ensure_database_initialized()` caches the resolved DB path in `DATABASE_INIT_PATH`, so late overrides will not work reliably.
- `src-tauri/src/cli/mod.rs` boots the backend immediately after `Cli::parse()`, which makes it a clean place for a global CLI flag.
- Desktop app startup in `src-tauri/src/lib.rs::run()` currently bootstraps with no storage override; `build.rs` already exposes `ORCHESTRA_TAURI_IS_DEV`, so dev-mode fallback can stay app-specific.
- Helper binaries `src-tauri/src/bin/remote_api_route_probe.rs` and `src-tauri/src/bin/hosted_web_e2e_server.rs` currently read raw process args, so a shared pre-bootstrap parser avoids positional-arg breakage there too.

## Implementation plan

### 1. Add shared startup override resolution

- Introduce a small shared helper (new service/module or `orchestra_paths.rs` companion) that:
  - scans process args for `--orchestra-home <path>` and `--orchestra-home=<path>`
  - treats the provided value as the final Orchestra storage root path
  - applies precedence: CLI/runtime flag > `ORCHESTRA_STORAGE_ROOT` env > desktop-dev default > `HOME/.orchestra`
  - sets `ORCHESTRA_STORAGE_ROOT` before any backend/database bootstrap

### 2. Expose the flag on the `orc` CLI

- Add `--orchestra-home <path>` as a global clap option in `src-tauri/src/cli/mod.rs`.
- Apply the resolved override before `initialize_cli_backend()`.
- Update CLI help/README examples so scripted/local usage can target alternate state roots explicitly.

### 3. Apply the same override path to desktop runtime startup

- In `src-tauri/src/lib.rs::run()`, resolve/apply the startup override before `initialize_backend()`.
- Only for desktop dev runs (`ORCHESTRA_TAURI_IS_DEV=true`) and only when neither the flag nor env override is set, default to `$HOME/.orchestra-dev`.
- Keep packaged app behavior unchanged.

### 4. Keep helper binaries and probes compatible

- Make the helper-binary entrypoints use the same startup override parser before reading their own positional args so `--orchestra-home` does not get mistaken for a case name.
- Preserve existing `ORCHESTRA_STORAGE_ROOT`-based test scripts.

### 5. Document the new behavior

- Update dev-run docs (`README.md`, `AGENTS.md`, and any nearby adhoc/dev docs that show `cargo tauri dev`) to explain:
  - Tauri dev now uses `~/.orchestra-dev` by default
  - `--orchestra-home <path>` can target a different storage root
  - explicit overrides are still useful when a developer intentionally wants the normal `~/.orchestra` data

## Test plan

- Rust unit tests for startup-option parsing and precedence, including `--orchestra-home=value`, `--orchestra-home value`, empty/missing-value rejection, and env fallback.
- CLI parser test confirming the new global flag is accepted with existing `orc` subcommands.
- Unit test for the dev-only desktop fallback helper so it chooses `~/.orchestra-dev` only when no explicit override is present.
- If implementation extracts a pure resolver, use it to cover the `database OnceLock` ordering assumption without needing fragile process-wide integration tests.

## Expected touch points

- `src-tauri/src/cli/mod.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/src/services/orchestra_paths.rs` and/or a new startup-options helper module
- `src-tauri/src/bin/orc.rs`
- `src-tauri/src/bin/remote_api_route_probe.rs`
- `src-tauri/src/bin/hosted_web_e2e_server.rs`
- `README.md`
- `AGENTS.md`

## Notes for implementation

- Do not reinterpret `--orchestra-home` as an OS home directory; `~/.orchestra-dev` should be used directly, not turned into `~/.orchestra-dev/.orchestra`.
- Do not let the dev default override explicit env/scripted test isolation.
- Because the override is applied at process startup, most existing service signatures can remain unchanged.
