# ORC-283 — Tool pagination and count-mode plan

## tl;dr
Scope the change to the agent/tool bridge contract, not the raw Tauri UI commands. Add one shared paging input (`page`, `pageSize`, `countOnly`) and one shared paged response envelope (`items`, `totalCount`, `page`, `pageSize`, `returnedCount`, `hasMore`, `nextPage`). Apply it to every flat list/search/unread bridge tool, compute totals in the backend, and reuse or extend existing limited/count helpers for the high-volume task, mail, and session surfaces. Leave tree/bootstrap tools (`list_notes`, `list_orchestra_tools`) alone unless implementation review explicitly expands scope.

## Executive summary
Current bridge list tools mostly return raw arrays with no bounds. A few already accept ad hoc `limit` (`search_task_comments`, `search_task_comment_file_mentions`, `list_sessions`) or use bounded helpers internally (`get_task_context`).

The cleanest way to fix ORC-283 without creating a large unrelated frontend migration is:

- keep raw Tauri/UI commands array-shaped for now
- add pagination/count at the tool bridge + `extensions/orchestra-tools.ts` surface
- add shared service helpers for the heavy lists so the bridge does not materialize whole collections when it does not need to

Why this boundary matters:

- desktop UI/tests still invoke raw Tauri `list_*` commands as arrays (for example `tests/desktop-e2e/driver.ts::invokeCommand()` is used against `list_projects`, `list_tasks`, and `list_sessions`)
- changing those app commands wholesale would turn a tool-contract task into a larger app-client migration
- the bridge/tool surface is the right compatibility boundary for this work

## Flat tool inventory to paginate
Grouped by backend owner:

- Simple config/project lists:
  - `list_agents`
  - `list_roles`
  - `list_role_operations`
  - `list_projects`
  - `list_repositories`
  - `list_workflows`
  - `list_policies`
- Task lists/searches:
  - `list_tasks`
  - `list_task_comments`
  - `list_task_attachments`
  - `search_task_comments`
  - `search_task_comment_file_mentions`
  - `list_task_todos`
  - `list_unfinished_task_todos`
  - `get_unread_task_comments`
  - `list_task_repositories`
  - `list_task_file_references`
- Mail/session lists:
  - `get_unread_mail`
  - `list_sessions`
- Secret metadata lists:
  - `list_project_secrets`
  - `search_project_secrets`

Proposed exclusions unless implementation review explicitly wants them in scope:

- `list_notes`: returns a nested `NotesTree`, not a flat collection
- `list_orchestra_tools`: bootstrap/discovery manifest, not normal user data

## Proposed contract
Common input on every paged tool:

- `page?: number` — 1-based, default `1`
- `pageSize?: number` — default `10`, cap `10`
- `countOnly?: boolean` — default `false`

Common response envelope:

```json
{
  "items": [],
  "totalCount": 0,
  "page": 1,
  "pageSize": 10,
  "returnedCount": 0,
  "hasMore": false,
  "nextPage": null
}
```

Rules:

- `totalCount` is always the full filtered count, not the page count
- `countOnly: true` returns the same envelope with `items: []` and `returnedCount: 0`
- resource-specific metadata may live alongside the envelope when needed (for example `projectSlug` and `availability` for project secrets), but the collection field itself should always be `items`

## Implementation shape
1. Add shared bridge pagination types/helpers in Rust, e.g. `ToolPaginationInput` and `ToolPagedResult<T>`.
2. Add a matching schema/helper in `extensions/orchestra-tools.ts` so every affected tool documents the same paging/count inputs.
3. In `src-tauri/src/services/tool_bridge.rs`, parse paging once and wrap each list result into the shared envelope.
4. Reuse existing limited/count helpers where they already exist:
   - task comments: `load_recent_task_comments(...)` pattern + new total-count helper
   - task attachments: existing limited loader + new count helper
   - task file references: existing limited loader + existing count helper
   - task todos: existing limited loader + existing count helper
   - bounded task-context metadata as a naming precedent
5. Add missing count/page helpers where current code only returns full vectors:
   - unread mail/comments
   - task repositories
   - agents/roles/projects/repositories/workflows/policies/tasks
   - sessions (wrap existing filtered inventory with total metadata)
   - project secrets/search results (page filtered secret metadata after auth/value-state resolution)
6. Keep mutation-query `limit` fields on session-admin tools (`hide_sessions`, `restore_sessions`, `delete_sessions`, `reconcile_sessions`) separate; do not replace destructive-scoping semantics with page semantics.

## Resource-specific notes
- `list_sessions` already supports `limit`; convert the list tool to the common page envelope and total metadata, but keep admin mutation inputs as-is.
- `get_unread_mail` currently merges agent mail + assignment mail through a `BTreeMap`, which implicitly sorts by `deliveryId`; pagination work should normalize this to a stable message order (`createdAt` + `deliveryId`) before slicing.
- `list_task_comments` and `get_unread_task_comments` should page recent history in a worker-friendly way: select the requested window from the newest side, then return the page in chronological order for readability.
- `search_task_comment_file_mentions` already has a hard result cap but does not know `totalCount`; it needs a full filtered candidate count before slicing so the new metadata is truthful.
- `list_project_secrets` and `search_project_secrets` should page the filtered secret-metadata list while preserving top-level `projectSlug` and `availability`.

## Count-only plan
Use `countOnly` on the paged list/search tools instead of adding a parallel `count_*` command for every resource. That keeps the tool manifest smaller and still satisfies the “count-only access” requirement. If reviewers later want higher-discoverability aliases, those can be thin wrappers over the same helpers.

## Validation
- Rust/unit tests for:
  - page normalization and max-page-size enforcement
  - `totalCount` / `hasMore` / `nextPage` correctness
  - `countOnly` flows
  - stable ordering for unread mail/comments and task-history pages
- Bridge/tool tests:
  - `src-tauri/src/services/tool_bridge.rs`
  - `tests/orchestra-tools-extension.tools.test.ts`
- Keep raw Tauri desktop UI tests stable by not changing their list-command return shapes unless implementation review explicitly expands scope.

## Likely file touch list
- `src-tauri/src/models.rs`
- `src-tauri/src/services/tool_bridge.rs`
- `src-tauri/src/services/tasks.rs`
- `src-tauri/src/services/messages.rs`
- `src-tauri/src/services/session_management.rs`
- `src-tauri/src/services/project_secrets.rs`
- `src-tauri/src/services/task_attachments.rs`
- `src-tauri/src/services/task_file_references.rs`
- `src-tauri/src/services/task_repositories.rs`
- `src-tauri/src/services/{agents,roles,projects,workflows,policies,role_runtime}.rs`
- `extensions/orchestra-tools.ts`
- `tests/orchestra-tools-extension.tools.test.ts`
