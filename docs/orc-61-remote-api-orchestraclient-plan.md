# ORC-61 `RemoteApiOrchestraClient` implementation plan

## tl;dr

- Rebase or merge ORC-57, ORC-59, and ORC-62 into the implementation branch first; this task should build on their contract, bootstrap, and remote-route work rather than recreating it.
- Replace the ORC-59 hosted-web placeholder binding with a real `RemoteApiOrchestraClient` backed by one shared HTTP JSON wrapper and one shared WebSocket event/session-stream manager.
- Treat the bootstrap payload as the single source of truth for contract version, endpoint discovery, auth mode, feature flags, and capability gating.
- Normalize every HTTP, WebSocket, auth, and capability failure into `OrchestraClientError` before any shared React code sees it.
- Keep explicit session stream behavior inside the adapter: `sessions.subscribe/unsubscribe` should coordinate the HTTP route and the WebSocket subscription confirmation so screens never touch transport details.

## Executive summary

ORC-57 defined the shared `OrchestraClient` contract, ORC-59 added the hosted-web bootstrap/auth seam plus a placeholder browser binding, and ORC-62 expanded the remote API/websocket surface to match that contract. ORC-61 is the client-side adapter ticket that closes the loop: the hosted-web path should stop returning unsupported proxy services and instead expose the same shared client surface as the desktop/Tauri path.

The main design requirement is to keep transport mechanics fully inside the adapter. React screens should call `client.tasks.*`, `client.sessions.*`, and `client.events.subscribe(...)` exactly the same way regardless of host. That means the remote adapter needs to own four concerns centrally:

1. bootstrap validation and capability gating
2. HTTP request/response and auth handling
3. WebSocket lifecycle, topic normalization, and explicit session-stream subscription state
4. error normalization across HTTP, socket, auth, and unsupported-capability failures

One current-state note: this task worktree predates the completed ORC-57/59/62 branches, so implementation should begin by rebasing/merging those dependency changes or their merged equivalent before coding against the shared client seam.

## Current repo footing from dependency work

### ORC-57

Expected shared frontend contract/files:

- `src/lib/orchestraClient/bootstrap.ts`
- `src/lib/orchestraClient/client.ts`
- `src/lib/orchestraClient/events.ts`
- `src/lib/orchestraClient/errors.ts`
- `src/lib/orchestraClient/defaultClient.ts`
- `src/lib/orchestraClient/provider.tsx`

Relevant contract facts:

- contract version is explicit
- host kind includes `remote_api`
- auth mode includes hosted-web negotiation values
- events are normalized to:
  - `task.change`
  - `session.change`
  - `session.stream`
  - `inbox.change`
- `OrchestraClientError` is the shared error target

### ORC-59

Expected hosted-web bootstrap seam:

- `src/lib/orchestraClient/hostedWeb.ts`
- `src/main.tsx`

Relevant behavior:

- hosted web fetches `/api/v1/frontend/bootstrap` before render
- the current hosted-web binding is an intentional placeholder that throws for all remote domain services
- bootstrap now carries `same_origin_cookie | bearer_token | none`

### ORC-62

Expected remote API surface:

- `/api/v1/client-errors` exists for browser-side error reporting
- shared-domain HTTP routes now exist for the `OrchestraClient` surface
- WebSocket delivery translates hosted-web clients onto shared event topics
- WebSocket control messages support explicit session subscribe/unsubscribe confirmation

## Proposed implementation shape

## 1. Add a dedicated remote adapter module

Recommended layout:

- `src/lib/orchestraClient/remoteApiClient.ts`
  - public factory for `RemoteApiOrchestraClient`
  - service-module assembly for `app`, `catalog`, `tasks`, `inbox`, `sessions`, `events`
- `src/lib/orchestraClient/remoteApiTransport.ts`
  - JSON request helper
  - auth/header/credentials handling
  - capability guards
  - HTTP error normalization helpers
- `src/lib/orchestraClient/remoteApiEvents.ts`
  - lazy WebSocket manager
  - websocket message parsing
  - remote envelope -> shared event mapping
  - session subscription confirmation tracking

If the implementation ends up easier with a `remoteApi/` subfolder instead of flat files, keep the same boundaries.

## 2. Replace the hosted-web placeholder binding

`src/lib/orchestraClient/hostedWeb.ts` should stop building unsupported proxy services and instead create a real remote binding.

Recommended factory shape:

```ts
createRemoteApiOrchestraClientBinding(
  bootstrap: OrchestraClientBootstrap,
  options?: {
    fetchImpl?: typeof fetch;
    webSocketFactory?: (url: string) => WebSocket;
    getBearerToken?: () => string | null | undefined;
  },
): OrchestraClientBinding
```

Why include an optional bearer-token getter even though hosted web is cookie-first:

- ORC-59 keeps `bearer_token` as an explicit remote auth mode
- it allows test coverage and paired/device-style browser contexts to reuse the same adapter
- it prevents a second remote adapter from appearing later just for alternate auth transport

## 3. Make bootstrap the authoritative runtime contract

The remote adapter should validate bootstrap up front:

- `hostKind` must be `remote_api`
- `contractVersion` must match the shared frontend constant
- `urls.apiBaseUrl` must exist for any HTTP-backed service call
- `urls.websocketUrl` must exist before realtime/session-stream behavior is attempted

Use bootstrap capabilities in two ways:

1. expose them unchanged via `client.getBootstrap()`
2. preflight guarded operations and throw normalized `unsupported` errors before hitting obviously unavailable routes

That keeps the UI from learning capability truth by tripping over transport failures.

## HTTP transport plan

## Request helper rules

Use one JSON helper for all remote service calls.

Responsibilities:

- resolve request URL from `bootstrap.urls.apiBaseUrl`
- attach `Accept: application/json`
- attach `Content-Type: application/json` when sending JSON
- auth handling:
  - `same_origin_cookie` -> `credentials: "same-origin"`, no bearer header by default
  - `bearer_token` -> `Authorization: Bearer ...`, `credentials: "omit"`
  - `none` -> allow only bootstrap/app-info style reads; protected calls should fail fast as auth/capability errors
- parse JSON success bodies
- parse JSON or text error bodies for better normalized messages/details
- convert all failures through `normalizeOrchestraClientError(...)`

## Representative route mapping

The adapter should map the shared client surface directly onto the ORC-62 routes.

| Client surface | Remote route shape |
| --- | --- |
| `app.getInfo` | `GET /api/v1/app-info` |
| `app.reportError` | `POST /api/v1/client-errors` |
| `catalog.*` | `/api/v1/projects`, `/api/v1/projects/:id`, `/api/v1/agents`, `/api/v1/roles`, `/api/v1/workflows`, `/api/v1/workflows/:id` |
| `tasks.list/get/create/update/remove` | `/api/v1/tasks`, `/api/v1/tasks/:task_id` |
| task todos | `/api/v1/tasks/:task_id/todos`, `/api/v1/tasks/:task_id/todos/unfinished`, `/api/v1/task-todos/:todo_id/*` |
| task comments | `/api/v1/tasks/:task_id/comments`, `/api/v1/tasks/:task_id/comments/read`, `/api/v1/task-comments/:comment_id`, `/api/v1/tasks/:task_id/comment-file-mentions` |
| task dependencies/files/attachments | `/api/v1/task-dependencies`, `/api/v1/tasks/:task_id/file-references`, `/api/v1/task-file-references/:reference_id/*`, `/api/v1/task-file-content`, `/api/v1/tasks/:task_id/attachments` |
| task schedules | `/api/v1/task-schedules`, `/api/v1/task-schedules/:schedule_id` |
| task transitions | `/api/v1/tasks/:task_id/dispatch`, `/approve-review`, `/approve-completion`, `/complete/*`, `/needs-work`, `/resume`, `/pause`, `/stop-activity`, `/reassign`, `/manual-whip`, `/reset-runtime` |
| `inbox.*` | `/api/v1/inbox`, `/api/v1/inbox/send`, `/api/v1/inbox/read`, `/api/v1/inbox/archive` |
| `sessions.*` | `/api/v1/sessions`, `/api/v1/sessions/:id`, `/runtime`, `/stats`, `/contextual`, `/resume`, `/subscribe`, `/unsubscribe`, `/model`, `/compact`, `/reload`, `/stop`, `/message` |

The important implementation rule is not the exact helper naming; it is that feature components only see the shared `OrchestraClient` contract and never raw `fetch(...)`, URLs, or WebSocket message formats.

## WebSocket/event plan

## One shared socket manager per remote client

Use a lazy WebSocket manager that:

- connects on first `events.subscribe(...)` or first session-stream subscription request
- fan-outs decoded events to local subscribers
- tracks pending subscription confirmations
- tracks currently subscribed session ids so they can be replayed if the socket reconnects

ORC-63 will own the richer reconnect/offline UX. ORC-61 only needs enough socket lifecycle management to avoid silent transport leakage and to keep session stream semantics correct.

## Incoming message handling

The manager should understand these remote message types:

- `connected`
- `subscription.confirmed`
- `event`
- `error`
- `pong`

For `event`, map the backend envelope into the ORC-57 shared union before delivering it.

### Topic normalization rule

Accept both shared and legacy aliases so the adapter remains resilient across hosted-web and bearer-token remote contexts:

- `task.change` or `task.updated` -> `kind: "task.change"`
- `session.change` or `session.updated` -> `kind: "session.change"`
- `inbox.change` or `inbox.updated` -> `kind: "inbox.change"`
- `session.stream` -> `kind: "session.stream"`

The adapter should treat the remote envelope as internal transport data. React code should only receive the shared event payloads.

## Explicit session subscription behavior

`client.sessions.subscribe(sessionId)` and `client.sessions.unsubscribe(sessionId)` should own both halves of remote session-stream behavior:

1. call the HTTP route (`/subscribe` or `/unsubscribe`) so the shared service method returns the canonical `SessionRecord`
2. ensure the WebSocket is connected
3. send `session.subscribe` or `session.unsubscribe`
4. wait for the matching `subscription.confirmed` frame
5. resolve only after both the HTTP mutation and socket confirmation are complete

Why this is the right boundary:

- the shared client contract already exposes explicit subscribe/unsubscribe methods
- the backend already separates resource semantics from socket confirmation
- it prevents screens from having to manually coordinate REST + socket messages

`events.subscribe(...)` itself should not implicitly subscribe every session stream. Global task/session/inbox change delivery can flow immediately, while `session.stream` remains opt-in through the explicit session methods.

## Error normalization plan

## HTTP failures

Use `mapHttpStatusToOrchestraClientErrorCode(...)` from `errors.ts` as the base mapping.

Additional adapter rules:

- `AbortError` -> `cancelled`
- fetch/network failure before a response -> `network`
- malformed JSON on a success/error path -> `transport`
- contract-version mismatch -> `unsupported`
- bootstrap missing a required remote URL -> `unsupported`

## WebSocket failures

Normalize these cases centrally:

- failure to connect/open -> `transport`
- explicit backend `error` frame that indicates auth -> `unauthorized` or `forbidden`
- timeout waiting for `subscription.confirmed` -> `timeout`
- unexpected socket close after a previously healthy connection -> `transport`
- unsupported topic/message shape -> `transport`

A practical rule for auth classification: let HTTP routes be the primary auth signal, and only classify raw socket problems as auth failures when the backend gives an explicit auth-shaped error. Otherwise treat them as transport failures.

## Capability failures

When bootstrap says a surface is unavailable, fail before transport with:

- `code: "unsupported"`
- `source: "adapter"` or `"remote_api"` depending on the context
- `operation` set to the shared client method name
- `details` including the relevant capability descriptor and bootstrap host/auth metadata

That keeps unsupported remote surfaces from showing up as misleading 404 or generic network errors.

## Recommended delivery order

### Slice 1 — transport foundation

- merge/rebase ORC-57/59/62 outputs into the branch
- add remote bootstrap validation
- add shared HTTP wrapper + normalized auth handling
- add tests for cookie vs bearer behavior and HTTP error normalization

### Slice 2 — service-module coverage

- implement `app`, `catalog`, `tasks`, `inbox`, and `sessions` against the ORC-62 routes
- replace the hosted-web placeholder binding with the real remote client
- update hosted-web bootstrap tests so remote methods no longer throw the ORC-61 placeholder error

### Slice 3 — realtime and session streams

- add the lazy WebSocket manager
- map remote envelopes into shared event deliveries
- implement explicit session subscribe/unsubscribe confirmation handling
- add tests for topic normalization, subscription ack timeouts, and stream delivery

### Slice 4 — polish and validation

- add representative contract-smoke tests for a few methods from each service module
- verify capability-gated operations fail as normalized unsupported errors
- verify `app.reportError` uses `/api/v1/client-errors` when available and degrades safely when not

## Validation plan

Add or update frontend tests for:

- hosted-web bootstrap binding now creates a real remote client
- `same_origin_cookie` requests use `credentials: "same-origin"`
- `bearer_token` requests attach `Authorization: Bearer ...`
- HTTP status normalization for `401/403/404/409/429/503`
- network and abort normalization
- WebSocket topic alias normalization
- `sessions.subscribe/unsubscribe` waits for `subscription.confirmed`
- `session.stream` delivery only arrives after explicit subscription
- capability-gated operations fail with `unsupported` before transport when bootstrap says unavailable

## Files likely touched during implementation

- `docs/orc-61-remote-api-orchestraclient-plan.md`
- `src/lib/orchestraClient/hostedWeb.ts`
- `src/lib/orchestraClient/index.ts`
- `src/lib/orchestraClient/remoteApiClient.ts`
- `src/lib/orchestraClient/remoteApiTransport.ts`
- `src/lib/orchestraClient/remoteApiEvents.ts`
- `tests/orchestra-client-hosted-web.test.ts`
- new remote-adapter tests, e.g. `tests/orchestra-client-remote-api.test.ts`

## Acceptance-criteria check

- **The browser-hosted frontend can obtain the same shared client surface as Tauri-backed screens**
  - yes, by replacing the hosted-web proxy binding with a real `RemoteApiOrchestraClient`
- **Remote transport details stay inside the adapter instead of feature components**
  - yes, by centralizing fetch/WebSocket/auth/capability logic in remote adapter modules
- **Errors, capabilities, and events are normalized to the shared contract**
  - yes, by validating bootstrap, preflighting capabilities, mapping HTTP/socket failures through `OrchestraClientError`, and translating remote event envelopes into the ORC-57 event union
