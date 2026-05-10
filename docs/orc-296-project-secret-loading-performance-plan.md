# ORC-296 — Project secret loading performance + Podman regression plan

## tl;dr
- Root cause: `src-tauri/src/services/project_secrets.rs` currently loads SQLite metadata and then calls `load_value_from_accounts(...)` for every secret row during `get_project_secrets_with_store(...)`. On Linux/Podman, each probe shells out to `secret-tool`, and each row can hit both primary and legacy account names.
- Fix the hot path so project-secret list/search screens operate on metadata first and resolve value presence in one bounded pass instead of one raw secret-store read per secret.
- Lock the fix down with supported Podman desktop coverage that makes per-secret raw reads observable and fails if the settings load path falls back to N secret-store lookups.

## Executive summary
The current project-secret settings load path is doing the most expensive possible thing for a metadata-first screen: it loads metadata from SQLite, then synchronously asks the secure store for every secret value just to derive `ready` vs `missing_value`. `search_project_secrets_with_store(...)` and the bridge `list_project_secrets` / `search_project_secrets` commands reuse that same full-hydration path before filtering or paging, so the cost scales with total secret count, not the visible result set. On Linux, `SecretToolProjectSecretStore::get_value(...)` makes this especially expensive because every check is a `secret-tool lookup` subprocess and each secret can probe both current and legacy account ids. The implementation lane should therefore move list/search onto metadata plus bulk/cached value-state resolution, keep actual raw secret reads only for explicit secret use, and add a deterministic Podman desktop regression that fails if the list path regresses back to per-secret raw lookups.

## What exists today and why it is slow
- `get_project_secrets_with_store(...)` in `src-tauri/src/services/project_secrets.rs`
  - loads metadata
  - immediately calls `load_value_from_accounts(...)` for every row
  - each row can check both the current and legacy secure-store account ids
- `search_project_secrets_with_store(...)`
  - calls the full list path first, then filters in memory
- `src-tauri/src/services/tool_bridge.rs`
  - `list_project_secrets` and `search_project_secrets` both take the same full-hydration path before paging
- Linux/Podman backend behavior
  - `SecretToolProjectSecretStore::get_value(...)` shells out to `secret-tool lookup ...` for every probe
  - `availability()` also shells out once per request

## Plan

### 1. Split metadata listing from raw secret retrieval
- Add a listing-oriented service path that:
  - loads DB metadata first
  - resolves top-level store availability once
  - resolves per-secret value presence without loading raw secret values and without one store call per row
- Keep `get_project_secret_value(...)` as the only authoritative raw-value load path.

### 2. Remove avoidable O(n) store work from list/search flows
- Refactor `search_project_secrets_with_store(...)` so it no longer calls the full `get_project_secrets_with_store(...)` hydration path.
- Apply metadata filters/paging as early as possible, then resolve value state only for rows that actually need to be returned.
- Preserve current returned states for visible rows: `ready`, `missing_value`, `store_locked`, and `store_error`.

### 3. Introduce a bulk or cached value-state mechanism
Preferred direction:
- extend the secret-store abstraction with a list/bulk presence capability for metadata/listing flows
- implement the Linux `secret-tool` backend so one request can resolve many secret accounts at once instead of spawning one subprocess per secret
- keep a safe fallback for backends that cannot bulk-resolve

If the cross-platform bulk path is not practical enough everywhere, add a small metadata-backed presence cache (`has_stored_value` or equivalent) that is updated on create/rotate/delete and reconciled on explicit value loads so the list path still avoids raw-value reads.

### 4. Add deterministic regression coverage on the supported Podman desktop runner
Prefer extending `tests/desktop-e2e/project-secrets-persistence.test.ts`, since it already owns the supported desktop secrets journey.

Coverage should:
- seed a project with multiple secrets
- use a deterministic test secret-store mode/fixture that makes per-secret raw reads visible via counters and/or artificial delay
- open the Secrets tab through the real desktop UI
- assert the tab becomes ready without N raw-value loads
- still verify that an explicit agent `get_project_secret` load retrieves the real value, so the optimization does not break actual secret use

The strongest stable observable signal is store-call behavior, not a tight wall-clock bound:
- assert list load does not perform one raw lookup per secret
- optionally keep a generous end-to-end timeout as a secondary safeguard

### 5. Add fast backend/unit coverage for the hot path
Add Rust coverage that proves:
- listing/searching secret metadata does not call the raw-value path once per row
- legacy-account fallback still works when explicitly loading a secret
- `missing_value`, `store_locked`, and `store_error` still surface correctly
- tool-bridge pagination/search no longer hydrate the full secret set before paging

## Expected touch points
- `src-tauri/src/services/project_secrets.rs`
- `src-tauri/src/services/tool_bridge.rs`
- `src-tauri/src/services/database.rs` if a metadata presence cache/migration is needed
- `tests/desktop-e2e/project-secrets-persistence.test.ts` or a focused sibling desktop spec
- `scripts/run-desktop-e2e.sh` if the new regression uses a dedicated secret-store fixture
- relevant Rust tests in `src-tauri/src/services/project_secrets.rs` and/or `tool_bridge.rs`

## Validation
- Focused supported run:
  - `./scripts/run-desktop-e2e-podman.sh tests/desktop-e2e/project-secrets-persistence.test.ts`
- If a focused sibling spec is added:
  - `./scripts/run-desktop-e2e-podman.sh tests/desktop-e2e/<project-secrets-loading-spec>.test.ts`
- Fast Rust coverage for service/bridge list/search behavior

## Expected outcome
Project secret settings loads stop scaling with one raw secret-store lookup per secret, Linux/Podman no longer shells out once per secret just to render metadata, and the supported desktop regression suite will fail if the list path regresses back to per-secret raw secret loading.
