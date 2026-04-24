# ORC-144 — managed skills catalog foundation plan

## tl;dr

- Add the catalog/storage foundation in Rust first: new skill path helpers, a `skills` table, a base `skill_scope_bindings` table, and a dedicated `skills` service/command surface.
- Treat Orchestra-local and external `~/.agents/skills` entries as catalog rows in the same table, but keep authored local markdown on disk at `~/.orchestra/skills/<slug>.md` and keep external skills read-only.
- Make local skills the canonical winners for same-slug collisions; among external collisions, pick the lexicographically earliest relative path as the deterministic winner and mark the rest shadowed.
- Persist external discovery state so missing/invalid/unloadable entries remain explainable instead of silently disappearing.
- Stop this slice at local desktop/Tauri/backend surfaces plus tests; defer scope-binding CRUD, runtime publication/loading, Settings UI, remote API parity, and `skills.*` permissions to ORC-149/146/148/147.

## Executive summary

ORC-144 should establish a single canonical skills catalog that later UI, binding, and runtime work can rely on without inventing their own storage rules. The key architectural move is to separate **catalog metadata in SQLite** from **authored markdown on disk**:

- local Orchestra-authored skills live at `~/.orchestra/skills/<slug>.md`,
- external skills are discovered read-only from `~/.agents/skills/**/SKILL.md`,
- both appear in one `skills` catalog with explicit `source_kind`, `status`, and shadow metadata.

This keeps phase-1 simple while still giving downstream slices stable IDs, deterministic collision behavior, and persistent missing/invalid status tracking.

## Current seams to use

- `src-tauri/src/services/orchestra_paths.rs` already owns Orchestra filesystem helpers and should gain the new skills/runtime-snapshot helpers.
- `src-tauri/src/services/database.rs` already centralizes schema creation plus additive migrations.
- `src-tauri/src/models.rs`, `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs`, and `src-tauri/src/services/mod.rs` are the normal places to register new backend surfaces.
- Pi runtime ownership already centers on `~/.orchestra/runtime/pi/agent/`; ORC-144 only needs to reserve the `skills/` and `skill-snapshots/` subtrees there, not publish/load them yet.

## Recommended implementation

### 1. Filesystem contract

Add helpers in `src-tauri/src/services/orchestra_paths.rs` for:

- `orchestra_skills_dir(root) -> ~/.orchestra/skills/`
- `orchestra_local_skill_path(root, slug) -> ~/.orchestra/skills/<slug>.md`
- `orchestra_pi_agent_skills_dir(root) -> ~/.orchestra/runtime/pi/agent/skills/`
- `orchestra_pi_skill_snapshots_dir(root) -> ~/.orchestra/runtime/pi/skill-snapshots/`

Notes:

- keep creation lazy; ORC-144 only needs canonical path resolution plus tests.
- do **not** move authored local files under `runtime/`; `runtime/` is only for published/global and snapshot material later in ORC-146.

### 2. Catalog schema foundation

Add a new `skills` table in `src-tauri/src/services/database.rs`.

Recommended shape:

- `id TEXT PRIMARY KEY`
- `slug TEXT` — required for local rows; nullable for invalid external rows
- `name TEXT NOT NULL`
- `description TEXT` — derived from the first non-empty paragraph
- `source_kind TEXT NOT NULL` — `local` | `external`
- `source_path TEXT NOT NULL` — local markdown path or external skill directory path
- `content_path TEXT NOT NULL` — local markdown file or external `SKILL.md`
- `relative_source_path TEXT` — external path relative to `~/.agents/skills` for deterministic ordering/debugging
- `archived INTEGER NOT NULL DEFAULT 0` — local only in practice
- `status TEXT NOT NULL` — `active` | `shadowed` | `missing` | `invalid` | `unloadable`
- `status_reason TEXT`
- `shadowed_by_skill_id TEXT`
- `last_seen_at TEXT`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

Recommended indexes/constraints:

- unique local slug: partial unique index on `slug` where `source_kind = 'local'`
- unique source path: unique index on `(source_kind, source_path)`
- lookup indexes on `(slug, source_kind)`, `(status, archived)`, and `(shadowed_by_skill_id)`

Add the base `skill_scope_bindings` table now, but keep it intentionally thin for ORC-149:

- `id TEXT PRIMARY KEY`
- `skill_id TEXT NOT NULL`
- `scope_kind TEXT NOT NULL` — `global` | `project` | `role` | `agent` | `workflow` | `workflow_lane`
- nullable target columns: `project_id`, `role_id`, `agent_id`, `workflow_id`, `workflow_lane_id`
- timestamps
- foreign key `skill_id -> skills(id)`
- unique index covering the scope tuple so the same binding cannot be inserted twice

ORC-144 should create the table/index shape only. Binding CRUD/validation remains ORC-149.

### 3. Local skill CRUD rules

Implement a dedicated `src-tauri/src/services/skills.rs` service.

Recommended local API shape:

- `list_skills(...)`
- `get_skill(skill_id)`
- `create_local_skill(input)`
- `update_local_skill(skill_id, input)`
- `set_local_skill_archived(skill_id, archived)`
- `delete_local_skill(skill_id)`
- `refresh_external_skills()`

Recommended local upsert input:

- `name: string`
- `slug?: string` — optional override so follow-on UI can support explicit slug editing
- `markdownBody: string`

Rules:

- canonical slug regex: `^[a-z0-9]+(?:-[a-z0-9]+)*$`
- if `slug` is omitted, derive it from `name` using the existing slug sanitizer
- reject duplicate **local** slugs; allow same-slug external rows because local should shadow them
- store only the markdown body in `~/.orchestra/skills/<slug>.md`; no frontmatter, wrapper JSON, or duplicated metadata block
- derive `description` from the first non-empty markdown paragraph, normalized to single-line whitespace
- keep the same `id` when a slug changes; rename the file and update catalog metadata in place
- archive/unarchive should flip DB state only and leave the markdown file at its canonical path
- delete should remove the DB row and markdown file, but reject deletion when any `skill_scope_bindings` rows exist for that skill

Implementation detail: perform local file writes via temp-file-then-rename so DB state only advances after the authored file is safely written.

### 4. External `~/.agents/skills` discovery and status rules

Discovery contract:

- scan `~/.agents/skills` recursively for directories that contain `SKILL.md`
- ignore root-level `~/.agents/skills/*.md` files entirely
- derive the candidate external slug from the containing directory basename
- set `relative_source_path` from the directory path relative to `~/.agents/skills`
- read `SKILL.md` as markdown body and derive `description` using the same paragraph logic as local skills

Status rules:

- `active`: valid row and currently the effective winner for its slug/source
- `shadowed`: valid row suppressed by a local skill or by an earlier external collision winner
- `missing`: previously indexed external row not found on the latest refresh
- `invalid`: discovered row fails phase-1 slug/body rules
- `unloadable`: path exists but `SKILL.md` could not be read/canonicalized reliably

Deterministic collision handling:

1. valid local rows win over all external rows with the same slug
2. among remaining valid external rows for the same slug, sort by `relative_source_path ASC`, then `source_path ASC`
3. the first row stays `active`; every later row becomes `shadowed`
4. invalid/missing/unloadable rows never win a collision

Persistence rule:

- never hard-delete external rows during refresh
- update rediscovered rows in place by `source_path`
- mark undiscovered previously-known rows as `missing`

That persistence is what makes later diagnostics, bindings, and migration warnings explainable.

### 5. Backend surface and repo touch points

Rust/backend files to add or change:

- `src-tauri/src/services/orchestra_paths.rs`
- `src-tauri/src/services/database.rs`
- `src-tauri/src/services/skills.rs` **(new)**
- `src-tauri/src/services/mod.rs`
- `src-tauri/src/models.rs`
- `src-tauri/src/commands/skills.rs` **(new)**
- `src-tauri/src/commands/mod.rs`
- `src-tauri/src/lib.rs`

Desktop/UI-facing wrappers for follow-on UI work:

- `src/types.ts`
- `src/lib/skills.ts` **(new)**

Keep ORC-144 local/desktop-scoped. Do **not** thread full remote API/bootstrap/capability work here; ORC-147 owns remote parity and `skills.*` permissions.

### 6. Explicit non-goals for this slice

Do not include in ORC-144:

- scope-binding CRUD or validation logic beyond the base table/index shape
- publishing global skills into `~/.orchestra/runtime/pi/agent/skills/`
- materializing runtime snapshots under `~/.orchestra/runtime/pi/skill-snapshots/`
- Pi `--skill` loading changes
- Settings/Skills UI
- remote API parity or final `skills.*` permission gating

### 7. Test coverage required in this slice

Add Rust tests for:

- new path helpers in `orchestra_paths.rs`
- `skills`/`skill_scope_bindings` migration presence and key indexes
- local create/update/rename/archive/delete behavior
- slug validation and duplicate-local rejection
- markdown-body-only storage
- description derivation from the first non-empty paragraph
- external recursive discovery and root `.md` ignore behavior
- deterministic external collision selection
- local-over-external shadowing
- missing/invalid/unloadable transitions across repeated refreshes

If `src/lib/skills.ts` is more than a thin invoke wrapper, add a small TS test for argument/shape normalization; otherwise keep coverage in Rust.

## Recommended execution order inside the implementation lane

1. add path helpers and tests
2. add DB tables/indexes/migration tests
3. add models + `skills` service with local CRUD and description extraction
4. add external discovery refresh and status resolution
5. add Tauri commands + `src/lib/skills.ts` wrappers
6. finish end-to-end service tests around shadow/missing/invalid behavior

## Handoff note

The main design constraint for implementers is to keep **catalog metadata** and **authored file content** separate. Local skill markdown should remain the canonical authored source on disk, while SQLite tracks IDs, discovery state, status, and future binding relationships. That separation is what keeps ORC-146/148/149/147 straightforward instead of forcing later storage migrations.