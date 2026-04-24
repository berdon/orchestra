# ORC-129 — Ctrl+O command/search loading hang plan

## tl;dr

- The immediate frontend failure point is `src/App.tsx:refreshCommandPaletteItems()`: the palette blocks on one `Promise.all(...)` across six reads, and `src/components/CommandPalette.tsx` hides all matches while `loading` is true.
- That means a single stalled read can wedge the whole Ctrl+O surface in `Loading commands…` forever even if most command groups are otherwise available.
- The implementation should both identify which desktop/runtime read is stalling and harden the palette so one hung source cannot keep the entire UI empty.
- Add regression coverage in both `tests/e2e/command-palette.spec.ts` and a new desktop/podrunner spec, then mark the command-palette journey as requiring both harnesses in `tests/ui-coverage-matrix.json`.

## Executive summary

The current command palette path is structurally fragile. Opening Ctrl+O calls `refreshCommandPaletteItems()` in `src/App.tsx`, which fans out to:

- `orchestraClient.sessions.list(activeProjectId)`
- `orchestraClient.tasks.list({ includeArchived: false, projectId: activeProjectId })`
- `listAgentOperations(false, activeProjectId)`
- `listRoleOperations(false)`
- `orchestraClient.catalog.listWorkflows(false)`
- `orchestraClient.catalog.listProjects()`

Those six reads are wrapped in a single `Promise.all(...)`. If any one of them never settles in the affected runtime path, `setCommandPaletteLoading(false)` is never reached and `CommandPalette.tsx` keeps rendering only the loading copy. The browser suite covers the mock path today, but the real desktop/podrunner path is not covered at all, so this class of failure can ship unnoticed.

The fix should do two things at once:

1. isolate the actual hanging source in the desktop/runtime path so the root cause is understood and corrected, and
2. make the palette resilient so a single slow or failed source cannot wedge the entire search surface.

## Current findings

### 1. The all-or-nothing load contract matches the reported symptom

Relevant code:

- `src/App.tsx`
  - `refreshCommandPaletteItems()`
  - `handleOpenCommandPalette()`
- `src/components/CommandPalette.tsx`

Current behavior:

- opening Ctrl+O sets `commandPaletteOpen = true`
- `refreshCommandPaletteItems()` sets `commandPaletteLoading = true`
- the palette renders `Loading commands…`
- command items are only rendered when `loading === false`

So even if we already know some safe commands (`Pages`, `Actions`, maybe cached `Sessions` / `Projects`), the UI shows nothing until the full batch resolves.

### 2. The likely runtime-specific failure is one of the six backend reads, not fuzzy search itself

`buildCommandPaletteItems()` in `src/lib/commandPalette.ts` is synchronous and deterministic. The fuzzy matching in `src/components/CommandPalette.tsx` is also synchronous. The loading hang therefore points upstream at the async data collection path, not the matching/render logic.

The first debugging pass should identify which of these reads stalls in the failing scenario:

- sessions list
- tasks list
- agent operations list
- role operations list
- workflows list
- projects list

### 3. The coverage gap is real today

Current coverage state in-repo:

- browser coverage exists in `tests/e2e/command-palette.spec.ts`
- no desktop/podrunner command-palette spec exists under `tests/desktop-e2e`
- `tests/ui-coverage-matrix.json` currently marks the command-palette journey as `requiredHarnesses: ["browser"]`

That means the exact runtime path most likely to exhibit the hang is unprotected.

## Proposed implementation shape

### 1. Reproduce and isolate the hanging source

Add temporary/local instrumentation around each palette read in `src/App.tsx` so the failing desktop run shows which request starts and which one never settles. The goal is to identify the true backend/runtime source instead of only masking the symptom.

Recommended approach:

- wrap each read in a small labeled helper for logging and timing
- capture success/failure/timeout per source in the desktop reproduction run
- confirm whether the stalled call is deterministic or tied to app state such as project switching, startup timing, or worker/runtime state

If the specific backend read has an obvious bug, fix that directly as part of the same change.

### 2. Make the palette resilient instead of all-or-nothing

Even after the root cause is fixed, the command palette should not depend on a single `Promise.all(...)` for basic usability.

Recommended changes:

- stop hiding all command items while background loading is active
- seed the palette immediately with command groups that do not depend on the hanging read
  - always-available page/action items
  - cached or already-loaded projects/sessions where safe
- replace the single blocking fan-out with an incremental or `allSettled`-style load so partial results can render
- clear the spinner once the palette has enough data to be usable instead of waiting for every source forever
- guard against stale responses when the palette is reopened quickly or the active project changes mid-load
- consider using the existing `retryOrchestraRead(...)` helper for retryable read failures where appropriate

The resilience bar for this surface should be:

- Ctrl+O always opens usable commands immediately
- slow sources enrich results later
- failed sources degrade a subset of commands instead of wedging the whole overlay

### 3. Add regression coverage in both harnesses

#### Browser E2E

Extend `tests/e2e/command-palette.spec.ts` so the normal suite explicitly asserts that:

- Ctrl+O opens the palette
- `Loading commands…` does not remain indefinitely
- real command items become visible and selectable

If the final implementation includes a targeted test hook for a slow source, add one browser test that proves the palette still renders usable commands while a subset of data is delayed.

#### Desktop / podrunner E2E

Add a new desktop spec under `tests/desktop-e2e`, for example `tests/desktop-e2e/command-palette.test.ts`, that:

- boots a real desktop session with `createReadyWebdriverSession()`
- dispatches the Ctrl+O shortcut through the app window
- waits for command results to appear instead of remaining on the loading copy
- exercises at least one real selection path after results load

This should be included automatically by the existing desktop suite manifests/scripts because every `*.test.ts` file in `tests/desktop-e2e` is part of the required suite.

#### Coverage matrix

Update `tests/ui-coverage-matrix.json` so the command-palette journey requires both browser and desktop harnesses and lists the new desktop spec.

### 4. Validate the fix with focused runs

Recommended validation set:

- `npm run test:e2e -- tests/e2e/command-palette.spec.ts`
- targeted desktop run for the new command-palette desktop spec via the existing desktop script
- if practical, one podman-backed run of that desktop spec to verify the exact automated environment called out in scope

## Edge cases to keep in scope

- opening Ctrl+O during initial app startup before all catalogs are warm
- reopening the palette quickly and avoiding stale async overwrite
- switching projects and then opening Ctrl+O immediately
- ensuring the logs window / detached window shortcut exclusions still behave the same
- preserving search usability even if one catalog source is empty, slow, or temporarily unavailable

## Files most likely to change

- `src/App.tsx`
- `src/components/CommandPalette.tsx`
- `src/lib/commandPalette.ts` (only if partial/cached item construction needs helper changes)
- `tests/e2e/command-palette.spec.ts`
- `tests/desktop-e2e/command-palette.test.ts`
- `tests/ui-coverage-matrix.json`
