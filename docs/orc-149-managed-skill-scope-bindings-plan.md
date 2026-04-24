# ORC-149 — managed skill scope bindings and assignment UX plan

## tl;dr

- Keep `skill_scope_bindings` as the only persisted assignment model; do **not** add `skillIds[]` write fields to projects, roles, agents, workflows, or lanes.
- Add a dedicated binding service on top of the existing table plus a skill-centric write API that replaces a skill’s direct binding set atomically after validating scope tuples, target existence, global exclusivity, and workflow-lane membership.
- Extend the local-only Skills detail view with a real assignment editor: global toggle, searchable project/role/agent/workflow pickers, and explicit workflow+lane rows for lane-scoped bindings.
- Add local-only read queries for related agent/role/workflow surfaces so they can show read-only linked-skill summaries and deep-link back into Settings → Skills without turning those entity editors into skill-assignment editors.
- Show agent inheritance explicitly as **direct bindings + inherited-from-role bindings**, but keep inheritance derived at read/runtime time rather than duplicating role bindings onto agent rows.
- Keep ORC-149 scoped to the current local-desktop rollout. Runtime load behavior, richer diagnostics, and `skills.*` permission / remote parity still belong to ORC-146 / ORC-145 / ORC-147.

## Executive summary

ORC-144 already created the catalog plus the base `skill_scope_bindings` table, and ORC-148 already created the local-only Skills UI with a placeholder bindings summary. ORC-149 should finish the missing middle layer: a centralized, validated binding model that can be edited from the Skills detail pane and queried from related worker/workflow surfaces without smearing `skillIds[]` arrays across half the schema.

The key design choice is to keep assignments **skill-centric on write** and **derived on read**:

- writes happen through a binding service that owns `skill_scope_bindings`,
- the Skills detail pane is the only editing surface,
- agent/role/workflow/lane views stay read-only and derive their linked skills from the shared table,
- and agent-role inheritance is represented as derived visibility rather than copied rows.

That keeps the storage model aligned with ORC-140, gives ORC-146 a clean resolution input, and avoids having ORC-149 accidentally become the permissions/remote-parity task that ORC-147 already owns.

## Current seams and constraints

- `src-tauri/src/services/database.rs` already creates `skill_scope_bindings`, but the current backend only uses it for delete blocking and summary counts.
- `src-tauri/src/services/skills.rs` already exposes `SkillDetail.bindingSummary`, so ORC-149 can extend the same seam instead of inventing a second skill-detail fetch.
- `src/settings/SkillsPanel.tsx` already has a stable detail layout and a read-only `Current bindings` section that can become the assignment editor.
- Settings → Skills is intentionally local-desktop-only today (`src/lib/skills.ts` rejects hosted-web/mock), so ORC-149 should keep its new mutation/read surfaces local-only too.
- Agents / Roles / Workflows already have stable detail panes plus existing Settings-selection patterns in `src/App.tsx`; that is the right place to add read-only linked-skill visibility and deep links back to the Skills editor.
- ORC-147 explicitly owns `skills.*` permissions and remote/API parity. ORC-149 should shape the APIs so that later gating is easy, but it should not broaden the remote surface prematurely.

## Recommended implementation

### 1. Keep the storage model centralized and additive

Do not add persisted `skillIds[]` columns or arrays to:

- projects
- roles
- agents
- workflows
- workflow lanes

`skill_scope_bindings` remains the source of truth.

Recommended additive DB work:

- keep the existing unique scope tuple index from ORC-144
- add reverse-lookup indexes for related-surface queries, ideally one partial index per scoped target:
  - project bindings by `project_id`
  - role bindings by `role_id`
  - agent bindings by `agent_id`
  - workflow bindings by `workflow_id`
  - workflow-lane bindings by `workflow_lane_id`

That is enough to support both skill-detail editing and reverse lookups without introducing duplicated storage.

### 2. Add a dedicated binding service and skill-centric write API

Recommended new backend seam:

- `src-tauri/src/services/skill_bindings.rs` **(new, recommended)**

Core responsibilities:

- normalize incoming binding sets
- validate target tuples and cross-record rules
- replace a skill’s direct binding set in one transaction
- load direct bindings for a skill detail view
- load derived linked-skill summaries for related agent/role/workflow surfaces

Recommended public command/API shape for this slice:

- `get_skill(skill_id)` → extend existing `SkillDetail` to include full direct binding rows, not just summary counts
- `set_skill_bindings(skill_id, bindings[])` → replace the direct binding set atomically
- `get_role_skill_links(role_id)`
- `get_agent_skill_links(agent_id)`
- `get_workflow_skill_links(workflow_id)`

Why replace-in-one-call is the right write shape:

- the Skills detail screen edits the whole assignment state at once
- global exclusivity is easier to enforce against the full requested set
- clearing removed rows and inserting new rows can happen atomically
- later permission checks in ORC-147 can gate one mutation seam (`skills.assign`) instead of many micro-mutations

Internal helper CRUD functions can still exist for tests and future reuse, but the UI-facing command should stay full-set and skill-centric.

### 3. Validate bindings by scope tuple, not by ad hoc UI rules

Recommended canonical binding input shape:

- `scopeKind`: `global | project | role | agent | workflow | workflow_lane`
- optional target ids matching the scope:
  - `projectId`
  - `roleId`
  - `agentId`
  - `workflowId`
  - `workflowLaneId`

Validation rules to enforce in the binding service:

1. **Global exclusivity**
   - if any requested binding is `global`, it must be the only binding for that skill
   - a skill cannot mix `global` with project/role/agent/workflow/workflow-lane bindings

2. **Exact scope tuple shape**
   - `global` → no target ids set
   - `project` → only `projectId`
   - `role` → only `roleId`
   - `agent` → only `agentId`
   - `workflow` → only `workflowId`
   - `workflow_lane` → both `workflowId` and `workflowLaneId`

3. **Target existence**
   - referenced project / role / agent / workflow ids must exist

4. **Workflow-lane validation**
   - the requested `workflowLaneId` must belong to the requested `workflowId`
   - do not rely on the UI’s currently loaded workflow data as the final authority

5. **One skill to many targets**
   - allow the same skill to bind to multiple projects, roles, agents, workflows, and lanes simultaneously
   - collapse exact duplicates before insert, or reject them clearly

6. **No inheritance row copying**
   - role bindings stay role bindings
   - agent bindings stay agent bindings
   - inherited visibility is derived later instead of writing duplicate agent rows for every role-bound skill

This keeps the semantics stable even if a future UI or remote client writes bindings differently.

### 4. Model agent-role inheritance as derived visibility

ORC-149 should make inheritance visible, but it should not denormalize it.

Recommended rule:

- an agent’s effective linked-skill visibility is the union of:
  - direct `agent` bindings for that agent
  - direct `role` bindings for the agent’s assigned role, if any

Recommended read model for the agent surface:

- `directSkills: SkillLinkSummary[]`
- `inheritedRoleSkills: SkillLinkSummary[]`
- optional `inheritedRoleId` / `inheritedRoleName`

Important behavior:

- do **not** pre-dedupe direct vs inherited rows away in the read model
- if the same skill is visible both directly and via the role, show both origins explicitly
- ORC-146 can later dedupe at runtime resolution time; ORC-149’s job is to make the relationship legible

That makes the operator story auditable: “this agent sees this skill directly” vs “this agent sees this skill because its role does.”

### 5. Extend `SkillDetail` with full binding rows

Keep the current summary counts, but add full binding detail to the skill detail payload.

Recommended additive types:

- `SkillBindingRecord`
  - `id`
  - `skillId`
  - `scopeKind`
  - target ids
  - small display metadata for the bound target where useful (`targetName`, `targetSlug`, `workflowName`, `laneName`)
  - timestamps
- `SkillDetail.bindings: SkillBindingRecord[]`

The summary counts remain useful for list/detail badges, but the assignment editor needs the actual rows.

### 6. Build the assignment editor directly into `SkillsPanel`

The Skills detail pane should remain the only editing surface.

#### 6.1 Global section

Add a dedicated `Global` toggle at the top of the assignments section.

Recommended behavior:

- when `Global` is on, the other scoped selectors become disabled
- if the draft already contains non-global bindings and the user enables `Global`, confirm that the other bindings will be cleared on save
- helper copy should make the semantics explicit: global means this skill is attached everywhere; it is not additive with narrower bindings

#### 6.2 Searchable scoped selectors

Add searchable selectors for:

- projects
- roles
- agents
- workflows

Recommended implementation approach:

- load target options from existing local desktop surfaces (`listProjects`, `listRoles`, `listAgents`, `listWorkflows`)
- filter client-side with a lightweight query input per scope
- render current selections as removable chips/tokens
- keep the control simple and local; do not over-engineer a shared cross-host combobox while skills are still desktop-only

#### 6.3 Workflow-lane editor rows

Lane bindings should be their own explicit editor, not a flattened chip list.

Recommended UX:

- `Add lane binding`
- each row has:
  - workflow selector
  - lane selector filtered to that workflow’s lanes
  - remove button
- the lane selector stays disabled until a workflow is chosen
- saving validates the lane/workflow relationship again in Rust

This is much clearer than trying to encode lane bindings into a single multi-select.

#### 6.4 Local vs external skill behavior

- local skill content stays editable as ORC-148 already implemented
- external skill content stays read-only
- the **assignment section** is still editable for both local and external skill rows in this slice

That preserves the ORC-148 distinction without making external skills unassignable.

#### 6.5 Draft-state handling

Add a second draft alongside the existing local-skill content draft:

- content draft (existing)
- binding draft (new)

Recommended behavior:

- switching skills should warn if either draft is dirty
- `Save changes` for local skill content remains separate from `Save assignments`
- assignment saves should refresh the selected skill detail and summary counts in place

### 7. Add read-only linked-skill summaries on related surfaces

Do not turn other entity editors into assignment editors.

Instead, add read-only sections that query the shared binding model and deep-link back into Settings → Skills.

#### 7.1 Roles

In `RolesPanel`, add a `Linked skills` section showing direct role-bound skills.

Each entry should show enough to scan quickly:

- skill name
- optional slug/source badge if helpful
- click/deep link into the Skills detail surface

#### 7.2 Agents

In `AgentsPanel`, add a `Linked skills` section split into:

- `Direct`
- `Inherited from role`

If the agent has no role, omit the inherited section.

#### 7.3 Workflows and lanes

In `WorkflowsPanel`:

- show workflow-scoped skills on the workflow detail side
- show lane-scoped skills in the selected-lane section

That satisfies both workflow and lane visibility without creating a separate lane screen.

#### 7.4 Deep-link behavior

Add a Settings-navigation helper in `App.tsx`:

- `navigateToSkill(skillId)`

Recommended implementation pattern:

- add a `skillsSelectionRequest` state object like the existing role/workflow selection requests
- pass it into `SkillsPanel`
- when a linked-skill chip/button is clicked from Roles / Agents / Workflows, switch to Settings → Skills and select that skill

### 8. Keep the new read/query surfaces local-only for now

Because ORC-147 still owns remote/API parity and `skills.*` authorization, ORC-149 should **not** thread these new binding queries through the shared remote client yet.

Recommended boundary for this slice:

- new skill-binding write/read wrappers live in `src/lib/skills.ts`
- related-surface summary sections are gated behind the same desktop-only skills capability used for Settings → Skills
- do not add browser/mock skills emulation in this task
- do not inject skill-binding data into unrelated remote entity payloads yet

That keeps the rollout coherent with ORC-148 and avoids pre-solving ORC-147 by accident.

## Test coverage

### 1. Rust/backend coverage

Add focused tests around the new binding service for:

- global exclusivity rejection
- per-scope target tuple validation
- workflow-lane membership validation
- one-skill-to-many-targets replacement round-trip
- exact-duplicate normalization or rejection
- agent linked-skill inheritance queries (direct + inherited role bindings)
- workflow + lane reverse lookups
- `get_skill()` returning both counts and full binding rows

### 2. Frontend helper coverage

If binding-draft logic lives in `src/lib/skillsUi.ts`, add tests for:

- global toggle clearing/disabling narrower scopes
- lane-row normalization
- searchable selector filtering
- dirty-state detection for assignment drafts

### 3. Desktop E2E coverage

Extend `tests/desktop-e2e/skills-settings.test.ts` or add a sibling file for at least:

1. **Binding round-trip from the Skills detail pane**
   - create a local skill
   - assign role / agent / workflow / lane bindings
   - save and reload the row
   - confirm the direct bindings persist and render correctly

2. **Global exclusivity UX**
   - add non-global bindings
   - enable global
   - verify the UI clears/disables other scopes and the backend stores only the global row

3. **Agent inheritance visibility**
   - bind a skill to a role used by an agent
   - open the agent detail surface
   - verify the skill appears under inherited-from-role, not as a direct agent binding

4. **Workflow + lane visibility**
   - bind one skill at workflow scope and one at lane scope
   - open Settings → Workflows
   - verify the workflow section and selected-lane section show the correct linked skills

This is the slice where the relationship model becomes user-visible, so regression coverage should hit the real local-desktop flow.

## Repo touch points

Expected primary files:

- `docs/orc-149-managed-skill-scope-bindings-plan.md` **(new)**
- `src-tauri/src/models.rs`
- `src-tauri/src/services/skill_bindings.rs` **(new, recommended)**
- `src-tauri/src/services/skills.rs`
- `src-tauri/src/services/database.rs`
- `src-tauri/src/commands/skills.rs`
- `src-tauri/src/services/mod.rs`
- `src/types.ts`
- `src/lib/skills.ts`
- `src/lib/skillsUi.ts`
- `src/settings/SkillsPanel.tsx`
- `src/settings/AgentsPanel.tsx`
- `src/settings/RolesPanel.tsx`
- `src/settings/WorkflowsPanel.tsx`
- `src/App.tsx`
- `src/styles.css`
- `tests/desktop-e2e/skills-settings.test.ts`

## Explicit non-goals for ORC-149

Do not include here:

- runtime effective-skill resolution, snapshot materialization, or Pi launch arg changes
- migration callouts, conflict diagnostics, or runtime explanation UI beyond the minimum needed to edit/view bindings
- `skills.*` permission enforcement
- remote/API parity for managed-skills administration
- entity-local persisted `skillIds[]` write fields
- turning agent/role/workflow surfaces into alternate binding editors

Those remain the responsibility of ORC-146, ORC-145, and ORC-147.

## Recommended execution order

1. add the binding service, reverse-lookup indexes, direct binding models, and `set_skill_bindings` transaction path
2. extend `get_skill()` / local skill wrappers so the Skills detail pane can load and save full binding rows
3. implement the assignment editor in `SkillsPanel`, including global exclusivity, searchable selectors, and workflow+lane rows
4. add local-only read queries plus read-only linked-skill sections for Roles / Agents / Workflows
5. add Settings deep-link selection plumbing for opening a specific skill from those related surfaces
6. finish Rust validation tests, binding-draft helper tests, and desktop E2E regression coverage
