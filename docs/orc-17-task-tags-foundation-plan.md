# ORC-17 task-tag foundation plan

## Problem summary

Orchestra tasks do not yet have a first-class tag model, but the follow-on work for tag-aware list filtering/sorting, task-edit UX, and regression coverage all assumes a stable backend contract.

Today there is no normalized tag storage, no `tags` field on the shared task models, and no create/update validation path that can enforce the ORC-14 semantics. The main affected surfaces are:

- `src-tauri/src/services/database.rs` for base schema creation and migration helpers
- `src-tauri/src/models.rs` and `src/types.ts` for shared task payloads and upsert inputs
- `src-tauri/src/services/tasks.rs` for task normalization, validation, persistence, and shared summary/detail loading
- `src/pages/TasksPage.tsx` and `src/lib/tauri.ts` for TypeScript defaults/local-mode compatibility
- `src-tauri/src/services/task_schedules.rs` because `TaskUpsertInput` is persisted inside schedule blueprint JSON and must stay backward-compatible when deserializing older rows

This slice should establish the relational/task-model foundation now so ORC-18 can add tag filtering/sorting on top of an already-stable payload shape instead of introducing a second model churn.

## Design goals

1. Store tags in normalized relational form, not as CSV/JSON inside `tasks`.
2. Make every task payload expose `tags` as a deterministic inline array.
3. Enforce ORC-14 canonical semantics in one shared normalization/validation path.
4. Keep existing tasks and older `TaskUpsertInput` JSON compatible with an implicit empty tag array.
5. Set up the schema/query shape so ORC-18 can add efficient tag filtering/sorting without reworking storage again.

## Proposed schema

Create a dedicated `task_tags` table:

```sql
CREATE TABLE IF NOT EXISTS task_tags (
    task_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (task_id, tag),
    FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
```

Recommended indexes:

- the composite primary key `(task_id, tag)` gives uniqueness and efficient ordered loads per task
- add a reverse lookup index for future ORC-18 list filtering:

```sql
CREATE INDEX IF NOT EXISTS idx_task_tags_tag_task_id
    ON task_tags(tag, task_id);
```

### Migration behavior

- Fresh databases should create `task_tags` directly in the base schema in `database.rs`.
- Existing databases should get the same table/index from a new `ensure_task_tag_tables(...)` helper that runs during initialization, immediately after the existing task-table migration helpers.
- No data backfill is needed because legacy tasks simply have no rows in `task_tags` and should therefore load with `tags: []`.

## Canonical tag semantics

Normalize and validate tags using the ORC-14 rules before persistence:

1. default missing input to `[]`
2. trim each input string
3. drop blank entries
4. lowercase to canonical form
5. validate canonical text against `^[a-z0-9_-]+$`
6. reject any tag longer than 32 characters
7. collapse duplicates after canonicalization
8. reject more than 20 unique tags after blank-removal and dedupe
9. sort lexicographically before persistence and response emission

A small shared helper in `tasks.rs` should own this logic so create/update/schedule materialization all behave the same.

### Validation guidance

Prefer task-style field errors that stay actionable for UI work later, e.g.:

- `tags: Task tags must contain at most 20 unique entries.`
- `tags[2]: Task tags may only contain lowercase letters, digits, hyphens, and underscores.`
- `tags[2]: Task tags must be 32 characters or fewer.`

Duplicates and blanks should not error; they should normalize away.

## Model and transport changes

### Rust models

Update `src-tauri/src/models.rs`:

- add `tags: Vec<String>` to `TaskSummary`
- add `tags: Vec<String>` to `TaskDetail` by inheritance/parallel field layout
- add `tags: Vec<String>` to `TaskUpsertInput`

Important compatibility detail:

- `TaskUpsertInput.tags` should be `#[serde(default)]` so older callers and stored schedule blueprint JSON without a `tags` field still deserialize as `[]`
- using `#[serde(default)]` on task payload arrays is also a low-risk guard for older local/mock persisted data

### TypeScript models

Update `src/types.ts` to add `tags: string[]` to:

- `TaskSummary`
- `TaskDetail`
- `TaskUpsertInput`

Because `TaskUpsertInput` becomes structurally wider, update draft constructors/copies such as:

- `src/pages/TasksPage.tsx#createBlankTaskDraft`
- `src/pages/TasksPage.tsx#taskToDraft`
- schedule blueprint helpers that clone `TaskUpsertInput`

Until ORC-19 adds the actual tag editor, these TypeScript defaults should explicitly seed `tags: []`.

## Persistence and load path

### Normalize and validate in `tasks.rs`

In `src-tauri/src/services/tasks.rs`:

- extend `normalize_input(...)` to canonicalize `input.tags`
- extend `validate_task_input(...)` to enforce count/charset/length rules after normalization
- keep repository/workflow validation unchanged

Suggested helper split:

- `normalize_task_tags(Vec<String>) -> Vec<String>`
- `validate_task_tags(&[String]) -> Vec<String>` or equivalent inline validation from `validate_task_input`

### Persist tags transactionally

Add a helper similar to `sync_task_repository_links(...)`, e.g.:

- `sync_task_tags(tx, task_id, tags, created_at)`

Behavior:

1. delete existing `task_tags` rows for the task
2. insert one row per normalized tag
3. call it from both `create_task(...)` and `update_task(...)` inside the existing transaction before commit

This gives straightforward replacement semantics for updates and naturally handles clearing tags back to `[]`.

### Load tags through the shared task-summary path

The most important implementation detail is to avoid a detail-only tag loader.

`TaskSummary` is the shared shape used by:

- `list_tasks(...)`
- parent/lineage/children loaders
- dependency blocker/blocked summaries
- schedule materialized-task summaries
- remote API/tool bridge/channel payloads that already reuse those summary helpers

Because of that, the preferred approach is to extend `task_summary_columns("t")` with an ordered aggregate of a task's tags, then parse that field in `map_task_summary_row(...)`.

That keeps tags automatically present everywhere `TaskSummary` already flows.

Implementation options:

- ordered `GROUP_CONCAT(...)` over a subquery ordered by `tag ASC`, then split in Rust
- or a small batched loader keyed by task ids if that is cleaner

The important constraint is: **do not introduce per-task summary N+1 tag queries**, because ORC-18 needs the summary/list path to remain efficient when filter/sort logic arrives.

`get_task(...)` will also need its manual row mapping updated because adding the shared tags column shifts the later column offsets (including `repository_id`).

## Schedule compatibility note

`TaskUpsertInput` is reused by task schedules in `src-tauri/src/services/task_schedules.rs`, where blueprint JSON is serialized/deserialized from the database.

That means this task should also account for:

- `sample_task_input()` and related test fixtures needing `tags: Vec::new()`
- legacy `task_blueprint_json` rows without `tags` still deserializing successfully via `#[serde(default)]`

No new task-schedule feature work is required here, but the deserialization contract must remain compatible.

## Mock/local-mode compatibility

Even though ORC-17 is primarily a backend/model slice, the TypeScript local/mock task helpers should be kept structurally aligned so the app still runs in local mode after the model change.

Likely touch points in `src/lib/tauri.ts`:

- `seedMockTasks()` should provide `tags: []` for seeded task detail records
- `ensureStoredMockTask(...)` should default missing persisted tags to `[]`
- `summarizeTask(...)` should copy `task.tags`
- `normalizeMockTaskInput(...)` should preserve/normalize tags to `[]` at minimum
- `normalizeScheduleBlueprint(...)` should continue returning a complete `TaskUpsertInput`

ORC-18/ORC-21 can harden mock parity further, but this task should at least keep the widened TS model non-breaking.

## Test plan

### `src-tauri/src/services/tasks.rs`

Add backend coverage for:

1. **round-trip normalization/persistence**
   - create a task with raw input such as `[
     "Urgent",
     " backend ",
     "",
     "urgent",
     "ops_1"
   ]`
   - assert persisted/loaded tags become `[
     "backend",
     "ops_1",
     "urgent"
   ]`
   - assert both detail and list/summary paths expose the same ordered array

2. **validation failures**
   - invalid characters
   - tag length > 32
   - > 20 unique tags after normalization

3. **update replacement semantics**
   - update an existing task from one tag set to another
   - assert old `task_tags` rows are removed and the response shows only the new set
   - include clearing back to `[]`

4. **empty-array compatibility**
   - create/load a task without specifying tags and assert `tags == []`

5. **delete cascade coverage**
   - create a tagged task
   - delete the task
   - assert `task_tags` contains no remaining rows for that task id

### `src-tauri/src/services/database.rs`

Add migration coverage for a legacy database that has `tasks` but no `task_tags` table:

- run `initialize_database_at(...)`
- assert `task_tags` now exists
- assert `idx_task_tags_tag_task_id` exists
- assert the preexisting task row remains readable/compatible afterward

### `src-tauri/src/services/task_schedules.rs`

At minimum, update existing fixtures for the widened `TaskUpsertInput`. If convenient, add one compatibility test confirming old serialized blueprint JSON without `tags` still deserializes to an empty array.

## Out of scope

This task should not absorb the later feature slices:

- ORC-18: tag-aware list filters, `tagMatch`, deterministic tag sort semantics, remote/tool parameter work, and broader transport parity
- ORC-19: task create/edit/detail tag UI
- ORC-21: broader regression/e2e hardening

## Recommended implementation order

1. add the `task_tags` schema + migration helper in `database.rs`
2. widen Rust/TS task models and upsert inputs with defaulted `tags`
3. implement tag normalization/validation and transactional `sync_task_tags(...)` in `tasks.rs`
4. extend shared summary/detail loading so every task payload includes inline tags
5. update TS defaults/mock helpers so the widened model compiles cleanly
6. add backend migration/persistence/validation/delete-cascade coverage
