# ORC-68 task-comment notification expansion plan

## tl;dr
Use one comment-notification policy keyed off the **current lane state**, not only the active runtime assignment. Keep live session delivery for `active` worker-owned lanes, explicitly queue worker follow-up for `queued` worker-owned lanes, and reuse the existing user mailbox + `mailbox.sent` notification path for user-facing review/intervention states and user-owned lanes with no runtime. Do not notify unrelated paused workers, and do not send user mailbox notifications for user-authored comments.

## Executive summary
The current `comment_on_task` flow only checks `task_runtime::get_active_lane_assignment()` in `src-tauri/src/commands/tasks.rs`, so comment delivery logic runs only when the current task has an open assignment in `queued` or `active` state. That already excludes the review/user-facing states called out in ORC-68 (`awaiting_user_approval`, `awaiting_user_intervention`, `paused_by_user`, and user-owned lanes with no runtime assignment).

There is also a narrower bug inside the existing worker path: `notify_active_assignment_delivery()` in `src-tauri/src/services/task_runtime.rs` returns `Ok(())` unless the assignment status is exactly `active`, so `queued` assignments never reach the fallback queue path even though `comment_on_task` looks them up.

The recommended fix is to centralize comment-notification routing around `get_current_lane_assignment()` plus the current task owner state:
- `active` worker-owned lane → live runtime delivery, with existing queue fallback on live failure
- `queued` worker-owned lane → explicit queued worker delivery via existing role/agent queue surfaces
- `awaiting_user_approval`, `awaiting_user_intervention`, `paused_by_user` → user mailbox delivery via existing inbox/system-notification surfaces
- user-owned lane with no runtime assignment → user mailbox delivery via the same mailbox path

This keeps recipient semantics aligned to the task’s **current attention owner**, avoids waking paused worker sessions that are explicitly waiting on the user, and reuses existing mailbox/session notification infrastructure instead of creating a new one-off comment alert system.

## Current-state findings

### 1. `comment_on_task` only routes through `get_active_lane_assignment()`
`src-tauri/src/commands/tasks.rs`
- After saving the comment, `comment_on_task()` calls `task_runtime::get_active_lane_assignment(&connection, &task_id)`.
- `get_active_lane_assignment()` only returns assignments with status `queued` or `active`.
- If that query returns `None`, the command records the comment and emits task-change events, but it does not create any worker delivery or user mailbox delivery.

Implication: comments on tasks in review/intervention-paused states currently rely only on later unread checks and UI unread badges.

### 2. `queued` assignments are found, but they do not actually get queued comment delivery today
`src-tauri/src/services/task_runtime.rs`
- `notify_or_queue_unread_comment_delivery()` only calls `queue_comment_delivery()` when the live notify closure returns `Err(...)`.
- `notify_active_assignment_delivery()` returns `Ok(())` immediately unless `assignment.status == "active"`.
- For a `queued` assignment, the notify closure therefore succeeds as a no-op, so fallback queueing never runs.

Implication: current behavior is effectively:
- `active` worker-owned assignment: live delivery attempt, with queue fallback only if live delivery errors
- `queued` worker-owned assignment: no live delivery and no queue fallback

### 3. Review/user-paused states already exist in the runtime model, but `comment_on_task` ignores them
`src-tauri/src/services/task_runtime.rs`
- `get_current_lane_assignment()` includes `queued`, `active`, `awaiting_user_approval`, `awaiting_user_intervention`, and `paused_by_user`.
- `complete_lane_as_success()`, `request_user_intervention()`, `pause_task_lane()`, and related paths move tasks into user-facing states by leaving the current lane assignment open but changing its status to one of those review/intervention states.
- `move_task_to_user_review()` also flips the task itself to `assignee_type = 'user'` and `status = 'in_review'`.

Implication: the backend already knows when the current lane is paused for user attention; the comment-notification path is simply looking at the narrower "active assignment" view.

### 4. User-owned lanes can have no runtime assignment at all
`src-tauri/src/services/task_runtime.rs`
- `dispatch_task_lane()` rejects lanes whose `assigned_entity_type == "user"`.
- Transition paths can still move a task into a user-owned workflow lane and mark it `in_review`.

Implication: for user-owned lanes there may be no assignment row that can receive session or queue delivery, so comment notifications need a non-runtime surface.

### 5. Orchestra already has the user unread/mailbox primitives needed for the user-facing half of the fix
Relevant files:
- `src-tauri/src/services/tasks.rs`
- `src-tauri/src/services/messages.rs`
- `src/App.tsx`

Existing building blocks:
- user unread comment receipts already exist via `count_unread_task_comments_for_user()` / `mark_task_comments_read_for_user()`
- user mailbox deliveries already exist via `mailbox_messages` + `mailbox_message_deliveries`
- `mailbox.sent` already drives inbox refresh and system notifications in `src/App.tsx`

Implication: user-facing comment notifications can reuse mailbox delivery instead of inventing a separate user-comment notification channel.

## Recommended notification semantics

### Recipient rule
Route comment delivery to the **current attention owner**:
- worker-owned runtime states (`active`, `queued`) notify the assigned worker
- user-facing states (`awaiting_user_approval`, `awaiting_user_intervention`, `paused_by_user`, or a user-owned lane with no runtime) notify the user mailbox

This deliberately avoids notifying both sides for a single comment.

### Author/self-notification rule
For user mailbox delivery, do **not** notify on comments whose `origin_type == "user"`.
- This matches existing user unread-comment semantics in `count_unread_task_comments_for_user()`.
- It avoids user self-spam when the task is already in a user-facing state.

For worker delivery, keep existing worker semantics unchanged unless implementation finds an obvious bug outside this ticket.

### Interrupt rule
Treat `interrupt_agent` as a **worker-delivery hint only**:
- `active` worker session → `steer` vs `follow_up` as today
- `queued` worker queue entry → same `steer` vs `follow_up` mapping as today
- user mailbox delivery → normal mailbox priority; do not reinterpret `interrupt_agent` as a user interrupt flag

## Delivery matrix

| Current lane state | Current behavior | Recommended behavior |
| --- | --- | --- |
| `active` worker-owned lane | Live session delivery attempt; queue fallback only on runtime error | Keep current live delivery path and existing fallback queue behavior |
| `queued` worker-owned lane | No live delivery; no queue fallback because live notify returns `Ok(())` | Explicitly queue worker comment delivery using existing `queue_comment_delivery()` path |
| `awaiting_user_approval` | No direct notification | Create a user mailbox delivery for non-user comments |
| `awaiting_user_intervention` | No direct notification | Create a user mailbox delivery for non-user comments |
| `paused_by_user` | No direct notification | Create a user mailbox delivery for non-user comments |
| user-owned lane with no open assignment | No direct notification | Create a user mailbox delivery for non-user comments |

## Recommended implementation

### 1. Centralize comment-notification routing behind one helper
Add a helper near the existing task-runtime delivery logic, for example in `src-tauri/src/services/task_runtime.rs`, that accepts:
- `task`
- `current_assignment`
- `comment`
- app/state context needed for live delivery or mailbox creation

Recommended helper responsibility:
- inspect `get_current_lane_assignment()` instead of `get_active_lane_assignment()`
- decide whether the recipient is the active runtime session, queued worker delivery, user mailbox, or no one
- return a structured outcome/warning so `comment_on_task()` remains thin

A small enum-based approach is recommended, e.g.:
- `ActiveWorkerSession(TaskLaneAssignment)`
- `QueuedWorker(TaskLaneAssignment)`
- `UserMailbox`
- `None`

That keeps the state matrix explicit and reduces future gaps when more assignment statuses are added.

### 2. Keep active worker delivery behavior as-is
Reuse the existing pieces for `active` assignments:
- `notify_active_assignment_of_unread_comments()`
- `notify_or_queue_unread_comment_delivery()`
- `queue_comment_delivery()` fallback on live-delivery failure

This preserves current active-lane behavior and keeps the acceptance criteria around non-regression straightforward.

### 3. Make `queued` delivery explicit instead of relying on the live-notify fallback
Do not depend on `notify_active_assignment_delivery()` to “fail into” queueing for `queued` assignments.

Recommended change:
- if `current_assignment.status == "queued"`, call `queue_comment_delivery()` directly
- keep the current active-only live-delivery helper strict; do not blur queued and active semantics inside it

That makes the queued-worker behavior intentional and testable.

### 4. Reuse mailbox delivery for user-facing states
Add a helper in `src-tauri/src/services/messages.rs` or `task_runtime.rs` to create a **user mailbox delivery derived from a task comment**.

Recommended behavior:
- recipient: existing default user mailbox recipient
- task context: set `task_id` so the delivery is task-scoped
- sender label: the comment author
- message body: a compact synthesized comment-notification body that makes it clear this was generated from a task comment, not manually typed mailbox mail
- priority: normal

Important: the comment path must also emit the same `mailbox.sent` app/inbox change events that ordinary mailbox sends use, otherwise the existing inbox/system-notification surface will not light up.

### 5. Use current-owner semantics for review/user-paused states
For `awaiting_user_approval`, `awaiting_user_intervention`, and `paused_by_user`, do **not** also queue or steer the paused worker.

Reasoning:
- those states explicitly mean the worker is waiting on the user
- the task is already assigned to the user (`move_task_to_user_review()`)
- waking the paused worker on every comment would blur ownership and risk spam
- the worker should be re-engaged by the existing explicit review actions (`approve`, `resume`, `send back for work`), not by passive comment traffic

### 6. Handle user-owned lanes without a runtime assignment
If `get_current_lane_assignment()` returns `None`, but the task is currently on a user-owned lane / `assignee_type == "user"`, route non-user comments to the user mailbox anyway.

This closes the pure user-lane gap that `get_active_lane_assignment()` can never cover.

### 7. Add a short code comment near the helper documenting the matrix
This behavior is subtle enough that the implementation should include a durable code comment or doc comment describing the delivery matrix and why review-paused states intentionally go to the user mailbox instead of the paused worker runtime.

## Regression coverage plan

## Backend test matrix
Add focused Rust coverage around the centralized routing helper and/or the `comment_on_task` path.

Recommended cases:
1. **active worker-owned lane**
   - comment attempts live delivery
   - if live delivery errors, fallback queue entry is created
2. **queued worker-owned lane**
   - comment creates a queued `task_comment` delivery for the assigned agent/role
   - no live-runtime requirement
3. **awaiting user approval**
   - non-user comment creates exactly one unread user mailbox delivery for the task
   - no worker queue/session delivery is created
4. **awaiting user intervention**
   - same mailbox expectation as above
5. **paused by user**
   - same mailbox expectation as above
6. **user-owned lane with no assignment**
   - non-user comment creates a user mailbox delivery even though no active/current runtime assignment exists
7. **user-authored comment on user-facing state**
   - no user mailbox self-notification is created

Good existing anchors to extend:
- `src-tauri/src/services/task_runtime.rs` tests for `queue_comment_delivery()` and unread comment delivery fallback
- `src-tauri/src/services/messages.rs` tests for user inbox listing/read behavior

## Optional UI/mock follow-up
If browser/mock e2e coverage is desired for the user mailbox path, mirror the same semantics in:
- `src/lib/tauri.ts` `commentOnTask()` mock

That would allow a small web e2e scenario to assert that commenting on an awaiting-user-review task emits `mailbox.sent` and surfaces in inbox/system-notification flows. This is optional if the implementation keeps coverage backend-only and relies on already-covered mailbox UI behavior.

## Expected file touch points
- `src-tauri/src/commands/tasks.rs`
- `src-tauri/src/services/task_runtime.rs`
- `src-tauri/src/services/messages.rs`
- `src-tauri/src/services/tasks.rs` only if a small helper/query is needed for user-lane detection or user unread symmetry
- optional: `src/lib/tauri.ts` if mock behavior needs parity
- tests in `src-tauri/src/services/task_runtime.rs`
- tests in `src-tauri/src/services/messages.rs` or a new focused backend test module

## Validation
Recommended focused validation after implementation:

```bash
cargo test task_runtime::tests::notify_or_queue_unread_comment_delivery_falls_back_to_queue_without_failing -- --exact
cargo test task_runtime::tests -- --nocapture
cargo test messages::tests::user_inbox_lists_and_marks_user_messages_read -- --exact
```

And specifically verify one test per target state in the ORC-68 matrix so future status additions do not silently reintroduce gaps.
