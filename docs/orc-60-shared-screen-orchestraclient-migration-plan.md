# ORC-60 shared-screen `OrchestraClient` migration plan

## tl;dr

- Build a small feature-data layer on top of `useOrchestraClient()` so shared screens stop importing `src/lib/tauri.ts` and the other transport-coupled read helpers directly.
- Migrate the highest-value shared surfaces first: tasks, inbox, session/chat state, and the app-shell read paths they depend on.
- Put refresh, polling, and event-driven invalidation inside hooks/store helpers that subscribe through `client.events`, not inside page components.
- Reuse the existing session transcript/list reducers instead of rewriting them; move them behind a session workspace hook.
- Keep settings/admin/logs/terminal panels out of scope, and keep any remaining named-agent chat launcher gap isolated instead of letting it keep the core session surface transport-coupled.

## Executive summary

ORC-58 finished the adapter split, so the missing piece is now above the transport boundary: shared React screens still bypass the injected client and own their own refresh logic. `src/main.tsx` already installs `OrchestraClientProvider`, and `src/lib/orchestraClient/client.ts` already exposes the contract ORC-60 needs (`app`, `catalog`, `tasks`, `inbox`, `sessions`, `events`). The product remains host-coupled because the core UI is still reading and mutating through direct helper imports from `src/lib/tauri.ts`, `src/lib/projects.ts`, `src/lib/agents.ts`, and `src/lib/roles.ts`.

The bounded fix for this ticket is a feature-scoped data layer, not another transport refactor. Add hooks/store helpers that depend only on `OrchestraClient`, let them own invalidation and refresh, and then migrate the task, inbox, and session/chat screens onto those hooks. Once those screens are on the injected boundary, the hosted-web adapter work can plug in underneath without each page needing another rewrite.

## Current findings

- The injected client/provider seam is present and live:
  - `src/main.tsx`
  - `src/lib/orchestraClient/provider.tsx`
  - `src/lib/orchestraClient/{client,tauriClient,mockClient,defaultClient}.ts`
- The remaining coupling is in the shared UI layer:
  - `src/App.tsx` still imports the core session/task/inbox read + event helpers directly from `src/lib/tauri.ts`
  - `src/pages/TasksPage.tsx` still owns task list/detail/schedule loading and repeats manual `loadTasksData()` / `loadTaskDetail()` follow-up refreshes after nearly every mutation
  - `src/pages/InboxPage.tsx` still loads mailbox/tasks/agents directly and wires its own `listenToInboxChanges()` / `listenToTaskChanges()` refresh loop
  - `src/pages/tasks/TaskDetailPage.tsx` still reads repository file content directly through `getTaskFileContent()`
  - `src/components/TaskCommentMentionsTextarea.tsx` still searches file mentions directly through `searchTaskCommentFileMentions()`
- `src/App.tsx` still owns session list/detail/transcript/model/stats refresh logic directly, including event listeners and timer-based reconciliation for active sessions.
- The shared client contract already covers almost all of the required read/write surface for this ticket:
  - `client.catalog` covers project/workflow/agent/role read paths used by the core shared pages
  - `client.tasks`, `client.inbox`, and `client.sessions` cover the task/inbox/session actions and read models those pages need
  - `client.events.subscribe(...)` already exposes shared `session.change`, `session.stream`, `task.change`, and `inbox.change` deliveries
- The main remaining gap is named-agent chat launcher state (`listAgentOperations()` / `ensureAgentSession()`), which is not yet on the shared contract. That should be isolated as a thin edge case instead of blocking migration of the underlying session/chat surface.

## Implementation shape

### 1. Add a small shared feature-data substrate

Create a lightweight UI-facing data layer under `src/lib/orchestraData/` that:

- reads via `useOrchestraClient()`
- exposes feature hooks instead of transport helpers
- owns loading/error state, refetch, and mutation follow-up refreshes
- subscribes once per feature to `client.events` and translates those events into feature invalidation/refresh
- keeps polling only where the backend still needs it, but hides the timer inside the hook/store layer rather than page components

This does **not** need to become a broad generic query framework. A small keyed resource store plus feature hooks is enough for this ticket.

### 2. Migrate the tasks surface first

Add a task workspace hook that owns the data and actions currently spread across `TasksPage`, `TaskDetailPage`, and `TaskCommentMentionsTextarea`.

Target responsibilities:

- task list / task schedules / workflow summaries / workflow definitions
- project repositories + default repository read data
- selected task detail + task messages
- task actions and mutations through `client.tasks.*`
- task event invalidation through `client.events`
- session-stream-triggered task refresh for tool events that currently force page-owned task reloads
- task file content loading through `client.tasks.getFileContent(...)`
- task comment file mention search through `client.tasks.searchCommentFileMentions(...)`

Expected component result:

- `src/pages/TasksPage.tsx` becomes route + form-state orchestration over hook output instead of transport orchestration
- `src/pages/tasks/TaskDetailPage.tsx` stops importing transport helpers directly
- `src/components/TaskCommentMentionsTextarea.tsx` gets a hook-backed callback/prop instead of importing `src/lib/tauri.ts`

### 3. Migrate inbox and app-shell unread/reference data

Add inbox/shell hooks so the shared unread surfaces stop fetching through transport helpers directly.

Target responsibilities:

- mailbox list + unread/archive filtering
- attention-task derivation
- send / mark-read / archive actions through `client.inbox.*`
- task-backed attention refresh through `client.events`
- project unread counters and task-comment unread counters used by the app shell
- project/task/agent/role/workflow read paths used by the shell and task/inbox surfaces through `client.catalog.*`

Expected component result:

- `src/pages/InboxPage.tsx` no longer owns transport listeners or direct mailbox/task fetches
- `src/App.tsx` project-switcher/reference/unread data uses client-backed hooks for the shared surfaces instead of direct task/inbox/project helper imports

### 4. Extract the session/chat workspace out of `App.tsx`

Move the session data logic in `src/App.tsx` behind a dedicated session workspace hook/store.

Reuse the existing proven reducers/helpers rather than replacing them:

- `src/lib/sessionTranscriptReducer.ts`
- `src/lib/sessionList.ts`
- `src/lib/sessionListMerge.ts`

Target responsibilities:

- session list loading and reconciliation
- selected session detail refresh
- transcript event reduction from `session.stream`
- model state, stats, runtime details, and mutation helpers through `client.sessions.*`
- background refresh/invalidation on `session.change` and `session.stream`
- active-session polling fallback when the session is live but not yet fully subscribed
- shared session/chat actions: create, contextual create, send, stop, compact, reload, subscribe, unsubscribe, delete

Expected component result:

- `src/App.tsx` becomes shell/routing/UI state, not the transport owner for session data
- `src/pages/SessionsPage.tsx`, `src/pages/AgentChatPage.tsx`, and `src/components/SessionChatPanel.tsx` continue to be mostly presentational consumers of the extracted session workspace

### 5. Isolate the named-agent chat launcher seam

The underlying chat/session surface should move to `client.sessions`, but the named-agent launcher currently still depends on `src/lib/agents.ts` helpers that are outside the ORC-57 client contract.

For ORC-60:

- keep that seam as thin as possible at the edge of `App.tsx`
- do **not** let it justify leaving the whole session/chat surface on `src/lib/tauri.ts`
- if it is the last blocker to full page migration, capture the smallest follow-on contract addition or explicitly document the launcher-only exception

## Proposed file plan

New UI-data-layer files:

- `src/lib/orchestraData/resourceStore.ts` — tiny keyed resource/invalidation helper
- `src/lib/orchestraData/catalog.ts` — project/workflow/agent/role read hooks used by shared screens
- `src/lib/orchestraData/tasks.ts` — task list/detail/schedule/file/mention hooks + task actions
- `src/lib/orchestraData/inbox.ts` — mailbox hooks + unread/attention helpers
- `src/lib/orchestraData/sessions.ts` — session workspace hook/store using the existing reducers
- `src/lib/orchestraData/index.ts` — exports

Primary migration targets:

- `src/App.tsx`
- `src/pages/TasksPage.tsx`
- `src/pages/InboxPage.tsx`
- `src/pages/tasks/TaskDetailPage.tsx`
- `src/components/TaskCommentMentionsTextarea.tsx`

## Sequencing

1. Start from the landed ORC-58 baseline on `origin/main` so the real injected-client/provider seam is present.
2. Add the small `orchestraData` substrate and client-event invalidation helpers.
3. Migrate task read/write paths first, including task detail file content + comment mention search cleanup.
4. Migrate inbox plus app-shell unread/reference read paths.
5. Extract session/chat state from `App.tsx` into a session workspace hook that reuses the existing transcript/list reducers.
6. Remove obsolete direct `lib/tauri.ts` imports from the migrated shared screens/components.
7. Leave any remaining launcher-only named-agent chat seam explicitly isolated/documented if it cannot be folded into this ticket without contract churn.
8. Validate build + focused regression coverage.

## Scope boundaries / non-goals

Out of scope for ORC-60:

- settings/admin panels still using specialized helper modules
- logs window helpers
- agent terminal window control
- system-notification plumbing beyond whatever shared unread/task data the shell needs
- remote/source-control/harness panels
- wholesale deletion of `src/lib/tauri.ts`
- remote API transport implementation itself (that belongs under the hosted-web/client-adapter follow-ons)
- broad optional desktop-only capability work already covered by follow-on tasks

## Validation plan

Expected implementation/review validation:

- `npm run build`
- focused Vitest coverage for the new task/inbox/session hooks or store helpers using injected client stubs
- focused coverage proving client-event deliveries trigger the expected feature refresh/invalidation behavior for:
  - `task.change`
  - `session.stream` task-tool refresh cases
  - `inbox.change`
  - `session.change`
- rerun any directly affected unit/UI coverage around task, inbox, and session surfaces

## Acceptance-criteria mapping

- **Shared React screens consume the injected client/hooks rather than direct Tauri helper modules**
  - migrated task, inbox, and session/chat surfaces read through `useOrchestraClient()`-backed hooks instead of direct `lib/tauri.ts` imports
- **Transport differences are isolated below the feature data layer**
  - pages/components talk to hooks and hook actions; only the client/adapters know whether the host is Tauri, mock, or later remote API
- **Core task, inbox, and session surfaces are on the new boundary and ready to run in both host modes as supporting adapter work lands**
  - the high-value shared surfaces move to the injected boundary now, so hosted-web support can attach under them without another page-by-page transport rewrite
