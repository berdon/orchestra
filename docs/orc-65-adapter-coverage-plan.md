# ORC-65 shared frontend adapter coverage plan

## tl;dr

- Start implementation from current `main`, not this task worktree baseline: the branch in this workspace predates the ORC-57/58/61/62 adapter merges.
- Add one reusable `OrchestraClient` contract suite and run it against the Mock, Tauri, and Remote API adapters.
- Add backend parity tests that compare Tauri command/service outputs and Remote API route/websocket outputs from the same seeded backend state.
- Add React integration tests for already-migrated shared surfaces using `OrchestraClientProvider` plus a mock client instead of Tauri internals.
- Add a real hosted-web Playwright harness that serves the shared Orchestra frontend in `hosted_web` mode against a live Remote API backend, then cover a focused shared-surface smoke set.

## Executive summary

Current mainline now has the shared frontend client surface and all three adapters from ORC-57/58/61/62, but the coverage story is still fragmented:

- `tests/orchestra-client-contract.test.ts` only checks helper-level error/event mappings.
- `tests/orchestra-client-adapters.test.ts` checks bootstrap/event wiring plus one transport split, not reusable shared semantics.
- `tests/orchestra-client-remote-api.test.ts` is transport-specific Remote API coverage, not adapter-parity coverage.
- `tests/e2e/*` exercise the browser/mock path, not the hosted-web Remote API path.
- `tests/web-driver-e2e/pairing.spec.ts` validates the mobile/web-driver pairing flow, not the shared Orchestra web frontend.
- `src-tauri/src/services/remote_api.rs` currently has narrow route probes (`frontend_bootstrap`, `session_message`) instead of broad command/route parity coverage.

ORC-65 should close that gap with four layers of coverage:

1. adapter-agnostic frontend contract tests
2. backend command/route/event parity tests
3. injected-client React integration tests for shared screens/hooks
4. real browser-hosted E2E against the Remote API path

## Current repo footing

Implementation should target current `main`, where the relevant client files now live:

- `src/lib/orchestraClient/client.ts`
- `src/lib/orchestraClient/bootstrap.ts`
- `src/lib/orchestraClient/defaultClient.ts`
- `src/lib/orchestraClient/mockClient.ts`
- `src/lib/orchestraClient/tauriClient.ts`
- `src/lib/orchestraClient/remoteApiClient.ts`
- `src/lib/orchestraClient/remoteApiTransport.ts`
- `src/lib/orchestraClient/remoteApiEvents.ts`
- `src/lib/orchestraClient/hostedWeb.ts`

Relevant existing coverage on `main`:

- `tests/orchestra-client-contract.test.ts`
- `tests/orchestra-client-adapters.test.ts`
- `tests/orchestra-client-hosted-web.test.ts`
- `tests/orchestra-client-remote-api.test.ts`
- `tests/e2e/*`
- `tests/desktop-e2e/*`
- `tests/web-driver-e2e/pairing.spec.ts`
- `src-tauri/src/services/remote_api.rs` route-probe tests

## Workstream 1: reusable frontend contract suites

Add one shared contract test builder for `OrchestraClient` semantics and execute it against all supported adapters.

### Proposed shape

Add a reusable suite helper under `tests/`, for example:

- `tests/orchestra-client-contract-suite.ts`

And bind it from adapter-specific entrypoints, for example:

- `tests/orchestra-client-mock-contract.test.ts`
- `tests/orchestra-client-tauri-contract.test.ts`
- `tests/orchestra-client-remote-api-contract.test.ts`

Exact filenames are flexible; the important part is that the assertions are shared and adapter-specific setup stays thin.

### Contract cases to cover

Keep the suite focused on shared frontend semantics, not host-specific implementation details:

- bootstrap shape is valid for the adapter host/auth mode
- `client.events.subscribe(...)` always emits the shared discriminants:
  - `task.change`
  - `session.change`
  - `session.stream`
  - `inbox.change`
- task list defaults are normalized consistently (`includeArchived`, `tagMatch`, `sortBy`, `sortDirection`)
- task completion outcomes map consistently (`success`, `failure`, `needs_user`)
- session subscribe/unsubscribe follow the shared contract and surface normalized errors
- unsupported or auth failures normalize into `OrchestraClientError` consistently

### Scope note

Keep transport-specific edge cases in their existing dedicated files:

- Remote HTTP/WebSocket details stay in `tests/orchestra-client-remote-api.test.ts`
- adapter-selection/bootstrap specifics can stay in `tests/orchestra-client-adapters.test.ts`

The new suite should prove parity on the shared client surface, not replace every specialized test.

## Workstream 2: backend command/route/event parity coverage

ORC-65 needs backend coverage that proves the Tauri and Remote API paths satisfy the same DTO and event semantics.

### Proposed shape

Add a Rust parity harness that seeds one backend state and compares:

- Tauri command/service outputs
- Remote API HTTP route outputs
- Remote API websocket event topics/envelopes after normalization

Likely home:

- a new focused test module near `src-tauri/src/services/remote_api.rs`
- or a dedicated shared parity test file under `src-tauri/src/services/`

### Cases to compare

Use JSON/DTO equality or normalized projections for representative shared surfaces:

- frontend bootstrap payload
- task list/detail reads
- task comments and todo reads/mutations
- inbox list/read/archive/send flows
- session list/detail/runtime/model state
- session subscribe/unsubscribe responses
- workflow/task transition responses used by shared screens

For events, assert that the backend mappings converge on the same shared frontend event model:

- task update -> shared task change
- session update -> shared session change
- inbox/mail update -> shared inbox change
- session stream -> shared session stream delivery

### Recommended reuse

Keep the existing production route-probe mechanism and extend it with a few more smoke cases, but use in-process parity tests for breadth. The route probe is good for “does the real route exist and authenticate,” while parity tests should answer “does the Remote API return the same contract as the Tauri path?”

## Workstream 3: injected-client frontend integration tests

The acceptance criteria call out shared-screen behavior no longer depending on Tauri internals. Right now the repo has strong unit and E2E coverage, but very little React integration coverage around the injected client seam.

### Proposed shape

Add a lightweight React integration harness using:

- `OrchestraClientProvider`
- `createMockOrchestraClientBinding(...)` or a small test double implementing `OrchestraClient`

If needed, add the minimal React test dependency/runtime for jsdom-based rendering.

### Target surfaces

Prefer already-migrated shared surfaces instead of desktop-only shell panels, for example:

- `src/lib/orchestraData/tasks.ts`
- `src/lib/orchestraData/inbox.ts`
- `src/lib/orchestraData/events.ts`
- representative shared pages already on `useOrchestraClient()`, such as task/inbox/session surfaces

### Test goal

The important change is architectural:

- shared-screen tests should inject a client through the provider seam
- they should stop depending on `window.__TAURI_INTERNALS__`
- they should stop needing `@tauri-apps/api/core` mocks for shared behavior

Host-admin and desktop-only shell surfaces can keep host-specific tests; ORC-65 only needs to move shared-screen behavior onto the shared client seam.

## Workstream 4: real hosted-web browser E2E

Current browser Playwright coverage uses the mock/browser path. ORC-65 needs real hosted-web coverage against the Remote API path.

### Proposed harness

Add a dedicated hosted-web Playwright config and runner, for example:

- `playwright.hosted-web.config.ts`
- `scripts/run-hosted-web-e2e.sh`
- optionally `scripts/serve-hosted-web-e2e.mjs`

### Recommended server model

Use a same-origin local harness that does all of the following:

1. serves the built Orchestra frontend with `VITE_ORCHESTRA_HOST_MODE=hosted_web`
2. starts a real seeded Remote API backend
3. proxies `/api/v1/*` and `/api/v1/ws` to that backend
4. injects or attaches the test auth token at the proxy layer so the browser boots directly into an authenticated hosted-web session

That preserves the real Remote API path while avoiding fragile cross-origin/bootstrap setup in Playwright.

### What to cover

Do not duplicate the entire browser suite. Add a focused hosted-web smoke set over the highest-value shared surfaces:

- task overview/detail read flow
- inbox read/archive flow
- sessions list/transcript/message flow
- one representative realtime refresh assertion through Remote API events

These should sit alongside, not replace:

- existing desktop/Tauri E2E
- existing mock/browser Playwright coverage
- existing web-driver pairing coverage

### Coverage matrix update

Update `tests/ui-coverage-matrix.json` to add a hosted-web harness dimension for the journeys that must now be proven against the Remote API path.

## Sequencing

1. Sync the implementation branch to current `main`.
2. Add the reusable frontend contract suite and wire Mock/Tauri/Remote API adapters into it.
3. Add Rust backend parity tests for command/route/event equivalence.
4. Add provider-backed React integration tests for shared screens/hooks.
5. Add the hosted-web Playwright harness and a focused Remote API smoke subset.
6. Update scripts/docs/coverage metadata and run the focused validation set.

## Validation plan

Expected validation after implementation:

- `npm ci`
- `npm run build`
- `npx vitest run tests/orchestra-client-contract.test.ts tests/orchestra-client-adapters.test.ts tests/orchestra-client-hosted-web.test.ts tests/orchestra-client-remote-api.test.ts <new contract/integration test files>`
- focused Rust tests covering the new Remote API parity harness
- `npx playwright test --config playwright.config.ts <affected mock/browser specs>`
- `npx playwright test --config playwright.hosted-web.config.ts <new hosted-web specs>`
- existing desktop and web-driver suites only where directly affected

## Non-goals

ORC-65 should not try to:

- duplicate the full browser suite in hosted-web mode
- migrate desktop-only host-admin or shell surfaces into the shared contract
- replace existing desktop E2E coverage
- collapse every transport-specific test into a single giant file

## Acceptance mapping

- **Shared client semantics are exercised by reusable contract tests across all supported adapters**
  - covered by the shared `OrchestraClient` contract suite run against Mock, Tauri, and Remote API bindings
- **Browser-hosted Orchestra is covered by real end-to-end tests against the remote API path**
  - covered by the new hosted-web Playwright harness with a live Remote API backend
- **Frontend integration tests no longer need to mock Tauri internals for shared-screen behavior**
  - covered by provider-backed React integration tests that inject a mock `OrchestraClient`
