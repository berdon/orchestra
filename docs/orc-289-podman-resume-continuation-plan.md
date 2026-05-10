# ORC-289 — Podman resume / Needs Work continuation regression plan

## tl;dr
- Add one focused supported desktop Podman regression that proves resumed work actually produces new session activity after:
  1. `awaiting_user_approval` → `Needs work`
  2. `blocked` → `Resume`
  3. `Whip` on the resumed assignment
- Use a deterministic fake Pi fixture in the desktop Podman runner so the spec can assert real session continuation, not just state labels.
- Fix the shared resume-delivery path so reactivated work chooses the correct live-session delivery mode after review/blocked pauses, and move manual whip delivery onto that same backend-owned path.

## Executive summary
Current coverage proves the UI shows the right buttons and that task/assignment state flips back to `active`, but it does **not** prove the resumed session actually starts working again. The main risk surface is the shared reactivation path in `src-tauri/src/commands/tasks.rs` / `src-tauri/src/services/task_runtime.rs`: approval rework, intervention resume, and blocked-task resume all reuse the same session/assignment shell, while blocked-task cleanup may also tear the live runtime down first. The strongest implementation direction is to add one shared backend helper for “continue this assignment now” and make it choose `prompt` vs `follow_up` from the real session state instead of hard-coding a rework follow-up send. Then lock that behavior down with a deterministic Podman desktop spec that observes new assistant output and whip interaction after resume.

## What exists today and why it is insufficient
- `tests/e2e/tasks.spec.ts`
  - browser-mock coverage already checks that approval-paused rework appends the rework prompt into mock session state.
  - this is useful, but it is **not** the supported desktop Podman path and it does not prove a live runtime actually continues.
- `tests/desktop-e2e/lane-approval.test.ts`
  - currently checks state transitions, session ids, and role operation counts for approval/intervention resume flows.
  - it does **not** assert a fresh assistant turn or any other observable continued execution after `Needs work` / `Resume`.
- `tests/desktop-e2e/task-whip.test.ts`
  - currently covers whip counters/reset behavior.
  - it does **not** prove the task-detail whip meaningfully delivers new work to a resumed session.
- `tests/desktop-e2e/lane-approval.test.ts` also has a paused-session direct-message regression, but it only checks command acceptance/logs, not that the session actually answers.

## Likely failure surface
1. `start_assignment_follow_up(...)` is the shared post-resume nudge path for review return / intervention resume / channel-based rework.
2. That path is distinct from normal `send_session_message`, which already resolves `prompt` vs `follow_up` based on whether the session is actually busy.
3. The blocked-task path can stop and retire the live runtime before resume, so “resume same session” may really mean “recreate the runtime and restart work for the same session id”.
4. Manual whip delivery is split today:
   - frontend `src/pages/TasksPage.tsx` sends the session message
   - backend `manual_task_whip` only records whip bookkeeping
   This split makes it easy for the UI to increment whip state without one backend-owned proof that resumed-session delivery actually happened.

## Plan

### 1. Add a dedicated deterministic desktop Podman fixture
- Add a new fake Pi RPC fixture under `tests/desktop-e2e/fixtures/` modeled after `fake-pi-model-auth-fixture.mjs`.
- The fixture should:
  - accept `prompt`, `follow_up`, and `steer`
  - append durable user + assistant events
  - emit `agent_end`
  - make the assistant text include the incoming message so the test can prove which resume/whip nudge actually ran
- Teach `scripts/run-desktop-e2e.sh` to select that fixture for the new ORC-289 desktop spec, the same way the model-auth spec swaps in its fixture.

### 2. Add one focused supported desktop spec for continuation-after-resume
Prefer a new spec such as `tests/desktop-e2e/task-resume-continuation.test.ts` rather than further growing the generic approval file.

The spec should cover all three assertions in one deterministic flow family:
- **approval review → Needs Work**
  - pause a role-owned task for approval
  - click `Needs work`
  - assert:
    - task returns to `in_progress`
    - same assignment/session is reused when no explicit Needs Work lane is configured
    - session record gains a fresh assistant reply after the resume nudge
    - logs/events show a real delivery path, not just UI state churn
- **blocked → Resume**
  - preserve a blocked task in paused state via the existing manual-block path
  - click `Resume`
  - assert:
    - task returns to `in_progress`
    - same session id is reused even if the runtime was torn down
    - a fresh assistant reply appears after resume
- **whip on resumed work**
  - after either resumed path, click `Whip`
  - assert:
    - whip count increments
    - the session record gains another new user/assistant turn caused by the whip message
    - the resumed session returns to idle/settled instead of stalling with only counter changes

For “observable continuation”, use session-record event growth and assistant text, not just task badges.

### 3. Fix the shared assignment-continuation path
Add one backend-owned helper for “resume this assignment’s work now” and use it from:
- `mark_task_needs_work`
- `resume_task_lane`
- channel/Telegram rework resume paths
- manual whip delivery if that flow is backend-owned after step 4

That helper should:
- ensure/recover the live runtime for the assignment session
- decide `prompt` vs `follow_up` from actual runtime/session busy state instead of always forcing one delivery type
- clear or recover stale run tracking when the session id is valid but the old runtime was already torn down

If the root cause is not delivery-type selection, the new spec should still localize the failure into this helper vs `live_sessions.rs` queued-delivery/run-tracking behavior.

### 4. Move task-detail whip delivery into the backend
- Change the task-detail whip action so the frontend no longer sends the message first and increments bookkeeping second.
- Make `manual_task_whip` own both:
  - delivery of the whip prompt
  - whip counter/domain-event updates
- Reuse the same continuation helper from step 3 so resumed flows and whip flows exercise one delivery contract.

### 5. Add backend coverage for the shared helper
Add or extend Rust tests around the continuation path so we keep a fast signal for:
- review-paused same-session resume
- blocked same-session resume after runtime cleanup
- manual whip against an active assignment using the shared delivery helper
- any prompt-vs-follow_up selection logic extracted from session send handling

## Expected touch points
- `scripts/run-desktop-e2e.sh`
- `tests/desktop-e2e/fixtures/<new fake pi fixture>.mjs`
- `tests/desktop-e2e/task-resume-continuation.test.ts` (preferred) or `tests/desktop-e2e/lane-approval.test.ts`
- `tests/desktop-e2e/task-whip.test.ts` if whip assertions stay there instead of the new focused spec
- `src-tauri/src/commands/tasks.rs`
- `src-tauri/src/services/task_runtime.rs`
- `src-tauri/src/commands/sessions.rs` and/or `src-tauri/src/services/live_sessions.rs` if delivery-mode selection is extracted
- `src-tauri/src/services/channels.rs`
- `src/pages/TasksPage.tsx`

## Validation
- Focused supported Podman run for the new regression:
  - `./scripts/run-desktop-e2e-podman.sh tests/desktop-e2e/task-resume-continuation.test.ts`
- If whip coverage remains separate, also run:
  - `./scripts/run-desktop-e2e-podman.sh tests/desktop-e2e/task-whip.test.ts`
- Final supported subset confidence pass:
  - `./scripts/run-desktop-e2e-suite-podman.sh tests/desktop-e2e/task-resume-continuation.test.ts tests/desktop-e2e/lane-approval.test.ts tests/desktop-e2e/task-whip.test.ts`

## Expected outcome
After implementation, the supported desktop Podman suite will prove that `Needs work`, `Resume`, and post-resume `Whip` all cause real continued session activity, and the live runtime/backend path will no longer be able to silently flip task state back to `active` while the underlying session stays stalled.