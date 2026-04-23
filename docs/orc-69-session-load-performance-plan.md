# ORC-69 — Session-load performance and stale session scan plan

## tl;dr

- Session list/load currently scales with **total session-history bytes on disk**, not the small set of sessions the UI actually needs right now.
- The biggest observed pathology is **soft-deleted/dismissed sessions still being scanned and parsed on every refresh** until a 7-day cleanup window expires.
- `get_session_record` and other helpers also pay an avoidable **cross-project session-file search** cost because session-id-to-path lookup is not indexed.
- Recommended fix: add a persisted **session catalog/index** for summary metadata and path lookup, but treat it as a **self-healing cache rather than the source of truth**; skip dismissed sessions **before** file parsing, keep the current 7-day recovery retention but remove dismissed files from the hot path immediately, and add synthetic history-heavy plus out-of-sync regression coverage.

## Executive summary

The current backend session path has two separate scaling problems:

1. `list_sessions` walks every `*.jsonl` file in the target session directory and parses the full file body to compute summary metadata.
2. `find_session_context_for_session` resolves a session id by scanning every project session directory and reading files until it finds a matching header.

That design means latency grows with accumulated history, file size, and number of projects. It also means soft-deleted/dismissed sessions still cost nearly full scan time even though they are filtered out of the returned list.

Local inspection of the current workstation state shows why this matters:

- `~/.orchestra/projects/*/sessions` currently contains **722 session files** totaling about **541 MB**.
- `~/.orchestra/projects/orchestra-dev/sessions` alone contains **322 files** totaling about **250 MB**.
- Of those 322 orchestra-dev files, **315 are already dismissed** in `session_list_entries`, accounting for about **239 MB** of data that should not be on the hot path anymore.
- An ad hoc reproduction of the current summary-style parsing over the orchestra-dev session directory took about **0.76s**; parsing only the 7 non-dismissed files took about **0.03s**.
- An ad hoc reproduction of the current worst-case session-id lookup took about **0.42s** with whole-file header reads versus about **0.02s** with a header-only approach.

Those are not formal benchmarks, but they are directionally strong enough to justify a structural fix instead of a micro-optimization-only patch.

## Current-state trace

### Session list path

Current hot path:

- `src-tauri/src/commands/sessions.rs` → `list_sessions`
- `src-tauri/src/services/pi_sessions.rs` → `list_sessions`
- `src-tauri/src/services/pi_sessions.rs` → `list_stored_session_summaries`
- `src-tauri/src/services/pi_sessions.rs` → `parse_session_file_summary`

Important behaviors today:

- `commands::list_sessions` loads dismissed ids from SQLite, but it only filters them **after** `list_real_sessions()` has already parsed the files.
- `parse_session_file_summary` does `fs::read_to_string(path)` and then parses the JSONL line-by-line, so summary generation is still O(file bytes).
- After file parsing, `decorate_session_record()` opens a **new SQLite connection per session record** before loading task/worker metadata.
- The frontend refreshes the session list on page entry, on focus, on session-change events, and every 15 seconds while sessions/chat are visible, so even sub-second backend costs are user-visible.

### Session record path

Current detail path:

- `src-tauri/src/commands/sessions.rs` → `get_session_record`
- `src-tauri/src/services/pi_sessions.rs` → `find_session_context_for_session`
- `src-tauri/src/services/pi_sessions.rs` → `get_session` / `resolve_session`

Important behaviors today:

- `find_session_context_for_session` loops over **all project session directories**.
- `resolve_session` loops over every `*.jsonl` file in a directory.
- `parse_session_header()` currently uses `fs::read_to_string(path)` even though it only needs the first non-empty line.

That makes session-id resolution O(projects × files × file size) in the worst case.

### Dismiss/delete lifecycle

Current delete behavior:

- `src-tauri/src/commands/sessions.rs` → `delete_session`
- `delete_session` only records `dismissed_at` in `session_list_entries`
- physical file deletion happens later in `cleanup_dismissed_sessions()` after `DISMISSED_SESSION_RETENTION_DAYS == 7`

That soft-delete policy is compatible with the existing mocked browser expectation that dismissing a session hides it without deleting the stored record immediately. The problem is not the retention window itself; the problem is that dismissed files are still scanned in the list hot path during that retention window.

## Root-cause summary

1. **Visible-list summary generation is file-scan based instead of catalog/index based.**
2. **Dismissed sessions are excluded too late** to save work.
3. **Session-id lookup is unindexed** and re-scans project directories repeatedly.
4. **List decoration is N-per-session DB work** instead of batch/per-request DB work.
5. The current implementation therefore scales with **historical inactive session volume**, which is exactly the behavior this task asks us to stop.

## Recommended implementation plan

## 1) Add a persisted session catalog for hot-path reads

Add a new SQLite-backed catalog table for session discovery and summary metadata.

Suggested fields:

- `session_id` primary key
- `project_id` and/or `project_slug`
- `session_path`
- `created_at`
- `updated_at`
- `title`
- `status`
- `last_role`
- `dismissed_at` or a join to existing dismissal state
- `file_size`
- `file_mtime` (or equivalent refresh token)
- `last_indexed_at`

### Why

This lets Orchestra answer:

- “which sessions should appear in the list?”
- “where is session X stored?”
- “has this file changed since we last summarized it?”

without reparsing every transcript body on every refresh.

### Index consistency contract

The catalog should be treated as a **cache of session metadata**, not an authoritative replacement for the filesystem.

That means the implementation should prefer the catalog on the hot path, but it must always be able to detect drift and repair itself safely.

Minimum safeguards:

- validate that a cataloged `session_path` still exists before trusting it
- on direct session lookup, verify the resolved file still belongs to the requested `session_id` before returning it
- if a catalog row is missing, stale, or points at the wrong file, fall back to a bounded disk scan and then repair the catalog row
- on create / rotate / dismiss / restore / cleanup flows, update the catalog in the same code path rather than waiting for passive discovery
- on startup and periodic list refresh, reconcile catalog rows against on-disk reality so interrupted writes or crashes self-heal

The failure mode we want is: **slightly slower one-time recovery when the cache is wrong**, not broken session discovery.

### Refresh strategy

Use an incremental reconciler per session directory:

1. enumerate directory entries
2. derive `session_id` cheaply from the filename when possible
3. skip dismissed/tombstoned ids before opening the file
4. only re-parse files whose `(mtime,size,path)` changed or whose catalog row is missing
5. delete catalog rows for files that no longer exist

A full cold backfill can still exist, but it should happen once, not on every list call.

Additionally, reconciliation should be conservative:

- if a file's `(mtime,size,path)` token changed, re-parse and rewrite the summary row
- if the filename-derived id and header id disagree, trust the header, repair the row, and log the anomaly
- if a row points at a missing path, evict it and trigger fallback rediscovery for that `session_id`
- if a session is dismissed/restored/deleted through Orchestra commands, perform write-through catalog maintenance immediately so the next list call does not depend on eventual repair

## 2) Move `list_sessions` to catalog-first behavior

Target behavior:

- `list_sessions(projectId)` refreshes the catalog incrementally for the target project directory
- the returned list is read primarily from SQLite summary rows
- only summary metadata needed for the list is loaded on this path
- dismissed sessions never reach the expensive parse/decorate stages
- if a catalog row needed for listing is stale or unverifiable, the request repairs just that row instead of trusting bad metadata

Even if the catalog work lands first and batching lands second, `list_sessions` should at minimum stop opening a fresh SQLite connection per record and instead reuse one connection for the whole request.

## 3) Add fast session-id → path resolution

Replace repeated directory scans in `find_session_context_for_session` with:

1. catalog lookup by `session_id`
2. file existence check
3. fallback one-time disk scan only when the catalog misses, is stale, or fails file/header validation
4. repair or evict the bad catalog row before returning

This change should be used by:

- `get_session_record`
- runtime/detail helpers
- any task/agent/role code that currently calls `find_session_context_for_session`

That turns repeated lookups from scan-heavy behavior into an indexed read with a bounded fallback.

## 4) Keep soft-delete retention, but remove dismissed sessions from hot-path work immediately

Recommended policy decision:

- Keep the current 7-day soft-delete retention window for dismissed sessions.
- Treat dismissed sessions as **cold storage only** during that window.
- Do not scan, summarize, decorate, or surface them during normal list loads.
- Continue pruning aged dismissed files and their catalog rows opportunistically.

This preserves recovery semantics while removing the performance penalty.

I do **not** recommend changing dismiss into immediate hard delete in the same fix unless product explicitly wants to change user-facing behavior; the existing tests/documented behavior imply soft delete.

## 5) Limit summary parsing to true detail loads

`get_session_record(session_id)` should remain the place where full JSONL parsing happens.

That means:

- list path → summary/catalog only
- detail path → full transcript parse for one selected session

This matches the frontend model already in `src/App.tsx`, where list refreshes reconcile light session records and preserve a detailed selected session separately.

## 6) Add performance-oriented regression coverage

Add tests that verify behavior structurally, not just by subjective feel.

Recommended coverage:

### Rust/unit-level

- session catalog refresh skips dismissed sessions before parsing
- session-id lookup resolves via catalog without directory scan when the row is valid
- session-id lookup falls back to disk and repairs the catalog when the row is missing, stale, or points at the wrong path
- dismissed-session cleanup removes aged files and catalog rows
- write-through flows (create, dismiss, restore, delete/cleanup, rotate) keep the catalog in sync immediately
- list hydration reuses one DB connection / batched metadata path
- synthetic many-session fixture keeps parsing limited to changed or visible files
- interrupted or partially stale catalog state self-heals on the next refresh instead of hiding sessions

### Validation fixture shape

Use a synthetic session directory with:

- a small visible active set
- many large dismissed files
- many historical closed files
- at least one changed file that must be re-indexed

Prefer assertions on:

- number of files parsed
- number of catalog refreshes
- number of DB connection opens / metadata queries where practical
- whether stale catalog rows are repaired/evicted automatically
- whether valid sessions remain discoverable even when the catalog is deliberately corrupted before the test

Wall-clock timing can be included as a smoke benchmark locally, but correctness should not depend on timing thresholds in CI.

## 7) Optional low-risk fast-paths worth folding in

These are worthwhile even if the catalog change lands separately:

- make `parse_session_header()` truly header-only instead of `read_to_string`
- derive `session_id` from the canonical `<timestamp>_<uuid>.jsonl` filename when possible
- reuse a single SQLite connection while decorating list records
- skip dismissed files before summary parse even before the full catalog work lands

These do not replace the index, but they reduce immediate pain and lower rollout risk.

## Validation plan

After implementation, validate with both synthetic and local-history-heavy data:

1. baseline current `list_sessions(projectId)` and `get_session_record(sessionId)` behavior
2. seed many dismissed/closed session files
3. confirm list load does not grow materially with dismissed history accumulation
4. deliberately corrupt/remove selected catalog rows and confirm the next lookup refresh repairs them without losing session visibility
5. confirm `get_session_record` resolves by indexed path lookup instead of whole-history scan when the catalog is healthy, and by bounded fallback repair when it is not
6. confirm dismissed sessions remain hidden immediately and are eventually pruned from disk after retention expiry
7. confirm closed-but-visible sessions still appear in the Closed filter with correct metadata

## Files likely involved

- `src-tauri/src/commands/sessions.rs`
- `src-tauri/src/services/pi_sessions.rs`
- `src-tauri/src/services/database.rs`
- `src-tauri/src/services/live_sessions.rs` or adjacent helpers only where session lookup helpers are shared
- tests under `src-tauri/src/commands/sessions.rs` and/or dedicated Rust test modules
- possibly `tests/desktop-e2e/session-refresh-churn.test.ts` if we want an end-to-end regression around bursty refreshes after the backend fix

## Recommended lane handoff

Implementation should proceed in this order:

1. add catalog schema + refresh helpers
2. switch `list_sessions` and session lookup helpers to catalog-first behavior
3. fold in cheap fast-path fixes (header-only reads, pre-filter dismissed, single DB connection)
4. add synthetic regression coverage and capture before/after notes in the task comments
