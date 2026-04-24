# ORC-63 offline, reconnect, loading, and error UX normalization plan

## tl;dr

- Build ORC-63 on top of the landed ORC-60 shared-screen data layer and ORC-61 hosted-web adapter, not by adding more page-local booleans.
- Extend the shared client boundary with explicit connection state plus consistent adapter-side error normalization for Tauri/mock and remote API paths.
- Push initial-load, background-refresh, mutation-pending, degraded-live, reconnecting, and fully-offline state into shared `orchestraData` hooks.
- Surface one shared UX pattern across tasks, inbox, and sessions/chat: cached content can stay visible, live degradation must be obvious, retryable failures get retry affordances, and unsupported capability failures stop looking like generic transport errors.
- Normalize retries centrally: bounded automatic retry for idempotent reads, explicit/manual retry for non-idempotent writes, and visible exponential-backoff reconnect for live session/event streams.

## Executive summary

ORC-60 and ORC-61 finished the important structural work: shared React screens now read through `useOrchestraClient()` / `src/lib/orchestraData/*`, and hosted web has a real `RemoteApiOrchestraClient` with HTTP/WebSocket normalization. What is still missing is the user-facing state model above that boundary.

Today the contract already has `OrchestraClientError`, capabilities, and a shared event surface, but the product mostly throws that information away before it reaches the UI. `TasksPage`, `InboxPage`, and the session workspace in `App.tsx` still reduce failures to plain strings and loading to local booleans; background refreshes are mostly silent; and `remoteApiEvents.ts` reconnects quietly after socket close with no visible degraded/offline signal. ORC-63 should close that gap by making connection health, retryability, degraded live state, and capability/unsupported failures first-class shared UI inputs instead of adapter internals.

## Current findings

- The shared error taxonomy exists in `src/lib/orchestraClient/errors.ts`, but product-facing flows rarely consume it directly.
  - pages mostly store `string | null` error state
  - `app.reportError(...)` returns a string message, so `code`, `retryable`, `source`, and capability context are lost before rendering
- The remote adapter already normalizes HTTP/WebSocket failures in:
  - `src/lib/orchestraClient/remoteApiTransport.ts`
  - `src/lib/orchestraClient/remoteApiEvents.ts`
- Tauri/mock service bindings do **not** yet normalize transport failures into the shared client error model consistently.
  - `src/lib/orchestraClient/tauriBindings.ts` still calls raw `invoke(...)`
  - `src/lib/orchestraClient/mockBindings.ts` mostly forwards legacy helper behavior
- The ORC-60 data layer gives a good seam for this ticket:
  - `src/lib/orchestraData/tasks.ts`
  - `src/lib/orchestraData/inbox.ts`
  - `src/lib/orchestraData/sessions.ts`
  - `src/lib/orchestraData/appShell.ts`
- Those hooks currently hide important state distinctions:
  - initial load vs background refresh
  - retryable vs non-retryable error
  - mutation pending vs read refresh
  - live stream connected vs reconnecting vs disconnected
  - host fully offline vs live stream only degraded
- `src/App.tsx` already has session background refresh and stream handling hooks, but the state is internal only.
  - `loadSessions({ background: true })` exists, but there is no shared visible background-refresh state
  - `RemoteApiEventManager.scheduleReconnect()` silently retries after socket close, but there is no user-visible reconnect/degraded state
- Host-specific feature separation from ORC-64 is already in place, so this ticket can stay focused on shared product surfaces rather than reopening shell/admin extension boundaries.

## Proposed implementation shape

### 1. Make shared client errors usable by the UI

Keep `OrchestraClientError` as the canonical adapter error shape, but stop collapsing it to strings immediately.

Recommended changes:

- extend `src/lib/orchestraClient/errors.ts` with any missing UX-relevant classification, especially an explicit `offline` code
- add shared adapter-side normalization for Tauri/mock bindings so all hosts throw `OrchestraClientError` consistently
- add a small UI-facing formatter helper, e.g. `src/lib/orchestraData/errors.ts`, that maps:
  - `code`
  - `retryable`
  - capability context / `unsupported`
  - source / operation
  into a rendered `UiErrorState`

That formatter should distinguish at least:

- offline / host unavailable
- live degraded / reconnecting
- timeout / transient transport failure
- authorization / forbidden
- unsupported capability
- validation/conflict
- generic unknown failure

Important rule: `app.reportError(...)` should remain the logging/reporting side effect, not the only value the UI keeps.

### 2. Add an explicit shared connection-state surface

ORC-63 needs one shared connection model the UI can consume regardless of host.

Recommended contract addition:

- `src/lib/orchestraClient/connection.ts`
- add `client.connection` in `src/lib/orchestraClient/client.ts`

Suggested snapshot shape:

```ts
interface OrchestraConnectionSnapshot {
  hostState: "online" | "offline";
  liveState: "connected" | "reconnecting" | "disconnected" | "unsupported";
  degraded: boolean;
  retrying: boolean;
  retryAttempt: number;
  lastTransitionAt: string;
  lastError?: OrchestraClientErrorShape | null;
}
```

Suggested API:

```ts
interface OrchestraConnectionService {
  getSnapshot(): OrchestraConnectionSnapshot;
  subscribe(handler: (snapshot: OrchestraConnectionSnapshot) => void): Promise<OrchestraUnsubscribe>;
}
```

Host expectations:

- **remote API**
  - derive host online/offline from browser online status plus transport failures
  - derive live-state from WebSocket lifecycle and reconnect loop
  - mark degraded when cached data is still usable but live delivery is not fully healthy
- **tauri/mock**
  - provide a stable optimistic online/connected snapshot for shared surfaces
  - still surface `unsupported` where live semantics or host capabilities do not exist

This keeps transport health explicit without pushing WebSocket or browser-network details into pages.

### 3. Normalize retry behavior centrally

Retry policy should stop being page-by-page behavior.

Add a small shared retry helper, e.g. `src/lib/orchestraClient/retry.ts` or `src/lib/orchestraData/retry.ts`, with these rules:

#### Reads

Automatic retry is allowed for idempotent reads on retryable failures:

- `offline`
- `timeout`
- `unavailable`
- `network`
- `transport`

Use bounded exponential backoff with jitter.

Targets include:

- task list/detail reads
- inbox reads
- session list/detail/runtime/stats/model reads
- workflow/project/catalog reads

#### Mutations

Do **not** blindly auto-retry every mutation.

Recommended split:

- default: manual retry only for non-idempotent writes (`sendMessage`, `comment`, `createTask`, `send mailbox message`, etc.)
- allow shared retry wrapper only for explicitly idempotent operations (`subscribe`, `unsubscribe`, maybe read-ack/archive style actions where repeating is safe)
- preserve draft/input state so a failed manual retry is one click, not a re-entry flow

#### WebSocket reconnect

Replace the current silent fixed-delay reconnect in `remoteApiEvents.ts` with:

- capped exponential backoff
- reconnect attempt counting
- connection snapshot updates on every transition
- replay of active session subscriptions after reconnect
- visible degraded-live state while reconnect is in progress

ORC-63 should make live reconnect **visible and testable**, not silent.

### 4. Expose shared load/refresh/mutation state from `orchestraData`

The right place for most UX state is the existing ORC-60 data layer, not every page component.

Add small shared state primitives, e.g.:

- `src/lib/orchestraData/connection.ts`
- `src/lib/orchestraData/resourceState.ts`
- `src/lib/orchestraData/errors.ts`

Then update the existing hooks/workspaces to expose structured state instead of only booleans:

- `useInboxData(...)`
- `useTaskAutoRefresh(...)`
- session workspace logic in `App.tsx`
- `useProjectUnreadCounts(...)`
- `useProjectReferenceData(...)`

Target shared resource state:

```ts
interface OrchestraResourceState<T> {
  data: T;
  initialLoad: "idle" | "loading" | "ready" | "error";
  refreshing: boolean;
  mutating: boolean;
  error: UiErrorState | null;
  retry: () => Promise<void>;
  connection: OrchestraConnectionSnapshot;
}
```

The goal is not a giant query framework. It is a small consistent state shape that shared surfaces can render the same way in Tauri and hosted-web modes.

### 5. Apply one shared UX pattern to tasks, inbox, and sessions/chat

#### App shell

Use the existing app-status-banner pattern in `src/App.tsx` for top-level connection/degraded state.

Add a shared banner component, e.g. `src/components/ConnectionStatusBanner.tsx`, for:

- fully offline host
- live reconnect in progress
- live disconnected but cached data still present
- capability-unavailable host mode where relevant

#### Tasks

`src/pages/TasksPage.tsx` should distinguish:

- first load: blocking “Loading tasks…” state
- background refresh: subtle “Refreshing…” state while content stays visible
- retryable load failure with cached data: stale-content banner + Retry
- unsupported/capability failure: capability message, not generic transport copy
- mutation in progress: consistent pending affordance on detail actions

#### Inbox

`src/pages/InboxPage.tsx` should get the same state model:

- initial load vs refresh
- retryable failure with cached messages/tasks still visible
- offline/degraded warning when inbox/task attention data is stale
- mutation retry affordances for safe actions

#### Sessions / chat

The session workspace in `src/App.tsx`, `src/pages/SessionsPage.tsx`, and `src/components/SessionChatPanel.tsx` should make live-state explicit:

- connected
- reconnecting live updates
- live disconnected / stale transcript
- fully offline host

Important UX rule:

- keep cached transcript/session data visible when possible
- disable or warn on actions that need live connectivity
- make “Retry” or “Reconnect” obvious when the failure is retryable

## Proposed file plan

Shared contract / adapter files:

- `src/lib/orchestraClient/client.ts`
- `src/lib/orchestraClient/errors.ts`
- `src/lib/orchestraClient/connection.ts`
- `src/lib/orchestraClient/retry.ts`
- `src/lib/orchestraClient/remoteApiTransport.ts`
- `src/lib/orchestraClient/remoteApiEvents.ts`
- `src/lib/orchestraClient/tauriBindings.ts`
- `src/lib/orchestraClient/mockBindings.ts`
- `src/lib/orchestraClient/index.ts`

Shared data-layer files:

- `src/lib/orchestraData/connection.ts`
- `src/lib/orchestraData/resourceState.ts`
- `src/lib/orchestraData/errors.ts`
- `src/lib/orchestraData/tasks.ts`
- `src/lib/orchestraData/inbox.ts`
- `src/lib/orchestraData/sessions.ts`
- `src/lib/orchestraData/appShell.ts`

Shared UI files:

- `src/components/ConnectionStatusBanner.tsx`
- possibly one small shared inline state component for retry/degraded copy

Primary page consumers:

- `src/App.tsx`
- `src/pages/TasksPage.tsx`
- `src/pages/InboxPage.tsx`
- `src/pages/SessionsPage.tsx`
- `src/components/SessionChatPanel.tsx`
- `src/pages/AgentChatPage.tsx`

Validation files:

- `tests/orchestra-client-contract.test.ts`
- `tests/orchestra-client-hosted-web.test.ts`
- `tests/orchestra-client-remote-api.test.ts`
- focused e2e/desktop-e2e coverage for tasks/inbox/sessions degraded/offline/retry flows

## Sequencing

1. Extend the shared contract with connection state and finish adapter-side error normalization for all hosts.
2. Add shared retry/backoff helpers and replace silent remote reconnect with visible reconnect state.
3. Add `orchestraData` resource/connection state helpers.
4. Rewire tasks, inbox, and session/chat surfaces to render from structured load/error/connection state instead of strings + booleans.
5. Add focused regression coverage for offline/degraded/retry paths in both hosted-web and Tauri-backed flows.

## Validation plan

Minimum validation for implementation/review should include the full matrix now expected on this codebase:

- `npm run build`
- `npm test`
- `npm run test:e2e`
- `npm run test:desktop-e2e`

Add targeted coverage for:

- Tauri/mock/remote error normalization into `OrchestraClientError`
- explicit `offline` classification and retryability rules
- connection snapshot transitions for socket close/reconnect/replay
- idempotent read retry backoff behavior
- manual-retry mutation behavior for non-idempotent writes
- tasks/inbox/session surfaces showing:
  - initial load
  - background refresh
  - cached-content degraded mode
  - reconnecting live updates
  - fully offline host state
  - unsupported capability copy instead of generic transport failure

## Acceptance-criteria mapping

- **Shared screens present consistent loading, error, retry, and degraded/offline behavior in both Tauri-backed and API-backed modes**
  - accomplished by moving those states into shared client/data-layer primitives and rendering the same banners/inline affordances from both hosts
- **Unsupported or host-specific features fail through normalized capability/error handling instead of ad hoc transport errors**
  - accomplished by adapter-side `OrchestraClientError` normalization plus UI formatting that treats `unsupported` distinctly
- **Live reconnect behavior is visible and testable rather than silently stalling**
  - accomplished by explicit connection snapshots, visible reconnect banners/state, and adapter/e2e tests around reconnect transitions
