# ORC-62 remote API parity plan

## tl;dr

- The hosted-web bootstrap/auth seam is now in place, but `src-tauri/src/services/remote_api.rs` still exposes only the older remote-driver slice.
- ORC-62 should close the gap by moving shared frontend semantics behind one reusable backend service layer, then adding the missing HTTP routes and websocket coverage for the shared task, inbox, session, catalog, settings, and admin surfaces.
- Keep the boundary explicit: shared cross-host reads/writes become remotely available; desktop-only shell/runtime affordances stay unavailable and remain advertised that way in bootstrap capabilities.

## Executive summary

ORC-57 defined the shared `OrchestraClient` contract and ORC-59 added hosted-web bootstrap/auth negotiation, but the remote backend still reports most shared capabilities as unavailable because it only implements a narrow set of endpoints: bootstrap/app info, project list + project task list, task detail + a few review/control actions, inbox list/send/read/archive, session list/detail/message/stop, supervisor helpers, and websocket delivery for `task.updated`, `session.updated`, `inbox.updated`, and `session.stream`.

The current shared frontend surface is materially larger. Between `src/lib/orchestraClient/client.ts` and the still-unmigrated shared helper modules under `src/lib/`, the browser-hosted UI needs parity for:

- full task CRUD plus comments, todos, attachments, file references, schedules, dependencies, task mail, and workflow transitions
- richer session/runtime/model actions
- project + repository reads/writes
- agent, role, workflow, policy, and channel reads/writes relevant to shared settings/admin screens
- shared project/source-control/prompting settings reads/writes
- websocket delivery that matches the shared frontend event model instead of the older mobile-driver topic names

ORC-62 should therefore be implemented as a backend-parity ticket, not as a pile of route-specific patches. The key move is to create one shared backend façade for frontend-facing semantics and have both Tauri commands and remote API handlers call that façade so the two transports cannot drift.

## Current repo state

### What already exists remotely

`src-tauri/src/services/remote_api.rs` currently exposes:

- `GET /api/v1/health`
- `GET /api/v1/app-info`
- `GET /api/v1/frontend/bootstrap`
- `POST /api/v1/pair/complete`
- `GET /api/v1/projects`
- `GET /api/v1/projects/:project_id/tasks`
- `GET /api/v1/projects/:project_id/supervisor`
- `POST /api/v1/projects/:project_id/supervisor/message`
- `GET /api/v1/tasks/:task_id`
- `POST /api/v1/tasks/:task_id/approve`
- `POST /api/v1/tasks/:task_id/needs-work`
- `POST /api/v1/tasks/:task_id/resume`
- `POST /api/v1/tasks/:task_id/pause`
- `POST /api/v1/tasks/:task_id/stop-activity`
- `GET /api/v1/inbox`
- `POST /api/v1/inbox/send`
- `POST /api/v1/inbox/:delivery_id/read`
- `POST /api/v1/inbox/:delivery_id/archive`
- `POST /api/v1/devices/push-token`
- `GET /api/v1/sessions`
- `GET /api/v1/sessions/:session_id`
- `POST /api/v1/sessions/:session_id/message`
- `POST /api/v1/sessions/:session_id/stop`
- `GET /api/v1/ws`

The hosted-web bootstrap path is already correct in shape, but `build_frontend_feature_flags(...)` and `build_frontend_capabilities(...)` still intentionally mark most shared surfaces unavailable.

### What the shared frontend surface still needs

From the current frontend contract and helper surface, the missing remote parity breaks down into six groups.

| Area | Current remote coverage | Missing for parity |
| --- | --- | --- |
| Projects + repositories | project list, project task list | project detail/CRUD, repository CRUD, attach remote, set default repository |
| Shared catalog/admin | none beyond project list | agents, roles, workflows, policies, channels, agent/role operations needed by shared pages |
| Shared settings | bootstrap only | source-control settings, project source-control settings, prompting/task automation/worker overlays |
| Tasks | list by project, task detail, approve/needs-work/resume/pause/stop-activity | create/update/delete, todos, comments, read markers, dependencies, file refs/content, attachments, schedules, task mail, full transition/action surface |
| Sessions/runtime | list/get/send/stop, supervisor helpers | runtime details, stats, model read/write, create/delete/resume, contextual create, subscribe/unsubscribe, compact/reload |
| Realtime | remote envelope + session subscribe/unsubscribe | shared event topic names/kinds, broader mutation coverage, contract-level websocket semantics/tests |

## Proposed implementation shape

### 1. Create a shared backend frontend-service façade

Add a dedicated backend façade for frontend-facing semantics, for example under `src-tauri/src/services/frontend_api/` with domain modules such as:

- `app`
- `projects`
- `catalog`
- `tasks`
- `inbox`
- `sessions`
- `settings`
- `admin`

Responsibilities:

- accept shared input DTOs plus app/state/auth context
- call the existing lower-level services (`projects`, `tasks`, `messages`, `channels`, `policies`, `project_settings`, `pi_sessions`, etc.)
- emit the same task/session/inbox app events regardless of transport
- return the same DTO shapes to both Tauri and remote callers

Guiding rule:

- Tauri commands become thin IPC wrappers over this façade
- remote HTTP/WS handlers become thin transport wrappers over this façade
- remote routes should stop depending on ad hoc combinations of direct service calls for reads and command calls for writes

Notes on reuse:

- pure reads that already map cleanly to service functions can stay thin
- task/session/inbox mutations currently encoded in `src-tauri/src/commands/tasks.rs`, `sessions.rs`, `messages.rs`, `agent_runtime.rs`, and `role_dispatch.rs` should be lifted below the command boundary so remote handlers and Tauri commands share exactly one semantic implementation

### 2. Expand the HTTP surface by shared domain

Prefer resource-oriented routes with nested subresources, and use explicit action endpoints only for workflow/session control semantics.

#### Projects + repositories

Add parity for the project/settings pages:

- `GET /api/v1/projects/:project_id`
- `POST /api/v1/projects`
- `PATCH /api/v1/projects/:project_id`
- `DELETE /api/v1/projects/:project_id`
- `GET /api/v1/projects/:project_id/repositories`
- `GET /api/v1/repositories/:repository_id`
- `POST /api/v1/projects/:project_id/repositories`
- `PATCH /api/v1/repositories/:repository_id`
- `DELETE /api/v1/repositories/:repository_id`
- `POST /api/v1/repositories/:repository_id/attach-remote`
- `POST /api/v1/projects/:project_id/default-repository`

#### Shared catalog/admin surfaces

Add the shared reads/writes behind explicit auth checks:

- agents
  - list/detail/validate/create/update/archive
  - list/get operations
  - enqueue/delete work
  - ensure agent session
- roles
  - list/detail/validate/create/update/archive
  - list/get operations
  - enqueue/delete work
  - dispatch/reset/release/dispose role runtime actions needed by shared screens
- workflows
  - list/detail/validate/create/update/duplicate/archive
  - lane add/update/delete/reorder
- policies
  - list/get policy
  - get role permissions
  - get agent permissions
  - list orchestra tools
- channels
  - list/detail/activity/create/update/delete
  - validate Telegram bot
  - list Telegram chat candidates

#### Shared settings surfaces

Expose the settings that are genuinely cross-host rather than desktop-shell specific:

- global source control settings
- project source control settings
- project session prompt settings
- project task automation settings
- project worker overlays

Do **not** pull local-shell configuration into the remote parity surface just because it currently lives under Settings. The following should remain explicitly host-specific unless a later ticket says otherwise:

- Pi runtime / harness settings
- remote-access host management
- logs window / system-notification shell affordances
- agent terminal transport and terminal-buffer controls

#### Task surface

Implement parity for the full shared task surface already defined by `OrchestraTaskService` plus the still-unmigrated shared helpers.

Required additions:

- task create/update/delete and list variants not limited to project-only lookup
- todo list/add/finish/unfinish/delete
- comment list/add/update/delete
- comment read markers and file-mention search
- dependency add/remove
- file reference list/add/default/remove
- file-content reads
- attachment add/remove
- schedule list/detail/create/update/delete
- task mailbox/message reads
- remaining transition/control actions:
  - dispatch
  - complete success/failure/needs-user
  - approve completion
  - reassign
  - manual whip
  - reset runtime
  - any remaining review/control paths used by the shared UI

#### Session/runtime surface

Bring the remote API up to the shared session contract:

- runtime details
- session stats
- create/delete/resume
- contextual create
- subscribe/unsubscribe
- get/set model
- compact/reload
- existing send/stop paths should route through the same façade as Tauri

### 3. Align websocket delivery to the shared frontend event model

The current websocket path forwards `RemoteEventEnvelope` records with topics such as `task.updated`, `session.updated`, `inbox.updated`, and `session.stream`. That was fine for the mobile-driver slice, but the shared frontend contract wants an event model keyed to:

- `task.change`
- `session.change`
- `session.stream`
- `inbox.change`

ORC-62 should update the backend websocket contract so the remote adapter does not have to guess at topic semantics.

Recommended changes:

- publish shared topic names that align directly with the ORC-57 event union
- keep the payload shapes equivalent to the existing desktop `CustomEvent` payloads
- preserve per-client session subscriptions for stream traffic
- add explicit subscription confirmations/errors for `session.subscribe` and `session.unsubscribe`
- keep project-selection filtering only if the shared frontend actually needs it; otherwise do not make the remote adapter depend on legacy driver semantics
- if backward compatibility with the older remote-driver topic names matters, support aliases temporarily rather than forcing the shared adapter to consume the old names forever

### 4. Make bootstrap capabilities reflect real route availability

As routes land, update `build_frontend_feature_flags(...)` and `build_frontend_capabilities(...)` so bootstrap stops advertising placeholder unavailability for surfaces that are now real.

Rules:

- mark shared cross-host routes available only when the HTTP + websocket paths actually exist
- keep desktop-only capabilities unavailable with explicit reasons
- use the same capability matrix to gate hosted-web UI behavior instead of hard-coded frontend assumptions

## Suggested delivery order

### Slice 1 — foundation + core shared-app parity

- extract the shared frontend-service façade
- move existing remote reads/writes onto it
- finish task/inbox/session/project parity needed by the main shared app shell
- align websocket event kinds for task/session/inbox/session-stream

This slice gives ORC-61 a stable transport target for the browser-hosted app itself.

### Slice 2 — shared settings/admin parity

- projects/repositories CRUD
- agents/roles/workflows/policies/channels
- shared source-control/prompting/task-automation settings
- role/agent operation reads/actions that are part of the shared UI

This slice closes the remaining settings/admin gaps without mixing in host-only configuration.

### Slice 3 — capability cleanup + validation hardening

- flip bootstrap feature flags/capabilities to the real final values
- add route/auth/websocket tests for every new domain
- add focused frontend contract coverage for the remote route + websocket mapping

## Auth and boundary rules

- keep the ORC-59 hosted-web auth model: same-origin cookie first, bearer token fallback for paired/device contexts
- require authentication for all shared domain reads/writes beyond bootstrap/app-info/pairing
- do not expose desktop-shell-only runtime controls just because the desktop app has them through Tauri
- keep privileged/shared admin routes explicit in bootstrap capabilities so the hosted-web UI can hide or disable anything intentionally unavailable

## Validation plan

Backend coverage should be added alongside the implementation:

- route tests for each new endpoint group
- auth tests for cookie vs bearer access on protected routes
- websocket tests for topic names, subscription behavior, and payload shape
- regression coverage that task/session/inbox mutations emit the same downstream events regardless of whether they were triggered through Tauri or remote HTTP

Frontend/shared-contract coverage should verify:

- the hosted-web adapter can consume the final bootstrap capability matrix
- websocket events map directly into the ORC-57 shared union without transport-specific translation leakage
- browser-hosted shared screens no longer depend on Tauri-only helpers for any surface ORC-62 claims to support

## Handoff summary

ORC-62 should land as the backend complement to ORC-57 and ORC-59:

- ORC-57 defined the shared frontend contract
- ORC-59 defined how hosted web bootstraps and authenticates
- ORC-62 should make the remote backend actually satisfy that contract, using one shared backend service layer so the Tauri and remote implementations remain semantically aligned
