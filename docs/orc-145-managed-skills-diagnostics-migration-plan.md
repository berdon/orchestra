# ORC-145 — managed skills diagnostics, migration warnings, and runtime detail visibility plan

## tl;dr

- Add one additive managed-skills diagnostics model and reuse it across runtime details, Settings → Skills warnings, logs, and session/domain-event audit payloads.
- Extend `runtime_skills.rs` so it keeps the full explanation set — ambient inputs, resolved winners, suppressed/rejected candidates, scoped snapshot metadata, and collision/migration notes — instead of returning only launch args plus a hash.
- Extend `SessionRuntimeDetails` with a nested managed-skills payload, store the **applied** diagnostics on live runtimes, and compute the **expected next spawn** diagnostics for inactive sessions without failing the entire runtime-details request.
- Add a local-only Skills catalog diagnostics query for the existing Settings surface so operators get: migration callout for discovered `~/.agents/skills`, missing/shadowed/invalid summary counts, and explicit scoped-vs-ambient conflict warnings in the existing skill detail + binding editor.
- Add audit logs/domain events plus regression coverage for runtime diagnostics rendering/serialization, migration callouts, and conflict/warning surfaces.

## Executive summary

ORC-146 and ORC-148 already delivered the hard backend/runtime behavior and the first Settings UI surface, but the current product still makes operators infer too much. `runtime_skills.rs` knows how a session’s effective skill set was chosen, which slugs were materialized into the scoped snapshot, and when ambient collisions should abort launch — yet almost none of that explanation reaches `SessionRuntimeDetails`, the Skills catalog, or any durable audit event.

ORC-145 should turn that existing resolution work into operator-facing diagnostics instead of inventing a second resolution model in the UI. The cleanest path is to make the backend produce a single authoritative managed-skills diagnostics payload that can be:

- attached to `SessionRuntimeDetails`,
- rendered in the Sessions runtime-details modal,
- summarized in Settings → Skills,
- reused for conflict/migration warnings,
- and serialized into logs/domain events when runtimes are resolved, applied, or rejected.

That keeps ORC-146 authoritative, keeps ORC-148/149 UI work additive, and gives ORC-147 a stable payload shape to expose remotely later.

## Current seams and constraints

- `src-tauri/src/services/runtime_skills.rs` already resolves the effective winners, materializes global publication + scoped snapshots, computes `context_hash`, and rejects scoped-vs-ambient slug collisions.
- That same service currently throws away most explanation detail. It returns `ManagedPiSkillLaunchPlan`, but the plan only exposes the applied paths/slugs, not:
  - ambient default external skill inputs,
  - rejected `missing` / `invalid` / `unloadable` / archived candidates,
  - same-record and same-slug losers with human-readable reasons,
  - or any structured collision payload.
- `src/pages/SessionsPage.tsx` and `SessionRuntimeDetails` currently show extension/runtime metadata only. There is no managed-skills section, no snapshot id/path, and no way to explain why a skill loaded or did not load.
- Runtime details are already available through Tauri and the remote session API, so the new runtime diagnostics contract must be additive and serialization-safe across:
  - `src-tauri/src/models.rs`
  - `src/types.ts`
  - `src/lib/orchestraClient/remoteApiClient.ts`
  - `src/lib/orchestraClient/mockBindings.ts`
- Settings → Skills is still intentionally local-only (`src/lib/skills.ts` rejects hosted-web/mock). ORC-145 should keep Settings diagnostics local-only for now; ORC-147 can widen that later.
- `src/settings/SkillsPanel.tsx` already has:
  - status badges for `shadowed` / `missing` / `invalid` / `unloadable`,
  - external warning banners,
  - and the ORC-149 assignment editor.

  That means ORC-145 does **not** need a second assignment flow. It should attach migration/conflict guidance directly to the existing panel and binding section.
- Important runtime nuance from ORC-146: catalog `shadowed` status is **not** a hard runtime exclusion. Runtime resolution recomputes precedence from bindings + context. The diagnostics model needs to explain that explicitly so the UI does not over-claim what `shadowed` means.

## Recommended implementation

### 1. Add one canonical managed-skills diagnostics shape

Recommended additive model in Rust + TS:

- `ManagedSkillRuntimeDiagnostics`
  - `state: "resolved" | "error"`
  - `context`
  - `contextHash`
  - `ambientSkills[]`
  - `resolvedSkills[]`
  - `suppressedSkills[]`
  - `scopedSnapshot`
  - `globalPublicationManifestPath`
  - `notes[]`
  - `warnings[]`
  - `errorMessage`
- `ManagedSkillRuntimeAmbientEntry`
  - ambient source kind: `default_external` or `published_global`
  - slug
  - optional skill id/name/source path/materialized dir
- `ManagedSkillRuntimeResolvedEntry`
  - skill id / binding id / slug / name
  - scope kind / source kind
  - load mode: `ambient` or `scoped`
  - source/content path
  - relative source path
- `ManagedSkillRuntimeSuppressedEntry`
  - same core fields as resolved entries
  - suppression reason, e.g.:
    - `archived`
    - `missing`
    - `invalid`
    - `unloadable`
    - `same_record_deduped`
    - `same_slug_suppressed`
    - `ambient_collision`
    - `empty_slug`
  - optional winning skill/binding reference
  - human-readable explanation
- `ManagedSkillCatalogDiagnostics`
  - external root path
  - discovered external counts by status
  - migration callout payload
  - per-skill warning summaries for list/detail rendering
  - conflict counts for scoped-vs-ambient collisions

The main goal is to keep the payload structured enough that:

- the runtime-details modal can render explanation UI without reverse-engineering strings,
- Settings can show badges/warning stacks without duplicating backend rules,
- and logs/domain events can store the same durable shape.

### 2. Build diagnostics inside `runtime_skills.rs`, not in the UI

ORC-145 should extend the existing runtime-resolution path instead of recreating precedence logic in React.

Recommended changes inside `src-tauri/src/services/runtime_skills.rs`:

1. Keep all candidates through classification, instead of immediately filtering out non-loadable rows.
2. Categorize each candidate into one of:
   - resolved global winner,
   - resolved scoped winner,
   - same-record suppression,
   - same-slug suppression,
   - rejected archived/missing/invalid/unloadable/empty-slug candidate.
3. Record ambient inputs explicitly:
   - valid default `~/.agents/skills` slugs,
   - published global winners.
4. Convert the current hard collision strings into structured diagnostics first, then map them to:
   - `warnings[]` / `errorMessage` for runtime details,
   - logs/domain events,
   - and optional Settings conflict affordances.
5. Add an explanatory note such as:
   - “Catalog `shadowed` status is not treated as a runtime exclusion; runtime precedence is recomputed from scope + source ordering.”

Recommended implementation seam:

- keep `ManagedPiSkillLaunchPlan` as the launch artifact,
- but add a sibling diagnostics payload to it, or wrap both in a new internal result type,
- so `live_sessions.rs` can store the launch plan **and** the explanation that produced it.

### 3. Extend `SessionRuntimeDetails` with managed-skills diagnostics

Add a nested `managedSkills?: ManagedSkillRuntimeDiagnostics | null` field to:

- `src-tauri/src/models.rs`
- `src/types.ts`
- client wrappers/mock bindings/remote client types.

Recommended behavior split:

#### 3.1 Live runtime attached

When a live runtime is spawned, store the **applied** managed-skills diagnostics on `SessionRuntime` next to the existing `skill_context_hash`.

Why this matters:

- a later modal open should describe the skills that the current live process actually launched with,
- not a freshly recomputed “desired” state that might already have drifted.

#### 3.2 No live runtime attached

When `get_session_runtime_details()` builds the “expected next runtime spawn” view, resolve managed-skills diagnostics fresh and attach them to the response.

Important requirement: managed-skills diagnostics must be **non-fatal** to the overall runtime-details request.

If the next launch would fail because of an ambient collision, the user should still get a runtime-details modal with:

- the ordinary runtime metadata,
- `managedSkills.state = "error"`,
- the collision warning/error text,
- and any partial context/ambient data that helps explain the failure.

Do **not** turn `get_session_runtime_details()` into an all-or-nothing wrapper around skill resolution.

### 4. Render the new diagnostics in the Sessions runtime-details modal

Extend `src/pages/SessionsPage.tsx` so the existing runtime-details dialog gets a managed-skills section with at least:

- runtime skill context source + hash
- ambient skills list
- global publication manifest path
- scoped snapshot id/path/manifest path
- resolved winners
- suppressed/rejected skills with reasons
- notes/warnings/error state

Recommended presentation:

- one compact summary row near the top (state, context source, context hash, counts)
- one ambient section
- one scoped snapshot card
- one resolved/suppressed list or table
- one warning/notes stack

The modal already works as an audit/debug surface; ORC-145 should keep the same pattern rather than inventing a new page.

### 5. Add local-only Settings catalog diagnostics and migration callout

`SkillsPanel` needs panel-level state in addition to the per-row `listSkills(true)` array.

Recommended new local Tauri command/wrapper:

- `get_skills_catalog_diagnostics()`

Return at least:

- external discovery root (`~/.agents/skills` resolved path)
- whether external skills were discovered/indexed previously
- counts for active/shadowed/missing/invalid/unloadable external rows
- scoped-vs-ambient conflict summaries
- migration callout copy inputs

Recommended banner behavior at the top of `src/settings/SkillsPanel.tsx`:

- show a migration/upgrade callout whenever Orchestra detects current or previously indexed external skills,
- explain that:
  - `~/.agents/skills` entries are now explicitly discovered and shown read-only in Settings,
  - those external skills remain ambient by default,
  - Orchestra-managed global skills are also ambient,
  - non-global scoped skills are loaded explicitly via snapshot + `--skill`,
  - and same-slug ambient/scoped mixes can conflict and block deterministic loading.

This does not need a sophisticated dismissal system in the first pass. The important thing is that existing external-skill users see the explanation instead of silently inheriting new behavior.

### 6. Surface per-skill conflict visibility in the existing Skills detail flow

Current external-status warnings already cover some of the requested scope. ORC-145 should extend that same pattern rather than replacing it.

Recommended additions:

- add warning metadata for **local and external** rows when a skill participates in a scoped-vs-ambient slug conflict risk,
- expose a list-row affordance such as a `Conflict` / `Ambient collision` badge,
- add detail warnings near the existing header/warning stack,
- and repeat the warning near the ORC-149 bindings editor so the operator sees it where they make scope choices.

Backend rule of thumb:

- keep ORC-146’s runtime collision validator authoritative,
- but reuse the same slug/collision helper for read-time warnings so the UI is not guessing.

Optional low-risk follow-up inside this same slice if implementation is straightforward:

- return an immediate `set_skill_bindings()` validation error for obviously impossible scoped-vs-ambient cases.

That preflight is helpful, but it should be treated as a convenience layer on top of the runtime validator, not a replacement for it.

### 7. Add durable audit hooks

ORC-146 already added useful spawn/reuse logs. ORC-145 should enrich the auditable trail with managed-skills-specific records.

Recommended backend logs:

- `skills.runtime.resolved`
- `skills.runtime.collision`
- `skills.runtime.snapshot_materialized`
- `sessions.runtime.respawn.skills_changed` (extend existing payload where needed)

Recommended domain-event topics:

- `session.managed_skills.resolved`
- `session.managed_skills.applied`
- `session.managed_skills.collision`

Recommended payload contents:

- session id / project id
- runtime context
- context hash
- snapshot id/path
- global publication manifest path
- resolved winners
- suppressed/rejected rows with reasons
- warnings/errors

Use the same or a trivially-derived diagnostics shape so there is only one explanation vocabulary in the codebase.

## Test coverage

### 1. Rust/service coverage

Add focused tests for:

- managed-skills diagnostics classification from mixed candidate sets
- serialization shape for the new runtime diagnostics structs
- inclusion of rejected `missing` / `invalid` / `unloadable` / archived candidates
- structured collision diagnostics for scoped-vs-ambient conflicts
- catalog diagnostics counts and migration-callout detection for discovered `~/.agents/skills`
- per-skill conflict summaries derived from bindings + ambient slug state

Primary Rust files likely touched:

- `src-tauri/src/services/runtime_skills.rs`
- `src-tauri/src/services/skills.rs`
- `src-tauri/src/services/live_sessions.rs`
- `src-tauri/src/commands/skills.rs` / `src-tauri/src/commands/sessions.rs`

### 2. Frontend/runtime-details coverage

Extend runtime-details tests so they verify managed-skills diagnostics rendering and additive serialization:

- `tests/desktop-e2e/session-runtime-details.test.ts`
- `tests/e2e/sessions.spec.ts`
- any light unit/helper coverage needed for new runtime-details rendering helpers

Minimum assertions:

- runtime details show managed-skills context/hash
- ambient skills are listed
- scoped snapshot id/path renders when present
- suppressed/rejected skills and warnings render cleanly
- collision/error state renders without suppressing the rest of the modal
- browser/mock and remote-client paths tolerate the new nested field

### 3. Settings/Skills coverage

Extend `tests/desktop-e2e/skills-settings.test.ts` for:

- migration/upgrade callout when `~/.agents/skills` entries are discovered
- shadowed/missing/invalid/unloadable warning surfaces still rendering
- scoped-vs-ambient conflict badge/detail warning visibility
- conflict guidance appearing near the bindings editor

A small TS helper test is reasonable if conflict or catalog-warning mapping logic moves into a frontend helper module.

## Repo touch points

Expected primary files:

- `docs/orc-145-managed-skills-diagnostics-migration-plan.md` **(new)**
- `src-tauri/src/services/runtime_skills.rs`
- `src-tauri/src/services/live_sessions.rs`
- `src-tauri/src/services/skills.rs`
- `src-tauri/src/models.rs`
- `src-tauri/src/commands/skills.rs`
- `src-tauri/src/commands/sessions.rs` **(if session-domain-event recording is extended here)**
- `src/types.ts`
- `src/lib/skills.ts`
- `src/lib/orchestraClient/mockBindings.ts`
- `src/lib/orchestraClient/remoteApiClient.ts`
- `src/pages/SessionsPage.tsx`
- `src/settings/SkillsPanel.tsx`
- `src/styles.css`
- `tests/desktop-e2e/session-runtime-details.test.ts`
- `tests/e2e/sessions.spec.ts`
- `tests/desktop-e2e/skills-settings.test.ts`

## Explicit non-goals for ORC-145

Do **not** expand this slice into:

- changing the ORC-146 precedence or launch semantics
- a new persisted cache/table for effective runtime skill views
- broad remote/API parity for the Skills catalog or assignment editor
- `skills.*` permission work
- a new standalone Skills editor/assignment flow outside the existing `SkillsPanel`

Those remain ORC-146 / ORC-147 territory.

## Recommended execution order

1. add the shared diagnostics structs/types in Rust + TS
2. extend `runtime_skills.rs` to produce structured runtime diagnostics and collision payloads
3. thread the diagnostics into `live_sessions.rs` and `SessionRuntimeDetails`
4. render the managed-skills section in `SessionsPage` runtime details
5. add the local-only catalog diagnostics command + Settings migration banner
6. add per-skill ambient-conflict warnings/badges in `SkillsPanel`
7. finish logs/domain events and regression coverage

## Handoff note

The main trap in ORC-145 is letting the UI invent explanations that drift from ORC-146’s runtime truth. Keep runtime resolution authoritative in the backend, make the diagnostics payload additive and serializable, and let every surface — runtime details, Skills warnings, logs, and domain events — render the same explanation. If that shared payload is right, operators will finally be able to answer the core questions this rollout creates: which skills were ambient, which were scoped, which were suppressed, and why.