# Frontend permission management design

This document describes the frontend UX for assigning and removing permissions on roles and agents.

## Goals

- Make access control understandable without forcing users to learn the full backend policy model first.
- Let users assign and remove permissions directly from the existing role and agent editors.
- Preserve the internal distinction between reusable policies and direct permission grants.
- Show inherited access clearly so users can tell what comes from a role versus what is attached directly to an agent.
- Prevent accidental downgrades of protected system actors such as `supervisor`.

## Non-goals for the first pass

- Full standalone policy CRUD UI.
- Deny rules or precedence rules.
- Per-target scope editors.
- Bulk editing across many roles or agents.

## Information model

The editor needs to present four kinds of access data:

1. **Attached policies** — reusable bundles attached directly to the role or agent.
2. **Direct permissions** — explicit `resource.action` grants attached directly to the role or agent.
3. **Inherited permissions** — permissions the current actor receives from related objects.
4. **Effective permissions** — the union of inherited, policy, and direct grants.

For roles:
- attached policies and direct permissions are editable
- effective permissions represent what future role instances will receive

For agents:
- attached policies and direct permissions are editable
- inherited access from the assigned role is read-only in this editor
- effective permissions represent the full access the agent will have at runtime

## Placement in the UI

Permission management should live inside the existing **Settings → Roles** and **Settings → Agents** detail panes.

Each detail pane gets a dedicated **Access** section below the execution defaults and above lower-priority metadata.

Order in the editor:
1. Configuration
2. Access
3. Memory / project overlay / validation / other secondary sections

This keeps authorization visible during editing without overwhelming the top of the form.

## Shared component model

Implement a shared frontend component for both surfaces, for example:

- `AccessEditor`
- `PermissionCatalog`
- `EffectiveAccessSummary`

Inputs to the shared editor:
- actor type: `role` or `agent`
- editable `policyIds[]`
- editable `directPermissions[]`
- available policies
- permission catalog grouped by domain
- optional inherited role summary
- flags like `system`, `immutable`, `archived`

This avoids duplicating logic between the Agents and Roles panels.

## Access section layout

The Access section should have three stacked blocks.

### 1. Effective access summary

This is the at-a-glance area.

Show:
- whether full access is granted
- number of effective permissions
- attached policies as chips
- inherited role source for agents
- a short explanatory sentence

Example summaries:
- `Full access via supervisor policy`
- `12 effective permissions`
- `Inherits 8 permissions from role Reviewer`

If the actor has no permissions, show:
- `No access grants yet`
- helper copy explaining that the actor will not be able to use protected Orchestra actions until permissions are attached

### 2. Policy attachments

This area manages reusable bundles.

#### First pass interaction

Support two policy modes:

1. **Supervisor access**
   - a dedicated, high-visibility toggle for the built-in `supervisor` policy
   - label it clearly as full access
   - show destructive warning copy when enabling it on non-system actors

2. **Other attached policies**
   - read-only for now if custom policy management is not exposed yet
   - if reusable non-system policies exist later, show them in a searchable multi-select / combobox

Recommended first-pass UI:
- a prominent toggle row for `Supervisor access`
- attached policy chips beneath it
- each removable chip has an `×` remove affordance
- immutable/system policies render locked with a lock icon and no remove affordance

Copy for supervisor toggle:
- label: `Grant supervisor access`
- helper: `Supervisor access grants the full Orchestra permission surface.`

### 3. Direct permissions

This is the main assignment/removal surface.

Use a searchable grouped checklist rather than a flat chip input.

Reasons:
- permission names are structured and enumerable
- grouped checklists make discoverability better than freeform text
- they reduce typos and keep naming consistent with backend permissions

#### Permission catalog behavior

Permissions should be grouped by resource domain, for example:
- Agents
- Roles
- Sessions
- Workflows
- Policies
- Projects
- Logs
- Tasks (when task tools land)
- System

Within each group:
- list checkbox rows for each permission
- show short helper descriptions where needed
- sort by action (`read`, `create`, `update`, `archive`, etc.)

Top-of-section controls:
- search input filtering groups and permissions
- optional quick filter chips like `Read`, `Write`, `Runtime`, `Admin`
- selected count summary

Selected permissions should also appear as removable chips above the checklist so users can scan and remove quickly.

## Agent-specific behavior

Agents need one extra concept: inherited access from their assigned role.

The Access section for agents should split effective access into:

- **Inherited from role**
- **Attached directly to this agent**
- **Effective total**

If an agent has an assigned role:
- show a read-only card like `Inherits from Reviewer`
- show inherited policies and permissions as read-only chips/list items
- clearly separate these from direct agent grants

If an agent has no assigned role:
- omit the inherited block
- explain that all effective permissions must come from direct grants/policies

Important UX rule:
- do not let users remove inherited permissions from the agent editor
- instead provide a link or hint: `Edit the role to change inherited access`

## Role-specific behavior

Roles are simpler because their access is their own.

The role editor should present:
- attached policies
- direct permissions
- effective total for future role instances

Helper copy should explain:
- `These permissions are inherited by role instances spawned from this role.`

## Protected and immutable actors

Protected actors need stricter UI states.

### Supervisor agent

For the built-in system `supervisor` agent:
- supervisor policy chip is always present
- supervisor toggle is forced on and disabled
- remove affordances for protected access are hidden
- show helper copy: `Supervisor access is required for this protected system agent.`

Other editable fields may remain editable according to the broader system rules, but access-downgrade controls must not be available.

### Immutable/system policies

If the actor has an immutable attached policy:
- show lock icon
- disable removal
- explain why the policy is locked

## Drafting and save behavior

Permission changes should follow the same edit model as the rest of the role/agent form.

That means:
- changes update the local draft immediately
- no backend writes happen per-click
- users commit all changes with the pane's existing `Save changes` action

Why:
- consistent mental model with the rest of the form
- avoids partial saves while editing several fields
- lets users review permission changes before committing

Unsaved permission edits should participate in the page's normal dirty state.

## Validation and feedback

### Client-side validation

Validate before save:
- dedupe repeated permissions/policies
- suppress direct edits to locked supervisor access where prohibited
- reject unknown permission keys from stale drafts

### Save feedback

After save:
- show normal success behavior for the panel
- refresh detail data so effective permissions reflect canonical backend state
- if available, refresh resolved permissions from `get_role_permissions` / `get_agent_permissions`

### Error cases

Show inline or section-level errors for:
- permission update rejected by backend authorization
- immutable actor cannot be downgraded
- unknown or removed policy id
- stale data conflict after object changed elsewhere

## Recommended backend data for the FE

The editor should load:

- role/agent definition
  - `policyIds[]`
  - `directPermissions[]`
  - `system`
  - `immutable`
- available policy summaries
- resolved permissions for preview
  - role: `get_role_permissions`
  - agent: `get_agent_permissions`

The effective summary should be driven by resolved backend data when possible, not only frontend recomputation.

## Permission catalog source of truth

The frontend should not hardcode permission strings in multiple places.

Instead, introduce a shared catalog definition with:
- permission key
- domain label
- display label
- short description
- optional risk level (`standard`, `sensitive`, `full-access`)

Example shape:

```ts
interface PermissionOption {
  key: string;
  group: string;
  label: string;
  description?: string;
  risk?: "standard" | "sensitive" | "full-access";
}
```

This catalog can initially live in the frontend, but should be structured so it can later move to a backend-provided manifest.

## Interaction details

### Assignment

Users can assign access by:
- enabling the supervisor toggle
- checking permissions in the catalog
- selecting reusable policies when available

### Removal

Users can remove access by:
- disabling the supervisor toggle, unless locked
- unchecking a direct permission
- removing a direct-permission chip
- removing an attached policy chip, unless locked

### Search and scanning

To make the surface usable once the permission list grows:
- keep group headings sticky within the access pane if needed
- allow text search across permission key, label, and description
- show `n selected` and `n effective` summaries

## Visual guidance

Use the existing Settings visual language:
- one section card for Access
- subtle separators instead of nested heavy cards
- chips for attached and selected access grants
- warnings only for truly sensitive operations like supervisor access

Status styling:
- neutral for inherited/read-only grants
- accent for direct grants
- warning for full-access / supervisor
- locked styling for immutable grants

## Future extension points

This design should grow into richer policy tooling without reworking the role/agent editors.

Future additions:
- create/edit reusable policies from Settings
- attach multiple reusable named policies from a dialog
- per-target scope rules
- audit/history drawer showing recent access changes
- diff view showing what changed before save

## Suggested implementation order

1. Extract a shared permission catalog in the frontend.
2. Add an `Access` section component used by both role and agent editors.
3. Show current direct permissions and supervisor access using the existing draft fields.
4. Add effective-permissions preview backed by resolved permission commands.
5. Add policy selection once reusable policy UI is exposed.

## Summary

The FE should treat permission management as a first-class part of the role and agent editors:
- direct permissions are the main editable surface
- supervisor access gets a dedicated high-signal control
- inherited access is visible but read-only
- protected actors cannot have critical grants removed
- effective permissions are always summarized so users understand the final runtime result
