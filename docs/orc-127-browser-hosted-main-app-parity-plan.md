# ORC-127 browser-hosted main-app parity plan

## tl;dr

- The hosted-web bootstrap/auth path already exists for the main app (`src/main.tsx`, `src/lib/orchestraClient/hostedWeb.ts`) and the remote API already exposes most of the missing admin/settings routes.
- The remaining parity gap is primarily frontend-side: `App.tsx`, `AgentsPage.tsx`, and the major Settings panels still bypass the injected `OrchestraClient` path and call mixed Tauri/mock helper modules that fall back to `isTauriAvailable()` plus localStorage state.
- Finish parity by extending the injected service boundary to cover the remaining main-app domains, migrating those screens onto provider-backed client/data hooks, splitting pure browser preferences from mock domain state, and capability-gating only the truly desktop-only affordances.
- Required hosted-web surface: Tasks, Inbox, Chat, Sessions, project switching, and the non-shell settings/admin tabs needed to manage projects, workers, workflows, channels, prompting, and source control. Explicit desktop-only gaps: logs window, runtime logs, bridge diagnostics, system notifications, harness/Pi runtime setup, remote-access host management, agent terminal windows, and Pi executable diagnostics.

## Executive summary

ORC-56 already proved that Orchestra can expose a real browser surface, and `src/main.tsx` now has a real hosted-web bootstrap path instead of always choosing mock. The remote backend is also no longer the main blocker: `src-tauri/src/services/remote_api.rs` already serves the project/repository, source-control, project-settings, agents, roles, workflows, policies, channels, task, inbox, and session routes that the main app needs.

What still prevents the main `src/` app from being a true browser-hosted equivalent is that several top-level screens still skip the injected client seam entirely and import helper modules that mix three concerns together:

1. Tauri IPC
2. browser/localStorage mock domain state
3. ordinary browser-local UI preferences

As long as those screens can fall back to mock domain data when `isTauriAvailable()` is false, the hosted-web main app is not actually using the remote API for its core behavior. ORC-127 should therefore be treated as a frontend-completion ticket: route the remaining main-app surfaces through one injected host binding, keep mock mode explicit for tests/dev only, and leave desktop-only shell/admin affordances visibly unavailable instead of silently mocked.

## Current repo footing

### Already in place

- hosted-web host-mode resolution and pre-render bootstrap fetch:
  - `src/main.tsx`
  - `src/lib/orchestraClient/hostedWeb.ts`
- working hosted-web remote adapter path:
  - `src/lib/orchestraClient/remoteApiClient.ts`
  - `src/lib/orchestraClient/remoteApiTransport.ts`
  - `src/lib/orchestraClient/remoteApiEvents.ts`
- partial hosted-web smoke coverage against the real Remote API:
  - `tests/hosted-web-e2e/tasks.spec.ts`
  - `tests/hosted-web-e2e/inbox.spec.ts`
  - `tests/hosted-web-e2e/sessions.spec.ts`
- app-shell capability gating for obviously desktop-only affordances already exists in `src/App.tsx` through:
  - `supportsLogsWindow(...)`
  - `supportsAgentTerminal(...)`
  - `supportsRuntimeLogs(...)`
  - `supportsBridgeDiagnostics(...)`
  - `supportsHarnessSettings(...)`
  - `supportsRemoteAccess(...)`
  - `supportsSystemNotifications(...)`

### Remote backend coverage already exists for the next wave

`src-tauri/src/services/remote_api.rs` already exposes the browser routes needed for the remaining main-app migration, including:

- `/api/v1/projects`
- `/api/v1/projects/:project_id`
- `/api/v1/projects/:project_id/repositories`
- `/api/v1/repositories/:repository_id`
- `/api/v1/settings/source-control`
- `/api/v1/project-settings/session-prompt`
- `/api/v1/project-settings/task-automation`
- `/api/v1/project-settings/source-control`
- `/api/v1/project-settings/worker-overlay`
- `/api/v1/models`
- `/api/v1/agents`, `/api/v1/agent-operations`, `/api/v1/agent-queue`
- `/api/v1/roles`, `/api/v1/role-operations`, `/api/v1/role-queue`
- `/api/v1/workflows`
- `/api/v1/policies`
- `/api/v1/channels`

That means ORC-127 should start from the assumption that the main missing work is frontend/client migration, not a fresh remote-driver or bootstrap redesign.

## Remaining frontend blockers

### Screens still bypassing the injected client seam

| Surface | Current direct path | Hosted-web problem |
| --- | --- | --- |
| `src/App.tsx` | `./lib/agents`, `./lib/roleRuntime`, `./lib/projectSettings`, `./lib/projects` | chat agent discovery, `ensureAgentSession(...)`, role-operation reads, and prompt settings still bypass the injected client; project preference helpers still live in a file that seeds mock projects |
| `src/agents/AgentsPage.tsx` | `../lib/agents`, `../lib/roleRuntime`, `../lib/tauri` | role/agent operations and runtime/task actions still use Tauri/mock helpers directly |
| `src/settings/ProjectsPanel.tsx` | `../lib/projects`, `../lib/projectSettings`, `../lib/sourceControlSettings` | project/repository CRUD and project-scoped settings still fall back to local mock state or Tauri IPC |
| `src/settings/SourceControlPanel.tsx` | `../lib/sourceControlSettings` | global source-control settings are not provider-backed |
| `src/settings/AgentsPanel.tsx` | `../lib/agents`, `../lib/policies`, `../lib/projectSettings`, `../lib/roles`, `../lib/tauri` | worker admin still mixes Tauri/mock helpers; model list and error reporting are not host-agnostic |
| `src/settings/RolesPanel.tsx` | `../lib/policies`, `../lib/roles`, `../lib/tauri` | same issue for role admin |
| `src/settings/WorkflowsPanel.tsx` | `../lib/agents`, `../lib/roles`, `../lib/tauri` | workflow CRUD is still anchored in `src/lib/tauri.ts` |
| `src/settings/ChannelsPanel.tsx` | `../lib/channels`, `../lib/projects`, `../lib/tauri` | channel CRUD/activity still bypasses the injected client |

### Cross-cutting helper problem

The remaining helper modules still collapse host transport and mock fallback together:

- `src/lib/projects.ts`
- `src/lib/projectSettings.ts`
- `src/lib/sourceControlSettings.ts`
- `src/lib/agents.ts`
- `src/lib/roleRuntime.ts`
- `src/lib/roles.ts`
- `src/lib/policies.ts`
- `src/lib/channels.ts`
- workflow/error/model helpers still in `src/lib/tauri.ts`

The most important cleanup item is `src/lib/projects.ts`: it mixes project CRUD and mock project seeding with the otherwise simple active-project preference helpers used by `App.tsx`. In hosted web, that means a normal page load can still touch mock project state even though the real project catalog is coming from `orchestraClient.catalog.listProjects()`.

## Hosted-web scope decision

### Required browser-hosted main-app surface

The browser-hosted main app should cover the real shared-product surface that makes `src/` meaningfully broader than the mobile/remote-driver UI:

- Tasks
- Inbox
- Sessions
- Chat / supervisor chat / agent chat session launch
- project switching in the main shell
- Agents page operational views that are already part of the main app
- Settings tabs for:
  - Projects
  - Agents
  - Roles
  - Workflows
  - Channels
  - Source Control
  - Prompting
- browser-local UI preferences that are intentionally local-only, such as theme, tooltips, collapsed navigation, and remembered active project

### Explicit desktop-only surface

These should stay unavailable in hosted web and be surfaced as such through capabilities/UI copy rather than `isTauriAvailable()` branches:

- logs window / detached runtime-log shell
- agent terminal windows and terminal buffer controls
- bridge diagnostics
- system-notification host integration
- harness / Pi runtime setup and credential-management shell flows
- remote-access host management
- Pi executable diagnostics for the local desktop runtime

### Important split

`listPiModels()` is part of the shared orchestration/backend story and already has a remote route. `getPiExecutableDiagnostic()` is desktop-shell-specific. ORC-127 should keep those concerns separate instead of treating “models” and “local runtime health” as one feature.

## Proposed implementation plan

### 1. Split browser-local preferences from mock domain helpers

Create a small host-neutral preference layer for values that are legitimately browser-local:

- active project id
- theme/tooltips/sidebar UI state
- lightweight remembered UI selections

Do **not** leave active-project selection inside `src/lib/projects.ts`, because that file currently drags mock project seeding into hosted-web startup.

### 2. Extend the injected client/service boundary for the remaining main-app domains

Use the same injected-binding pattern already used by tasks/inbox/sessions instead of adding a new generation of ad hoc fetch helpers.

The exact interface names can vary, but the hosted-web path needs provider-backed services for these domains:

- `projects`
  - project CRUD
  - repository CRUD
  - default repository / attach-remote actions
- `settings`
  - global source-control settings
  - project session prompt settings
  - project task automation settings
  - project source-control overrides
  - worker overlays
  - model catalog
- `workers` or equivalent
  - agent CRUD/validation/details/permissions/operations/queue actions
  - role CRUD/validation/details/permissions/operations/queue/runtime actions
  - `ensureAgentSession(...)`
- `workflows`
  - validate/create/update/duplicate/archive
  - lane mutations
- `policies`
  - list/get policy and resolved-permission helpers
- `channels`
  - CRUD/activity
  - Telegram validation/chat discovery

Implementation rule: do not keep the main app split across “shared injected client for some domains” and “direct Tauri/mock helpers for the rest.”

### 3. Implement all host bindings for those new surfaces

For every newly injected surface:

- Tauri binding should call the existing desktop commands
- Remote API binding should call the existing `remote_api.rs` routes
- Mock binding should keep explicit mock-mode behavior for tests/dev

Mock mode must remain explicit host selection, not the default behavior for “browser and not Tauri.”

### 4. Migrate the remaining screens onto the injected path

#### App shell

Move these `App.tsx` behaviors off direct helper imports and onto injected services/data hooks:

- chat agent discovery
- supervisor/agent session ensure flow
- command-palette agent/role operational data
- project-session prompt load/save
- active-project preference reads/writes via the new local-preference helper

#### Agents page

Replace direct uses of:

- `deleteAgentQueueEntry(...)`
- `getAgentOperations(...)`
- `listAgentOperations(...)`
- role-runtime queue/reset/release/dispose helpers
- `dispatchTaskLane(...)`
- `resetTaskRuntime(...)`
- `stopSessionRuntime(...)`

with injected service calls. Existing shared client methods already cover some of this (`tasks.dispatch`, `tasks.resetRuntime`, `sessions.stopRuntime`), so those should stop importing from `src/lib/tauri.ts` immediately.

#### Settings/admin screens

Migrate these panels to call injected services directly or through new `orchestraData/*` hooks:

- `ProjectsPanel`
- `SourceControlPanel`
- `AgentsPanel`
- `RolesPanel`
- `WorkflowsPanel`
- `ChannelsPanel`

Also replace raw `reportClientError(...)` imports with the provider-backed error path (`reportUiError(...)` / `orchestraClient.app.reportError(...)`).

### 5. Keep desktop-only affordances explicit

Use capability-based rendering for the remaining non-browser surfaces rather than leaving them reachable and failing late.

Concretely:

- keep `Harness` and `Remote` tabs hidden/disabled in hosted web
- keep detached logs/agent terminal UI unavailable in hosted web
- show model lists remotely where supported, but show Pi executable diagnostics only on desktop
- do not let any required hosted-web flow silently read or write localStorage mock domain records

## Delivery order

### Slice 1

- extract active-project/local preference helpers out of `src/lib/projects.ts`
- add the remaining injected service interfaces and adapter bindings
- wire remote bindings to the already-existing remote routes

### Slice 2

- migrate `App.tsx` chat/prompting/command-palette flows
- migrate `AgentsPage.tsx`
- remove remaining direct task/session runtime calls from `src/lib/tauri.ts` consumers

### Slice 3

- migrate settings/admin panels
- split remote-capable model catalog from desktop-only Pi diagnostics
- finalize explicit hosted-web capability gating for desktop-only controls

### Slice 4

- extend hosted-web tests and coverage metadata
- clean up any now-unused legacy helper exports that only existed to mix Tauri and mock paths

## Validation plan

### Client/adapters

Add contract/integration coverage for the new injected surfaces across mock, Tauri, and Remote API bindings.

### Hosted-web UI coverage

The current hosted-web matrix only requires:

- tasks
- inbox
- sessions

Expand hosted-web coverage to include at least:

- chat / ensure-agent-session flow
- one project/settings flow (source control or prompting)
- one admin flow (agents, roles, workflows, or channels)
- one command-palette or project-switching flow that exercises the main shell rather than the existing remote-driver subset

### Acceptance check

This task should be considered planned correctly when the implementation path makes the following explicit:

- the main `src/` app uses the remote API through injected bindings for its hosted-web core behavior
- browser-local preferences remain local, but browser-local mock domain state does not power required hosted-web flows
- desktop-only shell/admin affordances are explicit, capability-gated gaps rather than accidental fallback behavior
