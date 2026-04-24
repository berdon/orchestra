# ORC-148 — Skills settings/catalog UI plan

## tl;dr

- Add a local-desktop-only `Skills` Settings tab between `Workflows` and `Channels`, using the existing split-sidebar Settings pattern.
- Build a new `SkillsPanel` around the ORC-144 Tauri APIs: `listSkills(true)` for the catalog, `getSkill()` for selection detail, local CRUD actions for editable rows, and `refreshExternalSkills()` for external rescans.
- Keep the catalog filters client-side: search by name/slug, source filter (`All` / `Local` / `External`), and a status filter that treats `Archived` as the local archived bit and groups backend `invalid` + `unloadable` rows under the user-facing `Invalid` filter bucket.
- Give local skills an editable detail flow and external skills a clearly read-only detail flow with source/status badges, source-path disclosure, warning banners, and `SKILL.md` preview.
- Add regression coverage at the UI-helper + command-palette level plus real desktop E2E flows seeded through `ORCHESTRA_TEST_HOME` so local/external rendering and CRUD behavior stay protected without introducing browser/mock-only skills plumbing.

## Executive summary

ORC-144 already delivered the catalog foundation and local-only Tauri skill APIs. ORC-148 should build on that work directly instead of inventing a second skills model in the frontend. The cleanest implementation is a `SkillsPanel` that mirrors the existing `AgentsPanel` / `RolesPanel` / `WorkflowsPanel` shape:

- a left catalog pane for search, filters, create, and refresh,
- a right detail pane that switches between editable local skills and read-only external skills,
- shared visual treatment for source/status badges and warnings,
- and desktop-focused regression coverage that exercises the real backend/filesystem behavior.

The main scope guard is to keep this slice on the ORC-140 phase-1 data shape of **name + markdown body only**. ORC-148 should establish the Settings surface, list/detail/editor UX, and read-only bindings summary scaffolding, but it should not pull in the ORC-149 assignment editor or broader remote/mock parity work.

## Current seams and constraints to lean on

- `src/App.tsx` already owns Settings-tab routing, Settings subnav rendering, and command-palette navigation wiring.
- `src/types.ts` already includes `SkillSummary`, `SkillDetail`, and `LocalSkillUpsertInput` from ORC-144.
- `src/lib/skills.ts` already exposes the local-Tauri-only wrappers:
  - `listSkills(includeArchived)`
  - `getSkill(skillId)`
  - `createLocalSkill(input)`
  - `updateLocalSkill(skillId, input)`
  - `archiveLocalSkill(skillId)`
  - `unarchiveLocalSkill(skillId)`
  - `deleteLocalSkill(skillId)`
  - `refreshExternalSkills()`
- The backend status model is `active | shadowed | missing | invalid | unloadable` plus a separate `archived` boolean. The requested UI filter set can be satisfied by treating:
  - `Archived` as `archived === true`
  - `Invalid` as a filter bucket matching `status === "invalid" || status === "unloadable"`
  - while still rendering `Unloadable` explicitly in row/detail badges and warnings where helpful.
- Skills are intentionally local-desktop-only right now. `src/lib/skills.ts` rejects hosted-web and mock/browser mode, so ORC-148 should **hide the Settings tab outside local Tauri** rather than widening the mock/remote surface in this slice.
- ORC-149 owns binding CRUD and the assignment editor. ORC-148 only needs a read-only bindings summary area on the detail pane.

## Recommended implementation

### 1. Navigation, routing, and availability

Add a new `skills` settings tab and place it alongside the Agents / Roles / Workflows family:

- update `SettingsTab` in `src/types.ts`
- add `{ id: "skills", label: "Skills" }` in `SETTINGS_TABS` in `src/App.tsx`
- render the new panel in the Settings tab switch in `src/App.tsx`
- add a command-palette entry in `src/lib/commandPalette.ts`

Availability rule:

- show `Skills` only when the app is running against the local Tauri backend
- do not add hosted-web or mock skills support here
- gate both the Settings subnav entry and the command-palette entry with the same local-only capability check

That keeps the UI aligned with the actual backend support and avoids browser-only regressions caused by a tab that can never load its data.

### 2. New `SkillsPanel` shell

Add `src/settings/SkillsPanel.tsx` and follow the existing `ResizableSidebarLayout` pattern used by Agents/Roles:

- left pane: catalog/search/filter/actions/list
- right pane: detail/editor
- top-level state:
  - `skills`
  - `selectedSkillId`
  - `searchQuery`
  - `sourceFilter`
  - `statusFilter`
  - `loadingList`
  - `loadingDetail`
  - `saving`
  - `actionError`
  - `isCreatingLocalSkill`
  - local draft state for the detail editor

Recommended loading behavior:

- initial load calls `listSkills(true)` so archived local skills are always available for list filtering and restore flows
- selection changes call `getSkill(selectedSkillId)` for the right pane
- create / save / archive / unarchive / delete / refresh all reload the catalog and then restore the most relevant selection

### 3. Catalog list surface

The catalog should satisfy the requested browsing controls without needing new backend list endpoints.

#### Search

Use client-side matching against:

- `name`
- `slug`
- optionally `description`

Name should remain the primary visible sort/search target, but including slug/description makes the list materially easier to operate once there are collisions or terse names.

#### Source filter

Provide a simple segmented filter:

- `All`
- `Local`
- `External`

This maps directly to `sourceKind`.

#### Status filter

Recommended user-facing filter values:

- `All`
- `Active`
- `Archived`
- `Shadowed`
- `Missing`
- `Invalid`

Filter mapping:

- `Active` → `!archived && status === "active"`
- `Archived` → `archived === true`
- `Shadowed` → `status === "shadowed"`
- `Missing` → `status === "missing"`
- `Invalid` → `status === "invalid" || status === "unloadable"`

Row badges should still show the exact state, so an unloadable external row can display an `Unloadable` badge even though it lives under the broader `Invalid` filter bucket.

#### List item rendering

Each row should show:

- skill name
- slug or relative source path as secondary metadata
- short description if present
- source badge (`Local` / `External`)
- status badge(s)
- an obvious read-only cue for external entries

Recommended row ordering:

- preserve backend order from `listSkills(true)` unless a later UX issue makes a client-side reorder necessary
- keep local and archived rows visible when filters allow them

#### Left-pane actions

Required actions:

- `New local skill`
- `Refresh external`

Recommended behavior:

- `New local skill` opens a blank draft in the detail pane without immediately creating a DB row
- `Refresh external` calls `refreshExternalSkills()` and then reloads the selected row if it still exists
- disable or show a busy label while actions are in flight

### 4. Local skill detail/editor flow

Local skills should be fully editable in the right pane.

#### Editable fields

- `name`
- `slug`
- `markdownBody`

This must stay phase-1-clean: no frontmatter editor, no scope editor, no structured metadata block.

#### Derived description preview / validation

Add a small frontend helper module for draft-only logic, e.g. `src/lib/skillsUi.ts`, to mirror the backend rules closely enough for live preview:

- normalize markdown newlines
- derive the description from the first non-empty non-heading/non-rule paragraph, ignoring fenced code blocks
- derive the slug preview from the name when the slug field is blank
- validate explicit slug input against the backend regex before save

Important boundary:

- the backend remains the source of truth
- the frontend helper is for immediate UX only, so the UI should still surface backend validation errors verbatim after save attempts

#### Actions

For a local row, the detail header should support:

- `Save changes` / `Create skill`
- `Archive` / `Unarchive`
- `Delete`

Delete behavior should be explicitly consistent with backend constraints:

- show a confirmation step
- if deletion is blocked by `skill_scope_bindings`, surface the backend error inline instead of masking it

#### Dirty-state handling

Track draft dirtiness and avoid silent loss when switching rows or starting a new skill. A lightweight confirm/discard prompt is sufficient.

### 5. External skill detail flow

External skills should open in the same right-side detail region but with visibly read-only behavior.

#### Required external detail elements

- read-only `SKILL.md` preview using the existing `MarkdownContent` renderer
- source-path disclosure (`sourcePath`, `contentPath`, and `relativeSourcePath` when present)
- source badge + read-only badge
- warning banner(s) for `shadowed`, `missing`, `invalid`, and `unloadable`
- current bindings summary section

#### Warning treatment

Recommended mappings:

- `shadowed` → explain whether a local skill or another external winner is currently taking precedence; link the shadow winner name if it is already in the list cache
- `missing` → explain that Orchestra previously indexed the external skill but the directory is no longer present on disk
- `invalid` → explain the phase-1 rule violation from `statusReason`
- `unloadable` → explain the filesystem/read failure from `statusReason`

#### Markdown preview behavior

- if `markdownBody` is present, render it read-only
- if the backend returns `null` because the external file is missing or unloadable, show a clear empty-state message rather than a blank pane

#### Current bindings summary

ORC-149 owns editing, but ORC-148 should establish a read-only summary section now so the detail layout is stable.

Recommended approach:

- if the current `SkillDetail` payload lacks binding data, add a minimal read-only extension for summarized bindings/counts in this task
- keep it intentionally display-only: counts, scope chips, and an empty state like `No bindings yet`
- do not add scope-binding mutation controls here

That gives ORC-149 a natural place to add the assignment editor later without reworking the basic detail layout.

### 6. Shared visual language

Use one consistent badge/warning system across list and detail:

- source badges: `Local`, `External`
- state badges: `Archived`, `Shadowed`, `Missing`, `Invalid`, `Unloadable`
- read-only affordance for external rows/details

Recommended styling approach:

- reuse existing `status-badge` and Settings panel classes where possible
- only add narrowly scoped CSS for new skills-specific list/detail states

### 7. Test coverage

Because skills are local-Tauri-only, desktop-backed regression coverage is the right default.

#### Unit / helper coverage

Add focused tests for any new frontend helper module, especially:

- description derivation preview
- slug preview / explicit slug validation
- source/status filter matching
- `invalid` filter bucket covering both `invalid` and `unloadable`

#### Command palette / Settings-nav coverage

Extend existing tests so `Skills` appears only when the local desktop surface supports it:

- add `Open Settings → Skills` coverage to `tests/command-palette.test.ts`
- add or extend a browser-mode test to confirm the `Skills` tab does not appear in unsupported hosted-web/mock runs

#### Desktop E2E coverage

Add a dedicated desktop test file, e.g. `tests/desktop-e2e/skills-settings.test.ts`, seeded through `ORCHESTRA_TEST_HOME`.

Minimum scenarios:

1. **Local skill create/edit/archive/unarchive/delete**
   - open Settings → Skills
   - create a local skill
   - verify slug + description preview behavior
   - save, edit, rename slug, archive/unarchive, and delete
   - confirm the backing `~/.orchestra/skills/<slug>.md` behavior through direct command/file assertions where useful

2. **External discovery + read-only rendering**
   - seed `~/.agents/skills/**/SKILL.md` under the desktop test home
   - refresh external discovery
   - verify `External` + read-only badges
   - verify source-path disclosure and read-only markdown preview

3. **Status rendering**
   - seed at least one shadowed / missing / invalid or unloadable external case
   - verify filter behavior and warning badges/messages

This gives ORC-148 real regression protection against the exact filesystem-backed cases the UI exists to manage.

## Repo touch points

Expected primary files:

- `src/types.ts`
- `src/App.tsx`
- `src/lib/commandPalette.ts`
- `src/lib/skills.ts` (if small helpers belong there)
- `src/lib/skillsUi.ts` **(new, recommended)**
- `src/settings/SkillsPanel.tsx` **(new)**
- `src/styles.css`
- `tests/command-palette.test.ts`
- `tests/desktop-e2e/skills-settings.test.ts` **(new)**

Possible additive backend touch points only if the bindings summary truly needs extra data shape:

- `src-tauri/src/models.rs`
- `src-tauri/src/services/skills.rs`
- `src-tauri/src/commands/skills.rs`
- `src/types.ts`

## Explicit non-goals for ORC-148

Do not include here:

- scope-binding CRUD or assignment editing UI
- remote API parity for skills
- hosted-web/mock skills emulation
- runtime resolution/publication/loading behavior
- anything beyond the phase-1 `name + markdownBody` editing model

Those belong to the already-split follow-on tasks, especially ORC-149 and ORC-146.

## Recommended execution order

1. add the new Settings tab + command-palette routing/gating
2. build `SkillsPanel` list loading, filters, and selection handling
3. implement the local detail/editor flow
4. implement the external read-only detail flow and warning treatment
5. add read-only bindings summary support if the existing detail payload is insufficient
6. finish helper tests + command-palette coverage + desktop E2E regression cases
