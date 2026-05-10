# ORC-287 — whip reset and Podman regression plan

## tl;dr
- Current auto-whip logic has no real cadence gate, no way to distinguish unanswered whips from answered ones, and one whip path still writes task comments.
- Fix this in `src-tauri/src/services/task_runtime.rs` and `src-tauri/src/services/dispatcher.rs` by adding explicit cooldown + unanswered-streak handling, then reset and immediately redispatch the lane after more than 3 unanswered whips.
- Existing Podman coverage is not sufficient; extend `tests/desktop-e2e/task-whip.test.ts` with a deterministic automatic-whip/reset scenario.

## Executive summary
Today a task becomes whip-eligible as soon as its assignment is active and its session is idle. `last_whip_at` is written but never read, so once a session drops idle it can be whipped again on every dispatcher tick. `whip_count` is also monotonic for the whole assignment, so Orchestra cannot enforce “more than 3 unanswered whips” separately from “total whips ever sent on this assignment.” The only durable whip audit path currently in code is `escalate_task_whip_limit_exceeded`, which creates a task comment, violating the new requirement. Podman desktop coverage only proves config/diagnostics and does not execute the automatic whip lifecycle.

## Findings
- `load_task_whip_candidates` / `process_task_whips` never enforce a minimum interval between whips.
- Role whipping is now in scope in code (`worker_type IN ('agent', 'role')` plus a role `start_run` whip path), so the fix should cover both worker types unless we intentionally narrow behavior.
- `record_task_whip_sent` only increments `whip_count` and stamps `last_whip_at`; it cannot model an unanswered streak or reset-on-response behavior.
- `escalate_task_whip_limit_exceeded` is the current task-comment leak.
- `tests/desktop-e2e/task-whip.test.ts` only covers task creation defaults/custom values and a seeded runtime diagnostics view; it does not assert real automatic whips, cadence suppression, reset, recovery, or comment/history behavior.

## Plan
1. **Backend whip state + cadence**
   - Add explicit unanswered-whip state on `task_lane_assignments` instead of overloading `whip_count`.
   - Introduce a dedicated whip cooldown constant and make candidate refresh reject assignments whose `last_whip_at` is still inside the cooldown window.
   - Keep `whip_count` as the total whips for the current assignment/runtime display; use the unanswered streak for the hard `>3` reset rule.

2. **Response detection + reset semantics**
   - When a whipped session produces real worker output again, clear the unanswered streak before the next whip decision.
   - On the 4th unanswered whip, use a dedicated reset-and-redispatch helper rather than `reset_task_runtime` alone. `reset_task_runtime` intentionally leaves work ready and not auto-redispatched; the whip path needs “stop old session, clear claims, immediately dispatch a fresh assignment/session.”
   - End the old lane run as `canceled` with a whip-reset note, then start a fresh lane run for the replacement session.

3. **History instead of comments**
   - Remove the whip-specific task comment path.
   - Persist whip activity as lane/assignment history entries and surface them in task recent history / lane history instead of task comments.
   - Minimum events: whip sent, whip suppressed by cooldown, whip reset after `>3` unanswered attempts.

4. **Regression coverage**
   - Add backend unit tests in `src-tauri/src/services/task_runtime.rs` / `src-tauri/src/services/dispatcher.rs` for cooldown suppression, unanswered-streak reset after output, hard reset on the 4th unanswered whip, no comment creation, and fresh-session recovery.
   - Extend `tests/desktop-e2e/task-whip.test.ts` with a deterministic seeded scenario plus repeated `run_dispatcher_tick` calls to prove:
     1. the first eligible tick sends exactly one whip
     2. immediate extra ticks do not increment again
     3. after 4 unanswered whips the old session is closed/reset and a new assignment/session appears
     4. whip activity is visible in history
     5. task comments remain unchanged

## Suggested implementation files
- `src-tauri/src/services/task_runtime.rs`
- `src-tauri/src/services/dispatcher.rs`
- `src-tauri/src/services/database.rs`
- `src-tauri/src/commands/app.rs`
- `src/pages/TasksPage.tsx`
- `src/pages/tasks/TaskDetailPage.tsx`
- `tests/desktop-e2e/task-whip.test.ts`

## Notes / risks
- The cooldown value is currently implicit because no whip interval exists today; implementation should introduce one explicit constant and lock tests to it.
- If we keep the history surface narrow for this fix, prefer a focused lane-activity record over a generic task-activity system, but do not fall back to task comments.
