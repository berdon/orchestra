# ORC-147 — skills permissions and remote/API parity plan

## tl;dr

- Treat managed skills as their own permission namespace and gate every skills catalog, binding, archive/delete, and external-refresh action with `skills.*` instead of host-kind checks or unrelated admin permissions.
- Add shared client/bootstrap parity for skills by introducing a real skills capability block plus a shared skills service that works in Tauri and `remote_api`; keep mock explicitly unavailable.
- Reuse the existing ORC-144/145/149 catalog, binding, and diagnostics commands as the semantic source of truth, then expose matching remote routes on top instead of inventing a second skills model.
- Keep runtime managed-skills diagnostics under the existing `sessions.read` surface; ORC-147’s remote work is mainly the catalog/binding/admin surface plus capability-driven UI degradation.
- Cover drift with three layers: Rust permission tests, remote parity/403 tests, and frontend action-state tests for inspect-only vs edit/assign-disabled skills UI.

## Executive summary

ORC-144, ORC-145, and ORC-149 already delivered the catalog, diagnostics, binding model, and local Settings UI, but the surrounding admin surface is still phase-1 only:

- `src-tauri/src/commands/skills.rs` has no `AuthorizationContext` and no `skills.*` checks.
- `src/lib/access.ts` does not advertise any `skills.*` permissions.
- `src/lib/skills.ts` hard-rejects hosted-web/remote use.
- `src/App.tsx` shows Settings → Skills only when `hostKind === "tauri"`.
- `src/lib/orchestraClient/*` and bootstrap capabilities have no shared skills service/capability model.
- `src-tauri/src/services/remote_api.rs` exposes no managed-skills routes.

ORC-147 should not change the storage model or runtime-resolution rules again. The work here is the missing outer shell around the existing implementation:

1. define the `skills.*` permission group and map every action to the right permission,
2. apply those checks consistently in commands and remote routes,
3. expose the same catalog/binding/admin semantics through the shared remote/API surface,
4. replace the current desktop-only Skills gating with permission-aware capabilities,
5. and add enough automated coverage that permissions and transport parity cannot silently drift.

## Current seams to build on

- `src-tauri/src/commands/skills.rs` already exposes the full local admin surface needed for parity:
  - `list_skills`
  - `get_skill`
  - `get_skills_catalog_diagnostics`
  - local CRUD/archive/delete
  - `refresh_external_skills`
  - `set_skill_bindings`
  - related-surface link reads
- `src-tauri/src/services/skills.rs` and `src-tauri/src/services/skill_bindings.rs` already own the core semantics. ORC-147 should keep them authoritative.
- `src/settings/SkillsPanel.tsx` already has the edit/archive/delete/assignment UX that needs permission-aware degradation.
- `src/pages/SessionsPage.tsx` already renders managed-skills runtime diagnostics through `SessionRuntimeDetails`; remote session-runtime parity already exists and should stay additive.
- The shared frontend contract in `src/lib/orchestraClient/` already has the pattern ORC-147 needs: capability descriptors plus transport-specific bindings. Skills just are not part of that contract yet.

## Recommended implementation

### 1. Add the `skills.*` permission group and map actions explicitly

Add these permission strings to the shared permission catalog and any permission-enumeration seams that surface user-facing labels:

- `skills.read`
- `skills.create`
- `skills.update`
- `skills.archive`
- `skills.delete`
- `skills.assign`

Recommended action mapping:

| Surface | Permission |
| --- | --- |
| `list_skills`, `get_skill`, `get_skills_catalog_diagnostics` | `skills.read` |
| `get_role_skill_links`, `get_agent_skill_links`, `get_workflow_skill_links` | `skills.read` |
| `create_local_skill` | `skills.create` |
| `update_local_skill` | `skills.update` |
| `refresh_external_skills` | `skills.update` |
| `archive_local_skill`, `unarchive_local_skill` | `skills.archive` |
| `delete_local_skill` | `skills.delete` |
| `set_skill_bindings` | `skills.assign` |

Important nuance:

- keep runtime managed-skills diagnostics under the existing session surface. `get_session_runtime_details()` should stay gated by `sessions.read`, because it is a session/runtime inspection API that happens to include managed-skills detail.
- do **not** invent a second `skills.refresh` permission in this slice. Refresh mutates catalog discovery state, so `skills.update` is the cleanest existing fit.

Files to touch first:

- `src/lib/access.ts`
- `tests/access.test.ts`
- any user-facing permission-label helpers that need the new strings

### 2. Put authorization on every skills command seam

Update `src-tauri/src/commands/skills.rs` to follow the same pattern already used by roles, agents, projects, workflows, and policies:

- add `authorization: Option<AuthorizationContext>` to every command that needs it,
- call `command_authorization::require_permission(...)` with the mapped `skills.*` permission,
- add authorized audit logging on mutating paths, matching the existing command style.

Recommended audit/log actions:

- `create_local_skill`
- `update_local_skill`
- `archive_local_skill`
- `unarchive_local_skill`
- `delete_local_skill`
- `refresh_external_skills`
- `set_skill_bindings`

This is the main backend consistency fix. Once the commands are correct, Tauri and remote callers can share the same semantics instead of re-implementing permission logic in multiple layers.

### 3. Expose remote/API parity for the managed-skills admin surface

Add dedicated remote routes in `src-tauri/src/services/remote_api.rs` that forward to the same command/service seams used by Tauri.

Recommended route set:

- catalog reads/writes
  - `GET /api/v1/skills`
  - `GET /api/v1/skills/catalog-diagnostics`
  - `GET /api/v1/skills/:skill_id`
  - `POST /api/v1/skills`
  - `PATCH /api/v1/skills/:skill_id`
  - `POST /api/v1/skills/:skill_id/archive`
  - `POST /api/v1/skills/:skill_id/unarchive`
  - `DELETE /api/v1/skills/:skill_id`
- external discovery refresh
  - `POST /api/v1/skills/refresh-external`
- binding admin/read surface
  - `POST /api/v1/skills/:skill_id/bindings` (full-set replace, mirroring `set_skill_bindings`)
  - `GET /api/v1/roles/:role_id/skills`
  - `GET /api/v1/agents/:agent_id/skills`
  - `GET /api/v1/workflows/:workflow_id/skills`

Runtime/detail reads:

- do **not** add a second “runtime skills” route unless a concrete frontend need appears.
- keep `/api/v1/sessions/:session_id/runtime` as the canonical remote read for managed-skills runtime snapshot/detail information.

Implementation rule:

- remote handlers should call the same command or service seams as desktop/Tauri so the DTOs and authorization semantics stay aligned.
- do not fork a separate remote-only skills DTO model.

### 4. Extend the shared OrchestraClient contract instead of keeping skills local-only

The current shared client has no skills service, so `src/lib/skills.ts` had to become a Tauri-only escape hatch. ORC-147 should close that gap cleanly.

Recommended contract additions:

- new feature flag: `sharedSkills`
- new capability block:

```ts
skills: {
  read: OrchestraCapabilityDescriptor;
  create: OrchestraCapabilityDescriptor;
  update: OrchestraCapabilityDescriptor;
  archive: OrchestraCapabilityDescriptor;
  delete: OrchestraCapabilityDescriptor;
  assign: OrchestraCapabilityDescriptor;
}
```

- new shared service, e.g. `OrchestraSkillsService`, containing:
  - `listSkills(includeArchived?)`
  - `getSkill(skillId)`
  - `getCatalogDiagnostics()`
  - `createLocalSkill(input)`
  - `updateLocalSkill(skillId, input)`
  - `archiveLocalSkill(skillId)`
  - `unarchiveLocalSkill(skillId)`
  - `deleteLocalSkill(skillId)`
  - `refreshExternalSkills()`
  - `setSkillBindings(skillId, bindings)`
  - `getRoleSkillLinks(roleId)`
  - `getAgentSkillLinks(agentId)`
  - `getWorkflowSkillLinks(workflowId)`

Touch points:

- `src/lib/orchestraClient/bootstrap.ts`
- `src/lib/orchestraClient/bootstrapFactory.ts`
- `src-tauri/src/models.rs`
- `src-tauri/src/services/remote_api.rs` bootstrap builders
- `src/lib/orchestraClient/client.ts`
- `src/lib/orchestraClient/serviceBindings.ts`
- `src/lib/orchestraClient/baseClient.ts`
- `src/lib/orchestraClient/tauriBindings.ts`
- `src/lib/orchestraClient/remoteApiClient.ts`
- `src/lib/orchestraClient/mockBindings.ts`
- `tests/orchestra-client-remote-api.test.ts`
- `tests/orchestra-client-remote-api-contract.test.ts`

Recommended frontend migration shape:

- keep `src/lib/skills.ts` as the import surface used by `SkillsPanel`, but refactor it to call the active `OrchestraClient` skills service instead of hard-coding local Tauri `invoke(...)` calls.
- keep mock explicitly unavailable by bootstrap capability and by rejecting skill-service calls with a clear unsupported-host error.

That keeps ORC-147 additive instead of forcing a full UI rewrite.

### 5. Replace host-kind gating with capability-driven UI behavior

Current UI behavior is too coarse:

- `App.tsx` uses `hostKind === "tauri"` for Skills visibility,
- `SkillsPanel` assumes write access if the host is desktop,
- related deep links in Agents/Roles/Workflows are also keyed to that same host check.

Recommended UI rules:

#### 5.1 Settings tab visibility

- show Settings → Skills whenever `bootstrap.capabilities.skills.read` is available.
- remove the direct `hostKind === "tauri"` dependency from this decision.
- add a helper alongside the other capability helpers in `src/lib/orchestraClient/extensions.ts`, e.g. `supportsSkillsSettings(...)`.

#### 5.2 Fine-grained action states inside `SkillsPanel`

Use the new capability block to drive action affordances:

- `read` missing
  - Skills tab hidden entirely
- `read` available, but `create` missing
  - list/detail visible
  - “New local skill” disabled/hidden with explanatory copy
- `update` missing
  - local content editor becomes read-only
  - “Save changes” disabled
  - “Refresh external” disabled
- `archive` missing
  - archive/unarchive buttons disabled
- `delete` missing
  - delete button disabled
- `assign` missing
  - current bindings remain visible
  - binding selectors/toggles/save button are read-only
  - helper copy explains that assignments are inspect-only with current permissions

Keep the existing source-based rule too:

- external skill content remains read-only even when `skills.update` is available,
- but assignment remains editable for external rows when `skills.assign` is available.

#### 5.3 Related surfaces

For linked-skill sections in:

- `src/settings/AgentsPanel.tsx`
- `src/settings/RolesPanel.tsx`
- `src/settings/WorkflowsPanel.tsx`

Recommended rule:

- require `skills.read` before loading or showing linked managed-skill names and deep links.
- if the user can inspect the parent entity but not skills, show a small note such as “Managed skill links are unavailable with the current permissions.” instead of leaking the catalog through related screens.

### 6. Keep remote bootstrap/capabilities honest

Once the new skills routes and service are real, update the bootstrap builders so remote and local clients advertise the correct state.

Rules:

- Tauri optimistic/bootstrap capability descriptors should mark skills available in the trusted desktop shell.
- remote bootstrap should expose `skills.*` availability only when the corresponding routes exist.
- read-only vs edit/assign-disabled remote states should be represented through the per-action skills capability block rather than by hiding the entire tab.
- bump the shared contract version/date once the bootstrap shape changes.

## Validation plan

### 1. Rust/backend permission coverage

Add focused tests around `src-tauri/src/commands/skills.rs` and/or the underlying auth seams that prove:

- `skills.read` gates catalog/detail/diagnostic/link reads
- `skills.create` gates local create
- `skills.update` gates local update and external refresh
- `skills.archive` gates archive + unarchive
- `skills.delete` gates delete
- `skills.assign` gates full binding replacement
- missing permission returns the same clear forbidden error shape used elsewhere

### 2. Remote parity + forbidden coverage

Add remote tests in `src-tauri/src/services/remote_api.rs` that prove:

- the new read routes serialize the same payloads as the local command surfaces
- write routes forward the same semantics as the command surfaces
- missing permissions map to `403 Forbidden`
- session runtime detail routes still serialize managed-skills diagnostics remotely

Also extend the route probe harness with a new parity case, e.g. `skills_parity`, that compares representative remote responses against the command outputs for:

- `GET /api/v1/skills`
- `GET /api/v1/skills/:skill_id`
- `GET /api/v1/skills/catalog-diagnostics`
- at least one related-surface link read

### 3. Shared client/front-end coverage

Recommended TS coverage additions:

- `tests/access.test.ts`
  - include the new `skills.*` options in the permission catalog coverage
- `tests/orchestra-client-remote-api.test.ts`
  - verify remote skills methods hit the expected routes and respect the new capability descriptors
- `tests/orchestra-client-remote-api-contract.test.ts`
  - update bootstrap expectations for the new `sharedSkills` / `capabilities.skills` shape
- `tests/skillsUi.test.ts`
  - add a pure action-state helper test matrix for:
    - inspect-only (`read` only)
    - edit without assign
    - assign without edit
    - full access
    - external-source read-only content with assign allowed

Because the repo does not currently lean on component-level React tests for Settings panels, extracting a small pure `resolveSkillActionState(...)` helper is the lowest-friction way to lock down the permission-sensitive UI states.

### 4. Browser/hosted-web proof

Add one hosted-web or remote-adapter regression that proves the Skills surface is no longer desktop-only once the shared route/capability surface exists.

A good representative check is:

- authenticated remote bootstrap advertises skills read access,
- Settings → Skills appears,
- catalog/detail loads through the remote transport,
- and at least one restricted action is visibly disabled when the capability matrix says inspect-only.

## Suggested execution order

1. add the `skills.*` strings and labels in the shared permission catalog
2. add authorization + audit logging to `commands/skills.rs`
3. add remote routes for the skills catalog, bindings, and diagnostics surface
4. extend bootstrap capabilities and add the shared skills client service
5. refactor `src/lib/skills.ts` and `SkillsPanel` to use capability-driven shared services
6. replace `hostKind === "tauri"` skills gating in `App.tsx` and related linked-skill deep links
7. add Rust permission tests, remote parity/403 tests, and frontend action-state coverage

## Scope guard

ORC-147 should **not**:

- redesign the `skills` or `skill_scope_bindings` tables
- change runtime-resolution precedence rules from ORC-146
- move runtime managed-skills diagnostics off the existing session runtime detail surface
- broaden mock/browser-only fake skills support beyond explicit “unavailable” stubs

## Handoff summary

The cleanest ORC-147 implementation is to treat managed skills exactly like the other shared admin domains already in the codebase: command-level permission checks, transport parity through the shared client contract, and capability-driven UI states instead of host-kind assumptions. If the commands remain authoritative and the bootstrap tells the truth about `skills.read/create/update/archive/delete/assign`, both the desktop shell and remote clients can administer the same skills model without drift.