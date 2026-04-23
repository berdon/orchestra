# ORC-57 shared `OrchestraClient` contract plan

## Problem summary

The current frontend talks to Orchestra through a mix of direct helper modules:

- `src/lib/tauri.ts`
- `src/lib/projects.ts`
- `src/lib/agents.ts`
- `src/lib/roles.ts`
- other desktop-oriented helper files under `src/lib/`

That works for the current Tauri-hosted desktop app, but it leaves three important gaps for the ORC-56 shared-frontend epic:

1. there is no single frontend-facing client boundary that both a Tauri adapter and a remote API adapter can implement
2. task/inbox/session event delivery is split across ad hoc browser `CustomEvent` helpers instead of one typed shared union
3. the app root has no canonical bootstrap + injection seam where a chosen host client can be selected and provided to shared React code

The result is too much guesswork for follow-on adapter and screen migration work.

## Design goals

1. Define one host-agnostic `OrchestraClient` surface for the shared frontend.
2. Keep the first shared contract focused on the cross-host product surface, not every desktop-only shell affordance.
3. Reuse existing DTOs where they are already correct, but curate them behind a single contract entrypoint.
4. Normalize realtime delivery into one explicit event union.
5. Make host kind, auth mode, URLs, contract version, and feature availability part of a single bootstrap payload.
6. Define one normalized frontend error shape so adapters map transport/native failures consistently.
7. Add a React provider/context seam at the app root so future migrations can stop importing host helpers directly.

## Shared-surface boundary

The shared contract in this phase should cover the frontend surface that a browser-served remote client and the existing desktop-hosted client can both reasonably implement:

- app bootstrap / client error reporting
- project + workflow + assignee catalog reads needed by shared screens
- task list/detail/mutation flows
- inbox list/send/read/archive flows
- session list/detail/message/model/control flows
- task/inbox/session/session-stream event delivery

The following remain **outside** the shared surface for now and should stay behind desktop-specific helpers until a later ticket explicitly pulls them in:

- logs window management
- agent terminal window control
- desktop-only system notification affordances
- harness/runtime settings that only make sense in the local shell
- channel administration / remote-access administration / other operator-only shell setup panels

That split follows the ORC-56 epic note to keep desktop-only shell/admin affordances separate from the shared cross-host interface.

## Proposed file layout

Add a dedicated contract area under `src/lib/orchestraClient/`:

- `src/lib/orchestraClient/bootstrap.ts`
  - contract version constant
  - host kind + auth mode
  - transport URL shape
  - feature flags + capability descriptors
  - bootstrap payload
- `src/lib/orchestraClient/events.ts`
  - canonical task/inbox/session/session-stream delivery union
- `src/lib/orchestraClient/errors.ts`
  - normalized frontend error shape + HTTP/status mapping helpers
- `src/lib/orchestraClient/client.ts`
  - canonical `OrchestraClient` interface
  - domain service module interfaces
  - curated DTO re-exports for the shared frontend surface
- `src/lib/orchestraClient/defaultClient.ts`
  - default Tauri/mock-backed adapter that wraps the existing helper layer
- `src/lib/orchestraClient/provider.tsx`
  - provider/context/hooks for client injection + bootstrap access
- `src/lib/orchestraClient/index.ts`
  - public entrypoint for the contract package

## Canonical `OrchestraClient` boundary

The shared client should be modular instead of a single flat bag of functions.

### Top-level shape

```ts
interface OrchestraClient {
  readonly contractVersion: OrchestraClientContractVersion;
  getBootstrap(): Promise<OrchestraClientBootstrap>;
  readonly app: OrchestraAppService;
  readonly catalog: OrchestraCatalogService;
  readonly tasks: OrchestraTaskService;
  readonly inbox: OrchestraInboxService;
  readonly sessions: OrchestraSessionService;
  readonly events: OrchestraEventService;
}
```

### Module responsibilities

#### `app`

Purpose:
- fetch app/runtime display info for the shell
- report client-side failures through the host adapter

Initial methods:
- `getInfo()`
- `reportError(target, error, fallback)`

#### `catalog`

Purpose:
- provide shared read-only supporting data needed by tasks/inbox/session flows

Initial methods:
- `listProjects()`
- `getProject(projectId)`
- `listAgents(includeArchived?, projectId?)`
- `listRoles(includeArchived?)`
- `listWorkflows(includeArchived?)`
- `getWorkflow(workflowId)`

#### `tasks`

Purpose:
- own task CRUD, workflow transition, schedule, comment, todo, file, dependency, and task-scoped mailbox reads

Initial methods include:
- task list/detail/create/update/delete
- todo list/add/finish/reopen/delete
- comment list/add/update/delete/mark-read/search-file-mentions
- file reference list/add/default/remove + file content read
- attachment add/remove
- dependency add/remove
- task schedule list/detail/create/update/delete
- task-scoped mailbox reads
- workflow transitions:
  - `dispatch(...)`
  - `complete(..., outcome)`
  - `approveReview(...)`
  - `approveCompletion(...)`
  - `markNeedsWork(...)`
  - `resume(...)`
  - `pause(...)`
  - `stopActivity(...)`
  - `reassign(...)`
  - `manualWhip(...)`
  - `resetRuntime(...)`

#### `inbox`

Purpose:
- own user/operator mailbox flows that are not task-detail specific

Initial methods:
- `list(projectId?, includeArchived?)`
- `send(input)`
- `markRead(input)`
- `archive(input)`

#### `sessions`

Purpose:
- own session listing, transcript/message delivery, runtime details, model selection, and session-control actions

Initial methods:
- session list/detail
- runtime details + stats
- create/delete/resume/subscribe/unsubscribe
- stop runtime
- get/set model
- compact/reload
- send message
- create contextual successor session

#### `events`

Purpose:
- provide one subscription surface that normalizes all shared frontend event delivery

Initial method:
- `subscribe(handler)`

The adapter can internally fan this out from browser `CustomEvent`s, WebSocket events, SSE, polling, or any other transport, but consumers should only depend on the unified delivery union.

## Shared DTO contract strategy

`src/types.ts` already contains most of the DTOs the frontend needs. The missing piece is not raw type availability; it is the lack of a curated contract surface.

For ORC-57, the canonical shared DTO contract should be the curated re-export list in `src/lib/orchestraClient/client.ts`.

That means follow-on adapters and migrated screens should import shared DTOs from the contract layer instead of reaching into `src/types.ts` directly for discovery.

Initial curated DTO surface includes:

- `AppInfo`
- `ProjectSummary`, `ProjectDetail`
- `AgentSummary`, `RoleSummary`
- `WorkflowSummary`, `WorkflowDefinition`
- `TaskSummary`, `TaskDetail`, `TaskUpsertInput`
- `TaskTodo`, `TaskTodoInput`
- `TaskComment`, `TaskCommentInput`, `TaskCommentUpdateInput`
- `TaskFileReference`, `TaskFileReferenceInput`
- `TaskAttachment`, `TaskAttachmentInput`
- `TaskDependency`
- `TaskScheduleSummary`, `TaskScheduleDetail`, `TaskScheduleUpsertInput`
- `MailboxMessage`, mailbox send/read/archive inputs
- `SessionRecord`, `SessionRuntimeDetails`, `SessionStats`, `SessionModelState`, `QueuedSessionMessage`
- `TaskListOptions`

This keeps the contract explicit without forcing a risky wholesale rewrite of all DTO definitions in the same ticket.

## Shared event union

The shared event union should be transport-agnostic and discriminated by `kind`:

```ts
type OrchestraClientEvent =
  | (SessionChangeEvent & { kind: "session.change" })
  | (SessionStreamEnvelope & { kind: "session.stream" })
  | (TaskChangeEvent & { kind: "task.change" })
  | (InboxChangeEvent & { kind: "inbox.change" });
```

### Why this shape

- it preserves the existing payload fields the UI already understands
- it adds a stable discriminant for shared consumers and adapter implementations
- it keeps the initial migration cheap because Tauri `CustomEvent` payloads can be wrapped directly
- it gives the remote adapter a clear target for WebSocket/SSE mapping

### Delivery mapping expectations

Current desktop event sources map as follows:

- browser `orchestra:session-change` → `kind: "session.change"`
- browser `orchestra:session-stream` → `kind: "session.stream"`
- browser `orchestra:task-change` → `kind: "task.change"`
- browser `orchestra:inbox-change` → `kind: "inbox.change"`

Remote adapter expectation:
- map backend realtime events into the same union before any React consumer sees them
- do not leak transport-specific envelope shapes into shared screens

## Capability model and bootstrap payload

The bootstrap payload is the contract the app root reads before or while rendering shared UI.

### Canonical bootstrap shape

```ts
interface OrchestraClientBootstrap {
  contractVersion: "2026-04-22";
  bootstrappedAt: string;
  hostKind: "tauri" | "remote_api" | "mock";
  authMode: "desktop_session" | "bearer_token" | "none";
  urls: {
    apiBaseUrl: string | null;
    websocketUrl: string | null;
  };
  featureFlags: OrchestraClientFeatureFlags;
  capabilities: OrchestraClientCapabilities;
  appInfo: AppInfo | null;
}
```

### Required bootstrap fields

#### `contractVersion`

Use a single explicit contract version string.

Recommendation for this first cut:
- `"2026-04-22"`

Rationale:
- easy to compare at runtime
- obvious breaking-change bump point
- readable in logs/debug output

#### `hostKind`

Initial host kinds:
- `tauri`
- `remote_api`
- `mock`

#### `authMode`

Initial auth modes:
- `desktop_session`
- `bearer_token`
- `none`

#### `urls`

Always include:
- `apiBaseUrl`
- `websocketUrl`

For Tauri and local mock adapters these are currently `null`.
For remote API adapters they should be explicit.

#### `featureFlags`

Use booleans for broad UI availability checks.

Initial flags:
- `sharedCatalog`
- `sharedTasks`
- `sharedInbox`
- `sharedSessions`
- `taskSchedules`
- `sessionStreaming`
- `sessionControls`
- `taskComments`
- `taskFiles`
- `desktopWindows`
- `agentTerminal`

#### `capabilities`

Use nested descriptors for more specific enable/disable reasons.
Each leaf should be:

```ts
{
  availability: "available" | "unavailable" | "unknown";
  reason?: string | null;
}
```

This is more expressive than booleans for adapters that need to explain why a button or control is disabled.

## Normalized frontend error model

Adapters should normalize native/transport failures into one frontend shape before shared screens consume them.

### Canonical error shape

```ts
interface OrchestraClientErrorShape {
  name: "OrchestraClientError";
  code:
    | "unknown"
    | "validation"
    | "unauthorized"
    | "forbidden"
    | "not_found"
    | "conflict"
    | "rate_limited"
    | "unavailable"
    | "timeout"
    | "cancelled"
    | "network"
    | "transport"
    | "unsupported";
  message: string;
  userMessage?: string | null;
  retryable: boolean;
  status?: number | null;
  source: "adapter" | "tauri" | "remote_api" | "mock" | "frontend";
  operation: string;
  details?: JsonValue | null;
}
```

### Mapping expectations

#### Tauri/native adapter

- Tauri invoke failures should be mapped at the adapter boundary
- the adapter should set `source: "tauri"`
- if a native/domain error can be classified, map it to the closest canonical `code`
- otherwise use `code: "unknown"`

#### Remote HTTP adapter

Recommended status mapping:

- `400` / `422` → `validation`
- `401` → `unauthorized`
- `403` → `forbidden`
- `404` → `not_found`
- `409` → `conflict`
- `429` → `rate_limited`
- `408` → `timeout`
- `502` / `503` / `504` → `unavailable`
- `501` → `unsupported`
- network failures before a response → `network` or `transport`

#### WebSocket / realtime adapter

- disconnected socket before delivery → `transport`
- explicit timeout waiting for ack/subscription → `timeout`
- server says feature missing → `unsupported`

The important rule is that shared React consumers should not need to know whether a failure started as an HTTP status, a Tauri invoke rejection, or a mock adapter exception.

## Provider/context/bootstrap seam

The app needs one canonical place where a chosen `OrchestraClient` is injected.

### React seam

Add `src/lib/orchestraClient/provider.tsx` with:

- `OrchestraClientProvider`
- `useOrchestraClient()`
- `useOrchestraBootstrap()`

Provider behavior:
- accept an optional pre-resolved `binding` (`{ client, bootstrap }`)
- if none is supplied, build the default Tauri/mock binding
- resolve/bootstrap asynchronously without blocking the app forever
- make both the client and the bootstrap payload available through context

### App-root wiring

Wire the provider at the root in `src/main.tsx`:

```tsx
<OrchestraClientProvider>
  <App />
</OrchestraClientProvider>
```

This creates the single canonical bootstrap/injection seam.

### Initial in-app proof point

Use the new seam in `src/App.tsx` for app bootstrap reads:

- `useOrchestraBootstrap()` seeds initial `appInfo`
- `useOrchestraClient().app.getInfo()` refreshes app info

That is intentionally small but important: it proves the seam is real without forcing the whole app to migrate in one planning ticket.

## Default adapter expectations

`src/lib/orchestraClient/defaultClient.ts` should wrap the current helper layer and act as the reference implementation for the contract.

Responsibilities:
- expose the canonical service-module shape
- wrap current task/inbox/session/catalog reads and writes
- unify event delivery through `events.subscribe(...)`
- provide the initial optimistic bootstrap for the desktop/mock app

This is the compatibility bridge that lets follow-on work migrate screens incrementally.

## Follow-on implementation guidance

After ORC-57, the expected sequence is:

1. implement a dedicated remote API adapter that satisfies the same `OrchestraClient` contract
2. move shared screen/hooks imports from direct host helpers to `useOrchestraClient()`
3. normalize adapter error handling at the contract boundary
4. expand bootstrap sourcing for remote-hosted entrypoints so `apiBaseUrl`, `websocketUrl`, auth, and feature availability come from the real host bootstrap payload
5. keep desktop-only shell/admin helpers outside the shared client until they have a clear cross-host product story

## Files changed for this plan

- `docs/orc-57-orchestraclient-contract-plan.md`
- `src/lib/orchestraClient/bootstrap.ts`
- `src/lib/orchestraClient/events.ts`
- `src/lib/orchestraClient/errors.ts`
- `src/lib/orchestraClient/client.ts`
- `src/lib/orchestraClient/defaultClient.ts`
- `src/lib/orchestraClient/provider.tsx`
- `src/lib/orchestraClient/index.ts`
- `src/main.tsx`
- `src/App.tsx`

## Acceptance-criteria check

- **Both the Tauri and Remote API implementations can build against the defined contract without major guesswork**
  - yes: one `OrchestraClient` interface, one bootstrap model, one event union, one error shape, and one curated DTO surface are now explicit
- **The app has one canonical bootstrap and injection seam for `OrchestraClient`**
  - yes: `OrchestraClientProvider` now wraps the app root in `src/main.tsx`
- **Event, capability, bootstrap, and error shapes are explicit and reusable across adapters**
  - yes: each has a dedicated contract file under `src/lib/orchestraClient/`
- **The contract is documented clearly enough for follow-on implementation tickets to consume directly**
  - yes: this plan plus the contract source files define the expected shapes, scope, and migration direction
