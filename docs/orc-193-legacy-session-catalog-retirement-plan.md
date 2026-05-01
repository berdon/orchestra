# ORC-193 — Retire legacy session catalog and list-entry hot paths after canonical cutover

## tl;dr

- Once ORC-189, ORC-190, ORC-191, and ORC-192 are stable, normal session flows should stop reading or writing `session_catalog`, `session_list_entries`, and transcript-scan fallback lookup paths.
- `sessions` should become the only normal lookup surface for session path, project/task/lane/worker ownership, and visibility/archive state; transcript files stay detail payload, not discovery/index state.
- Any filesystem scan, orphan repair, or legacy-table comparison should move behind explicit admin diagnostics/reconciliation commands only.
- Prefer a two-step retirement: first remove hot-path callers and auto-repair fallback, then drop legacy schema/helpers once burn-in confirms canonical reads and writes are complete.

## Executive summary

Current session behavior still depends on legacy indexing and visibility layers even after the intended canonical-session redesign:

- `src-tauri/src/commands/sessions.rs::list_command_sessions_with_connection(...)` still runs `cleanup_dismissed_sessions()` and `load_dismissed_session_ids()` before listing.
- `src-tauri/src/services/pi_sessions.rs::list_sessions_with_connection(...)` still refreshes and reads `session_catalog`.
- `src-tauri/src/services/pi_sessions.rs::find_session_context_for_session(...)` still uses catalog lookup plus cross-project directory scan fallback.
- `src-tauri/src/services/session_list.rs` still makes `session_list_entries` the durable visibility/archive store.
- `src-tauri/src/services/session_management.rs` mixes valuable admin inventory/reconcile behavior with the same scan/catalog concepts that should no longer be on the normal path.

ORC-193 should be the cleanup pass that finishes the cutover:

1. remove legacy reads/writes from normal list/detail/runtime code
2. stop automatic scan-based repair during ordinary requests
3. keep only explicit admin diagnostics/reconciliation for drift cases
4. delete legacy schema/helpers after cutover burn-in proves the canonical row is sufficient

## Target end state

### Normal execution paths

Normal app, runtime, and tool flows should:

- resolve session metadata from the canonical `sessions` row only
- resolve transcript location from the canonical session row only
- derive visibility/archive state from canonical session fields only
- parse transcript files only when hydrating the specific session detail/transcript payload
- fail fast on missing canonical metadata instead of scanning the filesystem to guess intent

### Explicit admin/reconciliation paths

Only explicit operator-facing diagnostics should be allowed to:

- scan session directories
- compare transcript files with canonical session rows
- inspect legacy `session_catalog` / `session_list_entries` state when those tables still exist on upgraded databases or test fixtures
- repair orphaned transcript files or stale legacy rows

That means drift recovery becomes deliberate and observable, not something every normal `list_sessions` or `get_session_record` call quietly attempts.

## Preconditions before retirement

ORC-193 should not remove the legacy surfaces until all of these are true:

1. **ORC-189** backfilled every historical Orchestra-managed session into `sessions`, including transcript path and visibility/archive metadata.
2. **ORC-191** dual-write lifecycle flows already keep canonical session rows accurate at creation, rotation, archive, restore, task completion, and cleanup time.
3. **ORC-190** worker-context resolvers no longer need reverse inference from legacy scan helpers.
4. **ORC-192** read paths already prefer canonical rows and have proven stable in burn-in.
5. Burn-in evidence shows normal requests are no longer depending on repair fallback to succeed.

If any of those are false, ORC-193 should stop at quiescing unused code, not full schema deletion.

## Retirement plan

### 1. Remove legacy state from normal list/detail code

Replace these behaviors in normal code paths:

- `cleanup_dismissed_sessions()` on every list load
- `load_hidden_session_ids()` / `session_list_entries` as the normal visibility source
- `refresh_session_catalog()` and `load_session_catalog_records()` for normal session listing
- `find_session_context_for_session()` fallback scans across `all_session_contexts()`
- catalog write-through in `create_session_file()` / `delete_session_file()`

Expected replacements:

- canonical session query service for list surfaces
- canonical `session.transcript_path` lookup for detail/runtime access
- canonical visibility/archive fields for active/closed/hidden semantics
- direct session-row lookup by `session_id` for task/agent/role/runtime helpers

### 2. Remove automatic repair from ordinary requests

ORC-192 can still tolerate bounded repair while the cutover settles. ORC-193 should remove that tolerance from normal execution.

After retirement:

- if a canonical session row is missing, normal requests should return a clear error
- if `transcript_path` is missing or stale, normal requests should return a clear error
- the error should point operators toward the explicit reconciliation command/tooling
- no ordinary list/detail/runtime request should scan directories to “find” the session

This is the key behavior change that actually retires scan-first discovery.

### 3. Fence legacy scanning behind explicit admin tooling

Keep the useful parts of `src-tauri/src/services/session_management.rs`, but make them explicitly diagnostic:

- inventory/list sessions for operators
- session diagnostics
- reconcile/import orphan transcript files
- remove stale legacy rows or stale canonical rows

Recommended structure:

- move transcript scanning and legacy-table inspection into a dedicated admin-only helper/module
- make `reconcile_sessions` the canonical repair entry point
- ensure the normal desktop/backend session APIs never call those helpers implicitly

If the existing admin command names stay the same, their descriptions and filters should make the diagnostic nature explicit.

### 4. Drop or isolate legacy schema

Once burn-in is complete, add a cleanup migration that:

- copies any last required `session_catalog` / `session_list_entries` state into canonical session fields if needed
- stops creating indexes/helpers tied to those tables
- drops legacy tables and indexes, or at minimum makes them optional compatibility tables that the app no longer expects to exist

The recommended end state is:

- production runtime does not require either table
- admin diagnostics tolerate both cases: legacy tables absent, or legacy tables still present on a partially upgraded/test fixture database

## Code areas expected to change

Primary cleanup targets:

- `src-tauri/src/services/pi_sessions.rs`
- `src-tauri/src/services/session_list.rs`
- `src-tauri/src/commands/sessions.rs`
- `src-tauri/src/services/session_management.rs`
- `src-tauri/src/services/database.rs`
- `src-tauri/src/services/tool_bridge.rs`
- `extensions/orchestra-tools.ts`

Likely dead-call cleanup after ORC-190/192 lands:

- runtime/service callers that still import `find_session_context_for_session(...)`
- helper code that still assumes a directory scan is an acceptable session-id lookup strategy

## Tooling/API adjustments

The current admin inventory tools expose legacy concepts such as `catalogPresent` and `dismissed`.

After retirement, prefer one of these outcomes:

1. **Canonical-first rename**
   - rename legacy-oriented filters to explicit diagnostic names such as `legacyCatalogPresent` / `legacyListEntryPresent`
2. **Compatibility mode**
   - keep the same filters temporarily, but define them as admin-only drift signals that may always be false/empty once the legacy tables are gone

Either way, normal application session APIs should stop surfacing legacy catalog/list-entry semantics.

## Regression coverage to keep

Retire the hot path, not the safety net.

Keep tests for:

- normal `list_sessions` does not touch legacy tables or scan session directories
- normal `get_session_record` resolves from canonical row + transcript path only
- missing canonical row fails fast instead of auto-scanning
- explicit reconciliation can still detect and repair:
  - orphan transcript files
  - stale legacy catalog rows
  - stale legacy list entries
  - canonical row vs transcript path mismatches
- upgraded databases still behave correctly whether legacy tables are present or already dropped

Remove or rewrite tests that currently encode legacy hot-path behavior such as:

- catalog refresh on ordinary list load
- hidden-session filtering via preloaded `session_list_entries`
- automatic directory-scan fallback during normal record lookup

## Recommended implementation sequence

1. prove ORC-189/190/191/192 prerequisites are complete
2. cut normal callers over to canonical session lookup/visibility services only
3. delete automatic repair/scanning from normal list/detail/runtime paths
4. move remaining scan/reconcile code under explicit admin tooling
5. update admin tool schemas/descriptions to reflect legacy-diagnostic status
6. drop legacy schema/helpers once burn-in confirms no normal callers remain
7. keep focused drift/regression tests for explicit reconciliation only

## Exit criteria

ORC-193 is done when all of the following are true:

- normal session list/detail/runtime flows succeed without `session_catalog` or `session_list_entries`
- no normal request path scans project session directories to resolve a session id
- transcript parsing in normal paths happens only for the session already identified by the canonical row
- legacy recovery is available only through explicit diagnostics/reconciliation tooling
- repository references to `session_catalog` / `session_list_entries` are limited to migration/compat/admin code and tests, or removed entirely if the schema drop is complete
