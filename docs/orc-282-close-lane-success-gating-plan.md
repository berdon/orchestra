# ORC-282 close-lane success gating plan

## tl;dr
- Keep unread comments behind the completion tool, and narrow unread-mail plus unfinished-todo gating to `complete_lane_as_success` on active worker assignments.
- Return one actionable completion-blocker error that can mention unread comments, unread mail, unfinished todos, or the relevant combination.
- Simplify lane prompt/completion guidance by removing the manual pre-transition comment/mail/todo checklist, since the completion tool will enforce those checks itself.
- Mirror the runtime rule in mock mode and cover the change with focused runtime + prompt tests.

## Executive summary
`src-tauri/src/services/task_runtime.rs::complete_lane(...)` already checks unread comments, unread mail, and unfinished current-lane todos before allowing a lane-closing transition, but its behavior is broader than ORC-282 asks for. Right now it blocks **every** completion outcome, returns only the first mail/todo blocker it finds, and still tells workers to manually run the mail/todo checks immediately before transition.

ORC-282 should tighten that behavior to the actual product rule:

- unread comments remain a general completion guard, but only behind the completion tool itself
- unread mail and unfinished current-lane todos block **success** transitions only
- the failure message must say exactly what the worker needs to check next: unread comments, unread mail, unfinished todos, or the relevant combination
- the generated lane guidance should stop telling workers to manually perform comment/mail/todo pre-transition checks

This is a logic-and-prompt update, not a schema/API change.

## Findings from the current code
- `src-tauri/src/services/task_runtime.rs::complete_lane(...)` already has the relevant validation hook.
- The current unread-mail and unfinished-todo checks run before outcome-specific branching, so they also block `complete_lane_as_failure` and `request_user_intervention`.
- The current errors short-circuit one at a time, so a worker with both unread mail and open todos gets partial guidance per retry.
- The generated worker prompt still includes explicit pre-completion instructions to call `get_unread_task_comments`, `mark_task_comments_read`, `get_unread_mail`, `mark_mail_read`, and `list_unfinished_task_todos` immediately before completion.
- `src/lib/tauri.ts::completeMockTaskLane(...)` already mirrors unfinished-todo gating in browser/mock mode, but it does so for every outcome and does not yet mirror unread-mail success gating.

## Implementation plan

### 1. Make mail/todo validation success-only in `task_runtime.rs`
In `src-tauri/src/services/task_runtime.rs::complete_lane(...)`:

- keep assignment status/auth validation unchanged
- keep unread-comment validation unchanged
- move unread-mail and unfinished-current-lane-todo validation behind `if outcome == "success"` for active worker assignments
- leave the no-active-assignment/user-review path unchanged

That preserves the existing comment-safety rule while allowing failure/intervention transitions to proceed when success-specific checklist items are still open.

### 2. Return one combined actionable blocker message
Add a small helper in `src-tauri/src/services/task_runtime.rs` that:

- loads unread mail with `messages::list_unread_mail_for_authorization(...)`
- loads unfinished current-lane todos with `tasks::list_unfinished_task_todos(...)`
- returns success when both are empty
- otherwise builds one error that explicitly tells the worker to check:
  - unread mail only, or
  - unfinished todos only, or
  - both unread mail and unfinished todos

The message should keep the existing actionable style by naming the exact next tools to use:

- `get_unread_mail(taskId)` / `mark_mail_read(taskId)`
- `list_unfinished_task_todos(taskId, laneId=...)`

### 3. Simplify lane completion guidance
Update the generated prompt text in `src-tauri/src/services/task_runtime.rs` so it no longer tells workers to manually do the mail/todo pre-transition checklist.

Concretely:
- remove the completion-rule line that says to call `get_unread_mail`/`mark_mail_read` immediately before any completion tool
- remove the completion-rule line that says to call `list_unfinished_task_todos` immediately before any completion tool
- remove/reword the working-rule line that turns unfinished todos into a mandatory manual pre-transition step
- keep the broader resume/check-comment/check-mail guidance intact

## Mock parity
Update `src/lib/tauri.ts::completeMockTaskLane(...)` to mirror the runtime rule as closely as possible:

- unfinished current-lane todos should block `success` only
- unread mail should block `success` when there is visible unread assignment mail or direct unread agent mail for the active assignment worker
- failure/intervention outcomes should not be blocked by those success-only guards

A practical mock approximation is to inspect unread mailbox entries that target:
- `assignmentId === task.activeLaneAssignment.id`
- `recipientType === "agent" && recipientId === task.activeLaneAssignment.workerId`

## Test plan

### Rust/runtime tests
Add focused coverage in `src-tauri/src/services/task_runtime.rs` for:
- unread mail blocks `complete_lane_as_success` until `mark_mail_read(...)`
- combined unread-mail + unfinished-todo failure mentions both blockers and both next-step tools
- `complete_lane_as_failure` is still allowed when unread mail or unfinished todos remain
- `request_user_intervention` is still allowed when unread mail or unfinished todos remain

### Prompt tests
Update the existing prompt assertions in `src-tauri/src/services/task_runtime.rs` to verify:
- resume/check-comment/check-mail guidance still exists
- the explicit pre-completion comment/mail/todo checklist lines are gone

### Mock/frontend tests
Add or adjust coverage around `src/lib/tauri.ts::completeMockTaskLane(...)` so browser/mock mode matches the new success-only gating semantics.

## Expected touch points
- `src-tauri/src/services/task_runtime.rs`
- `src/lib/tauri.ts`
- runtime tests in `src-tauri/src/services/task_runtime.rs`
- mock/unit coverage for `src/lib/tauri.ts`

## Out of scope
- database/schema migrations
- tool schema or transport changes
- broader task-detail UI redesign beyond copy updates that keep todo warnings aligned with the new success-only gating
