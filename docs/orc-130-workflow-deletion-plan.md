# ORC-130 — workflow deletion plan

## tl;dr

- Add a real **hard-delete workflow** path, but only for **orphaned workflows**.
- Treat **archive** as the supported retention path for workflows that are still referenced by tasks, schedules, runtime assignments, or queued work.
- Implement a shared **delete-impact check** plus a guarded **delete_workflow** command/API/UI flow with clear blocker messaging, explicit confirmation, audit/event logging, and regression coverage.

## Executive summary

Orchestra already supports create/update/duplicate/archive for workflows, but it does not have a supported way to permanently remove one. The safest product rule with the current architecture is: **a workflow can be deleted only when no persisted operational state still references it**.

That rule fits the codebase as it exists today:

- task editing and task list loading still expect live workflow definitions for referenced tasks
- active lane/runtime flows still dereference workflow + lane data at execution time
- queue/assignment records retain workflow ids without a full historical workflow snapshot
- archive already exists as the non-destructive path for workflows that should disappear from normal selection but must remain historically valid

So the recommended design is **hard delete for unused workflows, archive for used workflows**.

## Current-state constraints

Relevant current surfaces:

- backend workflow service: `src-tauri/src/services/workflows.rs`
- Tauri commands: `src-tauri/src/commands/workflows.rs`
- remote API routes: `src-tauri/src/services/remote_api.rs`
- command authorization + tool bridge: `src-tauri/src/services/command_authorization.rs`, `src-tauri/src/services/tool_bridge.rs`
- frontend workflow settings UI: `src/settings/WorkflowsPanel.tsx`
- frontend workflow client bindings: `src/lib/tauri.ts`, `src/lib/orchestraClient/*`

Relevant persisted references today:

- `tasks.workflow_id` (`ON DELETE SET NULL`)
- `task_schedules.workflow_id` (`ON DELETE SET NULL`)
- `task_lane_assignments.workflow_id` (no FK cleanup)
- `role_queue_entries.source_workflow_id` (no FK cleanup)
- `agent_queue_entries.source_workflow_id` (no FK cleanup)
- `workflow_lanes.workflow_id` (`ON DELETE CASCADE`)

Important architectural detail: the system does **not** currently snapshot enough workflow/lane metadata into every runtime/history record to let us safely delete a referenced workflow and preserve equivalent behavior/UX.

Examples from the current code:

- `src/pages/TasksPage.tsx` eagerly loads workflow definitions for non-draft tasks.
- `src-tauri/src/services/task_runtime.rs` resolves active assignment workspace behavior from the live workflow/lane definition.
- role/agent queue validation still checks that referenced task/workflow/lane sources are valid.

That makes silent detachment or partial cascade deletion the wrong default.

## Product decision: deletion rules

### Allowed delete

A workflow is deletable only when it has **zero external references** in persisted state.

Recommended blocker categories:

1. tasks referencing the workflow
2. task schedules referencing the workflow
3. task lane assignments referencing the workflow
4. role queue entries referencing the workflow
5. agent queue entries referencing the workflow

If all five counts are zero, delete is allowed.

### Blocked delete

If any blocker count is non-zero, delete must fail with a structured, user-facing explanation.

Recommended user guidance:

- say that the workflow is still referenced and cannot be permanently deleted yet
- show counts by blocker type
- direct the user to **archive** the workflow instead when they want it out of normal use but still historically retained

### What deletion does

When delete is allowed, Orchestra should:

- delete the `workflows` row
- let `workflow_lanes` cascade naturally
- emit audit/log/domain-event records for the delete action
- leave unrelated data untouched, because the precondition guarantees there is nothing else to rewrite

### What does *not* block delete

Purely denormalized string payloads should not block delete. For example, domain-event payload JSON that already contains copied workflow ids/names can remain as historical strings.

## Why not auto-detach tasks/schedules on delete?

Although the schema could null some foreign keys automatically, that would create bad product behavior:

- tasks would silently lose their workflow identity
- task/schedule UX would drift from what users configured
- runtime/history records with plain workflow ids would become harder to interpret
- delete would become a hidden data-mutation operation instead of a clear remove-only action

That is too surprising for a destructive admin flow. The clean split is:

- **Archive** = hide but preserve references
- **Delete** = remove only when nothing still depends on it

## Recommended backend shape

### 1) Add a reusable delete-impact model/helper

Add a small workflow deletion inspection model, e.g. a `WorkflowDeleteImpact`/`WorkflowDeletionCheck` struct with:

- `workflowId`
- `workflowName`
- `canDelete`
- per-category reference counts
- optional derived blocker messages

Add a shared service helper in `src-tauri/src/services/workflows.rs` that:

- verifies the workflow exists
- counts references in the blocker tables
- returns the structured result

This helper should back both the UI preview and the final delete action.

### 2) Add `delete_workflow`

Add a new backend delete function in `src-tauri/src/services/workflows.rs` that:

- opens a write transaction
- re-runs the deletion check inside the transaction
- fails if any blocker count is non-zero
- deletes the workflow row if safe
- returns either the deleted workflow summary/definition or a small delete result payload

No DB migration should be required for the core delete path.

### 3) Add Tauri command + audit/event plumbing

Add a new command in `src-tauri/src/commands/workflows.rs` and register it through:

- `src-tauri/src/lib.rs`
- `src-tauri/src/services/tool_bridge.rs`
- `src-tauri/src/services/command_authorization.rs`

Also add:

- a new permission: `workflows.delete`
- log/audit entry: `delete_workflow`
- domain event topic: `workflow.deleted`

Mirror the new topic where frontend unions/options are enumerated, including `src/types.ts` and the workflow event option list in `src/pages/tasks/TaskScheduleEditorForm.tsx`.

### 4) Add hosted-web parity

Expose the same behavior through:

- `DELETE /api/v1/workflows/:workflow_id`
- a lightweight preview route if needed for UX, e.g. `GET /api/v1/workflows/:workflow_id/delete-impact`

Then thread the new methods through:

- `src/lib/orchestraClient/client.ts`
- `src/lib/orchestraClient/tauriBindings.ts`
- `src/lib/orchestraClient/remoteApiClient.ts`
- `src/lib/orchestraClient/mockBindings.ts`
- `src/lib/tauri.ts`

## UI/UX plan

### 1) Add a Delete action to `WorkflowsPanel`

In `src/settings/WorkflowsPanel.tsx`:

- add a danger-style **Delete** button near Duplicate/Archive
- keep it available for selected persisted workflows
- allow deleting archived workflows too, since archive may be the intermediate state before final cleanup

### 2) Use a confirmation modal, not a blind click

Recommended flow:

1. user clicks **Delete**
2. UI loads delete-impact data
3. modal shows one of two states:
   - **safe to delete**: permanent-delete warning + confirm button
   - **blocked**: blocker counts + confirm disabled/hidden + guidance to archive instead

Suggested copy themes:

- safe state: “This permanently deletes the workflow definition and its lanes. This cannot be undone.”
- blocked state: “This workflow is still referenced by tasks, schedules, or runtime records and cannot be deleted safely.”

A modal confirmation is enough here because the allowed-delete case is already constrained to orphaned workflows.

### 3) Post-delete UI behavior

After successful delete:

- refresh workflow list
- clear stale detail state
- select the next remaining workflow, or fall back to the blank/new state
- surface inline success/error messaging through the existing panel error/action state

### 4) Help-text update

Update the workflow-library explanatory copy to reflect the new lifecycle clearly:

- workflows can be edited/duplicated/archived
- only unreferenced workflows can be permanently deleted
- archive is the safe alternative for historically used workflows

That change will also require updating the browser e2e assertion in `tests/e2e/workflows.spec.ts`.

## Mock/browser parity

Because the browser-only Playwright workflow settings coverage relies on mock bindings, mock workflow deletion should exist too.

Recommended mock behavior:

- allow deleting workflows with no mock task/schedule references
- block deletion when mock tasks or mock schedules still reference the workflow
- keep the mock rule intentionally aligned with the real product rule, even if the mock does not simulate every runtime-history table

## Automated coverage plan

### Backend/service coverage

Add tests in `src-tauri/src/services/workflows.rs` for at least:

1. deleting an unused workflow succeeds and removes its lanes
2. delete fails when a task references the workflow
3. delete fails when a task schedule references the workflow
4. delete fails when a task lane assignment references the workflow
5. delete fails when a role queue entry references the workflow
6. delete fails when an agent queue entry references the workflow

### Command / transport / authorization coverage

Update coverage for:

- command registration in `src-tauri/src/lib.rs`
- command authorization allowlist
- tool bridge command dispatch
- Orchestra tools extension registration/execution tests in `tests/orchestra-tools-extension.tools.test.ts`

### UI coverage

Add workflow settings coverage for:

1. deleting an unused workflow removes it from the library
2. a referenced workflow shows a blocked delete state and is not removed
3. help text reflects archive-vs-delete guidance

Desktop e2e is the best place for the blocked case if the test needs real backend reference counts.

## Non-goals

This task should **not** attempt to make historically used workflows deletable by rewriting or snapshotting every old runtime/history record.

If Orchestra later wants “delete even after past use,” that should be a separate design task with explicit history-snapshotting work. For ORC-130, the simpler and safer contract is enough:

- **unused => deletable**
- **referenced => archivable, not deletable**
