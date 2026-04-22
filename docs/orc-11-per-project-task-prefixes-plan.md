# ORC-11 per-project task prefix plan

## Problem summary

Orchestra currently treats the human-facing task number as a hard-coded `ORC-*` string rather than project configuration:

- `src-tauri/src/services/tasks.rs` builds new task numbers with `format!("ORC-{sequence_number}")`.
- `src-tauri/src/services/projects.rs`, `src-tauri/src/models.rs`, and `src/types.ts` do not give projects any first-class task prefix field.
- `src/settings/ProjectsPanel.tsx` only lets users edit a project's name and description, so there is no normal project settings flow for task numbering.
- `src/lib/tauri.ts` mirrors the same hard-coded `ORC-*` behavior for the mock/frontend path.
- Help/docs text in places like `src/lib/projectSettings.ts`, `src-tauri/src/services/project_settings.rs`, and several test fixtures assume every task number looks like `ORC-42`.

That means the current behavior fails the core product requirement: task identifiers are project-local in sequence, but not project-configurable in prefix.

## Design goals

1. Make the task prefix a first-class, required project setting.
2. Keep task sequencing project-local by continuing to use `tasks.sequence_number`.
3. Keep previously assigned task numbers stable even if a project's prefix changes later.
4. Make the prefix visible and editable in normal project create/edit flows.
5. Define deterministic migration behavior for existing projects and existing `ORC-*` tasks.
6. Prevent ambiguous new prefixes through validation instead of hidden defaults.

## Proposed model

### Project data model

Add a required task prefix to the project model:

- SQLite column: `projects.task_prefix TEXT NOT NULL`
- Rust API model: `task_prefix`
- TS API model: `taskPrefix`
- project create/update input: `taskPrefix`

This should live on the project record itself, not in project settings JSON, because it is core project identity/configuration rather than an optional overlay.

### Prefix format and normalization

Canonicalize prefixes before persistence:

- trim whitespace
- uppercase for storage/display
- require a leading letter
- allow only `A-Z0-9`
- enforce a short bounded length, e.g. 2-8 characters

Recommended validation rule:

- `^[A-Z][A-Z0-9]{1,7}$`

This keeps identifiers readable (`ORC-11`, `WEB-7` is not allowed because of the extra hyphen, `WEB2-7` is allowed), avoids whitespace/punctuation ambiguity, and is easy to validate consistently in Rust and TS.

### Prefix uniqueness

Reject duplicate prefixes across projects case-insensitively.

Reasoning:

- the product goal is to move away from a global one-size-fits-all `ORC` space
- global surfaces such as inbox/session lists/notifications are clearer when new task numbers are not reused by different projects
- duplicate prefixes would reintroduce ambiguity for newly created tasks

Implementation note:

- add a case-insensitive unique check in the service layer
- also add a unique SQLite expression index like `UNIQUE INDEX ... ON projects(UPPER(task_prefix))`

## Task numbering semantics

Keep the current task fields:

- `sequence_number` stays the project-local monotonic integer
- `number` stays the stored human-facing identifier

Generate new task numbers as:

- `format_task_number(project.task_prefix, sequence_number)`
- result: `${task_prefix}-${sequence_number}`

### Important invariant: task numbers are immutable once assigned

Do **not** recompute `tasks.number` from the current project prefix on read.

Why:

- comments, mentions, notifications, session titles, and external references already store/render the current task number string
- changing a project prefix later should not silently rename historical tasks
- storing the full number keeps legacy compatibility simple

Effect of a prefix change:

- existing tasks keep their current `number`
- future tasks use the new prefix with the next `sequence_number`

Example:

- existing tasks: `ORC-1`, `ORC-2`
- user changes project prefix to `APP`
- next created task becomes `APP-3`

This mixed-prefix state is acceptable and should be explained in the UI/help text.

## Project create/edit UX

### Required project field

Add a required **Task prefix** field to `src/settings/ProjectsPanel.tsx` and to the underlying project create/update commands.

Behavior:

- project creation cannot succeed without a valid prefix
- project editing always shows the current prefix
- save is disabled or rejected with inline validation when the prefix is empty/invalid/duplicated

### Suggested-prefix UX

For new projects only, prefill the field with a suggestion derived from the project name, but keep it editable.

Recommended suggestion behavior:

- multi-word names → initials (`Desktop Automation Project` → `DAP`)
- single-word names → first three letters (`Orchestra` → `ORC`)
- if too short, extend with additional letters from the normalized name
- if the suggestion collides, append a numeric suffix and trim to the max length if needed

Important UX rule:

- once the user edits the prefix manually, stop auto-syncing it from the name
- when editing an existing project name later, do **not** mutate the prefix automatically

### Visibility

Make the configured prefix obvious in the project settings UI:

- label the field with helper text like `Used for new task numbers such as APP-42`
- optionally show the prefix in the project sidebar/detail header as a small badge so the model is discoverable without opening code/docs

## Migration strategy

### Schema migration

Update the base schema so fresh databases create `projects.task_prefix` directly.

For existing databases, add migration logic in `src-tauri/src/services/database.rs` to ensure the column exists and backfill it for legacy rows.

A dedicated `ensure_projects_table_columns` step should be added alongside the other table migration helpers.

### Backfill strategy for existing projects

Backfill existing projects in a deterministic order with this priority:

1. If a project already has a consistent non-legacy task prefix in its stored task numbers, reuse that prefix.
2. If the project is the default seeded Orchestra project, use `ORC`.
3. Otherwise generate a unique suggested prefix from the project name/slug.
4. If a generated prefix collides, append a numeric suffix until it is unique.

Important nuance:

- many existing projects will currently only contain `ORC-*` tasks because that was the hard-coded legacy behavior
- non-default projects should **not** all be backfilled to `ORC`, or the new model is still ambiguous for future tasks
- only the default Orchestra project should automatically retain `ORC` unless a project already has a distinct stored prefix

### Existing tasks

Do not rewrite existing task numbers during migration.

Previously created `ORC-*` tasks remain exactly as stored.

Consequences:

- migration is low-risk and does not invalidate historical references
- a migrated project may temporarily contain old `ORC-*` tasks and new `<PREFIX>-*` tasks
- the settings/help copy should explain that prefix changes only affect newly created tasks

### Compatibility behavior after migration

Because `sequence_number` is already unique per project, compatibility stays straightforward:

- exact lookups by `task.number` still work for old and new tasks
- numeric shorthand lookups (e.g. `/task 7` in channels) can still resolve by sequence suffix because each project still has only one `*-7`
- project-scoped task lists remain stable because ordering already uses `sequence_number`

## Backend implementation plan

### 1. Project schema/models

Update:

- `src-tauri/src/services/database.rs`
- `src-tauri/src/models.rs`
- `src/types.ts`
- `src/lib/projects.ts`
- `src-tauri/src/services/projects.rs`

Work:

- add `task_prefix`/`taskPrefix` to summary/detail/upsert types
- validate and normalize the prefix in `normalize_project_input`
- enforce case-insensitive uniqueness on create/update
- include the prefix in project queries, inserts, updates, and domain event payloads
- seed the default Orchestra project with `ORC`

### 2. Task creation path

Update:

- `src-tauri/src/services/tasks.rs`
- `src/lib/tauri.ts`

Work:

- replace the hard-coded `ORC-*` formatter with a project-aware formatter
- load the project's configured prefix before creating a task
- fail task creation clearly if a project somehow lacks a usable prefix
- update mock/frontend task creation to use the active project's configured prefix and sequence math

### 3. Supporting parsers/help text

Update any logic or copy that assumes alphabetic-only `ORC-*` literals.

Likely files:

- `src/lib/sessionList.ts` if prefix suggestions/collision suffixes allow digits in the prefix
- `src/lib/projectSettings.ts`
- `src-tauri/src/services/project_settings.rs`
- docs/help text that currently says `ORC-42`

Recommended copy change:

- from `Human-readable task number such as ORC-42.`
- to `Human-readable task number such as <PROJECT_PREFIX>-42.`

### 4. Global/mock/tool surfaces

Update create/update project surfaces that are backed by `ProjectUpsertInput`, including:

- desktop UI invocations
- mock/local-storage project persistence in `src/lib/projects.ts`
- tool/bridge schema expectations that serialize project inputs/outputs
- debug/test seed helpers such as `src-tauri/src/commands/app.rs`

## Frontend validation plan

### Required field behavior

The project form should show inline validation for:

- empty prefix
- invalid characters/format
- duplicate prefix already used by another project

### Error messaging

Prefer explicit, actionable errors such as:

- `Task prefix is required.`
- `Task prefix must start with a letter and contain only A-Z or 0-9.`
- `Task prefix APP is already used by another project.`

### Editing semantics

Project editing should make the migration behavior obvious:

- helper text: `Changing the prefix only affects tasks created after this change.`
- optionally show a non-blocking note when the project already has tasks

## Testing plan

### Backend tests

Add/adjust tests for:

- project creation rejects missing/invalid/duplicate prefixes
- project update rejects invalid/duplicate prefixes
- default seeded project uses `ORC`
- per-project task creation uses the configured prefix
- changing a project's prefix only affects future tasks
- legacy project migration backfills prefixes deterministically
- existing `ORC-*` task numbers survive migration unchanged

### Frontend/unit tests

Add/adjust tests for:

- project settings form requires prefix on create
- project settings form shows the current prefix on edit
- suggested prefix behavior for new projects
- duplicate prefix validation
- mock project/task creation uses the configured prefix
- session/task sorting and metadata still behave with non-`ORC` prefixes like `DAP-2` or `WEB2-10`

### Desktop/e2e tests

Update/create desktop coverage for:

- project creation flow now filling the required prefix
- project edit flow updating the prefix
- creating tasks in different projects and verifying distinct prefixes
- compatibility cases where old `ORC-*` tasks coexist with new prefixed tasks after a project prefix change

## Files likely to change

- `src-tauri/src/services/database.rs`
- `src-tauri/src/models.rs`
- `src/types.ts`
- `src-tauri/src/services/projects.rs`
- `src-tauri/src/services/tasks.rs`
- `src-tauri/src/commands/projects.rs`
- `src/lib/projects.ts`
- `src/lib/tauri.ts`
- `src/settings/ProjectsPanel.tsx`
- `src/lib/projectSettings.ts`
- `src-tauri/src/services/project_settings.rs`
- `src/lib/sessionList.ts`
- relevant unit/e2e/desktop test fixtures that currently hard-code `ORC-*`

## Recommended implementation order

1. Add the project prefix field to schema/models plus migration/backfill logic.
2. Switch backend and mock task creation to use the project prefix.
3. Add project settings UI for required prefix editing and validation.
4. Update help/docs/copy and any parsers that assumed global `ORC-*` formatting.
5. Update and expand tests for migration, UI validation, and mixed legacy/new numbering.

## Handoff notes

- The highest-value invariant is that `tasks.number` stays stable once created.
- The highest-risk migration edge case is multiple legacy projects that currently only contain `ORC-*` tasks; those should receive unique project prefixes for future tasks without rewriting historical numbers.
- The most important user-facing copy is: **task prefix is required**, and **changing it only affects new tasks**.
