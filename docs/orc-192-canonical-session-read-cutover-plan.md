# ORC-192 — Canonical session-row read-path cutover plan

## tl;dr

- Move `find_session_context_for_session`, UI/remote `list_sessions`, `get_session_record`, and session-management query helpers onto `sessions` rows as the primary read model.
- Keep transcript parsing only for **single-session detail hydration** and **bounded one-session repair** when a row is missing or stale.
- Treat `session_catalog`, `session_list_entries`, and directory scans as compatibility/repair inputs only until ORC-193 removes them from normal execution.
- Track ORC-192 as blocked by ORC-189 (schema/backfill) and ORC-191 (dual-write lifecycle updates).

## Executive summary

Today’s session hot paths still start from transcript discovery or legacy cache tables, then reconstruct project/task/worker context by querying multiple tables and sometimes rescanning files. ORC-189 and ORC-191 establish the missing prerequisite: a canonical `sessions` row for every Orchestra-managed Pi session plus write-through lifecycle updates.

ORC-192 should be the read-path cutover on top of that foundation. After this task, the normal answer to “what session is this?”, “which sessions should I list?”, and “what task/worker does this session belong to?” should come from `sessions` first. Transcript files remain important, but only for loading one session’s event history and for repairing one broken/missing row at a time.

## Scope

This task should cut these paths to `sessions`-first behavior:

- `src-tauri/src/services/pi_sessions.rs`
  - `find_session_context_for_session`
  - `get_session_path`
  - project/session lookup helpers used by detail/runtime callers
- `src-tauri/src/commands/sessions.rs`
  - `list_sessions`
  - `get_session_record`
  - session decoration helpers shared by list/detail
- `src-tauri/src/services/session_management.rs`
  - session inventory/query helpers backing the agent tool surface
- `src-tauri/src/services/session_list.rs`
  - task/worker/visibility decoration inputs should start from canonical session ownership rows, not reverse inference from transcript/catalog presence

## Current problems to remove

1. `find_session_context_for_session` still falls back to cross-project directory scans.
2. UI `list_sessions` still depends on `session_catalog` refresh and legacy session-list decoration lookups.
3. `get_session_record` still discovers the session through the legacy lookup path before parsing the transcript.
4. `session_management::list_sessions` still scans transcript files to build inventory and search/filter results.
5. Session decoration still infers task/worker bindings from `task_lane_assignments`, `task_lane_runs`, `agent_runtime_states`, and `role_instances` without a canonical session-owned starting row.

## Target read model

Assume ORC-189 provides a `sessions` row with, at minimum, the fields ORC-192 needs to read directly:

- session identity and project ownership
  - `id`
  - `project_id`
  - `transcript_path`
  - `created_at`
  - `updated_at`
- session summary state
  - `title`
  - `status`
  - visibility metadata now living in or derived from the row
- canonical ownership/context
  - `session_kind`
  - `task_id`
  - `workflow_id`
  - `lane_id`
  - `task_lane_assignment_id` / owning assignment link
  - `agent_id` / `role_id` / `role_instance_id` where applicable
- repair/lifecycle support
  - row freshness / repair metadata sufficient for bounded repair

The important design rule is not “everything must be denormalized onto one row”; it is “every lookup starts from one canonical row instead of from file scans or reverse inference.”

## Cutover plan

### 1. Add a shared session-row read layer

Introduce a single read helper set that loads:

- one session row by `session_id`
- session rows for one project
- session rows for all visible projects
- optional joined summary fields needed by list/query surfaces

This layer should be the only normal entry point for session lookup. Existing commands/services should call it instead of talking to `session_catalog` or scanning directories.

### 2. Rework `find_session_context_for_session`

New flow:

1. load `sessions` row by `session_id`
2. resolve project/session context from row-owned `project_id`/`transcript_path`
3. if the row and path are valid, return immediately
4. if the row is missing or stale, run **bounded repair for that single session only**, then retry once
5. if repair still cannot recover the row, fail

Explicit non-goal: no normal-path scan across every project session directory.

### 3. Rework list paths to query `sessions` rows directly

For both the Tauri/remote session list and the agent-tooling inventory list:

- query `sessions` rows directly, scoped by project when requested
- derive hidden/closed/active semantics from canonical visibility/ownership data
- join to tasks / assignments / agents / roles only for display metadata
- overlay runtime-only flags (`subscribed`, `terminal_attached`, live runtime state) after the DB read
- do not parse transcripts on the list path
- do not refresh `session_catalog` on the list path

`session_management::list_sessions` should keep its current external filter surface, but its base inventory should come from `sessions` rows. Legacy-only diagnostic facts such as catalog presence or transcript/header mismatch should be attached from lightweight secondary checks, not by making transcript scans the starting point.

### 4. Rework `get_session_record`

New flow:

1. load the canonical session row first
2. build the summary/session metadata from that row plus joined owner/task data
3. parse the single transcript file only to hydrate events/detail-only fields
4. apply the existing list-vs-detail visibility/messageability rules on top of canonical session ownership data
5. if the transcript is missing or invalid, invoke bounded repair and return the best recoverable detail result

This keeps detail loading transcript-aware without making transcript discovery the canonical lookup path.

### 5. Rework decoration/query helpers around canonical ownership

Refactor session decoration helpers so they start from the session row and use FK-backed joins only where needed:

- historical task fields come from the session’s canonical owning task/assignment history links
- active task fields come from the current open assignment link for that session, if any
- worker identity comes from canonical session ownership (`agent`, `role`, `role_instance`, task assignment owner) rather than from “find whichever table currently mentions this session id first”
- visibility classification should consume canonical session/task lifecycle state first, with legacy hidden-list entries only acting as temporary compatibility inputs until ORC-193

## Bounded repair rules

Bounded repair in ORC-192 should mean:

- at most one target session id per request
- read the known transcript path if present
- if the row is missing, use indexed/targeted legacy hints to find the one transcript that should own that id
- repair/upsert the canonical row
- never perform a full project-wide or cross-project scan as part of a normal list/detail lookup

That keeps drift survivable without preserving the old scan-first architecture.

## Compatibility boundary for legacy tables

During ORC-192:

- `session_catalog` may still exist, but only as a fallback/diagnostic source
- `session_list_entries` may still exist, but only as temporary compatibility input if ORC-189 has not fully moved hidden/dismissed metadata onto `sessions`
- transcript files remain the source for event history, not for session identity/context discovery

After ORC-192, legacy tables/files should no longer be the primary source for normal execution paths. ORC-193 can then safely remove or quarantine that logic.

## Validation

Add/adjust regression coverage for:

- `find_session_context_for_session` resolving from `sessions` without directory scans
- one-session bounded repair when the canonical row/path is stale
- `list_sessions` returning correct active/closed/hidden behavior without transcript parsing
- `get_session_record` loading metadata from the session row while still hydrating transcript events
- persistent agent and role-session visibility/messageability semantics staying unchanged
- session-management tool queries filtering/searching from `sessions` rows instead of transcript inventory scans

## Sequencing

Recommended order:

1. finish ORC-189 schema/backfill
2. finish ORC-191 dual-write lifecycle updates
3. implement ORC-192 read-path cutover
4. implement ORC-190 broader worker-context resolver cutovers where they still rely on reverse inference
5. implement ORC-193 legacy hot-path retirement

## Files likely touched

- `src-tauri/src/services/pi_sessions.rs`
- `src-tauri/src/commands/sessions.rs`
- `src-tauri/src/services/session_list.rs`
- `src-tauri/src/services/session_management.rs`
- shared canonical-session read helpers added alongside the new session-row service
- Rust tests covering list/detail/context lookup behavior
