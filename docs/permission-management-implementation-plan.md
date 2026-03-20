# Frontend permission management implementation plan

This plan turns the FE permission-management design into concrete implementation work for Orchestra.

Related td work:
- epic: `td-854f36` — Implement frontend permission management for roles and agents
- plan: `td-68aab4` — Write FE permission management implementation plan
- feature: `td-20d5a4` — Build role and agent access management UI
- test: `td-2c3b1d` — Add automated tests for permission management UI

## Goals

- Let users assign and remove permissions directly from the Settings editors for roles and agents.
- Keep the first pass lightweight: supervisor toggle + direct permission management + effective access visibility.
- Reuse one shared access-management UI between the role and agent surfaces.
- Preserve backend policy semantics while keeping the FE understandable.
- Ship with automated test coverage, including Playwright proof that saved access controls persist and protected actors remain locked.

## Scope for this slice

### In scope

- Shared FE permission catalog and helpers
- Shared access editor section for roles and agents
- Supervisor policy toggle
- Direct permission assignment/removal UI
- Policy chip display for attached policies
- Effective permission summary driven by resolved backend data where available
- Agent inherited-role access summary
- Protected supervisor-agent behavior in the UI
- Browser/mock parity for the permission-management flow
- Vitest coverage for permission helper logic
- Playwright tests for roles and agents permission editing flows

### Out of scope

- Full custom policy CRUD UI
- Deny rules
- Per-target scopes
- Audit-history UI
- Bulk role/agent access editing

## Current state

The current app already has:
- backend models and commands for `policyIds`, `directPermissions`, `list_policies`, `get_agent_permissions`, and `get_role_permissions`
- Settings editors for roles and agents
- mock local-storage implementations for roles and agents
- Playwright coverage for settings panels in general

The current gaps are:
- no access-management UI in the current mainline role/agent editors
- no shared permission catalog layer in the FE
- no FE wrappers around the policy/resolved-permissions commands
- mock role/agent persistence does not consistently preserve permission fields
- no automated proof for direct permission assignment/removal in the current UI

## Delivery slices

### Slice 1 — FE data plumbing

Add FE helpers and data sources needed by both panels.

Deliverables:
- `src/lib/access.ts`
  - permission catalog
  - grouping/filter helpers
  - supervisor policy helpers
  - chip/summary helper logic
- `src/lib/policies.ts`
  - `listPolicies()`
  - `getAgentPermissions()`
  - `getRolePermissions()`
- mock implementations for the same flows when Tauri is unavailable
- type-safe catalog structures for display labels, descriptions, and grouping

Acceptance:
- the FE can enumerate available permission options from one source of truth
- the FE can fetch policy summaries and resolved permission previews
- browser/mock mode persists `policyIds[]` and `directPermissions[]`

### Slice 2 — Shared access editor UI

Build reusable UI pieces used in both the Role and Agent settings panels.

Deliverables:
- `src/components/access/AccessEditor.tsx`
- `src/components/access/AccessSummary.tsx`
- `src/components/access/PermissionCatalog.tsx`
- searchable grouped checklist for direct permissions
- selected-permission chips with remove affordances
- supervisor toggle row with helper/warning copy
- attached policy chip list

Acceptance:
- users can add/remove direct permissions without editing raw strings
- users can enable/disable supervisor access where allowed
- selected permissions remain in the parent draft until save
- access UI is visually consistent across roles and agents

### Slice 3 — Role integration

Integrate the shared editor into the Roles settings surface.

Deliverables:
- role drafts include `policyIds[]` and `directPermissions[]`
- saved roles persist permission edits in both browser and Tauri modes
- effective-permissions summary appears in the role detail pane
- helper copy explains that spawned role instances inherit this access

Acceptance:
- create/edit/save role permission changes works
- supervisor toggle maps to the supervisor policy id
- effective permissions update after save/reload

### Slice 4 — Agent integration

Integrate the shared editor into the Agents settings surface.

Deliverables:
- agent drafts include `policyIds[]` and `directPermissions[]`
- agent detail loads inherited role access using resolved-permission data when available
- effective-permissions summary separates inherited vs direct access
- protected supervisor behavior is enforced visually

Acceptance:
- create/edit/save agent permission changes works
- agents show inherited role access as read-only context
- the built-in supervisor agent cannot have its access downgraded

### Slice 5 — Automated proof

Add tests that prove the feature works in browser mode and remains stable.

Deliverables:
- Vitest coverage for permission catalog/helper behavior
- Playwright role-permission test
- Playwright agent-permission test
- Playwright protected-supervisor test

Acceptance:
- `npm test` passes
- `npm run build` passes
- `npx playwright test tests/e2e/roles.spec.ts tests/e2e/agents.spec.ts` passes

## Implementation notes

### Shared permission catalog

Use a single FE catalog entry shape, e.g.:

```ts
interface PermissionOption {
  key: string;
  group: string;
  label: string;
  description?: string;
  risk?: "standard" | "sensitive" | "full-access";
}
```

The catalog should cover all currently implemented Orchestra permissions and be easy to extend later.

### Effective permission preview

Prefer backend-resolved previews over frontend recomputation when possible.

Use:
- `get_role_permissions(roleId)` for saved roles
- `get_agent_permissions(agentId)` for saved agents

For unsaved drafts:
- show a draft summary from current `policyIds` + `directPermissions`
- label it as draft/current selection
- replace it with canonical resolved data after save/reload

### Inherited agent access

Agents may inherit permissions from an assigned role.

The agent UI should:
- show the inherited role id/name when present
- separate inherited policy/permission display from direct agent grants
- avoid making inherited grants editable in the agent panel

### Protected supervisor handling

The built-in supervisor agent must:
- always show supervisor access on
- disable access-removal controls
- disable archive/downgrade paths already blocked elsewhere
- explain why the controls are locked

## Test strategy

### Vitest

Add pure tests for:
- permission grouping
- search/filter behavior
- supervisor toggle helper behavior
- permission add/remove helper behavior
- summary helper output for direct/full-access states

### Playwright

Role flow:
- open Settings → Roles
- create role
- assign supervisor access + one direct permission
- save
- assert persisted local-storage state and visible summary

Agent flow:
- open Settings → Agents
- create agent
- assign direct permissions and/or supervisor access
- save
- assert persisted local-storage state and visible summary

Protected flow:
- open built-in supervisor agent
- assert supervisor access is locked on
- assert removal/downgrade controls are disabled

## Definition of done

This work is done when:
- the implementation plan doc exists and is linked from project docs
- the role editor supports permission assignment/removal
- the agent editor supports permission assignment/removal
- effective/inherited access is visible in the UI
- protected supervisor access cannot be downgraded in the FE
- browser/mock mode and Tauri mode both preserve access data
- `npm test`, `npm run build`, and targeted Playwright tests pass
