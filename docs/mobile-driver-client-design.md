# Orchestra mobile driver client design

## Summary

Orchestra should support a cross-platform Android/iOS client as a **remote driver** for the host Orchestra instance.

This client should:
- control Orchestra over authenticated network/API calls
- provide a richer visual UX than Telegram or other text channels
- let a human inspect and direct work while away from the desktop
- **not** host agent sessions, worktrees, or pi runtimes on-device

The recommended design is:
1. keep all execution on the host machine running Orchestra
2. add a host-side authenticated HTTP + realtime API
3. build a dedicated mobile client that talks to that API
4. treat the current Tauri desktop app as one client surface among several, rather than the only control plane

## Decision

### Adopt a host-side remote-control architecture

Orchestra should support mobile by exposing a **networked control plane** from the host, not by porting the current desktop runtime to the phone.

The host remains responsible for:
- project state
- SQLite persistence
- session files under `~/.orchestra`
- live pi runtimes
- dispatcher loops
- channel integrations
- task/workflow/mailbox services

The mobile app becomes a remote operator surface for:
- supervisor chat
- task browsing and triage
- inbox/mail actions
- approvals / needs-work actions
- session visibility and light intervention
- push notifications

### Do not treat the mobile app as a full Tauri-mobile port

Although the Tauri crate entrypoint is already written as:
- `src-tauri/src/lib.rs` → `#[cfg_attr(mobile, tauri::mobile_entry_point)]`

that does **not** make the current app architecture a good fit for running Orchestra on Android/iOS.

The current backend depends on host-local capabilities such as:
- spawning `pi` processes
- managing long-lived local runtimes
- working with repository/worktree paths
- reading and writing Orchestra-managed session JSONL files
- opening terminal windows / PTY-backed sessions
- delivering updates directly into the desktop webview

That architecture maps well to a desktop host and poorly to a phone.

## Goals

- Support a cross-platform Android/iOS client with a richer UX than Telegram.
- Allow the mobile client to act as another Orchestra driver for a host instance.
- Preserve Orchestra's existing host-side execution model.
- Support realtime updates for sessions, tasks, and inbox state.
- Preserve existing authorization and auditing guarantees.
- Allow the desktop app and mobile client to coexist against the same host.
- Make the architecture extensible for future remote clients beyond mobile.

## Non-goals

For the first version, the mobile client will **not**:
- run `pi` sessions locally
- host repositories or worktrees on-device
- replace the desktop app entirely
- expose the full settings/editor surface from mobile
- support deep repository/file-management workflows
- support embedded terminals or terminal handoff flows
- reuse the current desktop frontend wholesale
- expose the internal Orchestra tool bridge directly as a public API

## Product framing

The mobile client is closest in spirit to a **richer supervisor channel**:
- like Telegram, it is an external surface that can direct and observe Orchestra
- unlike Telegram, it has structured UI, richer task/session displays, and a persistent authenticated client identity

This means the mobile client should reuse some of the same underlying orchestration semantics as channels:
- default project selection
- supervisor-session routing
- run-origin tracking
- user-visible replies and notifications

However, it should **not** be modeled only as another entry in the current `channels` subsystem.

Text channels and rich remote drivers have different needs:
- channels need transport adapters and activity logs
- mobile needs authenticated sessions, rich queries, realtime fanout, per-device subscriptions, and push notifications

## Current-state findings

### Backend architecture is service-oriented, which is good

The current backend command surface is registered in:
- `src-tauri/src/lib.rs`

but the implementation logic mostly lives in reusable services under:
- `src-tauri/src/services/`

Key areas:
- sessions: `services/live_sessions.rs`, `services/pi_sessions.rs`
- tasks: `services/tasks.rs`, `services/task_runtime.rs`
- messages/inbox: `services/messages.rs`
- channels: `services/channels.rs`
- authz: `services/authorization.rs`, `services/command_authorization.rs`
- state: `src-tauri/src/state.rs`

This is the strongest architectural reason the mobile plan is practical: most domain logic is already below the UI layer.

### Frontend/backend coupling is still Tauri-centric

The current React frontend mostly talks to the backend via Tauri invoke wrappers such as:
- `src/lib/tauri.ts`
- `src/lib/projects.ts`
- `src/lib/channels.ts`
- `src/lib/agents.ts`

This means the current desktop UI is not ready to be dropped into mobile as-is. It assumes:
- Tauri `invoke(...)`
- desktop-window lifecycle
- desktop-specific capabilities
- browser-mode mocks rather than a true remote transport

### Realtime events are currently delivered only to the desktop webview

The current event fanout is implemented in:
- `src-tauri/src/services/app_events.rs`

That service emits updates by evaluating JavaScript in the **main Tauri webview** and dispatching browser `CustomEvent`s such as:
- `orchestra:session-change`
- `orchestra:task-change`
- `orchestra:inbox-change`

The frontend listens via `window.addEventListener(...)` in:
- `src/lib/tauri.ts`

This is the largest architectural gap for remote/mobile support.

Today the event system is effectively:
- backend → main desktop window

The mobile design needs:
- backend → internal event bus → many clients

### Session subscription state is not yet multi-client

Current subscription state is tracked centrally in:
- `src-tauri/src/state.rs`
- `src-tauri/src/commands/sessions.rs`
- `src-tauri/src/services/live_sessions.rs`

Today the model is effectively per-session:
- subscribed or not

It is **not** yet per-client/per-connection:
- which device is watching a session
- how many clients are attached
- which sessions each client is subscribed to
- how to clean up on disconnect

A mobile client requires per-client fanout and subscription tracking.

### The existing HTTP bridge is not the right public API

The current tool bridge lives in:
- `src-tauri/src/services/tool_bridge.rs`

It already proves Orchestra can host a token-authenticated HTTP service, but its purpose is different:
- it is an internal agent tool bridge for pi runtimes
- it exposes Orchestra tools to running sessions
- it is not a human/operator API

It should stay internal.

### Telegram shows the right product pattern, but not the right transport shape

The existing channel integration in:
- `src-tauri/src/services/channels.rs`
- `src-tauri/src/commands/channels.rs`

already demonstrates a valid external-driver pattern:
- a remote surface can target the supervisor
- it can switch default project
- it can inspect tasks
- it can approve or send work back
- it can read and archive inbox messages
- channel-originated runs can route responses back outward

That is excellent prior art for mobile.

But the Telegram design is intentionally narrow:
- polling transport
- text command interface
- single chat target
- activity log oriented
- no rich realtime client state

Mobile should borrow the orchestration behavior, not the transport limitations.

## Architecture decision

### Introduce a first-class remote driver API

Orchestra should add a new host-side subsystem:
- **Remote driver API**

This subsystem should expose:
- authenticated HTTP endpoints for reads and commands
- a realtime stream for live updates
- device pairing and token management
- push-notification registration
- per-client presence and session subscriptions

The desktop app will remain a first-class host UI, but the mobile client will stop being dependent on Tauri-specific command transport.

### Keep channels and remote drivers separate

Recommended conceptual model:
- **channels** = asynchronous external transport adapters like Telegram
- **drivers** = richer interactive clients like desktop, web, and mobile

The mobile app behaves like a remote driver, not a mere channel transport.

## High-level architecture

```text
┌────────────────────────────────────────────────────────────┐
│                    Orchestra host machine                  │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Orchestra core services                             │  │
│  │ - projects/tasks/workflows                          │  │
│  │ - sessions/live runtimes                            │  │
│  │ - inbox/mail                                        │  │
│  │ - dispatcher/reminders                              │  │
│  │ - authz/audit                                       │  │
│  └──────────────────────────────────────────────────────┘  │
│                 │                          │               │
│                 │                          │               │
│  ┌──────────────▼──────────────┐   ┌──────▼─────────────┐ │
│  │ Internal event bus          │   │ Remote driver API  │ │
│  │ - session events            │   │ - HTTP             │ │
│  │ - task changes              │   │ - WebSocket / SSE  │ │
│  │ - inbox changes             │   │ - auth / pairing   │ │
│  │ - dispatcher/runtime state  │   │ - device registry  │ │
│  └──────────────┬──────────────┘   └──────┬─────────────┘ │
│                 │                          │               │
│     ┌───────────▼──────────┐   ┌──────────▼───────────┐   │
│     │ Tauri desktop adapter │   │ Notification broker │   │
│     └───────────────────────┘   └──────────────────────┘   │
└────────────────────────────────────────────────────────────┘
                          │
          ┌───────────────┴────────────────┐
          │                                │
┌─────────▼─────────┐            ┌─────────▼─────────┐
│ Android / iOS app │            │ Future web client │
│ - tasks           │            │ / tablet client   │
│ - inbox           │            └───────────────────┘
│ - supervisor chat │
│ - session view    │
└───────────────────┘
```

## Host-side backend design

## 1. Internal event bus

### Problem

Current event delivery is tied directly to the main desktop webview.

### Design

Introduce a typed internal event bus inside the backend.

Event producers include:
- session runtime updates
- session lifecycle changes
- task changes
- task-lane transitions
- inbox delivery/read/archive changes
- channel activity worth surfacing to drivers
- dispatcher tick and failure states
- reminder delivery outcomes

Event consumers include:
- Tauri desktop adapter
- remote WebSocket/SSE clients
- notification broker
- diagnostics/logging panels

### Recommended event envelope

```text
id
sequence
timestamp
topic
projectId?
sessionId?
taskId?
inboxDeliveryId?
payload
```

Suggested topics:
- `session.stream.delta`
- `session.updated`
- `task.updated`
- `task.comment.updated`
- `task.assignment.updated`
- `inbox.updated`
- `driver.notification`
- `dispatcher.updated`
- `channel.updated`

### Migration path

Refactor `src-tauri/src/services/app_events.rs` into a thin adapter:
- current behavior becomes one subscriber to the new event bus
- the desktop app keeps receiving `CustomEvent`s, but they are no longer the source of truth

## 2. Per-client subscription tracking

### Problem

Current session subscription state is stored as a per-session boolean-ish flag.

### Design

Track subscriptions per connected client.

Suggested runtime structures:
- `client_id -> connection info`
- `client_id -> subscribed session ids`
- `session_id -> subscribed client ids`

Each client connection should track:
- client id
- device id, if authenticated device-backed
- client kind (`desktop_window`, `mobile_app`, `web_client`, `channel_adapter`)
- authenticated actor
- active project context
- subscribed sessions
- last seen timestamp
- connection metadata

### Result

This enables:
- multiple devices watching the same session
- mobile + desktop coexistence
- fanout without pretending there is only one subscriber
- correct cleanup on disconnect
- future presence UI

## 3. Remote driver HTTP API

### Transport recommendation

Use an async Rust web stack that supports both HTTP and realtime connections cleanly.

Recommended choice:
- `axum`

Why:
- straightforward routing
- good middleware story
- WebSocket support
- aligns well with a future extracted server process

Do **not** build the mobile API on top of the current `tiny_http` bridge.

### API shape

The API should be explicitly structured around operator actions rather than mirroring raw Tauri command names one-for-one.

#### Core endpoint groups

##### Auth / pairing
- `POST /api/v1/pair/start`
- `POST /api/v1/pair/complete`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/logout`
- `GET /api/v1/devices`
- `DELETE /api/v1/devices/:id`

##### Projects
- `GET /api/v1/projects`
- `GET /api/v1/projects/:id`
- `POST /api/v1/projects/:id/select`

##### Tasks
- `GET /api/v1/projects/:id/tasks`
- `GET /api/v1/tasks/:id`
- `GET /api/v1/tasks/:id/comments`
- `POST /api/v1/tasks/:id/comments`
- `POST /api/v1/tasks/:id/approve`
- `POST /api/v1/tasks/:id/needs-work`
- `POST /api/v1/tasks/:id/request-intervention`

##### Inbox / mail
- `GET /api/v1/inbox`
- `GET /api/v1/inbox/:deliveryId`
- `POST /api/v1/inbox/:deliveryId/read`
- `POST /api/v1/inbox/:deliveryId/archive`
- `POST /api/v1/inbox/send`

##### Sessions / supervisor
- `GET /api/v1/sessions`
- `GET /api/v1/sessions/:id`
- `POST /api/v1/sessions/:id/message`
- `POST /api/v1/sessions/:id/stop`
- `GET /api/v1/projects/:id/supervisor`
- `POST /api/v1/projects/:id/supervisor/message`

##### Realtime / diagnostics
- `GET /api/v1/events` (SSE fallback)
- `GET /api/v1/ws` (preferred)
- `GET /api/v1/health`
- `GET /api/v1/app-info`

### API behavior guidelines

- keep existing backend services authoritative
- route API handlers to service-layer functions, not duplicated logic
- preserve project scoping rules already used by the desktop app
- perform backend authz checks for every write/action
- emit structured app events after every meaningful state change

## 4. Realtime protocol

### Recommendation

Use WebSocket as the primary interactive transport.

Reasons:
- session transcript streaming
- live state updates
- efficient multi-topic subscriptions
- future support for presence, typing, and acknowledgements

Support SSE as an optional simpler fallback for read-only consumers if desired.

### WebSocket messages

Suggested client → server messages:
- `auth.authenticate`
- `project.select`
- `session.subscribe`
- `session.unsubscribe`
- `task.subscribe`
- `inbox.subscribe`
- `ping`

Suggested server → client messages:
- `auth.authenticated`
- `subscription.confirmed`
- `event.session.stream.delta`
- `event.session.updated`
- `event.task.updated`
- `event.inbox.updated`
- `event.notification`
- `error`
- `pong`

### Session streaming semantics

The mobile client should be able to:
- subscribe to a session transcript
- receive stream deltas and terminal turn state
- continue to load history via REST if the live connection was interrupted

This should be built on the same runtime events already produced by `live_sessions.rs`, but routed through the event bus.

## 5. Authentication and trust model

## Requirements

A remote mobile client introduces a new security boundary that does not exist for the local Tauri app.

The system needs:
- authenticated devices
- revocable credentials
- operator identity
- backend authorization checks
- audit logs
- optional network-scope restrictions

## Recommended MVP pairing flow

### Pairing start

From the desktop app, the user enables remote access and generates:
- one-time pairing code
- short-lived QR payload
- optional human-readable device label

### Pairing complete

The mobile app submits:
- pairing code / QR secret
- public device metadata
- push token, if available

The host returns:
- device id
- access token or refresh token pair
- default project info
- host capabilities

### Token handling

Store only token hashes on the host.

Recommended tables:
- `remote_devices`
- `remote_device_tokens`
- `remote_device_push_tokens`

Suggested `remote_devices` fields:
- `id`
- `label`
- `platform` (`ios`, `android`)
- `created_at`
- `updated_at`
- `last_seen_at`
- `revoked_at?`
- `default_project_id?`

Suggested `remote_device_tokens` fields:
- `id`
- `device_id`
- `token_hash`
- `created_at`
- `expires_at?`
- `last_used_at?`
- `revoked_at?`

### Network exposure stance

Recommended default for MVP:
- bind only when remote access is explicitly enabled
- optimize for trusted LAN / Tailscale-style access first
- do not assume safe public internet exposure by default

This keeps the first version practical without forcing immediate built-in TLS/public-hosting complexity.

## 6. Authorization model integration

The current authorization model is defined in:
- `docs/authorization-model.md`

Today it focuses on:
- agents
- role instances
- privileged supervisor behavior
- Orchestra tool permissions

The mobile design adds a new class of actor:
- **operator** or **user**

### Recommendation

Introduce a user/operator authorization context alongside existing worker contexts.

Example:
- `actorType = "user"`
- `actorId = "default-user"` for the first implementation

This actor should be able to:
- read projects/tasks/sessions/inbox
- send supervisor messages
- approve / send back work
- send mail
- perform explicit user interventions

Every write path should continue to enforce backend authorization even when called from the mobile API.

## 7. Run-origin and driver-origin tracking

The existing channels implementation already records channel-originated runs using:
- session run origin tracking in `services/channels.rs`

That model should be generalized.

### Recommendation

Generalize run origins to support:
- `source_type = channel`
- `source_type = remote_driver`
- `source_type = desktop_ui`
- `source_type = system`

Suggested additional fields:
- `source_id`
- `source_client_id?`
- `source_device_id?`
- `source_project_id?`

This enables:
- routing supervisor replies back to the correct mobile client if desired
- auditing where actions originated
- better notification and diagnostics

## 8. Notification broker

Mobile is much more valuable if Orchestra can reach out proactively.

### Notification-worthy events

- task requires approval
- task sent back or failed critically
- new user inbox message
- supervisor reply while app is backgrounded
- reminder fired for the user
- critical dispatcher/session failure

### Design

Add a notification broker that subscribes to the internal event bus and decides:
- whether to emit a push notification
- which device(s) should receive it
- whether the event should be coalesced or suppressed

The broker should operate on structured event data rather than scraping message text.

## 9. Host lifecycle and daemon mode

### Problem

If the remote API only exists while the desktop window is open, mobile value is limited.

### Recommendation

Support two host modes:

#### Mode A: desktop-attached server
- easiest MVP
- remote API runs while the Tauri app is open
- suitable for early validation

#### Mode B: background daemon / headless host
- better long-term user experience
- keeps dispatcher, sessions, reminders, and mobile access alive without the desktop window
- better fit for always-on project orchestration

### Design requirement

The remote driver API and event bus should be designed so they can eventually move into an extracted host/server process without rewriting domain logic.

## 10. Desktop integration strategy

The desktop app should continue to work during and after this refactor.

### Recommended path

1. add internal event bus
2. make `app_events.rs` a desktop adapter on top of that bus
3. add remote driver HTTP/WS API against the same services
4. later, optionally move parts of the desktop frontend onto a shared client transport abstraction

This avoids a risky flag-day rewrite.

## Mobile client design

## Client technology recommendation

Recommended stack:
- **React Native + Expo**

Reasons:
- TypeScript alignment with the current frontend stack
- easier shared types/contracts than a native-only stack
- strong push-notification support
- practical cross-platform delivery for iOS + Android
- fast MVP iteration

## Client architecture

The mobile app should use:
- typed API client generated from shared contracts or OpenAPI
- local cache/query layer
- persistent auth/device store
- WebSocket lifecycle manager
- lightweight notification deep-link routing

Recommended client concerns:
- session management / token refresh
- project selection
- task lists and filters
- task detail and approval actions
- inbox views
- supervisor chat and session view
- notification settings

## Mobile MVP feature scope

### Included in MVP

- authenticate/pair with a host
- choose active project
- view task list and task detail
- approve task
- send task back for work
- read/archive inbox items
- send inbox/task mail
- quick supervisor chat per project
- inspect session transcript for the supervisor or selected task lane session
- receive push notifications for intervention-worthy events

### Deferred from MVP

- workflow editor
- agent/role editor
- full session management surface
- embedded terminal UI
- repository creation/management flows
- advanced comment anchoring/file viewers
- deep Settings parity with desktop

## API design details

## Query model

Prefer task/project/inbox endpoints that return shapes optimized for mobile UX rather than leaking raw DB rows.

Examples:
- task list item should already contain status, priority, lane, assignee, and intervention flags
- inbox list item should already contain sender, task reference, priority, unread state, and preview line
- session summaries should include enough state to avoid round-tripping for every list cell

## Command model

Prefer explicit action endpoints over generic arbitrary-command RPC.

Good:
- `POST /tasks/:id/approve`
- `POST /tasks/:id/needs-work`
- `POST /projects/:id/supervisor/message`

Avoid for mobile:
- generic "invoke any Tauri command" endpoint
- direct exposure of tool-bridge commands

## Suggested shared API response examples

### Task summary

```json
{
  "id": "task-123",
  "number": "ORC-52",
  "title": "Implement remote driver API",
  "status": "in_review",
  "priority": "P1",
  "currentLane": {
    "id": "lane-review",
    "name": "Review"
  },
  "assignee": {
    "type": "agent",
    "id": "agent-supervisor",
    "label": "Supervisor"
  },
  "requiresUserAction": true,
  "updatedAt": "2026-04-05T12:00:00Z"
}
```

### Session stream event

```json
{
  "type": "event.session.stream.delta",
  "sequence": 1842,
  "timestamp": "2026-04-05T12:00:05Z",
  "sessionId": "session-abc",
  "runId": "run-xyz",
  "payload": {
    "deltaType": "assistant_text",
    "text": "I investigated the current architecture..."
  }
}
```

## Data-model additions

The mobile design does **not** require changing the host-side session storage model.

Existing session storage under:
- `docs/session-storage.md`
- `src-tauri/src/services/pi_sessions.rs`

remains valid.

### New persistent tables likely needed

- `remote_devices`
- `remote_device_tokens`
- `remote_device_push_tokens`
- `remote_pairing_codes`
- optional: `remote_device_preferences`

### Existing runtime state needing redesign

Current in-memory state in `src-tauri/src/state.rs` should evolve to include:
- connected remote clients
- per-client subscriptions
- per-session subscriber counts
- optional event sequence tracking

## Implementation plan

## Phase 0 — design and contracts

### Deliverables
- finalize remote-driver terminology and scope
- choose auth and transport stack
- define API resources and realtime event schema
- choose mobile stack and shared type strategy

### Acceptance criteria
- approved design doc
- endpoint inventory mapped to existing services
- security stance documented

## Phase 1 — backend event bus foundation

### Deliverables
- add internal typed event bus
- refactor session/task/inbox change producers to publish to it
- adapt current desktop `app_events.rs` to subscribe and continue dispatching webview events

### Acceptance criteria
- desktop app behavior remains unchanged
- backend events are no longer webview-only internally
- tests prove task/session/inbox events reach the bus

## Phase 2 — remote API server MVP

### Deliverables
- add authenticated HTTP server to the host
- expose read endpoints for projects/tasks/inbox/sessions
- expose write endpoints for supervisor messaging, task approval, needs-work, and inbox actions
- add WebSocket event stream

### Acceptance criteria
- a non-desktop client can authenticate and fetch project/task/inbox/session data
- a non-desktop client can send a supervisor message and receive the response through the API/event stream
- multiple clients can connect concurrently without breaking the desktop app

## Phase 3 — pairing and device management

### Deliverables
- one-time pairing flow
- persisted trusted-device registry
- token issuance, revocation, and rotation
- push-token registration endpoints

### Acceptance criteria
- user can pair a device from the desktop app
- revoked devices immediately lose access
- audit logs show operator/device actions

## Phase 4 — mobile app MVP

### Deliverables
- React Native/Expo app
- project switcher
- task list/detail
- inbox list/detail/actions
- supervisor quick-chat
- session transcript viewer

### Acceptance criteria
- user can direct a host Orchestra instance from Android or iOS
- common triage flows do not require opening the desktop app
- mobile UI stays coherent under live updates

## Phase 5 — push notifications and background host support

### Deliverables
- notification broker
- APNs / FCM integration
- host background/daemon mode planning and first implementation

### Acceptance criteria
- important events arrive as push notifications
- remote access remains available when the desktop window is not focused, and later when it is not open at all

## Phase 6 — convergence and expansion

### Deliverables
- shared API contracts across desktop and mobile clients
- optional web/tablet client support
- richer task/session actions from mobile
- improved mobile-specific diagnostics and presence

## Testing strategy

## Backend tests

Add Rust coverage for:
- event bus fanout
- per-client subscription tracking
- auth token validation and revocation
- pairing flows
- supervisor message roundtrip through the remote API
- task approval / needs-work / inbox action APIs
- device push-token registration

## Desktop regression coverage

Ensure existing desktop coverage still passes after the event-bus refactor.

Specifically verify:
- session streaming still reaches the desktop UI
- task change events still refresh task views
- inbox change events still refresh inbox views

## Mobile/API integration tests

Add integration tests that spin up a real Orchestra host and verify:
- API auth
- project/task/inbox reads
- supervisor message flow
- realtime websocket subscriptions
- multi-client coexistence

## Mobile app tests

For the mobile client, prefer:
- component/screen tests for local rendering
- contract tests against recorded API shapes
- end-to-end mobile flows with a real host test environment

## Risks and mitigations

### Risk: desktop-specific assumptions leak into the API

Mitigation:
- force all remote endpoints through service-layer functions
- keep Tauri-only code in adapters, not domain logic

### Risk: realtime session streaming gets complicated with many clients

Mitigation:
- centralize stream fanout in a single event bus and subscription registry
- keep runtime prompt serialization rules unchanged
- treat fanout as observer complexity, not execution complexity

### Risk: public-network exposure increases security burden

Mitigation:
- default to explicit opt-in remote access
- optimize first for trusted LAN / Tailscale-like networks
- store only hashed tokens
- support device revocation from day one

### Risk: trying to clone the full desktop app on mobile bloats scope

Mitigation:
- keep mobile MVP focused on supervisor, tasks, inbox, approvals, and notifications
- defer editor/admin surfaces

### Risk: host availability is poor without daemon mode

Mitigation:
- make server mode extractable from the start
- accept desktop-attached server for MVP, then prioritize daemon mode

## Open questions

- Should remote access in MVP assume LAN/Tailscale only, or ship built-in TLS/public-host support immediately?
- Should the first mobile release assume a single human operator, or support multiple named users/devices from the start?
- Should mobile supervisor chat always route through the canonical per-project supervisor session, or support direct subscription to arbitrary worker sessions for sending input?
- How much of task comments and anchored file-reference UX should mobile support in v1?
- Should the future desktop app eventually talk to the same HTTP/WS client transport for maximum convergence, or only share backend services/contracts?

## Recommendation

Build mobile support by adding a first-class **remote driver API** to the Orchestra host and then building a dedicated mobile client on top of it.

Concretely:
- do **not** port the current app to Tauri mobile as the main strategy
- do **not** expose the current tool bridge as the public API
- do **not** model mobile only as a Telegram-like channel transport

Instead:
- add an internal backend event bus
- add an authenticated HTTP + WebSocket control plane
- add per-client subscription tracking
- add trusted-device pairing and push-notification support
- build a focused Android/iOS operator client against that API

That path best matches Orchestra's current architecture, preserves host-side execution where it belongs, and gives the product a clean foundation for future remote clients beyond mobile.
