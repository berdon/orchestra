# ORC-10 plan: seeded install baseline

## Why this change is needed

Fresh Orchestra installs currently do not come up with a coherent ready-to-use baseline across the real desktop app and browser-mode mock state.

Today the codebase has three mismatches:

1. **The backend lazily creates a special default project that cannot be deleted.**
   - `src-tauri/src/services/projects.rs` calls `ensure_default_project()` from list/get helpers.
   - `delete_project()` rejects the hard-coded project id `orchestra`.
   - That makes the seeded project behave like protected system state instead of ordinary user-editable data.
2. **The backend does not seed the standard roles/workflows required by this task.**
   - Real installs only get the supervisor auth bootstrap at startup.
   - Browser mode separately seeds a minimal `Developer` / `Reviewer` set plus one `Development` workflow in `src/lib/roles.ts` and `src/lib/tauri.ts`.
3. **Many backend and frontend paths hard-code `"orchestra"` as the fallback project id/slug.**
   - That assumption appears in task commands, project settings commands, channels, agent runtime helpers, browser-mode adapters, and parts of the UI.
   - Even after removing the delete guard, those call sites would still behave incorrectly once the seeded project is renamed, replaced, or deleted.

## Goals

- Fresh installs get one useful seeded project plus seeded roles and workflows.
- Seeded items are **normal records**: editable, archivable, replaceable, and where supported, deletable.
- Deleting the seeded default project must **not** cause it to be recreated automatically on the next list/read call.
- Browser-mode mock state and the real Tauri backend should seed the **same catalog**.
- Seeded workflows should already reference the seeded role slugs correctly.
- Docs/onboarding should explain what gets seeded and that users can customize or remove it.

## Proposed design

### 1. Add a dedicated install baseline bootstrap service

Create a new backend service, e.g. `src-tauri/src/services/install_seed.rs`, with an idempotent entry point such as:

- `ensure_install_baseline_seeded(connection: &mut Connection)`

This should run during app startup next to the existing auth bootstrap.

It should **not** be wired into normal list/get/read helpers the way `ensure_default_project()` is today. Seeding belongs to install bootstrap, not ordinary read paths.

### 2. Persist one-time bootstrap state so deleted seeds stay deleted

Add a small table for installation/bootstrap state, for example:

- `installation_bootstrap_state`
  - `key TEXT PRIMARY KEY`
  - `version INTEGER NOT NULL`
  - `applied_at TEXT NOT NULL`

Use a key like `default-install-baseline`.

Behavior:

- If the key is missing, apply the baseline seed pack and record it.
- If the key already exists, do nothing.
- Future versions can bump `version` deliberately instead of re-seeding every time the database is empty.

This is the critical difference from the current project bootstrap. It prevents the app from resurrecting the seeded project, roles, or workflows after the user intentionally deletes or archives them.

### 3. Replace the special default project with an ordinary seeded project

Seed a normal project record named **Orchestra** with the usual project fields, but do **not** give it undeletable semantics.

Key points:

- Remove the delete guard in `projects::delete_project()`.
- Remove lazy `ensure_default_project()` calls from project read/list helpers.
- Do not rely on a hard-coded project id being permanently present.
- Prefer seeding **no default repository** for the project.

Why no seeded repository:

- The current backend default repository path is derived from the source tree and is not a good fit for packaged installs.
- The task requirements only require a seeded project, roles, prompts, and workflows.
- Orchestra can already operate against a project root without a repository, so planning/strategy/development flows still work immediately.
- This keeps deletion/editability simple and avoids shipping misleading repo state.

### 4. Move to a canonical seed catalog shared by backend and browser mode

Define one canonical install baseline catalog in a neutral format that both Rust and TypeScript can consume, e.g.:

- `seed/default-install-baseline.json`

The catalog should include:

- seeded project definition
- seeded role definitions
- seeded workflow definitions
- any shared copy needed by onboarding/help

Why this is worth doing:

- prevents prompt/workflow drift between browser mode and the real app
- makes tests assert against one source of truth
- makes future seed-pack versioning easier

If a shared JSON file proves awkward, the fallback is duplicated Rust/TS constants, but the preferred plan is a single declarative catalog.

## Seeded baseline contents

### Seeded project

Seed one ordinary project:

- **Name:** `Orchestra`
- **Slug:** generated normally from the name (`orchestra` on first install)
- **Description:** short explanation that this is the initial ready-to-use workspace
- **Default repository:** `null`

This project is just a starting workspace. Users can rename it, replace it, or delete it.

### Seeded standard roles

Seed these global roles with stable slugs and complete prompts:

| Name | Slug | Primary purpose |
| --- | --- | --- |
| Architect | `architect` | planning, technical design, implementation framing |
| Senior Developer | `senior-developer` | implementation, debugging, code quality, delivery |
| QA | `qa` | validation, repro steps, regression checking, release confidence |
| Product Owner | `product-owner` | user outcomes, scope, acceptance criteria, prioritization |
| Project Manager | `project-manager` | sequencing, coordination, blockers, execution tracking |

All seeded roles should be created as ordinary editable roles (`archived = 0`, no special protection flags).

#### Role prompt shape

The role prompts should be full usable prompts, but they should stay **role-specific** instead of duplicating Orchestra's global task-operating instructions already injected by the session template.

Each role prompt should include:

- mission / decision lens
- what “good output” looks like
- required habits in Orchestra (clear comments, explicit transitions, concrete artifacts)
- role-specific quality bars
- anti-patterns to avoid

Recommended emphasis:

- **Architect:** clarify requirements, propose minimal viable design, call out risks/dependencies, keep plans concrete and implementation-ready.
- **Senior Developer:** implement approved plans carefully, keep changes scoped, run relevant validation, explain tradeoffs and follow-up work.
- **QA:** verify acceptance criteria, reproduce issues precisely, report findings with evidence, distinguish blockers from nits, avoid vague “looks good.”
- **Product Owner:** optimize for user value and clarity, tighten scope, define acceptance criteria, surface ambiguity and tradeoffs.
- **Project Manager:** maintain execution flow, identify blockers/owners, keep work sequenced sensibly, preserve handoff clarity and status accuracy.

#### Role permissions

Seed the standard roles with the task-worker permissions needed to follow Orchestra's current worker instructions without immediately failing authorization.

Recommended minimum grants:

- `tasks.read`
- `tasks.create`
- `tasks.update`
- `tasks.comment`
- `tasks.transition`
- `tasks.attachments.write`
- `tasks.dependencies.write`

Direct permissions are sufficient for this slice. A shared seeded worker policy could be added later, but it is not required to satisfy ORC-10.

### Seeded workflows

Seed these global workflows with stable slugs and role-slug lane references:

1. **Product Strategy**
2. **Planning**
3. **Development**

All seeded workflows should be ordinary editable/archiveable workflow records.

#### Recommended workflow shapes

##### Product Strategy

Suggested lane sequence:

1. **Frame opportunity** — Product Owner
2. **Technical framing** — Architect
3. **Delivery framing** — Project Manager
4. **Review** — User

Suggested transitions:

- success flows forward lane-by-lane
- role-lane failure usually returns to the immediately preceding framing lane
- final user review success ends the workflow
- final user review failure returns to Product Owner or Architect depending on the desired iteration point

##### Planning

Suggested lane sequence:

1. **Clarify scope** — Product Owner
2. **Technical plan** — Architect
3. **Execution plan** — Project Manager
4. **Review** — User

This produces a workflow suitable for turning a strategy item into implementation-ready work.

##### Development

Suggested lane sequence:

1. **Plan** — Architect
2. **Implement** — Senior Developer
3. **Verify** — QA
4. **Review** — User

Suggested transitions:

- Implement failure → back to Plan
- Verify failure → back to Implement
- User review failure → back to Implement or Verify depending on how strict we want the loop

This should replace the current minimal browser-only development seed that points at `developer`.

## Project fallback strategy after deleting the seeded project

We need to stop assuming `orchestra` is always present.

Introduce a small resolver in the backend and parallel logic in browser mode:

- `resolve_default_project_id(connection) -> Option<String>`
  - first explicit project id if supplied
  - else current active/selected project where that concept already exists
  - else first available project by stable ordering
  - else `None`

Then audit call sites that currently hard-code `"orchestra"` so they either:

- use the resolved project id, or
- surface a friendly “Create a project first” error when no project exists

Expected hotspots:

- `src-tauri/src/services/tasks.rs`
- `src-tauri/src/commands/tasks.rs`
- `src-tauri/src/commands/project_settings.rs`
- `src-tauri/src/services/channels.rs`
- `src-tauri/src/services/agent_runtime.rs`
- browser-mode helpers in `src/lib/projects.ts`, `src/lib/projectSettings.ts`, and `src/lib/tauri.ts`
- UI hard-coding in `src/settings/ProjectsPanel.tsx` and `src/App.tsx`

## UX / docs / onboarding updates

Update first-run/help surfaces so users understand:

- Orchestra now starts with a seeded baseline project, roles, and workflows
- these are templates and starting points, not protected system records
- the seeded project can be deleted
- roles/workflows can be edited or archived to fit the user's process

Minimum documentation/UI updates:

- `README.md` first-run / setup copy
- Settings empty-state or intro copy for Projects / Roles / Workflows
- any help text that currently implies only a single built-in Orchestra project exists forever

## Validation plan

### Backend tests

Add Rust tests covering:

1. **Fresh-install seed bootstrap**
   - baseline project exists
   - required roles exist
   - required workflows exist
   - workflow lane owner refs point to the expected role slugs
2. **Seeded project deletion**
   - seeded project deletes successfully
   - no automatic reseed occurs on subsequent project listing
3. **Seeded items remain ordinary**
   - roles can be updated/archived
   - workflows can be updated/archived
4. **Fallback behavior**
   - command/service paths that omit a project id use another available project when present
   - they return a clean error when no projects remain

### Browser/web tests

Update Playwright coverage so browser mode matches the same baseline:

- Projects settings show the seeded Orchestra project
- Roles settings show all seeded standard roles
- Workflows settings show Product Strategy / Planning / Development
- deleting the seeded project is allowed and falls back cleanly
- Development workflow owner refs use `senior-developer` / `qa` (or whatever final seeded slugs are chosen), not legacy ids

### Desktop E2E

Add or extend one real desktop first-run test that validates the true Tauri bootstrap path, not just browser local storage.

## Implementation order

1. Add install bootstrap state table and backend seeding service.
2. Seed the canonical catalog in the Tauri startup path.
3. Remove special project delete protections and lazy read-path seeding.
4. Replace hard-coded `orchestra` fallbacks with a resolver-based approach.
5. Switch browser-mode seeds to the same catalog.
6. Update docs/help copy.
7. Add/refresh backend, browser, and desktop first-run tests.

## Main risk to watch

The biggest risk is not the seed records themselves; it is the number of places that currently assume the seeded project id is always `orchestra`.

If we only change seeding and deletion rules without auditing those fallbacks, the project will become deletable in theory but fragile in practice.

So the implementation should treat **"remove hard-coded default-project assumptions"** as part of the feature, not as cleanup.
