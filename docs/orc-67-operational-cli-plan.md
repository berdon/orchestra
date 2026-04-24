# ORC-67 — broader operational `orc` CLI plan

## tl;dr

- Keep the ORC-66 baseline (`orc chat`, `orc msg`) and extend the same Rust CLI binary instead of creating a second CLI surface.
- Add one task-centric root command: `orc task ...`.
- Introduce a shared task-reference resolver so CLI commands accept canonical task ids plus human-facing task numbers like `ORC-67` / `GW-12`, with explicit ambiguity handling.
- Use the existing Orchestra task/runtime services as the source of truth; do **not** invent CLI-only workflow semantics.
- Add an app-independent task-action helper layer so CLI, Tauri commands, and remote API routes can reuse the same durable mutations, audit/domain events, and runtime side effects.
- Align that helper extraction with the current shared-web/frontend work so the CLI reinforces, rather than cuts across, the ORC-56 direction toward shared Tauri and browser-backed semantics.
- Ship a first operational slice covering: list, show/context, create, update, comment add, comment list, approve, needs-work, pause, resume, stop, dispatch, and move-to-lane.
- Treat automated coverage as part of the shipped CLI surface: every initial `orc task` command should have parser/help coverage plus behavior coverage for its success and relevant error paths.
- Default to human-readable terminal output, and add structured `--json` output for scripts and automation.
- Document the initial command set in help text plus repo docs, and explicitly defer broader task CRUD/admin surfaces that are not needed for the first operator workflow slice.

## Executive summary

ORC-66 established the right local CLI foundation: `orc` already exists as a real Rust binary under `src-tauri`, it already bootstraps Orchestra headlessly, and it already proves the CLI can be a thin local layer over Orchestra’s real backend instead of a separate HTTP-only client.

ORC-67 should build directly on that baseline by adding a single coherent task command family rather than scattering task actions across unrelated top-level nouns. The recommended information architecture is:

- keep existing top-level conversational commands:
  - `orc chat`
  - `orc msg`
- add one operational task surface:
  - `orc task ...`

That gives the CLI a clear split:

- **agent conversation** lives at the top level
- **task/workflow operations** live under `task`

The important implementation constraint is that many of the desired operational actions already exist, but today they are split across three different layers:

- pure task data services in `src-tauri/src/services/tasks.rs`
- workflow/runtime transitions in `src-tauri/src/services/task_runtime.rs`
- desktop-oriented wrappers in `src-tauri/src/commands/tasks.rs`

The CLI should not bypass that structure by mutating SQLite directly and it should not route local task operations through ad hoc HTTP calls just to feel “thin.” Instead, ORC-67 should extract shared app-independent task-action helpers from the current command layer so the CLI, Tauri commands, and remote API all execute the same real Orchestra behavior:

- same validation
- same task/workflow semantics
- same domain events and durable state changes
- same runtime side effects where applicable
- optional UI event emission only when a real `AppHandle` exists

That keeps the CLI honest, keeps Orchestra state durable, and closes the biggest current gap from ORC-66: operational task commands that are still effectively desktop-coupled.

The same principle also fits the broader product direction already in flight for the hosted web frontend: ORC-67 should reuse abstractions in a way that helps Tauri, remote API, and browser-hosted clients converge on the same underlying semantics instead of creating a CLI-specific fork.

## Current baseline after ORC-66

The repository already has the key building blocks ORC-67 should reuse:

- `src-tauri/src/bin/orc.rs`
  - real CLI binary entrypoint
- `src-tauri/src/cli/mod.rs`
  - current clap parser for `chat` and `msg`
- `src-tauri/src/services/backend_bootstrap.rs`
  - shared local backend bootstrap for CLI mode
- `src-tauri/src/services/tasks.rs`
  - task list/detail/create/update/comment/todo/file-reference persistence logic
- `src-tauri/src/services/task_runtime.rs`
  - dispatch/review/control/re-lane semantics
- `src-tauri/src/commands/tasks.rs`
  - current desktop wrappers that also record domain events, logs, and runtime/UI side effects
- `src-tauri/src/services/remote_api.rs`
  - existing HTTP routes for most of the same task operations

That means ORC-67 is **not** a greenfield CLI design problem. It is primarily an orchestration and CLI-shape problem.

### Important discovery: the operational surfaces already mostly exist

Today’s backend already exposes nearly every action in the requested ORC-67 scope:

- list tasks
- get full task context
- create/update tasks
- add/list comments
- approve review-paused work
- mark needs work
- pause/resume/stop task activity
- dispatch a task lane
- reassign a task to another lane

The main missing pieces are:

1. a coherent CLI command layout
2. a shared task lookup layer for human task references
3. a shared output layer for text vs JSON rendering
4. app-independent wrappers for the operations that currently live in desktop-oriented command functions

## Fit with the current shared web frontend work

The current ORC-56 implementation stream is directly relevant to ORC-67, even though the deliverables are different.

Relevant current work:

- `ORC-56`
  - the epic goal is a shared frontend client and adapter layer for Tauri-hosted and API-hosted Orchestra web clients
- `ORC-61`
  - implements `RemoteApiOrchestraClient` for the browser-hosted/shared frontend
- `ORC-62`
  - expanded the remote API toward parity for the shared frontend contract
- `ORC-64`
  - is actively splitting desktop-only shell/host-admin features away from the shared frontend surface
- `ORC-65`
  - defines the parity/contract-coverage direction for the shared client adapters

This affects ORC-67 planning in three concrete ways.

### 1. The CLI should share backend abstractions, not frontend transport abstractions

The browser-hosted frontend still needs the remote API and shared `OrchestraClient` contract from ORC-56. The CLI does **not** need to become another frontend adapter.

Instead, ORC-67 should sit one layer lower:

- shared backend service/helper layer
- Tauri command wrappers above it
- remote API routes above it
- CLI command handlers beside them

That way:

- the browser-hosted frontend keeps using the remote API path it already needs
- the CLI gets efficient local execution without inventing HTTP-only dependencies
- both still drive the same authoritative Orchestra task/runtime semantics underneath

#### Why not make the CLI use the frontend transport adapter directly?

The short version is that the frontend transport adapter solves a **hosting/transport** problem, while ORC-67 primarily needs to solve a **shared task-action semantics** problem.

Reasons to keep ORC-67 one layer below the frontend adapter:

- the frontend adapter exists so shared frontend code can talk to Orchestra through either Tauri-hosted commands or the remote API without changing UI behavior
- the local CLI is not a browser-style frontend and does not need an adapter whose main job is abstracting over transport boundaries
- using the adapter as the CLI's primary execution path would push local task mutations through a client-shaped contract that is optimized for frontend portability, not for expressing the internal authoritative task/runtime actions themselves
- that would make the CLI more coupled to request/response transport shapes, serialization rules, and remote-style error mapping than it needs to be when it already runs beside the local backend/services
- it would also make it easier to accidentally treat the adapter contract as the source of truth, when the real source of truth should remain the backend task-action helpers that enforce validation, workflow rules, domain events, and runtime side effects

So the recommendation is:

- share the **authoritative backend action layer** across CLI, Tauri commands, and remote API routes
- let the frontend adapter continue to consume the remote/Tauri surfaces it already needs
- verify parity with tests so the frontend adapter path and CLI path still produce the same user-visible semantics where they overlap

This is a layering choice, not a rejection of the adapter work. If Orchestra later wants a remote-first CLI mode or a standalone CLI that talks to a hosted Orchestra instance, the frontend/client adapter direction may become a good fit for that mode. It is just not the best primary abstraction for the initial local operational CLI described in ORC-67.

#### Implication for future CLI modes

It is reasonable to think about ORC-67 as establishing the **local authoritative CLI layer first**, while leaving room for a later **remote/hosted CLI transport layer** if Orchestra needs one.

A sensible long-term split would be:

- **local developer CLI mode**
  - can call shared backend task-action helpers directly when running beside the local Orchestra/Tauri backend
- **remote/hosted CLI mode**
  - can lean more heavily on the remote API plus shared client/adapter contracts when talking to a hosted Orchestra instance across a network boundary

That keeps the first slice optimized for the environment ORC-67 actually targets today without foreclosing a future CLI architecture that reuses more of the ORC-56 client/adapter work.

### 2. ORC-67 should reinforce the split between shared vs desktop-only behavior

ORC-64 is already moving desktop-only affordances out of the shared frontend surface. ORC-67 should follow the same rule:

- task operations that represent core Orchestra semantics should move toward app-independent helpers
- UI event emission and other desktop-only follow-up should remain optional wrappers when an `AppHandle` exists

That keeps the CLI from depending on desktop-only behavior for commands that conceptually belong to Orchestra as a whole.

### 3. Coverage should support parity, not just CLI parsing

Because ORC-56/61/62/65 are about shared semantics across host modes, ORC-67 coverage should validate more than clap parsing. The important tests are the ones that prove the extracted task-action helpers preserve the same behavior regardless of whether they are invoked from:

- the CLI
- Tauri command wrappers
- remote API routes that the browser frontend depends on

So ORC-67 should treat task-command coverage as part of the larger parity story, not an isolated CLI-only test exercise.

### 4. Recommended coordination with the currently active frontend tasks

Based on the current task queue, the most relevant active work is:

- `ORC-61`
  - active implementation of `RemoteApiOrchestraClient`
- `ORC-64`
  - active work separating desktop-only shell/host-admin behavior from the shared frontend surface

Planning guidance for ORC-67:

- ORC-67 should **not** wait on the browser adapter work to define its own command layout or local CLI behavior.
- ORC-67 **should** align its backend extraction points with the same boundaries ORC-64 is reinforcing: shared core behavior below, host-specific wrappers above.
- If ORC-67 adds or refactors remote API-backed task behavior for parity, it should preserve the contracts that ORC-61 and the completed ORC-62 work expect rather than inventing CLI-only payload semantics.
- The comprehensive command coverage planned for ORC-67 should be designed so the most reusable pieces can later feed ORC-65-style adapter/parity validation instead of becoming a dead-end CLI-only harness.

That means ORC-67 is best treated as complementary infrastructure for the broader shared-client direction: it should deepen the common backend action layer while leaving the frontend transport/interface work to the ORC-56 stream.

## Recommended CLI information architecture

Use `task` as the single operational root.

### Why `orc task ...` is the right primary shape

`orc task ...` is the cleanest fit because the requested ORC-67 scope is explicitly task-centric. The actions are different verbs, but they all target a real Orchestra task and should read as task operations rather than unrelated top-level tools.

This is more coherent than splitting the surface into separate roots like:

- `orc tasks ...`
- `orc review ...`
- `orc comment ...`
- `orc workflow ...`

Those splits would force users to remember product-internal category boundaries even though the real target is almost always “this task.”

### Recommended initial command surface

```bash
orc [--project <project>] task list [--all] [--tag <tag> ...] [--tag-match all|any] [--sort-by <field>] [--sort-direction asc|desc] [--json]
orc [--project <project>] task show <task>
orc [--project <project>] task create --title <title> [field flags...] [--json]
orc [--project <project>] task update <task> [field flags...] [--json]
orc [--project <project>] task comment <task> <message...> [--reply-to <comment-id>] [--interrupt] [--json]
orc [--project <project>] task comments <task> [--json]
orc [--project <project>] task approve <task> [--json]
orc [--project <project>] task needs-work <task> [--notes <text>] [--json]
orc [--project <project>] task pause <task> [--notes <text>] [--json]
orc [--project <project>] task resume <task> [--notes <text>] [--json]
orc [--project <project>] task stop <task> [--notes <text>] [--json]
orc [--project <project>] task dispatch <task> [--json]
orc [--project <project>] task move <task> --lane <lane-id> [--notes <text>] [--json]
```

### Naming rules

- use singular `task`, not `tasks`, for the primary resource root
- use short verb subcommands under `task`
- keep user-facing names aligned with Orchestra semantics:
  - `approve` → `approve_task_review`
  - `needs-work` → `mark_task_needs_work`
  - `pause` / `resume` / `stop` → task control actions, not session-only aliases
  - `move --lane` → workflow lane reassignment
- keep the existing top-level `chat` and `msg` commands unchanged except for shared global project resolution where useful

A `tasks` alias can be added later if clap makes it trivial, but `task` should be the canonical help/documentation form.

## Command-to-backend mapping

Each CLI verb should be an explicit wrapper over an existing Orchestra action, not a new parallel model.

| CLI command | Primary backend action | Notes |
| --- | --- | --- |
| `task list` | `services::tasks::list_tasks_with_query(...)` / `commands::tasks::list_tasks(...)` | Reuse current tag/sort query model |
| `task show` | `services::tasks::get_task_context(...)` | Use full context, not the smaller summary payload |
| `task create` | shared helper over `commands::tasks::create_task(...)` semantics | preserve validation + domain event behavior |
| `task update` | shared helper over `commands::tasks::update_task(...)` semantics | patch-style CLI over full `TaskUpsertInput` |
| `task comment` | shared helper over `commands::tasks::comment_on_task(...)` semantics | preserve unread delivery / fallback queue behavior |
| `task comments` | `services::tasks::list_task_comments(...)` | threaded human rendering, raw JSON available |
| `task approve` | `services::task_runtime::approve_task_review(...)` via shared helper | user-authority review approval |
| `task needs-work` | `services::task_runtime::mark_task_needs_work(...)` via shared helper | same-lane review rejection |
| `task pause` | `services::task_runtime::pause_task_lane(...)` via shared helper | user-authority pause |
| `task resume` | `services::task_runtime::resume_task_lane(...)` via shared helper | resumable paused work |
| `task stop` | `services::task_runtime::stop_task_activity(...)` via shared helper | resets work to same-lane ready state |
| `task dispatch` | `services::task_runtime::dispatch_task_lane(...)` via shared helper | actual workflow dispatch |
| `task move` | `services::task_runtime::reassign_task_to_lane(...)` via shared helper | explicit lane reassignment |

This mapping is the key ORC-67 guardrail: the CLI should **reuse Orchestra’s real task/runtime semantics, not reinterpret them.**

## Shared task lookup strategy

ORC-67 needs a first-class task selector layer because the CLI should accept human-facing task numbers, not only internal ids.

### Recommended accepted task references

For any `<task>` argument, support:

1. canonical task id
   - `task-bb954bef4f884c6babe1bfba410eb4f2`
2. human-facing task number
   - `ORC-67`
   - `GW-12`
3. numeric shorthand inside a resolved project
   - `67`

### Recommended resolution rules

Use a shared helper, ideally extracted into a reusable service layer such as `src-tauri/src/services/task_lookup.rs`, with this behavior:

1. if the selector matches a canonical task id, resolve it directly
2. else if it looks like a `<PREFIX>-<N>` task number, resolve exact `tasks.number` case-insensitively
3. else if it is only digits, resolve it within the selected/default project by numeric suffix / sequence number
4. if multiple exact-number matches exist because of legacy cross-project duplicates, fail with an explicit ambiguity error and require `--project`
5. do **not** resolve by task title in the CLI

The last rule is intentional. The Telegram/channel helper currently allows exact-title lookup, but the CLI should be stricter and more deterministic.

### Project selection rules

Add a shared `--project <project>` option for operational commands.

`<project>` should accept:

- canonical project id
- project slug

If `--project` is omitted, reuse the existing default-project resolution from `services::projects::resolve_requested_or_default_project_id(...)`.

### Why this fits Orchestra’s actual model

This strategy works with the real database model Orchestra already has:

- canonical ids remain authoritative
- `tasks.number` remains the durable human-facing identifier
- per-project task prefixes from ORC-11 naturally support numbers like `GW-12`
- numeric shorthand remains safely project-scoped

## Create and update ergonomics

### `task create`

The CLI should be easier to use than the raw `TaskUpsertInput` shape.

Recommended create defaults:

- `type=task`
- `status=ready`
- `priority=P2`
- `assigneeType=unassigned`
- `tags=[]`
- no workflow/lane unless explicitly provided

If `--workflow` is provided and `--lane` is omitted, reuse the existing backend default-lane behavior from `services::tasks::apply_default_lane_if_needed(...)`.

### `task update`

The update command should be **patch-style** even though the backend update path currently consumes a full `TaskUpsertInput`.

Recommended CLI behavior:

- load the current task first
- overlay only the flags the user actually provided
- pass the merged full payload through the normal backend validation/update path

This avoids a bad CLI UX where updating one field would require restating every other field.

### Explicit clear behavior

For nullable fields, avoid treating empty strings as magical clear signals.

Use explicit flags such as:

- `--clear-description`
- `--clear-workflow`
- `--clear-lane`
- `--clear-parent`
- `--clear-assignee`
- `--clear-tags`

The exact flag set can be finalized during implementation, but the important design rule is: **patches must be explicit and deterministic.**

## Comment semantics

### Add comment

`orc task comment` should map directly to `TaskCommentInput` with a CLI-friendly shape:

- positional message text for the common case
- `--reply-to <comment-id>` for threading
- `--interrupt` to preserve the existing interrupt/follow-up behavior

The initial slice does **not** need to expose every file-anchor field on `TaskCommentInput`. File-anchored comment metadata can be deferred.

### List comments

`orc task comments` should reuse the stored threaded comment model and render it in human mode with reply indentation, author, timestamp, and comment id.

The CLI should not flatten the thread model into a separate pseudo-chat transcript.

## Output conventions

ORC-67 should define one consistent output model for operational commands.

### Default mode: human-readable text

Use concise text optimized for terminal operators.

#### `task list`

Render a stable single-line row per task, e.g.:

```text
ORC-67  in_progress  P2  lane-plan   architect   Add broader operational CLI commands
GW-12   ready        P1  -           -           Ship release checklist improvements
```

Recommended default columns:

- number
- status
- priority
- current lane
- assignee
- title

Tags can appear as a trailing compact column when present.

#### `task show`

Render a compact sectioned view based on full task context:

- header: `ORC-67 · Add broader operational CLI commands`
- summary line: type / status / priority / assignee / lane / workflow
- tags
- description
- dependency / child counts
- active assignment status
- todo/comment/file-reference counts

The command should **fetch full context** but not dump every child list by default in text mode.

#### mutation commands

Use short success messages such as:

```text
Created ORC-123.
Updated ORC-67.
Commented on ORC-67.
Approved ORC-67.
Moved ORC-67 to lane-review.
```

### Structured mode: `--json`

Every non-interactive command in the new task surface should support `--json`.

Rules:

- output canonical JSON derived from the existing Rust models
- do not invent CLI-only JSON wrappers unless a command truly has no canonical payload
- list commands return arrays
- show/mutation commands return the resulting task/comment payload

This keeps shell scripting practical without sacrificing readable default terminal output.

### Error behavior

Keep stderr concise and actionable:

- no stack traces
- preserve the useful backend error text
- when lookup fails, explain whether the task was missing vs ambiguous
- when an action is invalid for the current task state, surface the real workflow-state reason from the backend

## Implementation architecture

### 1. Extend the current CLI module tree

Build on the ORC-66 CLI layout instead of replacing it.

Recommended touchpoints:

- `src-tauri/src/cli/mod.rs`
  - add global project selection
  - register `task` subcommands
- `src-tauri/src/cli/task.rs`
  - parse and execute the task command family
- optional shared helpers:
  - `src-tauri/src/cli/output.rs`
  - `src-tauri/src/cli/task_flags.rs`

### 2. Add a shared task lookup helper

Create a reusable lookup helper instead of embedding task-reference parsing separately in CLI code and channel code.

Recommended result type:

- resolved project id
- resolved task id
- resolved task number
- maybe the already-loaded `TaskDetail` / `TaskSummary` when useful

This should be reusable by:

- the CLI
- the Telegram/channel command layer
- any future operator scripting surface

### 3. Extract app-independent task action helpers

This is the most important backend change.

A useful implementation split for ORC-67 is:

- read-oriented CLI commands (`list`, `show`, `comments`) can usually call existing service-layer reads directly
- mutating CLI commands should prefer extracted shared action helpers rather than calling desktop-oriented command wrappers or inventing direct SQLite mutations

Today, many operational actions live in `src-tauri/src/commands/tasks.rs`, where they are mixed with:

- UI event emission
- `AppHandle` usage
- `AppState` logging
- runtime/session side effects

ORC-67 should extract shared helpers beneath that layer so the same action can run in both:

- desktop command mode
- local CLI mode
- existing remote API mode

Recommended design rule:

- **authoritative mutation + domain event recording** belongs in shared helpers
- **UI event emission** remains optional and only runs when an `AppHandle` exists

This follows the same direction ORC-66 already took with `backend_bootstrap` and the no-app mailbox send path in `services::messages.rs`.

### 4. Preserve real runtime side effects where they matter

For review/control/dispatch commands, the CLI is not just editing rows; it may need to:

- auto-dispatch next work
- start assignment runs
- start follow-up prompts
- queue fallback unread delivery
- retire sessions after transitions

Those are real Orchestra behaviors and should stay intact.

The implementation should therefore keep those effects in the shared helper layer, with optional desktop event emission layered on top.

## Coverage plan

ORC-67 should add comprehensive coverage for the shipped operational slice, not just a few representative examples. The rule for the first release should be simple: if a command ships in the initial `orc task` surface, it should have meaningful automated coverage.

### Parser / command surface tests

Add clap-level tests for every shipped command in the initial matrix:

- `orc task list`
- `orc task show <task>`
- `orc task create ...`
- `orc task update <task> ...`
- `orc task comment <task> ...`
- `orc task comments <task>`
- `orc task approve <task>`
- `orc task needs-work <task>`
- `orc task pause <task>`
- `orc task resume <task>`
- `orc task stop <task>`
- `orc task dispatch <task>`
- `orc task move <task> --lane ...`
- shared global flags such as `--project` and `--json`

### Help / UX tests

Add explicit help-text coverage for:

- `orc --help`
- `orc task --help`
- each shipped `orc task <verb> --help`

This is worth testing because help text is part of the product surface for a CLI-heavy workflow.

### Task lookup tests

Add dedicated tests for:

- canonical task id lookup
- exact task number lookup (`ORC-67`, `GW-12`)
- numeric shorthand lookup within a selected/default project
- ambiguity errors for duplicated task numbers across projects
- unknown task errors
- invalid `--project` resolution

### Shared action helper tests

Cover every shipped mutating command, not just a sample subset:

- create
- update, including patch-overlay and explicit clear behavior
- comment add, including reply and interrupt flags
- approve
- needs-work
- pause
- resume
- stop
- dispatch
- move/reassign lane

The important thing to validate is that the extracted helpers preserve real Orchestra side effects such as validation, domain events, runtime transitions, follow-up delivery, and session retirement semantics where applicable.

### CLI integration tests

Add command-oriented integration coverage that executes the CLI handler layer against a temporary Orchestra database/workspace so each shipped command has at least one realistic happy-path invocation and at least one representative failure-path assertion.

Recommended focus:

- text-mode success output
- JSON-mode output shape
- non-zero exit behavior for lookup/action failures

### Cross-surface parity tests

When ORC-67 extracts app-independent task helpers, add regression tests that prove the same helper semantics remain valid when invoked from the layers that matter to other host modes:

- Tauri task command wrappers
- remote API routes used by the browser-hosted frontend

That keeps ORC-67 aligned with the ORC-56 / ORC-61 / ORC-62 / ORC-65 direction instead of leaving CLI work as an unshared branch.

### Output tests

At minimum, cover:

- stable human list rendering
- human detail rendering for `task show`
- human comment-thread rendering for `task comments`
- concise mutation success messages
- JSON mode returning the canonical payload shapes

## Documentation deliverables

Implementation should update user-facing docs in addition to help text.

Recommended minimum documentation:

- add ORC-67 command examples to `README.md`
- keep `orc --help` / `orc task --help` authoritative for exact flags
- preserve this plan doc as the implementation rationale and deferred-surface record

## Intentionally deferred from the first operational slice

ORC-67 should stay focused on the core day-to-day task workflow slice.

Defer for later unless implementation proves they are trivial and low-risk:

- task delete
- task subtasks / todo CRUD beyond simple read visibility
- dependency management commands
- attachment and file-reference mutation commands
- schedule commands
- file-anchored comment metadata flags
- comment edit/delete CLI verbs
- worker-lane completion tools (`complete success`, `complete failure`, `needs user`)
- session-scoped runtime control verbs outside task context
- broad client-side list filters that do not already exist in the shared backend query model
- a separate remote/hosted CLI mode that talks to Orchestra primarily through remote API/client adapter transport contracts

That keeps the initial CLI coherent and genuinely useful without turning ORC-67 into a full mirror of every backend endpoint.

## Recommended implementation order

1. add the shared task-reference resolver
2. add the `task` clap parser and the common text/JSON output helpers
3. extract app-independent helpers for create/update/comment + review/control/dispatch/reassign
4. wire `task list` / `show` / `comments`
5. wire mutation verbs (`create`, `update`, `comment`, `approve`, `needs-work`, `pause`, `resume`, `stop`, `dispatch`, `move`)
6. add comprehensive coverage for the full shipped command matrix: lookup, parser/help, mutating task actions, CLI integration, cross-surface parity, and output
7. update help text + `README.md`

If ORC-67 follows this plan, the result should be a practical first operational CLI slice that feels like one coherent tool, maps cleanly onto Orchestra’s real semantics, and gives developers a clear path to keep expanding `orc` without reopening the model every time.