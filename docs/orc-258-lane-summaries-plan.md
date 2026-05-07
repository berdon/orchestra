# ORC-258 Lane summaries plan

## tl;dr
- Add an explicit required `summary` field to lane-closing transitions instead of overloading `notes`.
- Persist that summary on the lane lifecycle records that already own transition state: `task_lane_runs` for durable run history and `task_lane_assignments` for the pending review/intervention window.
- Expose a first-class `task.laneSummaries[]` detail field so task details can show one current/latest summary per workflow lane without reconstructing from comments.
- Require summaries for `complete_lane_as_success`, `complete_lane_as_failure`, and `request_user_intervention`; keep `reassign_task_to_lane` on notes-only semantics and keep approval/resume/rework controls reusing the already-captured summary instead of asking twice.
- Add a shared transition dialog in task details, update bridge/remote/client/tool schemas and prompt text, and cover persistence, validation, rendering, and prompt/schema integration with tests.

## Executive summary
The current system has two adjacent but insufficient fields:

- `task_lane_runs.notes` for free-form run history
- `task_lane_assignments.completion_notes` for pending review/intervention state

Neither is an explicit, durable, per-lane summary contract. They are optional, notes-oriented, and not surfaced as a first-class task-detail concept. ORC-258 should **not** repurpose `notes` as the summary. The summary needs its own contract because it has different semantics:

- concise, display-oriented, and expected on close/move transitions
- durable and auditable
- visible in task details without reading comments
- explicit in tool docs and prompts

The recommended design is to add a separate `summary` field to lane transitions, store it alongside the structured lane lifecycle records, and derive a task-level `laneSummaries[]` collection from those records. This keeps the source of truth close to the transition machinery, preserves auditability per lane run, avoids a second “shadow transition table,” and gives the UI a simple, explicit field to render.

## Design goals
1. **Do not overload `notes`.** `notes` stays optional and secondary.
2. **Make summaries explicit in every closing/moving transition surface.**
3. **Keep summaries durable and auditable per lane run.**
4. **Make task details show summaries directly, not as inferred history.**
5. **Handle pending review/intervention states cleanly.**
6. **Keep the rule simple enough that agents can reliably follow it.**

## Recommended data model
### 1. Add explicit structured summary fields
Add:

- `task_lane_runs.summary TEXT`
- `task_lane_assignments.completion_summary TEXT`

Keep existing `notes` / `completion_notes` columns unchanged.

### 2. Add first-class task detail summary output
Add a new task detail/model field:

```ts
interface TaskLaneSummary {
  laneId: string;
  laneName?: string | null;
  summary: string;
  outcome?: string | null;
  pending: boolean;
  sessionId?: string | null;
  updatedAt: string;
}
```

and expose:

```ts
interface TaskDetail {
  // existing fields...
  laneSummaries: TaskLaneSummary[];
}
```

### Why this shape
A separate `task_lane_summaries` table is possible, but it duplicates state already owned by lane runs / assignments and makes the pending-review window harder to reason about. The lane lifecycle records already know:

- which lane was active
- which session produced the result
- whether the run is still pending user action
- which outcome or handoff happened

So the lowest-risk design is:

- store immutable/run-level summary data on `task_lane_runs`
- store pending summary data on the open assignment while review/intervention is unresolved
- derive `task.laneSummaries[]` from the latest structured summary-bearing records per lane

This is still “first-class per-lane summary” at the task contract level, while preserving per-run auditability underneath.

## Summary semantics
### Summary vs notes
- **`summary`**: required concise lane handoff/closure text; intended for task-detail display.
- **`notes`**: optional extra detail for operator context, longer explanation, or edge-case rationale.

Recommended validation:
- trim whitespace
- reject empty summary
- cap summary length (recommendation: **500 chars max**)
- keep `notes` optional

### What `task.laneSummaries[]` means
`task.laneSummaries[]` should represent the **latest durable structured summary for each lane on the task**, ordered by workflow lane order.

Resolution order for a lane:
1. current open assignment `completion_summary` when the lane is paused for user approval/intervention
2. latest open lane run with a non-empty `summary`
3. latest completed lane run with a non-empty `summary`

That gives the task details a stable “latest lane summary” view while preserving full run-by-run audit history underneath.

## Transition requirement matrix
The rule should be simple:

> **Any transition that closes the current lane or moves the task out of the current lane must carry an explicit `summary`.**

### Require `summary`
- `complete_lane_as_success`
- `complete_lane_as_failure`
- `request_user_intervention`

### Do not require a new summary
These actions should reuse the already-captured summary or continue work without creating a new lane-summary record:
- `approve_task_review`
- `approve_lane_completion`
- `mark_task_needs_work`
- `resume_task_lane`

### Still optional / unchanged
These are operational controls, not lane-summary-producing transitions:
- `dispatch_task_lane`
- `pause_task_lane`
- `stop_task_activity`
- `reset_task_runtime`
- `manual_task_whip`

## Transition persistence behavior
### `complete_lane_as_success`
- require `summary`
- if lane requires user approval, store summary immediately on:
  - `task_lane_assignments.completion_summary`
  - the open `task_lane_runs.summary`
- if lane closes immediately, finalize the lane run with both `summary` and `notes`

### `complete_lane_as_failure`
- require `summary`
- finalize the current lane run with `summary`
- use failure transition as today

### `request_user_intervention`
- require `summary`
- store summary immediately on the paused assignment and open lane run
- do not ask again when the user later approves/resumes/re-lanes

### `reassign_task_to_lane`
- keep `notes` optional; do not require `summary`
- treat the current lane as being exited
- finalize/cancel the current run with notes before moving to the target lane

### `approve_task_review` / `approve_lane_completion`
- no new summary input
- finalize using the summary already captured on the pending assignment / open lane run

### `mark_task_needs_work` / `resume_task_lane`
- no new summary input
- preserve the prior summary as audit/history; the next worker close/handoff can replace the lane’s latest summary later

## Backend / contract changes
### Rust models and DB
Update:
- `src-tauri/src/services/database.rs`
- `src-tauri/src/models.rs`
- `src-tauri/src/services/tasks.rs`
- `src-tauri/src/services/task_runtime.rs`

Key work:
- migration/add-column support for `task_lane_runs.summary` and `task_lane_assignments.completion_summary`
- task context loading for `laneSummaries[]`
- transition validation helper for required summaries
- normalization helper shared by all summary-requiring transitions
- domain-event payloads should include `summary` (and `notes` when present)

### Command / bridge / remote API surfaces
Update the explicit transition payloads so summary is not implicit:

- Tauri commands in `src-tauri/src/commands/tasks.rs`
- tool bridge in `src-tauri/src/services/tool_bridge.rs`
- remote API request structs/routes in `src-tauri/src/services/remote_api.rs`
- extension schema/help in `extensions/orchestra-tools.ts`
- frontend client interfaces/bindings in:
  - `src/lib/orchestraClient/client.ts`
  - `src/lib/orchestraClient/tauriBindings.ts`
  - `src/lib/orchestraClient/remoteApiClient.ts`
  - `src/lib/orchestraClient/mockBindings.ts`
  - `src/lib/tauri.ts`

Recommended request shapes:

```ts
{ taskId, summary, notes? }
{ taskId, laneId, summary, notes? }
```

Do not hide summary inside `notes` or a generic `inputJson` blob.

## UI plan
### 1. Add a visible lane summaries section to task details
Add a dedicated **Lane summaries** card/section in the overview area of `TaskDetailPage`, above recent history.

Each row/card should show:
- lane name (fallback to lane id)
- outcome / pending badge
- timestamp
- summary body

This gives task details a clear per-lane handoff view without needing to scan the history tab or comments.

### 2. Keep run history showing per-run detail
Also update the history/runtime surfaces so lane-run cards can show `summary` distinctly from `notes`.

### 3. Collect summaries through a shared transition dialog
`TaskDetailPage` already has a re-lane confirm overlay. Expand this idea into a shared transition dialog used by:
- complete success
- complete failure
- request user intervention
- re-lane

Dialog fields:
- **Lane summary** (required)
- **Notes** (optional)

This is the cleanest way to make the rule visible and consistent for direct user-driven transitions.

Likely files:
- `src/pages/tasks/TaskDetailPage.tsx`
- `src/pages/TasksPage.tsx`
- `src/pages/tasks/taskDetailHeaderActions.ts`
- `src/styles.css`

## Prompting and documentation changes
Update the worker-facing prompt/help text so the expectation is explicit everywhere the agent sees it.

Primary prompt/help surfaces to update:
- `TASK_WHIP_PROMPT` in `src-tauri/src/services/task_runtime.rs`
- `orchestra_tool_help_block()` in `src-tauri/src/services/task_runtime.rs`
- `orchestra_completion_rules_block()` in `src-tauri/src/services/task_runtime.rs`
- manual whip / retry messages in `src/pages/TasksPage.tsx`
- bridge tool descriptions/examples in `extensions/orchestra-tools.ts`

The wording should shift from:
- “task ID and optional notes”

to something like:
- “task ID, required lane summary, and optional notes”

## Automated coverage
### Rust/service coverage
Add or update tests in:
- `src-tauri/src/services/task_runtime.rs`
- `src-tauri/src/services/tasks.rs`

Cover:
- summary persistence on success/failure/re-lane/request-user-intervention
- pending approval/intervention preserving summary before final approval
- required-summary validation failures
- task-context `laneSummaries[]` derivation/order

### Tool/schema coverage
Update:
- `tests/orchestra-tools-extension.tools.test.ts`

Cover:
- `summary` is required for the three lane-closing transition tools
- payloads serialize `summary` separately from `notes`
- descriptions/examples mention summary explicitly

### UI coverage
Add/update Playwright or desktop E2E coverage in the existing task-detail suites, likely:
- `tests/e2e/tasks.spec.ts`
- `tests/desktop-e2e/lane-approval.test.ts`
- `tests/desktop-e2e/review-action-regression.test.ts`

Cover:
- overview renders lane summaries when present
- transition dialog blocks submit without summary
- re-lane requires summary
- approval-required success shows pending summary, then finalizes correctly after approval

### Prompt/help coverage
Add targeted assertions for updated prompt/help text where practical, especially in:
- `src-tauri/src/services/task_runtime.rs` tests that already assert prompt content

## Expected files
- `docs/orc-258-lane-summaries-plan.md`
- `src-tauri/src/services/database.rs`
- `src-tauri/src/models.rs`
- `src-tauri/src/services/tasks.rs`
- `src-tauri/src/services/task_runtime.rs`
- `src-tauri/src/commands/tasks.rs`
- `src-tauri/src/services/tool_bridge.rs`
- `src-tauri/src/services/remote_api.rs`
- `extensions/orchestra-tools.ts`
- `src/types.ts`
- `src/lib/orchestraClient/client.ts`
- `src/lib/orchestraClient/tauriBindings.ts`
- `src/lib/orchestraClient/remoteApiClient.ts`
- `src/lib/orchestraClient/mockBindings.ts`
- `src/lib/tauri.ts`
- `src/pages/TasksPage.tsx`
- `src/pages/tasks/TaskDetailPage.tsx`
- `src/styles.css`
- transition/tool/UI regression tests

## Non-goals
- Do not require summaries for pause/stop/reset operational controls.
- Do not migrate historical free-form comments into summaries.
- Do not add summary-driven task list filtering/sorting in this ticket.

## Final recommendation
Implement ORC-258 as an **explicit transition-summary contract**:

- `summary` required on close/move transitions
- `notes` optional and separate
- summary persisted on lane runs + pending assignments
- `task.laneSummaries[]` rendered prominently in task details
- prompt/tool/help text updated so agents know the requirement before they transition

That gives Orchestra durable lane handoff summaries without inventing a second workflow system beside the one it already has.