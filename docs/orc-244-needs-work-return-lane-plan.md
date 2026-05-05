# ORC-244 Needs Work return-lane plan

## tl;dr
Add an optional `needsWorkTargetLaneId` workflow-lane field. Show a `Needs Work` lane picker only when `requireUserApprovalOnSuccess` is enabled. If the field is set, clicking `Needs Work` should close the approval-paused lane and move the task to that configured lane. If the field is unset, preserve the current behavior and resume the same paused lane/session.

## Executive summary
This feature should be modeled as a review-specific lane routing rule, not as ordinary failure routing. The workflow editor, persisted workflow lane schema, mock/runtime validation, and the real `mark_task_needs_work` transition all need to learn the new optional target lane. The safest backward-compatible fallback is to keep today’s same-lane/session reactivation when no explicit target is configured.

## Proposed implementation
- **Schema / API / persistence**
  - Add nullable `needs_work_target_lane_id` / `needsWorkTargetLaneId` to workflow lane models, workflow upsert inputs, duplication helpers, remote API payloads, tool schemas, and TS types.
  - Add a DB migration for `workflow_lanes.needs_work_target_lane_id` and include it in workflow lane load/write queries.
- **Workflow editor**
  - In `src/settings/WorkflowsPanel.tsx`, add a `Needs Work target lane` control above `On failure`.
  - Only render it when `requireUserApprovalOnSuccess` is enabled.
  - Make the empty option explicit, e.g. `Resume current lane/session (legacy default)`, so fallback behavior is visible.
  - Exclude the current lane from selectable explicit targets so `null` remains the single “stay on this lane” path.
- **Validation / normalization**
  - `needsWorkTargetLaneId` is optional.
  - If present, it must reference an existing lane id.
  - If `requireUserApprovalOnSuccess` is false, normalize/clear the field and reject persisted invalid combinations.
  - If a referenced lane is deleted or missing, surface the same invalid-reference error pattern used for other transition targets.
- **Runtime behavior**
  - Keep the existing `mark_task_needs_work` reactivation path when `needsWorkTargetLaneId` is unset.
  - When it is set, use a dedicated review-return helper instead of the generic failure/re-lane helper so `Needs Work` stays distinct from `On failure`.
  - That helper should close the approval-paused assignment/lane run, move the task to the configured lane, and reuse existing auto-dispatch logic for worker-owned target lanes.
- **Fallback semantics**
  - Legacy workflows and newly edited lanes with no explicit `needsWorkTargetLaneId` continue to resume the same current lane/session after `Needs Work`.
  - Configured target lanes opt into explicit re-laning behavior.

## Expected touch points
- `src-tauri/src/models.rs`
- `src-tauri/src/services/database.rs`
- `src-tauri/src/services/workflows.rs`
- `src-tauri/src/services/task_runtime.rs`
- `src-tauri/src/commands/tasks.rs`
- `src/types.ts`
- `src/lib/tauri.ts`
- `src/settings/WorkflowsPanel.tsx`
- `tests/e2e/workflows.spec.ts`
- `tests/e2e/tasks.spec.ts`
- `tests/desktop-e2e/lane-approval.test.ts` (or a new nearby desktop E2E)
- `tests/orchestra-tools-extension.tools.test.ts` if workflow tool schemas are snapshotted there

## Test plan
- Rust workflow tests: persistence, duplication, validation, hidden/invalid combinations.
- Rust runtime tests: configured `Needs Work` lane moves the task to that lane; unset field preserves same-session fallback.
- Mock/web tests: workflow editor visibility + persistence, runtime `Needs Work` behavior.
- Podman desktop E2E: configure the workflow through settings UI, verify the control hides when approval is off, run a task into approval pause, click `Needs Work`, and verify the task lands in the configured lane.
