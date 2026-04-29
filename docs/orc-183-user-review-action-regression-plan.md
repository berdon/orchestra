# ORC-183 user-review action regression plan

## tl;dr
- Treat `pendingOutcome` as the source of truth whenever a task is already in `status="in_review"` with `assigneeType="user"`.
- Replace fragmented raw `activeLaneAssignment.status` checks with one shared derived review-action state.
- Add regression coverage for mismatched review payloads so `Approve` / `Needs work` cannot silently fall back to `Resume` again.

## Executive summary
The current task-detail UI has partial normalization for review-paused work, but the logic is split across multiple call sites and still over-trusts raw assignment status in some cases. In particular, `src/pages/tasks/taskDetailActionState.ts` preserves explicit paused statuses before it consults `pendingOutcome`, while `src/pages/TasksPage.tsx` and `mobile/App.tsx` still branch on raw `activeLaneAssignment.status` for follow-up actions. That means a task that is already clearly in user review (`task.status === "in_review"`, `assigneeType === "user"`) can still surface `Resume` semantics when the persisted assignment status is stale or inconsistent even though the review outcome says the lane is awaiting approval.

## Reproduction target
Use a task-detail payload shaped like:

- `status: "in_review"`
- `assigneeType: "user"`
- `currentLaneId: <present>`
- `activeLaneAssignment.status: "awaiting_user_intervention"` or `"paused_by_user"`
- `activeLaneAssignment.pendingOutcome: "success"`

Today that combination falls into `Resume` rendering instead of `Approve` / `Needs work` because the helper preserves the raw paused status before it evaluates the review outcome.

## Root cause
1. `src/pages/tasks/taskDetailActionState.ts` only repairs one kind of status lag (`active`/`queued` + `pendingOutcome`).
2. The same file treats explicit paused statuses as authoritative even when they disagree with the task already being in a user-review state.
3. `src/pages/TasksPage.tsx` action dispatch and `mobile/App.tsx` button rendering do not reuse the shared derived state, so even the existing normalization is not applied consistently.
4. Current tests cover happy-path approval/intervention states, but they do not lock down mismatched `{ assignment.status, pendingOutcome }` combinations.

## Implementation plan
1. Replace the current status helper with a single derived review/action-state helper in `src/pages/tasks/taskDetailActionState.ts` that:
   - first recognizes user-owned review state from task ownership/status,
   - then prefers `pendingOutcome === "success" | "needs_user" | "paused"`,
   - only falls back to raw assignment status when no review outcome is present.
2. Reuse that shared derived state in:
   - `src/pages/tasks/taskDetailHeaderActions.ts`
   - `src/pages/tasks/TaskDetailPage.tsx`
   - `src/pages/TasksPage.tsx` follow-up action handling
   - `mobile/App.tsx`
3. Keep `paused_by_user` distinct only when the derived state actually represents a user pause, not approval review.
4. Audit nearby review/intervention branches so approval, intervention, explicit user pause, and user-owned no-runtime lanes remain disambiguated.

## Test plan
- Extend `tests/task-detail-action-state.test.ts` with mismatched explicit-status cases, especially:
  - `awaiting_user_intervention + pendingOutcome=success -> awaiting_user_approval`
  - `paused_by_user + pendingOutcome=success -> awaiting_user_approval`
  - `awaiting_user_approval + pendingOutcome=needs_user -> awaiting_user_intervention`
- Add/extend a task-detail UI test so those derived states produce the correct action set (`Approve` / `Needs work` vs `Resume`).
- Keep/update `tests/e2e/tasks.spec.ts` review-state coverage with a seeded inconsistent payload so the browser UI reproduces the exact regression.
- Re-run the existing desktop approval workflow coverage in `tests/desktop-e2e/lane-approval.test.ts` so podman-runner E2E still proves the real approval path never exposes `Resume` during approval review.

## Expected outcome
After implementation, user-review approval states will derive from the review outcome instead of stale paused-status hints, all task-detail surfaces will agree on the same action set, and regression coverage will explicitly fail if `Resume` ever reappears for approval-paused review work.
