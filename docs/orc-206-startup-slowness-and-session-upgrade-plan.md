# ORC-206 — Startup slowness and session-path upgrade panic plan

## tl;dr

- Treat this as **two related but separate fixes**: (1) measure and trim startup work, and (2) make session-catalog upserts/path repairs collision-safe so upgrades cannot crash boot.
- The most likely startup cost is **eager hydration work after app launch**, especially unconditional session-list loading plus project unread/reference preloads.
- The session panic is caused by a **unique `session_path` constraint with upserts keyed only by `session_id`**; a stale row that already owns the path can make a repair/upsert crash.
- Implement one small timing layer first, then land two focused fixes: **lazy/deferred startup hydration** and **collision-safe session catalog repair/upsert** with regression tests.

## Executive summary

A quick code audit points to two concrete issues.

First, startup currently has no end-to-end timing breakdown, and the app eagerly kicks off more work than it needs immediately. `src/App.tsx` unconditionally calls `loadSessions()` on startup for normal windows, and it also eagerly loads project unread counts plus project reference data. On the backend side, there is no startup-stage timer around `initialize_backend()`, `sync_channel_runtimes(...)`, `ensure_remote_api_server(...)`, or the session-list RPC path. That makes the slow path hard to prove and easy to regress.

Second, session catalog writes are vulnerable to upgrade-time path collisions. The schema makes `session_catalog.session_path` unique, but the write path in `src-tauri/src/services/pi_sessions.rs` and the reconcile path in `src-tauri/src/services/session_management.rs` use `INSERT ... ON CONFLICT(session_id) DO UPDATE ...`. If a different stale row already owns the same `session_path`, the upsert fails before it can repair the row. Because the catalog is a cache, that should self-heal instead of crashing startup.

## Current findings

### 1) Startup work is broader than it needs to be

Relevant paths:

- `src-tauri/src/lib.rs`
- `src-tauri/src/services/backend_bootstrap.rs`
- `src/App.tsx`
- `src-tauri/src/commands/sessions.rs`
- `src-tauri/src/services/session_list.rs`

Observed hot spots from code shape:

- backend boot does several synchronous steps before the window is fully ready:
  - database init/migrations
  - tool bridge startup
  - auth/bootstrap seeding
  - install baseline seeding
  - channel runtime sync
  - remote API ensure
- frontend startup then eagerly loads:
  - app info / Pi diagnostics
  - project catalog
  - session list
  - project unread counts for every project
  - project reference data for the active project
- `loadSessions()` runs even when the user did not open the Sessions or Chat surface.
- session listing still does per-session decoration work in `commands/sessions.rs` via `session_list::load_session_list_decoration(...)`, which fans out into several DB lookups per visible session.

Local workspace state also explains why unnecessary session work is noticeable here:

- `~/.orchestra/projects/*/sessions`: **1,530** session files, about **1.25 GB** total
- `~/.orchestra/projects/orchestra-dev/sessions`: **847** files, about **714 MB** total

The catalog work reduced full transcript parsing, but startup still pays for session discovery/list decoration earlier than necessary.

### 2) The session-path panic is a repair/upsert correctness bug

Relevant paths:

- `src-tauri/src/services/database.rs`
- `src-tauri/src/services/pi_sessions.rs`
- `src-tauri/src/services/session_management.rs`

The current schema declares:

- `session_catalog.session_id` as the primary key
- `session_catalog.session_path` as a unique index

The current repair/upsert pattern updates on `session_id` conflict only. That means this sequence fails:

1. stale row A still claims `/path/to/file.jsonl`
2. refresh/reconcile discovers the same file now belongs to session B
3. code upserts B by `session_id`
4. SQLite rejects the write because row A still owns the unique `session_path`

That is consistent with the reported upgrade panic: the file-path uniqueness rule is correct, but the repair path is not removing or rewriting the conflicting stale owner before the insert/update.

## Proposed implementation

### 1) Add explicit startup timing instrumentation first

Add lightweight timing logs for:

- `initialize_backend()` sub-steps in `src-tauri/src/services/backend_bootstrap.rs`
- Tauri setup steps in `src-tauri/src/lib.rs`
- expensive startup RPCs, at minimum:
  - `list_sessions`
  - `get_app_info`
  - `list_tasks` if it is part of eager startup data
- frontend startup milestones in `src/App.tsx`

The output only needs to be durable logs/console timings with a stable prefix, e.g. `startup.timing.*`, so a before/after launch shows where time is spent.

### 2) Trim eager startup hydration

Change startup so the app does not pay for session-heavy work immediately unless needed.

Recommended order:

1. keep the minimal shell/bootstrap loads
2. load project catalog
3. only load sessions eagerly when the initial surface actually needs them (`sessions`, `chat`, or supervisor quick chat recovery)
4. defer project unread counts and project reference data until after initial paint or behind the surfaces that actually use them

If a background warm-up is still desirable, schedule it after the first paint/idle boundary instead of in the critical startup path.

### 3) Make session catalog upserts collision-safe

Create one shared helper for session catalog writes that:

- runs in a transaction
- checks for an existing row by `session_path`
- if that row belongs to a different `session_id`, validates which file/session mapping is authoritative
- deletes or rewrites the stale owner before the insert/update
- then performs the canonical upsert

Use that helper from both:

- `src-tauri/src/services/pi_sessions.rs`
- `src-tauri/src/services/session_management.rs`

Because `session_catalog` is a cache, repair should prefer “evict stale and continue” over hard failure.

### 4) Add upgrade-safe repair on startup/reconcile

Before relying on catalog rows during refresh, handle the stale-owner case explicitly:

- same path + different session id → repair deterministically
- missing file/path mismatch → evict stale row
- header id differs from filename/catalog id → trust the file header, repair the row, log the anomaly

The important behavior change is: **catalog corruption or legacy drift may slow one startup, but must not panic the app**.

## Validation plan

### Startup

- capture a before/after startup timing log on the same workstation state
- confirm whether the initial route still loads sessions when not needed
- verify the first usable paint and first project render improve measurably

### Session upgrade safety

Add regression tests for:

- stale row owns `session_path`, fresh row/session should replace it without error
- refresh/reconcile repairs `session_path` ownership instead of failing the write
- upgrade/startup with preexisting stale catalog state no longer panics
- direct session-path resolution still works after repair

## Recommended file touch set

- `src-tauri/src/services/backend_bootstrap.rs`
- `src-tauri/src/lib.rs`
- `src/App.tsx`
- `src-tauri/src/commands/sessions.rs`
- `src-tauri/src/services/session_list.rs`
- `src-tauri/src/services/pi_sessions.rs`
- `src-tauri/src/services/session_management.rs`

## Suggested execution order

1. add timing instrumentation
2. capture one baseline launch
3. trim/defer eager startup session/reference loads
4. make session catalog upserts/path repair collision-safe
5. add regression coverage for both startup timing markers and upgrade collision repair
