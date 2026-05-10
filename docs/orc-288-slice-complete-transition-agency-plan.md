# ORC-288 slice-complete failure/intervention agency plan

## tl;dr
- Require `actuallyFailed` on `complete_lane_as_failure` and `actuallyBlocked` on `request_user_intervention` across the worker-facing tool/command surfaces.
- When either boolean is `false` on an active agent/role lane, do **not** transition the lane. Keep the task in progress, inspect task-wide unfinished todos, and immediately send the exact continue-working coaching message into the same session.
- Treat that `false` path as a non-transition result so commands/tool-bridge code does not emit failure/intervention events, retire sessions, or run post-transition bookkeeping.
- Update prompt/help/schema copy plus mock/runtime/tests so the new contract is explicit and the false-path behavior is covered end to end.

## Executive summary
Today `complete_lane_as_failure` and `request_user_intervention` always mean “close or pause the lane now.” ORC-288 adds a second, explicit meaning for those tools: an agent/role can say “I am **not actually** failed/blocked; I just finished this slice and need Orchestra to steer me toward the next slice.”

That means the change is not just a schema tweak. The runtime currently routes both tools through `src-tauri/src/services/task_runtime.rs::complete_lane(...)`, and the command/tool-bridge layers assume that a successful return means a real lane transition happened. For ORC-288, a `false` boolean must instead become a controlled **continue working** result:

- keep the same active lane assignment
- keep task/lane status in progress
- do not finalize the open lane run
- do not move the task to blocked/in-review/failure routing
- do not emit failure/intervention transition events or post-transition auto-dispatch logic
- send an immediate follow-up instruction back into the active worker session

The safest implementation is to make failure/intervention completion return an explicit disposition (`transitioned` vs `continue_working`) from shared runtime logic, then teach both the Tauri command path and tool-bridge path to suppress normal transition side effects when the disposition is `continue_working`.

## Key findings from the current code
- `src-tauri/src/services/task_runtime.rs::complete_lane(...)` owns the shared lane-close logic for success, failure, and intervention.
- `src-tauri/src/commands/tasks.rs::complete_lane_command(...)` and `src-tauri/src/services/tool_bridge.rs` both assume that calling the runtime helper means a real transition happened; they immediately run cleanup, auto-dispatch checks, transition logging/domain events, task-change emits, and session-retirement logic.
- `src-tauri/src/services/task_runtime.rs::start_assignment_follow_up(...)` already exists and is the right real-runtime mechanism for “send the session an immediate coaching message without opening a new task/lane transition.”
- `src-tauri/src/services/task_runtime.rs::lane_rework_follow_up_prompt()` plus the matching mock flow in `src/lib/tauri.ts` already show the pattern for resuming a lane by sending a system/follow-up message into the same session.
- The worker-facing contract currently appears in several places that all need to stay aligned:
  - Tauri command signatures in `src-tauri/src/commands/tasks.rs`
  - tool-bridge payload parsing in `src-tauri/src/services/tool_bridge.rs`
  - remote API request bodies in `src-tauri/src/services/remote_api.rs`
  - tool schemas/help in `extensions/orchestra-tools.ts`
  - prompt/help text in `src-tauri/src/services/task_runtime.rs`
  - manual whip / retry guidance in `src/pages/TasksPage.tsx`
  - TS wrapper functions in `src/lib/tauri.ts` and `src/lib/orchestraClient/*`
- The required todo check for the new false-path is **task-wide unfinished todos**, not current-lane-only success gating. The requirement says “if the task has unfinished todos,” so this should use `list_unfinished_task_todos(..., None)` semantics.

## Recommended implementation

### 1. Make the failure/intervention contract explicit
Update the worker-facing failure/intervention surfaces so they require the new boolean:

- `complete_lane_as_failure(taskId, summary, actuallyFailed, notes?)`
- `request_user_intervention(taskId, summary, actuallyBlocked, notes?)`

Apply that requirement in:
- `src-tauri/src/commands/tasks.rs`
- `src-tauri/src/services/tool_bridge.rs`
- `src-tauri/src/services/remote_api.rs`
- `extensions/orchestra-tools.ts`
- `src/lib/tauri.ts` low-level helpers

For prompt/help text, explicitly document:
- pass `true` when the lane really failed / the worker is really blocked
- pass `false` when the current slice is done but the worker should keep going on the same lane and wants Orchestra to coach the next step

### 2. Branch early into a shared continue-working false path
In `src-tauri/src/services/task_runtime.rs`, add a small shared helper for the new semantics before normal failure/intervention transition handling runs.

Recommended shape:
- validate there is an active authorized assignment
- only allow the continue-working path for active `agent` / `role` assignments
- if `actuallyFailed == false` or `actuallyBlocked == false`:
  - skip normal completion-transition guards and routing
  - inspect **task-wide** unfinished todos
  - choose one exact message:
    - unfinished todos exist:
      - `Great work finishing the next slice, keep going in the next todo until you have finished it!`
    - no unfinished todos:
      - `Great work finishing this next slice, create todos for the remaining work then keep working until you finish the next todos`
  - send that message via `start_assignment_follow_up(...)`
  - return a `continue_working` disposition without changing lane/task state

Keep the existing true-path behavior untouched after that branch.

### 3. Return an explicit disposition instead of overloading `TaskDetail`
The false-path must not be mistaken for a real transition by the layers above it.

Recommended internal result shape:

```rust
enum LaneCompletionDisposition {
    Transitioned(TaskDetail),
    ContinueWorking(TaskDetail),
}
```

or an equivalent struct with `task` plus `transitioned: bool`.

Use that result in both:
- `src-tauri/src/commands/tasks.rs::complete_lane_command(...)`
- `src-tauri/src/services/tool_bridge.rs`

When the result is `ContinueWorking`:
- do **not** run blocked-runtime cleanup for a completed transition
- do **not** collect post-completion auto-dispatches
- do **not** record failure/intervention transition domain topics
- do **not** emit failure/intervention task transition reasons
- do **not** retire the assignment session
- just return the current task after the follow-up message is queued

This is the main safeguard that prevents `false` from accidentally acting like a real failed/blocked transition.

### 4. Keep internal/service callers explicit
Even though the product requirement is phrased around worker tools, it is worth threading the boolean through the service-layer helpers too so internal callers must make an intentional choice.

That means updating direct runtime helpers/call sites such as:
- `src-tauri/src/services/task_runtime.rs::complete_lane_as_failure(...)`
- `src-tauri/src/services/task_runtime.rs::request_user_intervention(...)`
- whip/escalation callers that should always pass `true`
- Rust tests that call these helpers directly

This keeps the code honest and makes true vs false behavior impossible to forget in future call sites.

### 5. Keep higher-level client APIs ergonomic where appropriate
The explicit booleans should be required on the worker-facing tool/command functions, but the generic UI-oriented task client wrapper does not necessarily need to expose new ceremony everywhere.

A low-risk approach is:
- change the explicit low-level functions (`completeLaneAsFailure`, `requestUserIntervention`) to require the booleans
- keep generic `orchestraClient.tasks.complete(...)` ergonomics intact by internally mapping:
  - `failure` -> `actuallyFailed: true`
  - `needs_user` -> `actuallyBlocked: true`

That preserves existing user-driven task-detail completion flows while still making the worker tool contract strict and allowing direct low-level callers to use `false` when needed.

## Prompt/help/doc updates
Update all worker-facing guidance so the new contract is hard to miss:

### Runtime prompt/help text
In `src-tauri/src/services/task_runtime.rs` update:
- `TASK_WHIP_PROMPT`
- `orchestra_tool_help_block()`
- any prompt assertions that reference the old signatures

The failure/intervention help lines should show the new parameter names and the `false` semantics explicitly.

### Tool schemas and parameter descriptions
In `extensions/orchestra-tools.ts`:
- add required `actuallyFailed` / `actuallyBlocked` schema properties
- make the parameter descriptions say when to pass `false`
- update help examples so failure/intervention examples include the new booleans
- add schema assertions/tests for both tools, not just success

### UI copy that mirrors worker guidance
Update the worker-steering copy in `src/pages/TasksPage.tsx` so manual whip / retry guidance does not keep teaching the old signature.

## Mock/runtime parity
Update `src/lib/tauri.ts::completeMockTaskLane(...)` to mirror the runtime semantics closely:

- add required `actuallyFailed` / `actuallyBlocked` parameters on the explicit helper functions
- if the boolean is `false`, keep the task/assignment active and append the exact continue-working system message to the same mock session
- inspect task-wide unfinished todos to choose the correct message
- do not move the mock task into `blocked` or `in_review`
- do not finalize the mock lane run on the false path

That keeps browser/mock behavior aligned with the real runtime and gives lightweight regression coverage without needing a full desktop run for every case.

## Test plan

### Rust/runtime coverage
Add focused tests in `src-tauri/src/services/task_runtime.rs` for:
- `complete_lane_as_failure(..., actually_failed=false)` keeps the lane active and sends the exact “keep going in the next todo” message when unfinished task todos exist
- `complete_lane_as_failure(..., actually_failed=false)` keeps the lane active and sends the exact “create todos for the remaining work” message when no unfinished task todos exist
- `request_user_intervention(..., actually_blocked=false)` gets the same two-way message behavior
- `actuallyFailed=true` still follows the normal failure transition
- `actuallyBlocked=true` still follows the normal intervention transition
- prompt/help assertions updated to the new signatures/descriptions

If practical in these tests, inspect queued/live follow-up delivery state rather than only task status so the “session receives the instruction immediately” requirement is explicitly covered.

### Mock/unit coverage
Update/add tests in `tests/blocked-task-runtime-mock.test.ts` for the same two false-path message cases plus true-path regression.

### Tool schema/help coverage
Update `tests/orchestra-tools-extension.tools.test.ts` to assert:
- `complete_lane_as_failure` requires `actuallyFailed`
- `request_user_intervention` requires `actuallyBlocked`
- the parameter descriptions mention the `false` slice-complete semantics

### Client/contract coverage
Update the client contract tests so:
- low-level explicit failure/intervention helpers include the new booleans
- generic `tasks.complete(...)` still works by sending `true` internally for normal user-driven failure/intervention calls

Likely touch points:
- `tests/orchestra-client-tauri-contract.test.ts`
- `tests/orchestra-client-mock-contract.test.ts`
- `tests/orchestra-client-remote-api-contract.test.ts`

### Existing call-site regressions
Update direct invocation tests that currently call the old signatures, including the desktop lane-approval regressions that invoke `request_user_intervention` directly.

## Expected touch points
- `src-tauri/src/services/task_runtime.rs`
- `src-tauri/src/commands/tasks.rs`
- `src-tauri/src/services/tool_bridge.rs`
- `src-tauri/src/services/remote_api.rs`
- `src-tauri/src/services/command_authorization.rs`
- `extensions/orchestra-tools.ts`
- `src/lib/tauri.ts`
- `src/lib/orchestraClient/tauriBindings.ts`
- `src/lib/orchestraClient/mockBindings.ts`
- `src/lib/orchestraClient/remoteApiClient.ts`
- `src/pages/TasksPage.tsx`
- runtime/mock/client/tool tests that exercise completion transitions

## Out of scope
- changing `complete_lane_as_success`
- auto-creating todos when none exist
- redefining normal blocked/dependency-blocked task semantics outside this explicit false-path behavior
- broader workflow/lane UX redesign beyond the needed prompt/help/contract updates
