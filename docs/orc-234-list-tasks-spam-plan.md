# ORC-234 — dev-build `list_tasks` spam plan

## tl;dr

- The likely root cause is **event-driven over-refresh**, not backend polling by itself: multiple frontend task listeners call `orchestraClient.tasks.list(...)` immediately on every task-related event.
- The clearest duplicate path is `src/lib/orchestraData/tasks.ts`: `useTaskAutoRefresh()` refreshes on both `task.change` **and** `session.stream` `tool_execution_end`, even though the same task-mutating tools already produce `task.change` events.
- A global amplifier also exists in `src/lib/orchestraData/appShell.ts`: `useProjectUnreadCounts()` reloads task lists for every project on every `task.change` with no burst coalescing.
- Fix by **coalescing task refresh requests behind the same scheduled/in-flight guard pattern already used for sessions**, then add regression coverage that counts `tasks.list` calls during a synthetic burst of task events.

## Executive summary

A code audit points to a frontend fan-out problem.

On the Tasks surface, `useTaskAutoRefresh()` reloads task data from two event sources: backend `task.change` events and session-stream `tool_execution_end` events for task tools. Those sources overlap for the same user-visible mutation, so one real task update can schedule multiple `list_tasks` calls. Separately, the always-on app-shell unread-count loader (`useProjectUnreadCounts()`) also issues `tasks.list(...)` on every `task.change`, which amplifies any burst of task activity into more background task-list reads.

Unlike the sessions path, none of these task refresh flows currently debounce bursts or suppress duplicate in-flight reloads. That is the most plausible reason `list_tasks` appears to spam indefinitely in the dev build whenever there is ongoing task/runtime activity.

## Current findings

### 1) TasksPage has overlapping refresh triggers

Relevant path:

- `src/lib/orchestraData/tasks.ts`

`useTaskAutoRefresh()` currently does all of the following:

- refreshes on every `task.change`
- refreshes on `session.stream` `tool_execution_end` for task-mutating tools
- immediately calls `refreshTasks()` with no debounce or in-flight gate

That means a single task mutation can cause:

1. a session-stream tool completion event
2. a backend `task.change` event
3. two immediate task-list refresh attempts

If a worker is actively operating on tasks, that becomes a near-continuous `list_tasks` stream.

### 2) App-shell unread counts amplify every `task.change`

Relevant path:

- `src/lib/orchestraData/appShell.ts`

`useProjectUnreadCounts()` is always active once startup auxiliary hydration finishes. On every `task.change`, it reloads:

- `orchestraClient.inbox.list(...)`
- `orchestraClient.tasks.list(...)` for each project

So even outside the Tasks page, any burst of task activity can keep `list_tasks` hot.

### 3) Related task surfaces follow the same pattern

Relevant paths:

- `src/lib/orchestraData/appShell.ts`
- `src/lib/orchestraData/inbox.ts`

`useProjectReferenceData()` and `useInboxData()` also react to `task.change` by issuing immediate `tasks.list(...)` refreshes. They are not necessarily the first repro path, but they share the same missing coalescing behavior.

### 4) Coverage exists nearby, but not for this failure mode

Existing adjacent coverage:

- `tests/e2e/tasks.spec.ts` already verifies that task detail refreshes from backend `task-change` events.
- `tests/e2e/sessions.spec.ts` already verifies that bursty session events debounce into one background refresh.

Missing coverage:

- no test currently counts `tasks.list` refreshes under bursty `task.change` / task-tool activity
- mock `listTasks()` does not currently emit the same simple call log that `listSessions()` already exposes for this kind of assertion

## Proposed implementation

### 1) Introduce one shared coalesced task-refresh helper

Add a small helper for task-driven background refreshes that:

- schedules at most one pending refresh at a time
- skips duplicate scheduling while a refresh is already in flight
- uses a short debounce window (same idea as the sessions path)

Apply it to task-list refresh consumers instead of calling `tasks.list(...)` immediately from every event callback.

### 2) Remove or collapse duplicate TasksPage event triggers

In `useTaskAutoRefresh()`:

- treat `task.change` as the canonical task-data invalidation signal
- keep `session.stream` refresh only if an audited case truly lacks a matching `task.change`; otherwise remove it
- if both sources must remain, route both through the same coalesced refresh gate so one mutation still yields one background reload burst

### 3) Apply the same guard to global/background task-list readers

Use the shared coalescing path in:

- `useProjectUnreadCounts()`
- `useProjectReferenceData()`
- `useInboxData()`
- `useTaskAutoRefresh()`

That keeps the fix rooted in the actual over-refresh architecture instead of only masking one symptom.

### 4) Add regression instrumentation and tests

Implementation-friendly coverage plan:

1. add lightweight mock logging for `listTasks()` in `src/lib/tauri.ts` (matching the existing `sessions.list` logging pattern)
2. add an e2e regression that injects a burst of `orchestra:task-change` events and asserts `tasks.list` increases by a bounded amount instead of once per event
3. keep the existing task-detail freshness test so the debounce/coalescing change does not regress visible updates

A good first assertion is the always-on shell case (one project, no Tasks page-specific listeners), then optionally add a Tasks-page-specific burst test if the duplicated session-stream path is retained.

## Validation plan

- Reproduce in the dev build with an active task/runtime path that emits repeated task updates while watching command logs for `list_tasks`.
- Confirm the pre-fix fan-out path by correlating the refresh source with:
  - `useTaskAutoRefresh()` event handling
  - `useProjectUnreadCounts()` background refreshes
- After the fix, verify:
  - `list_tasks` no longer rises linearly with each task event burst
  - task detail still refreshes promptly after real task updates
  - unread badges / inbox task summaries still converge correctly after task changes
