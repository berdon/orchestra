# ORC-189 — canonical `sessions` schema + backfill plan

## tl;dr

- Add a new `sessions` table that absorbs the hot-path metadata currently split across `session_catalog`, `session_list_entries`, transcript headers, and reverse lookups into task/agent/role runtime tables.
- Backfill it from the union of transcript files, `session_catalog`, `session_list_entries`, `task_lane_assignments`, `task_lane_runs`, `agent_runtime_states`, and `role_instances`.
- Allow canonical rows to exist even when the transcript file is gone so historical task/runtime references still have a real session record.
- Keep legacy tables in place for now; ORC-191/192/193 can dual-write, cut reads over, then retire scan-first/session-catalog logic.

## Executive summary

ORC-189 should land the canonical row first, before any read-path cutover. The row needs to answer the common “what project/task/lane/owner does this session belong to?” questions directly, but it does **not** need to replace every legacy history table in the same change.

The safest shape is:

1. a new `sessions` table keyed by the existing session UUID;
2. explicit project, owner, task/lane, transcript, and list-visibility fields on that row;
3. a backfill/reconcile pass that is idempotent and can create rows even for transcript-missing historical sessions;
4. existing many-to-one history left in `task_lane_assignments` and `task_lane_runs`, with the `sessions` row storing the **primary/current** binding used for lookup and UI decoration.

That gives ORC-190/191/192 a real canonical surface without forcing ORC-189 to also do the full write/read cutover.

## Scope boundary for this task

ORC-189 should cover:

- schema creation for the canonical `sessions` row;
- indexes needed for project/session/task/owner lookup;
- backfill of existing transcript-backed sessions;
- backfill of legacy visibility metadata;
- backfill of task/lane/assignment ownership context;
- backfill of agent-main and role-instance ownership context;
- parity/integrity tests for the backfill.

ORC-189 should **not** also try to finish:

- dual-write session lifecycle updates on every creation/rotation/cleanup path;
- resolver cutover for worker context helpers;
- list/detail/path lookup cutover;
- retirement of `session_catalog` / `session_list_entries`.

Those are already split into ORC-190 through ORC-193.

## Proposed canonical table

```sql
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,

    session_kind TEXT NOT NULL,
    owner_worker_type TEXT,
    owner_worker_id TEXT,
    agent_id TEXT,
    role_id TEXT,
    role_instance_id TEXT,

    primary_task_id TEXT,
    primary_workflow_id TEXT,
    primary_lane_id TEXT,
    primary_assignment_id TEXT,

    transcript_path TEXT,
    transcript_cwd TEXT,
    transcript_exists INTEGER NOT NULL DEFAULT 1,
    file_size INTEGER,
    file_mtime_ms INTEGER,
    last_indexed_at TEXT,

    title TEXT NOT NULL,
    session_status TEXT NOT NULL,
    list_visibility TEXT NOT NULL,
    hidden_reason TEXT,
    dismissed_at TEXT,

    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,

    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE SET NULL,
    FOREIGN KEY(role_id) REFERENCES roles(id) ON DELETE SET NULL,
    FOREIGN KEY(role_instance_id) REFERENCES role_instances(id) ON DELETE SET NULL,
    FOREIGN KEY(primary_task_id) REFERENCES tasks(id) ON DELETE SET NULL,
    FOREIGN KEY(primary_assignment_id) REFERENCES task_lane_assignments(id) ON DELETE SET NULL,
    FOREIGN KEY(primary_workflow_id, primary_lane_id)
        REFERENCES workflow_lanes(workflow_id, id)
        ON DELETE SET NULL
);
```

### Intended field semantics

- `session_kind`: `user_created | agent_main | role_instance | task_assignment | orphaned`
- `primary_*`: the canonical binding used for direct lookup and decoration:
  - active assignment when one exists;
  - otherwise the most recent historical assignment;
  - otherwise the most recent lane-run binding;
  - otherwise null.
- `owner_worker_*`: the primary worker owner for the session row:
  - agent main session → `agent` + `agent_id`
  - role instance session → `role` + `role_id`
  - task-only historical binding → `worker_type` / `worker_id` from the best assignment
  - user-created session → `user` / default user id or null if we want to avoid fake ownership.
- `transcript_*`: persisted file metadata; nullable because some historical references may outlive the file.
- `session_status`: transcript/detail state (`active` / `closed`) from the real session record when a transcript exists, otherwise best-effort historical fallback.
- `list_visibility`: concrete list semantics (`active` / `closed` / `hidden`) so ORC-192 does not need to recreate `session_list.rs` classification on the read path.

## Why this shape

### 1. It keeps one canonical row per session id

Every existing `session_id` / `main_session_id` reference can point at a real row without inventing a second id scheme.

### 2. It does not collapse historical many-to-one links incorrectly

A single agent main session can be reused across multiple task assignments over time. The `sessions` row should store the **primary/current** binding, while `task_lane_assignments` and `task_lane_runs` remain the normalized history.

### 3. It can represent transcript-missing history

Backfill cannot assume every historical session still has a `.jsonl` file. The row must survive even if only task/runtime history remains.

### 4. It absorbs the hot-path parts of legacy tables

`session_catalog` and `session_list_entries` both become secondary once their fields live on `sessions`.

## Required indexes

Add at minimum:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_transcript_path
    ON sessions(transcript_path)
    WHERE transcript_path IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_project_updated
    ON sessions(project_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_project_visibility
    ON sessions(project_id, list_visibility, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_primary_task
    ON sessions(primary_task_id, updated_at DESC)
    WHERE primary_task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_primary_task_lane
    ON sessions(primary_task_id, primary_lane_id, list_visibility, updated_at DESC)
    WHERE primary_task_id IS NOT NULL AND primary_lane_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_agent_main
    ON sessions(project_id, agent_id, updated_at DESC)
    WHERE agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_role_instance
    ON sessions(role_instance_id, updated_at DESC)
    WHERE role_instance_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_owner_worker
    ON sessions(owner_worker_type, owner_worker_id, updated_at DESC)
    WHERE owner_worker_type IS NOT NULL AND owner_worker_id IS NOT NULL;
```

## Backfill inputs and precedence

| Source | Fields contributed | Notes |
| --- | --- | --- |
| transcript file / `session_catalog` | `title`, `session_status`, `created_at`, `updated_at`, `transcript_path`, `transcript_cwd`, `file_size`, `file_mtime_ms`, `last_indexed_at` | use real file/header data when present |
| `session_list_entries` | `dismissed_at`, `hidden_reason` | seed hidden state directly |
| `task_lane_assignments` | `primary_task_id`, `primary_workflow_id`, `primary_lane_id`, `primary_assignment_id`, `owner_worker_*` | use the same “best assignment” ordering as current `load_historical_session_binding()` |
| `task_lane_runs` | fallback `primary_task_id` / `primary_lane_id` | only when no better assignment binding exists |
| `agent_runtime_states` | `session_kind = agent_main`, `agent_id`, project ownership | strongest non-file signal for persistent agent sessions |
| `role_instances` (+ `roles`) | `session_kind = role_instance`, `role_id`, `role_instance_id`, `owner_worker_*` | strongest non-file signal for role sessions |

### Primary binding precedence

Use this order per `session_id`:

1. open task assignment (`active`, `awaiting_user_approval`, `awaiting_user_intervention`, `paused_by_user`, `queued`)
2. most recently updated/completed task assignment
3. most recent lane run
4. null task binding

This intentionally mirrors the current `session_list.rs` lookup behavior so backfill parity is predictable.

### Session-kind precedence

Use this order:

1. `agent_main` if referenced by `agent_runtime_states.main_session_id`
2. `role_instance` if referenced by `role_instances.session_id`
3. `task_assignment` if only task history is known
4. `user_created` if only transcript-backed session data is known
5. `orphaned` if a legacy ref exists but nothing else identifies the session cleanly

### Project-ownership precedence

Use this order for `project_id`:

1. open assignment task project
2. agent runtime project
3. most recent historical assignment / lane-run task project
4. transcript/catalog context

If the relational owner and transcript location disagree, keep the transcript path as-is, prefer the relational `project_id`, and treat the mismatch as a repair/admin-diagnostics issue rather than blocking row creation.

### Visibility backfill rules

Backfill `list_visibility` as a concrete state, not `Unchanged`:

1. if `session_list_entries.hidden_reason` or `dismissed_at` exists → `hidden`
2. else if an open assignment exists for a non-terminal task → `active`
3. else if the bound task is `completed` → `hidden` with `task_completed`
4. else if the bound task is `canceled` → `hidden` with `task_canceled`
5. else if the session is a stale role session with no valid task binding → `hidden` with `stale_role_session`
6. else fall back to transcript `session_status`:
   - `active` → `active`
   - `closed` → `closed`

That preserves current semantics while moving them onto the canonical row.

## Transcript-missing rows are required

The canonical row must support:

- `transcript_path = NULL`
- `transcript_exists = 0`
- fallback `title` from task/owner/session id
- fallback `created_at` / `updated_at` from the best historical source

Without this, historical `task_lane_runs`, `task_lane_assignments`, `agent_runtime_states`, or `role_instances` can still point at session ids that never get a canonical row.

## Migration / implementation plan

### Step 1 — add schema + indexes

Files likely involved:

- `src-tauri/src/services/database.rs`
- `src-tauri/src/models.rs` if we want an internal `SessionRow` / backfill report type
- new helper module, likely `src-tauri/src/services/canonical_sessions.rs` or similar

### Step 2 — build one idempotent backfill/reconcile helper

Add a helper that:

1. scans known project session dirs;
2. loads legacy catalog/list-entry data;
3. loads task/assignment/lane-run ownership data;
4. loads agent/role ownership data;
5. upserts one `sessions` row per discovered `session_id`.

The helper should be safe to rerun and should prefer repair over duplicate rows.

### Step 3 — run backfill from schema initialization / bootstrap

Add a schema-level `backfill_sessions_table(connection)` call after the legacy tables are ensured.

Behavior:

- first run creates all missing canonical rows;
- later runs repair drift and fill rows for any old legacy references that were missed earlier;
- counts created/updated/transcript-missing/conflicted rows for tests and logging.

### Step 4 — keep legacy tables as the source of historical fan-out for now

Do **not** rebuild every legacy table in ORC-189 just to add hard SQLite FKs.

For this task, it is enough that:

- every legacy `session_id` now resolves to a real canonical row;
- the canonical row carries the primary binding needed for future lookups;
- ORC-191/192 can start dual-writing and reading against the new row.

If true DB-level FK rebuilds are still wanted later, that can happen after cutover when the hot path no longer depends on the legacy scan logic.

## Validation plan

Add tests that prove:

1. transcript-backed sessions get canonical rows with path/fingerprint/title/status data;
2. hidden/dismissed legacy entries are copied into `list_visibility` / `hidden_reason` / `dismissed_at`;
3. agent main sessions without task history still backfill correctly;
4. role-instance sessions without a surviving transcript still get canonical rows;
5. task-history-only session ids still get canonical rows;
6. a reused session with multiple assignments picks the same primary binding ordering as the current code;
7. rerunning the backfill is idempotent;
8. transcript-missing rows are preserved instead of dropped.

The existing `session_management` inventory helpers are a good validation oracle because they already surface:

- catalog/file drift
- hidden/dismissed state
- orphan list entries
- orphan run origins
- derived-vs-header session-id mismatches

## Handoff to sibling tasks

- **ORC-189**: create the canonical row and backfill old history
- **ORC-191**: dual-write session creation/rotation/lifecycle updates into `sessions`
- **ORC-190**: move worker/task/lane ownership resolvers to `sessions`
- **ORC-192**: switch list/detail/context lookup to `sessions`-first reads
- **ORC-193**: retire `session_catalog`, `session_list_entries`, and scan-first fallback from the hot path

## Recommended success criteria for this lane

This plan is good enough to hand to implementation if the eventual ORC-189 change set can answer “yes” to all of these:

- Can every historical Orchestra-managed `session_id` get a canonical row, even if its transcript file is gone?
- Can the row answer project/task/lane/owner lookup without rescanning transcript files or reverse-searching multiple runtime tables?
- Can later lanes cut reads/writes over incrementally without first deleting the legacy tables?
- Does the backfill preserve current visibility semantics instead of silently reopening hidden history?
