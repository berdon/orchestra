# ORC-220 linked entity labels plan

## tl;dr
- Treat ORC-220 as a shared entity-reference presentation pass, not a set of isolated string swaps.
- Add reusable link primitives for task, session, agent, and role references plus a consistent raw-ID secondary treatment.
- Feed those primitives from app-level lookup maps and backend-decorated labels where current payloads only expose raw ids.
- Convert the remaining raw-ID-heavy surfaces first: task runtime/history/timeline, task schedule occurrences, workforce operations, inbox fallbacks, and bridge diagnostics.
- Keep non-navigable infrastructure ids raw, but stop using navigable ids as the primary visible label.

## Executive summary
Orchestra already has most of the navigation plumbing needed for this ticket: `src/App.tsx` can open task, session, agent, and role detail surfaces, and many screens already render human-friendly task titles or session titles. The remaining problem is consistency. A handful of operational surfaces still render raw `sessionId`, `taskId`, `agentId`, or `roleId` directly because their view models only expose ids or because the rendering code is string-only.

ORC-220 should therefore land as a shared entity-reference layer, not as one-off JSX tweaks. The implementation should introduce reusable link renderers and entity lookup helpers, then enrich the few response types that still lack stable display labels. That lets task runtime/history, workforce operations, inbox/schedule surfaces, and bridge diagnostics all render the same pattern: human-friendly linked label first, raw ID secondary only where that surface is operational or debug-oriented.

## Scope

### In scope
- Session, task, agent, and role references that already have a detail surface or navigation target.
- Replacing raw IDs as primary visible labels in desktop/web task, session, workforce, inbox, schedule, and diagnostics surfaces.
- Consistent secondary raw-ID access for audit/debug surfaces.

### Out of scope
- Non-navigable infrastructure ids as primary entities: queue entry ids, role instance ids, bridge client ids, request ids, cleanup ids, and similar internal identifiers.
- Lane/workflow ID copy cleanup except where it sits next to a newly linked entity reference.
- Large mobile changes unless a concrete mobile parity gap is found during implementation; the current mobile task/session views do not appear to visibly lead with raw ids.

## Current-state audit
- `src/pages/tasks/TaskDetailPage.tsx`
  - runtime card shows `workerId` and `sessionId`
  - lane history shows `Session {laneRun.sessionId}`
- `src/pages/TasksPage.tsx`
  - timeline items flatten lane-run metadata into plain strings (`session ${laneRun.sessionId}`), which blocks linked rendering
- `src/pages/tasks/TaskScheduleDetailPage.tsx`
  - occurrences show `Task {occurrence.taskId}`
- `src/agents/AgentOperationsDetail.tsx`
  - runtime summary shows `mainSessionId`
  - queue entries show raw `sourceTaskId` and `sessionId`
- `src/agents/RoleOperationsDetail.tsx`
  - instances show raw `sessionId`
  - instance ids / assigned instance ids are debug-only and should stay secondary if retained
- `src/settings/GeneralPanel.tsx`
  - bridge clients/requests show raw `sessionId`
  - actor column shows `actorType:actorId`
- `src/pages/InboxPage.tsx`
  - task buttons already prefer number/title, but still fall back to raw `taskId`; this should move onto the shared task reference pattern

## Recommended implementation

### 1. Add shared entity reference primitives
Introduce a small shared UI layer, e.g. `src/components/entity-links/*`, with typed props for:
- task reference -> label from `number/title`
- session reference -> label from `title`
- agent reference -> label from `name`
- role reference -> label from `name`

Each renderer should support:
- the appropriate `onOpen*` navigation callback
- optional `projectId`
- optional `rawId`
- a consistent secondary raw-ID mode (`inline`, `tooltip`, or `none`)

### 2. Add a shared lookup model instead of ad-hoc `find(...)`
Create an app-level reference lookup object that can be threaded into pages that already support navigation:
- tasks from `useProjectReferenceData(...)`
- agents from `useProjectReferenceData(...)`
- roles from `useProjectReferenceData(...)`
- sessions from `App.tsx` session state

Prefer inline labels from the loaded record itself, then fallback to the lookup map, then fallback to the raw id.

### 3. Enrich response shapes where the frontend cannot reliably infer labels
Some surfaces do not consistently have the linked entity loaded in memory. Add optional display fields to the affected types so the frontend can render a stable label without extra fetches:

- `TaskLaneAssignment`
  - `workerName?`
  - `workerSlug?`
  - `sessionTitle?`
- `TaskLaneRun`
  - `sessionTitle?`
- `TaskScheduleOccurrence`
  - `taskNumber?`
  - `taskTitle?`
- `AgentRuntimeState`
  - `mainSessionTitle?`
- `AgentQueueEntry`
  - `sourceTaskNumber?`
  - `sourceTaskTitle?`
  - `sessionTitle?`
- `RoleInstance`
  - `sessionTitle?`
- `BridgeClientDiagnostics` / `BridgeRequestDiagnostics`
  - `sessionTitle?`
  - `actorLabel?` for navigable agent/role actors

These should stay optional so existing mock/remote contract paths can roll forward incrementally.

### 4. Convert the raw-ID-heavy surfaces in batches
#### Task surfaces
- `TaskDetailPage.tsx`
  - render worker name link instead of `workerType · workerId`
  - render session title link in the runtime card and lane history
  - keep raw ids as subdued secondary copy on the runtime card, not as primary text
- `TasksPage.tsx`
  - stop storing lane-run timeline display as string-only text
  - move lane-run/session rendering to structured timeline fields so links are possible
- `TaskScheduleDetailPage.tsx`
  - render occurrence task links using number/title first

#### Workforce surfaces
- `AgentOperationsDetail.tsx`
  - session summary -> linked session title
  - source task/session references in queue entries -> linked labels
- `RoleOperationsDetail.tsx`
  - instance session -> linked session title
  - keep instance ids secondary if they remain visible for ops/debugging

#### Diagnostics and inbox
- `GeneralPanel.tsx`
  - bridge session columns -> linked session titles
  - actor column -> linked agent/role label when the actor is navigable, otherwise current raw fallback
- `InboxPage.tsx`
  - replace the current `taskNumber ?? taskId` fallback with the shared task reference renderer

### 5. Use surface-appropriate raw-ID preservation
- Operational/debug surfaces (`TaskDetailPage` runtime, workforce ops, `GeneralPanel`) should keep visible secondary raw IDs, ideally code-styled.
- Simple navigation surfaces (`InboxPage`, schedule occurrences, lane history/timeline) can keep the raw id in a tooltip/title or expandable secondary line instead of always showing it.

## Test plan
- Update existing web/e2e coverage instead of creating an isolated happy-path-only spec.
- `tests/e2e/tasks.spec.ts`
  - task runtime card shows linked worker/session labels
  - lane history/timeline show human labels, not raw ids
- `tests/e2e/agents.spec.ts`
  - agent/role operations surfaces show linked task/session labels
- `tests/e2e/task-schedules.spec.ts`
  - occurrence rows open the materialized task via linked label
- `tests/e2e/general.spec.ts`
  - bridge diagnostics still expose debug data but stop using raw session ids as the primary visible session label
- Update contract/type tests if the new optional display fields flow through Tauri/remote adapters.

## Likely files
- `src/App.tsx`
- `src/components/...` (new shared entity-link primitives)
- `src/lib/orchestraData/appShell.ts` or a new lookup helper module
- `src/pages/TasksPage.tsx`
- `src/pages/tasks/TaskDetailPage.tsx`
- `src/pages/tasks/TaskScheduleDetailPage.tsx`
- `src/agents/AgentOperationsDetail.tsx`
- `src/agents/RoleOperationsDetail.tsx`
- `src/settings/GeneralPanel.tsx`
- `src/pages/InboxPage.tsx`
- `src/types.ts`
- corresponding Tauri model/service files under `src-tauri/src/models.rs` plus the task/runtime, worker-runtime, schedule, and diagnostics command/service layers
- relevant e2e/contract tests

## Recommended implementation order
1. Land the shared link/lookup primitives.
2. Add the missing optional display fields to backend/frontend types.
3. Convert task surfaces first.
4. Convert workforce and diagnostics surfaces next.
5. Update e2e/contract coverage.
