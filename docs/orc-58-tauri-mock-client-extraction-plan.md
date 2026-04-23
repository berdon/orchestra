# ORC-58 Tauri/Mock `OrchestraClient` extraction plan

## tl;dr

- Replace the current mixed `src/lib/orchestraClient/defaultClient.ts` compatibility wrapper with a selector over two concrete adapters: `TauriOrchestraClient` and `MockOrchestraClient`.
- Keep ORC-58 focused on the ORC-57 shared-contract surface only: `app`, `catalog`, `tasks`, `inbox`, `sessions`, and shared event delivery.
- Move contract-scope browser/mock state and event helpers out of `src/lib/tauri.ts` so the production desktop adapter no longer depends on `isTauriAvailable()` branches.
- Preserve current desktop command names, payloads, and `orchestra:*` browser event sources; translate them into the shared event union at the adapter boundary.
- Leave broad screen/hook migration to ORC-60 and desktop-only shell/admin affordances to their follow-on tickets.

## Executive summary

ORC-57 created the shared `OrchestraClient` contract and app-root provider seam, but the default binding is still a stopgap. `src/lib/orchestraClient/defaultClient.ts` currently imports roughly 75 helpers from a mixed frontend helper layer, and the largest of those helpers (`src/lib/tauri.ts`) still bundles three concerns together:

1. real Tauri `invoke(...)`-backed desktop calls
2. browser/localStorage mock fallback state
3. desktop/mock custom-event delivery

That is the exact coupling ORC-58 needs to undo.

The right implementation boundary for this ticket is the ORC-57 contract surface, not the whole frontend. This task should produce two explicit adapters that both satisfy `OrchestraClient`, reduce `defaultClient.ts` to host selection/bootstrap wiring, and extract the contract-scope mock/event utilities needed to keep behavior stable. Existing shared screens still importing `../lib/tauri` directly are mostly a later ORC-60 migration concern, although small low-risk proof-point updates on already-injected paths are reasonable here.

## Current findings

- `src/lib/tauri.ts` is still the main mixed helper layer (~5.8k LOC, 114 exported functions).
- `src/lib/orchestraClient/defaultClient.ts` currently selects host mode with `isTauriAvailable()` and directly wraps mixed helpers instead of dedicated adapters.
- The shared-contract catalog methods still come from mixed helper files:
  - `src/lib/projects.ts`
  - `src/lib/agents.ts`
  - `src/lib/roles.ts`
- Contract-relevant mock helpers are still anchored in `src/lib/tauri.ts`, including mock session creation/upsert and browser custom-event emission.
- `src/lib/agents.ts` and `src/lib/roleRuntime.ts` both import mock session helpers from `./tauri`, so mock extraction has to account for those callers too.
- Direct shared-screen imports from `../lib/tauri` still exist in files such as:
  - `src/App.tsx`
  - `src/pages/TasksPage.tsx`
  - `src/pages/InboxPage.tsx`
  - `src/pages/tasks/TaskDetailPage.tsx`
  - `src/components/TaskCommentMentionsTextarea.tsx`
  Those paths should not define ORC-58 scope; ORC-60 is already the broader screen migration ticket.

## Implementation shape

### 1. Create explicit shared-contract adapters

Add two concrete client implementations under `src/lib/orchestraClient/`:

- `src/lib/orchestraClient/tauriClient.ts`
- `src/lib/orchestraClient/mockClient.ts`

Both should export factory functions that return `OrchestraClient` implementations against the ORC-57 contract.

### 2. Reduce `defaultClient.ts` to selection + binding

`src/lib/orchestraClient/defaultClient.ts` should stop being the implementation itself.

After extraction it should only:

- detect host kind once
- choose `TauriOrchestraClient` vs `MockOrchestraClient`
- assemble optimistic/bootstrap metadata
- expose `createDefaultOrchestraClientBinding()`

That keeps the provider seam stable while removing transport logic from the default wrapper.

### 3. Keep the Tauri adapter pure

`TauriOrchestraClient` should use desktop-only transport behavior only:

- direct Tauri command/invoke mappings for shared contract methods
- desktop browser custom-event listeners for shared event delivery
- no embedded mock/localStorage fallback branches

This adapter should preserve the already-proven desktop semantics by keeping the current command names and payload shapes.

### 4. Move contract-scope mock logic into mock-owned modules

The browser/localStorage fallback needed by the shared contract should move out of `src/lib/tauri.ts` into mock-owned helpers used by `MockOrchestraClient`.

The extraction only needs the contract-scope mock pieces, for example:

- shared mock session/task/inbox event emission helpers
- mock session record creation/upsert helpers
- contract-scope localStorage readers/writers/seeding helpers

A small top-level mock helper area is reasonable if it helps reuse, for example:

- `src/lib/mockOrchestra/events.ts`
- `src/lib/mockOrchestra/sessions.ts`
- `src/lib/mockOrchestra/store.ts`

Exact filenames are flexible; the important part is that mock state/event code is no longer hidden inside the Tauri adapter path.

### 5. Centralize browser event wiring behind the shared event abstraction

ORC-58 should keep the existing browser event names intact:

- `orchestra:session-change`
- `orchestra:session-stream`
- `orchestra:task-change`
- `orchestra:inbox-change`

But adapter consumers should only see `client.events.subscribe(...)` and the ORC-57 shared discriminated union.

That means:

- `TauriOrchestraClient.events.subscribe(...)` listens to those browser events and maps them with the existing `toOrchestra*Delivery(...)` helpers
- `MockOrchestraClient` emits the same browser events through extracted mock event helpers so current test/dev behavior remains intact

## Proposed file plan

Keep the ORC-57 contract files and add the extraction-specific pieces:

- `src/lib/orchestraClient/bootstrap.ts` — keep
- `src/lib/orchestraClient/client.ts` — keep
- `src/lib/orchestraClient/events.ts` — keep shared event union/mappers
- `src/lib/orchestraClient/errors.ts` — keep
- `src/lib/orchestraClient/provider.tsx` — keep
- `src/lib/orchestraClient/defaultClient.ts` — shrink to selector/binding only
- `src/lib/orchestraClient/tauriClient.ts` — new dedicated desktop adapter
- `src/lib/orchestraClient/mockClient.ts` — new dedicated browser/mock adapter
- `src/lib/mockOrchestra/*` — new shared mock state/event helpers as needed

## Sequencing

1. Start from the ORC-57 baseline on `origin/main` so the shared contract files are present.
2. Extract contract-scope mock event/session helpers from `src/lib/tauri.ts` into mock-owned modules.
3. Update `src/lib/agents.ts` and `src/lib/roleRuntime.ts` to import those mock helpers from the new mock location instead of `./tauri`.
4. Implement `TauriOrchestraClient` for the ORC-57 contract surface using pure desktop transport logic.
5. Implement `MockOrchestraClient` for the same contract surface using extracted browser/localStorage helpers.
6. Rewrite `defaultClient.ts` as a selector over those two adapters.
7. Update any tiny already-injected proof points that should use the extracted adapters directly; avoid turning this into the broad page migration ticket.
8. Add focused adapter tests and rerun validation.

## Scope boundaries / non-goals

This ticket should **not** try to finish the rest of the epic.

Out of scope here:

- full migration of shared React screens/hooks away from `../lib/tauri` imports
- logs window helpers
- agent terminal window control
- harness/runtime settings panels
- system notifications
- channels/remote/source-control/operator admin panels
- broader desktop-only shell/admin affordances
- wholesale deletion or total rewrite of `src/lib/tauri.ts`

The goal is to make the shared client path clean first, not to solve every remaining desktop-specific helper in one pass.

## Validation plan

Expected validation for implementation/review:

- `npm ci`
- `npm run build`
- `npx vitest run tests/orchestra-client-contract.test.ts`
- add and run a focused adapter test file covering:
  - default selector chooses Tauri vs Mock correctly
  - both adapters satisfy `OrchestraClient` bootstrap/event expectations
  - event subscription delivers the shared `kind` discriminants
  - mock event emission still refreshes through the same browser event names

If a small proof-point migration is included, rerun any directly affected focused tests as well.

## Acceptance-criteria mapping

- **Shared feature code can obtain desktop behavior through the injected client rather than direct Tauri helper imports**
  - the injected default binding now resolves to a dedicated `TauriOrchestraClient`; only small already-migrated proof points should change here, with the wider screen migration deferred to ORC-60
- **Mock behavior is separated from production transport logic**
  - contract-scope browser/localStorage fallback code moves into `MockOrchestraClient` and mock-owned helpers
- **Current desktop command and event behavior remains intact after extraction**
  - keep existing Tauri command names/payloads and current `orchestra:*` event sources
- **The extracted adapters implement the shared contract defined for ORC-56**
  - both concrete adapters return the ORC-57 `OrchestraClient` shape and use the shared bootstrap/event/error contract files
