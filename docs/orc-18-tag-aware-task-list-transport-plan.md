# ORC-18 tag-aware task list filtering, sorting, and transport plan

## Goal

ORC-18 is the follow-on slice after ORC-17 lands the normalized `task_tags` storage and inline `tags: string[]` task model fields.

This ticket should **not** invent new tag semantics. It should make the existing ORC-14 plan executable across the task-list/query surfaces by:

- extending `list_tasks` with tag filters plus `all` / `any` multi-tag matching
- adding explicit `sortBy=tags` support using the canonical joined-tag-string rule from ORC-14
- keeping backend list queries efficient and free of join-driven count distortion
- surfacing tag-aware list/create/update behavior through Tauri, the remote API, and the Orchestra tool bridge
- mirroring the same filtering/sorting/payload behavior in the mock/frontend helpers

## Scope boundary

This ticket should own the **query + transport contract**. It should not own the UI controls/chips themselves; that stays with ORC-19 and ORC-20.

Concretely:

- ORC-17 owns schema, validation, normalization, and task detail persistence/loading.
- **ORC-18 owns list-query semantics and transport plumbing.**
- ORC-19 owns task create/edit/detail tag UX.
- ORC-20 owns task overview filter/sort controls and list rendering UX.
- ORC-21 hardens the whole feature with regression coverage.

## Current code touchpoints

### Backend list/query path

- `src-tauri/src/services/tasks.rs`
  - `list_tasks(...)` currently only accepts `project_id` + `include_archived`
  - `list_tasks_materialized_from_schedule(...)` also returns `TaskSummary`
  - `task_summary_columns(...)` computes counts via scalar subqueries and must stay insulated from tag join duplication

### Tauri command surface

- `src-tauri/src/commands/tasks.rs`
  - `list_tasks(...)` currently only forwards `project_id` + `include_archived`
  - `create_task(...)` / `update_task(...)` already deserialize `TaskUpsertInput`, so once ORC-17 adds `tags` the transport change is mostly pass-through

### Tool bridge

- `src-tauri/src/services/tool_bridge.rs`
  - `list_tasks` currently only reads `projectId` + `includeArchived`
  - `create_task` and `update_task` deserialize `TaskUpsertInput`; those paths should round-trip `tags` once the model includes them
  - bridge tests already exist around project-scoped `list_tasks` and `create_task`

### Remote API

- `src-tauri/src/services/remote_api.rs`
  - `GET /api/v1/projects/:project_id/tasks` currently returns the unfiltered list
  - `GET /api/v1/tasks/:task_id` already returns `TaskDetail`
  - there are currently no remote task create/update endpoints, so the remote scope here is list filtering/sorting plus payload parity on list/detail responses

### Frontend + mock helper path

- `src/lib/tauri.ts`
  - `listTasks(...)` currently only handles `includeArchived` + `projectId`
  - mock mode only filters by project/archive state and returns `summarizeTask(...)`
  - `normalizeMockTaskInput(...)` / `validateMockTaskInput(...)` need to preserve ORC-17 tag semantics so tool/local mode stays aligned

### Tool extension schema

- `extensions/orchestra-tools.ts`
  - custom schemas currently exist for `list_tasks` and `create_task`
  - `list_tasks` needs tag filter/sort parameters
  - `create_task` needs explicit `tags`
  - `update_task` should be considered for explicit schema exposure as well so tag transport is discoverable in help/tooling

### Existing tests worth extending

- `src-tauri/src/services/tasks.rs` tests
- `src-tauri/src/services/tool_bridge.rs` tests
- `tests/orchestra-tools-extension.tools.test.ts`
- mock/frontend Vitest coverage around `src/lib/tauri.ts`

## Proposed public contract

## Shared list query fields

Use one shared logical query model everywhere, even if the transport shapes differ slightly:

- `projectId?: string`
- `includeArchived?: boolean`
- `tags?: string[]`
- `tagMatch?: "all" | "any"`
- `sortBy?: "updatedAt" | "createdAt" | "priority" | "number" | "title" | "tags"`
- `sortDirection?: "asc" | "desc"`

### Defaults

- `includeArchived = false`
- `tags = []`
- `tagMatch = "all"`
- `sortBy = "updatedAt"`
- `sortDirection = "desc"`

### Important behavior rules

- Empty/blank tag inputs normalize away; an empty normalized tag list means **no tag filter**.
- Tag filters use the same normalization rules as ORC-17: trim, lowercase, drop blanks, dedupe, validate.
- Invalid filter tags should fail clearly instead of silently rewriting punctuation/spaces.
- Task payloads returned from list/detail paths should always include `tags: string[]`.

## Transport shape by surface

### Tauri commands / tool bridge payloads

Keep the existing flat payload style for backward compatibility:

```json
{
  "projectId": "project-1",
  "includeArchived": false,
  "tags": ["backend", "urgent"],
  "tagMatch": "all",
  "sortBy": "tags",
  "sortDirection": "asc"
}
```

### Remote API query params

Use query keys that match the future frontend state model:

```text
GET /api/v1/projects/:project_id/tasks?includeArchived=false&tags=backend,urgent&tagMatch=all&sortBy=tags&sortDirection=asc
```

Notes:

- `tags` should parse from a comma-separated string so it aligns with the ORC-14 query-state recommendation.
- `GET /api/v1/tasks/:task_id` does not need new params; it just needs to serialize `tags` on the returned task payload.

## Backend implementation plan

## 1. Introduce an internal list-query type

Add an internal Rust struct in the task service layer, e.g. `TaskListQuery`, to avoid pushing stringly typed branching through the service code.

Suggested fields:

- `include_archived: bool`
- `tags: Vec<String>`
- `tag_match: TaskTagMatchMode`
- `sort_by: TaskSortField`
- `sort_direction: TaskSortDirection`

The Tauri command, tool bridge, and remote API can continue accepting flat params, but should normalize them into this struct before calling the main list function.

## 2. Reuse ORC-17 tag normalization for filters

Do not create a second set of tag rules just for `list_tasks`.

Recommended rule:

- share the same canonicalizer/validator used for create/update input
- normalize requested filter tags before SQL construction
- if the normalized tag list is empty, skip tag filtering entirely

That keeps filter behavior aligned with stored task values and avoids case-sensitive surprises.

## 3. Use a tag-aware CTE/subquery strategy

Do **not** join `task_tags` directly into the existing `task_summary_columns(...)` query in a way that duplicates `tasks` rows.

The list query should be shaped in two logical stages:

### A. matching-tags stage

Compute matching task ids and match counts from `task_tags` only.

Needed output:

- `task_id`
- `matched_tag_count`

Semantics:

- `any`: keep tasks where `matched_tag_count >= 1`
- `all`: keep tasks where `matched_tag_count == requested_tag_count`

### B. tag-rollup stage

Compute the canonical sort key without exploding task rows.

Needed output:

- `task_id`
- `tag_count`
- `tag_sort_key`

Recommended `tag_sort_key`:

- build it from the lexicographically ordered canonical tags
- join with `,` so the examples from ORC-14 hold:
  - `['api', 'backend'] -> "api,backend"`
  - `['urgent'] -> "urgent"`
  - `[] -> NULL`

### C. final task select

Join the filtered ids / sort-key data back onto `tasks t` and continue using the existing summary-count subqueries from `task_summary_columns(...)`.

That preserves the existing comment/dependency/attachment counts and avoids join-driven overcounting.

## 4. Batch-hydrate tag arrays after the ordered list is known

For `list_tasks`, prefer a single batched follow-up tag load rather than one per task.

Recommended flow:

1. run the ordered task list query
2. collect the ordered task ids
3. run one `SELECT task_id, tag FROM task_tags WHERE task_id IN (...) ORDER BY task_id, tag`
4. attach grouped tag arrays to the `TaskSummary` values while preserving the original task order

This matches the ORC-14 recommendation and avoids app-level N+1 loading.

The same batched hydrator can also be reused for other `TaskSummary` list loaders if ORC-17 has not already handled them cleanly.

## 5. Sort semantics

### Default behavior

If no explicit sort is provided, preserve today’s behavior:

1. `archived ASC`
2. `updated_at DESC`
3. `sequence_number DESC`

### Explicit tag sort

When `sortBy = tags`:

1. keep tagged tasks before untagged tasks
2. compare `tag_sort_key` using the requested direction
3. tie-break with the existing default order

Examples:

- ascending: `[api]`, `[api,backend]`, `[backend]`, `[]`
- descending: `[backend]`, `[api,backend]`, `[api]`, `[]`

Untagged tasks should remain last even in descending mode.

### Other sort fields

This ticket should expose the shared sort model now so ORC-20 can consume it without reopening backend transport.

That means validating and wiring:

- `updatedAt`
- `createdAt`
- `priority`
- `number`
- `title`
- `tags`

Even if the immediate feature motivation is tag sorting, landing the shared sort contract here avoids one-off API churn in the next ticket.

## Frontend/mock implementation plan

## 1. Move `listTasks` to an options object

`src/lib/tauri.ts` should stop using the positional `(includeArchived, projectId)` signature and instead accept an options object that mirrors the shared query model.

Suggested TS type:

```ts
interface TaskListOptions {
  projectId?: string | null;
  includeArchived?: boolean;
  tags?: string[];
  tagMatch?: "all" | "any";
  sortBy?: "updatedAt" | "createdAt" | "priority" | "number" | "title" | "tags";
  sortDirection?: "asc" | "desc";
}
```

This is the transport shape ORC-20 will need for the actual UI controls.

## 2. Mirror backend semantics in mock mode

In local/mock mode:

- normalize filter tags the same way ORC-17 does
- filter by exact tag match with `all` / `any`
- sort by the same canonical tag-string rule
- ensure `summarizeTask(...)` preserves `tags`
- ensure `normalizeMockTaskInput(...)` / `validateMockTaskInput(...)` preserve the ORC-17 tag rules for create/update round-trips

The goal is that local mode and Tauri mode produce the same visible list behavior.

## 3. Preserve tags on summaries

Because many frontend surfaces consume `TaskSummary`, this ticket should make sure summary payloads include tags everywhere they originate:

- real backend `list_tasks`
- mock `summarizeTask(...)`
- any intermediate adapters that rebuild `TaskSummary`

That way ORC-20 can render tags without needing secondary detail fetches.

## Tool/extension plan

## `list_tasks`

Update `extensions/orchestra-tools.ts` so the explicit schema exposes:

- `projectId`
- `includeArchived`
- `tags`
- `tagMatch`
- `sortBy`
- `sortDirection`

## `create_task`

Update the explicit schema + `buildTaskInput(...)` to carry `tags`.

## `update_task`

Recommended: promote `update_task` from the generic `inputJson` fallback into the same explicit task-input schema used by `create_task`.

Why:

- tag transport becomes discoverable in tool help
- parity with `create_task`
- easier round-trip assertions in extension tests

If that feels too broad for this ticket, the minimum acceptable fallback is:

- backend bridge parsing must round-trip `tags`
- tests must cover `update_task` with nested `input.tags`

## Remote API notes

Remote task mutations are not currently exposed, so ORC-18 should **not** invent new remote create/update endpoints just for tags.

The remote work needed here is:

- add query-param parsing to `GET /api/v1/projects/:project_id/tasks`
- ensure both remote task list and task detail responses include `tags`

That keeps the scope aligned with the current remote surface area.

## Test plan

## Backend Rust tests

Add/extend `src-tauri/src/services/tasks.rs` tests for:

- single-tag filter
- multi-tag `all`
- multi-tag `any`
- duplicate/uppercase/blank filter normalization
- invalid filter rejection
- tag sort ascending
- tag sort descending
- tagged-before-untagged behavior
- tie-break stability on equal tag keys
- include-archived interaction

## Tool bridge Rust tests

Add/extend `src-tauri/src/services/tool_bridge.rs` tests for:

- `list_tasks` with `tags`, `tagMatch`, `sortBy`, `sortDirection`
- `create_task` round-tripping `tags`
- `update_task` round-tripping `tags`

## Extension/Vitest tests

Update `tests/orchestra-tools-extension.tools.test.ts` to assert:

- `list_tasks` schema includes the new tag filter/sort params
- `create_task` schema includes `tags`
- if `update_task` gets explicit schema here, assert that too
- bridge payloads preserve the new fields exactly

## Mock/frontend parity tests

Add a focused Vitest around `src/lib/tauri.ts` list helper behavior covering:

- exact tag filtering in mock mode
- `all` vs `any`
- canonical tag sort key ordering
- untagged tasks at the end
- round-trip preservation of `tags` through mock create/update

## Recommended implementation sequence

1. Rebase on ORC-17 once `task_tags` + `tags` model fields exist.
2. Introduce the shared list query types/defaulting.
3. Implement the backend tag-aware list query + batched tag hydration.
4. Thread the new params through Tauri command, tool bridge, remote API, and `src/lib/tauri.ts`.
5. Update extension schemas and transport tests.
6. Leave UI controls/rendering for ORC-20.

## Handoff summary

If ORC-18 follows this plan, ORC-20 can treat tag filtering/sorting as a pure consumer of an already-finished API contract instead of reopening backend query work. The critical architectural guardrails are:

- reuse ORC-17 normalization for filter inputs
- avoid direct tag joins that duplicate task rows
- batch-load tags for task lists instead of per-task queries
- expose one consistent filter/sort contract across Tauri, remote, bridge, and mock mode
- keep `TaskSummary` payloads tag-complete so later UI work does not need extra lookups
