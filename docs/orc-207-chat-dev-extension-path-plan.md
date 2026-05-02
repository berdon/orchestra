# ORC-207 — Fix missing packaged extension path when opening chat in `cargo tauri dev`

## tl;dr
- Reproduced the dev-mode failure against the existing debug binary at `/Users/auhanson/workspace/hnsn/orchestra-dev-build/src-tauri/target/debug/orchestra` with `ORCHESTRA_PROJECT_ROOT` unset: Chat shows `Packaged Orchestra extension path does not exist: /Users/auhanson/workspace/hnsn/orchestra-dev-build/src-tauri/target/debug/extensions/orchestra-tools.ts`.
- Root cause: chat open goes through `ensure_agent_session` → live runtime startup, and `src-tauri/src/services/live_sessions.rs` uses a narrow extension resolver that only checks `ORCHESTRA_PROJECT_ROOT` and packaged Tauri resources.
- In dev, `BaseDirectory::Resource` resolves to `src-tauri/target/debug/extensions/orchestra-tools.ts`, which is not guaranteed to exist.
- `src-tauri/src/services/pi_launch.rs` already has a broader fallback chain, so runtime launch paths are inconsistent today.
- Fix by centralizing extension resolution and preferring source-checkout paths in dev mode before packaged-resource lookup.

## Executive summary
This bug is not a chat-specific frontend issue; it is a backend runtime bootstrap bug exposed by the chat page. Opening chat calls `ensure_agent_session`, which ensures the main agent session runtime immediately. That runtime path uses `live_sessions::resolve_orchestra_extension_path`, and that helper assumes packaged resources unless `ORCHESTRA_PROJECT_ROOT` is set. In a source checkout launched via `cargo tauri dev`, that assumption is too strict.

The implementation should replace the duplicated live-session resolver with a shared helper used by live sessions, the embedded terminal path, and interactive Pi launch. That helper should treat source-checkout resolution as the normal dev-mode path and only rely on packaged resources when they actually exist.

## Reproduction
- Observed on the existing checkout referenced by the error report:
  - binary exists: `/Users/auhanson/workspace/hnsn/orchestra-dev-build/src-tauri/target/debug/orchestra`
  - packaged resource is missing: `/Users/auhanson/workspace/hnsn/orchestra-dev-build/src-tauri/target/debug/extensions/orchestra-tools.ts`
- Using `tauri-wd` with `ORCHESTRA_ENABLE_WEBDRIVER_AUTOMATION=1` and `ORCHESTRA_PROJECT_ROOT` unset, loading `http://localhost:1420/?page=chat&projectId=orchestra` reproduced the exact UI error string.

## Root cause
- `src-tauri/src/commands/agent_runtime.rs`
  - `ensure_agent_session(...)` ensures the main session runtime when chat opens.
- `src-tauri/src/services/live_sessions.rs`
  - `resolve_orchestra_extension_path(...)` currently checks:
    1. `ORCHESTRA_PROJECT_ROOT/extensions/orchestra-tools.ts`
    2. `BaseDirectory::Resource -> extensions/orchestra-tools.ts`
  - if the packaged resource path exists logically but the file is absent, it errors with the exact message from the bug report.
- `src-tauri/src/services/pi_launch.rs`
  - already has a stronger resolver with extra fallbacks, so the app currently has two different definitions of “where the Orchestra extension lives.”

## Planned fix
1. Create one shared Orchestra extension resolver for all runtime launch paths.
2. Use this fallback order:
   1. `ORCHESTRA_EXTENSION_PATH` when set and present.
   2. `ORCHESTRA_PROJECT_ROOT/extensions/orchestra-tools.ts` when present.
   3. detected dev checkout root (`discover_dev_checkout_root()` / equivalent source-root detection) + `extensions/orchestra-tools.ts`.
   4. packaged Tauri resource path, but only if the resolved file exists.
   5. compile-time manifest-dir parent fallback only as a last source-build fallback if still needed for tests.
3. Switch these callers to the shared helper:
   - `src-tauri/src/services/live_sessions.rs`
   - `src-tauri/src/services/agent_terminal.rs`
   - `src-tauri/src/services/pi_launch.rs`
4. Keep error text explicit about the paths checked if none resolve.

## Validation
- Add unit coverage for:
  - dev checkout fallback when packaged resource is missing
  - packaged-resource success path
  - explicit env override precedence
- Re-run a dev-mode chat smoke path and verify chat opens without the extension-path error.
- Optionally extend desktop E2E coverage so a dev launch without `ORCHESTRA_PROJECT_ROOT` still opens Supervisor chat successfully.
