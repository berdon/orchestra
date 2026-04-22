# ORC-21 task tag regression hardening plan

## Problem summary

ORC-21 is the coverage and hardening follow-on for the task-tag feature. The current branch still reflects the pre-tag baseline in the main task surfaces:

- `src/types.ts` and `src-tauri/src/models.rs` do not yet expose `tags` on `TaskSummary`, `TaskDetail`, or `TaskUpsertInput`.
- `src-tauri/src/services/tasks.rs` still exposes `list_tasks(connection, project_id, include_archived)` with no tag filter/sort inputs.
- `src/lib/tauri.ts` mirrors the same no-tag task shape and no-tag list behavior for local/mock mode.
- `src/pages/tasks/TaskEditorForm.tsx`, `TaskDetailPage.tsx`, `TaskCompactCard.tsx`, `WorkflowTaskBoardSection.tsx`, and `TasksOverviewPage.tsx` do not yet render or edit tags.
- `extensions/orchestra-tools.ts`, `src-tauri/src/services/tool_bridge.rs`, and `src-tauri/src/services/remote_api.rs` only cover the current task payload/list shape.

That means ORC-21 should be planned as a **post-integration hardening pass** on top of the dependent tag feature tickets, not as a parallel semantic redesign. The job here is to lock down the semantics that ORC-17/18/19/20 introduce and make regressions obvious across backend, mock/frontend, UI, and tool/transport paths.

## Dependency and sequencing assumptions

ORC-21 is blocked by the tag implementation tickets for good reason. The recommended execution order is:

1. **ORC-17** lands the relational model, validation, normalization, persistence, and base backend payload support.
2. **ORC-18** lands list filtering/sorting plus remote/tool transport for tags.
3. **ORC-19** lands task create/edit/detail tag UX.
4. **ORC-20** lands task overview rendering plus tag filter/sort controls.
5. **ORC-21** rebases on all of the above and adds coverage that proves the end-to-end semantics match.

If ORC-21 starts before those branches land, the first step should be to rebase/merge the feature work and then write tests against the final helpers/components rather than re-deriving tag behavior in a second place.

## Hardening goals

1. Prove backend validation and normalization rules are stable.
2. Prove task payloads preserve tags through create, update, get, list, bridge, and remote transport paths.
3. Prove local/mock mode uses the same semantics as the backend.
4. Prove UI editing flows and task overview filter/sort flows behave the same way a user would expect from the backend model.
5. Explicitly pin mixed-tag, invalid-input, duplicate, and untagged-task edge cases so follow-on work cannot accidentally reinterpret them.

## Coverage plan by surface

### 1. Backend Rust coverage

Primary files:

- `src-tauri/src/services/tasks.rs`
- `src-tauri/src/models.rs`
- any ORC-17/18 helper module that centralizes tag normalization, sorting, or query construction

Add/extend Rust tests to cover four buckets.

#### A. Validation and normalization

Pin the canonical tag rules introduced by ORC-17:

- lower-case canonical storage
- trimming and blank removal
- duplicate collapse
- lexicographic ordering of stored tags
- invalid character rejection
- max length rejection
- max tag count rejection

Regression cases to include explicitly:

- mixed-case input normalizes to one canonical tag
- duplicate tags supplied through create and update collapse to one stored value
- blank entries are removed before persistence
- invalid values fail with field-specific errors instead of partial writes
- updating a previously tagged task to an empty tag list clears persisted rows cleanly

#### B. Persistence and retrieval

Extend the existing task create/update/get coverage so it proves:

- `create_task` persists tags and returns them in the response
- `update_task` can add, remove, replace, and clear tags
- `get_task` / `get_task_context` include the same canonical tag payload
- task deletion cleans up related tag rows
- tasks with no tags still round-trip as an empty array, not `null`

#### C. List filtering and sorting

Once ORC-18 lands its list semantics, add service-level tests for:

- exact single-tag match
- multi-tag `all` match behavior
- multi-tag `any` match behavior
- mixed-tag datasets where some tasks match partially and some fully
- untagged tasks excluded from positive tag filters
- tag sort ordering using the canonical joined-tag-string semantics from ORC-18
- explicit untagged sort behavior so empty-tag tasks are not left ambiguous

Important rule: the tests should assert against the same shared sort/filter helper introduced by ORC-18, not a second hand-rolled expectation path.

#### D. Query regression protection

Because tag filters/sorts are likely implemented with joins or aggregation, add at least one test that protects against:

- duplicate task rows from tag joins
- broken counts/ordering when a task has multiple tags
- N+1-style payload gaps where tags appear in `get_task` but not `list_tasks`

### 2. Mock/frontend parity coverage

Primary files:

- `src/lib/tauri.ts`
- `src/types.ts`
- targeted Vitest suites under `tests/`

The mock path is especially important because Playwright web tests run against it heavily.

Required parity work:

- add `tags` to the mock task types and stored task normalization path
- mirror backend normalization/validation in `normalizeMockTaskInput` and `validateMockTaskInput`
- mirror ORC-18 list filtering/sorting behavior in `listTasks()` mock mode

Recommended new Vitest coverage:

- a focused `tests/task-tags-mock-parity.test.ts` suite that seeds mock tasks directly and verifies create/update/list semantics
- shared fixture cases copied from the backend edge-case matrix so backend and mock mode stay aligned

Parity cases to pin:

- mixed-case + duplicate input normalizes identically to backend behavior
- invalid tag input fails in mock mode with comparable field paths/messages
- `all` vs `any` filtering returns the same task ids as backend expectations
- tag sorting puts tagged and untagged tasks in the same order as the backend contract

### 3. Tool bridge and transport coverage

Primary files:

- `src-tauri/src/commands/tasks.rs`
- `src-tauri/src/services/tool_bridge.rs`
- `extensions/orchestra-tools.ts`
- `tests/orchestra-tools-extension.tools.test.ts`
- `src-tauri/src/services/remote_api.rs`

This layer needs hardening in two directions: payload shape and list filter inputs.

#### A. Tauri command and bridge round-trip coverage

Add tests proving that:

- create/update command payloads accept `tags`
- list command payloads accept tag filter/sort inputs from ORC-18
- bridge responses include `tags` on returned tasks
- bridge list filtering honors the same semantics as direct service calls

Good fit:

- extend the existing bridge tests in `src-tauri/src/services/tool_bridge.rs`
- extend the extension manifest tests in `tests/orchestra-tools-extension.tools.test.ts`

#### B. Extension/tool schema coverage

The tool manifest should expose the new parameters explicitly instead of burying them in generic JSON.

Planned assertions:

- `create_task` and `update_task` tool schemas expose `tags`
- `list_tasks` exposes the new tag filter and match-mode inputs
- the generated payload sent through the bridge preserves those fields exactly

#### C. Remote API coverage

`src-tauri/src/services/remote_api.rs` currently exposes `/api/v1/projects/:project_id/tasks` by forwarding `tasks::list_tasks(...)`. Once ORC-18 extends that contract, add route-level tests so remote clients are not the forgotten path.

At minimum cover:

- task detail payload includes `tags`
- project task listing includes `tags`
- project task listing accepts tag filter/sort query inputs if ORC-18 exposes them remotely

## 4. UI and Playwright coverage

Primary files:

- `src/pages/tasks/TaskEditorForm.tsx`
- `src/pages/tasks/TaskDetailPage.tsx`
- `src/pages/tasks/TaskCompactCard.tsx`
- `src/pages/tasks/WorkflowTaskBoardSection.tsx`
- `src/pages/tasks/TasksOverviewPage.tsx`
- `tests/e2e/tasks.spec.ts`
- any new dedicated Playwright spec if `tasks.spec.ts` becomes too crowded

### A. Task edit/detail flows

Cover the ORC-19 user path end to end:

- add tags while creating a task
- edit existing tags on the detail page
- remove tags individually
- save and reload to prove persistence
- invalid input shows inline feedback and does not silently commit
- duplicate and mixed-case input collapses to the canonical rendered chips

### B. Task overview flows

Cover the ORC-20 list path end to end:

- overview cards/table render tags compactly
- tag filter controls can isolate matching tasks
- both `Match all` and `Match any` modes behave correctly
- tag sort changes the visible order deterministically
- untagged tasks remain visible when they should and disappear when a positive tag filter is applied

### C. Regression matrix for UI tests

Use a seed dataset with at least:

- one untagged task
- one single-tag task
- one multi-tag task
- one task sharing only one tag with the multi-tag task
- one task with tags that sort after the others canonically

That single fixture can power add/edit/remove/filter/sort assertions without hiding edge cases.

## Acceptance-criteria mapping

- **Backend validation, list/filter/sort, UX, and transport/tool coverage** → covered by the four surface areas above.
- **Mixed-tag and invalid-input regressions explicitly covered** → backend normalization tests, mock parity tests, and UI invalid-entry tests all include them.
- **Untagged vs tagged filter/sort semantics tested** → backend list tests, mock list tests, and Playwright overview tests all pin them.
- **Low semantic ambiguity for follow-on maintenance** → one shared edge-case matrix should be reused across backend/mock/UI coverage so later contributors see the intended behavior clearly.

## Recommended implementation order inside ORC-21

1. Rebase onto completed ORC-17/18/19/20 work.
2. Add backend service tests first, because they define the canonical semantics.
3. Match the mock/frontend path to the backend and add parity tests.
4. Extend bridge/tool/remote coverage so payload/filter regressions are caught in CI.
5. Finish with Playwright coverage for create/edit/remove/filter/sort user flows.

This order keeps the UI tests from masking deeper semantic disagreements.

## Suggested file touch list

Likely implementation/test touch points once blockers land:

- `src/types.ts`
- `src-tauri/src/models.rs`
- `src-tauri/src/services/tasks.rs`
- `src-tauri/src/commands/tasks.rs`
- `src-tauri/src/services/tool_bridge.rs`
- `src-tauri/src/services/remote_api.rs`
- `src/lib/tauri.ts`
- `extensions/orchestra-tools.ts`
- `tests/orchestra-tools-extension.tools.test.ts`
- `tests/task-board-model.test.ts` if overview sort/filter helpers move into unit-testable code
- `tests/e2e/tasks.spec.ts` or a new `tests/e2e/task-tags.spec.ts`

## Notes for the implementer

- Do not duplicate tag semantics in multiple helper paths if a shared normalizer/filter helper already exists from ORC-17/18.
- Prefer data-driven fixtures for the backend/mock parity matrix so the same edge cases stay readable.
- If remote API tag list filters are deferred by ORC-18, document that explicitly in ORC-21 instead of silently leaving the remote path uncovered.
- If the Playwright task suite becomes unwieldy, split tag-specific coverage into a dedicated spec rather than burying it in `tasks.spec.ts`.
