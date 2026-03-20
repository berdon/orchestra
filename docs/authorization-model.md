# Orchestra authorization model

This document defines how Orchestra grants and restricts tool access for agents, role instances, and future automation surfaces.

## Goals

- Keep workforce behavior separate from authorization.
- Make the privileged orchestration path explicit and auditable.
- Support a protected built-in supervisor without overloading the workforce role model.
- Start with a low-friction UX while leaving room for richer policy management later.

## Core concepts

### Roles are workforce templates

Roles describe how transient workers behave:
- name/slug/description
- system prompt defaults
- provider/model defaults
- thinking defaults
- concurrency capacity
- runtime queue and instance behavior

Examples:
- Developer
- Reviewer
- Planner
- QA

Roles are **not** the same thing as authorization bundles.

### Policies are authorization bundles

Policies group permissions that can be attached to agents and roles.

Suggested policy fields:
- `id`
- `slug`
- `name`
- `description`
- `permissions[]`
- `system`
- `immutable`
- `createdAt`
- `updatedAt`

Policies answer the question: **what can this actor do?**

### Direct permissions remain supported

To keep the UX lightweight, Orchestra should also support attaching permissions directly to agents and roles.

Suggested fields:
- `policyIds[]`
- `directPermissions[]`

This allows the product to support policy-based access internally without forcing users to manage reusable policies up front.

## Built-in system policy

### `supervisor`

Orchestra should ship with a built-in immutable `supervisor` policy that grants full access.

Suggested shape:
- `slug`: `supervisor`
- `permissions`: `[*]`
- `system`: `true`
- `immutable`: `true`

This policy exists so Orchestra can always provide a trusted orchestration actor with the full tool surface.

## Built-in system agent

### `supervisor`

Orchestra should also ship with a protected built-in system agent named `supervisor`.

Characteristics:
- persistent identity
- persistent memory
- immutable attachment to the `supervisor` policy
- cannot be deleted
- cannot be archived
- cannot be renamed
- cannot have its access downgraded

Important boundary:
- the `supervisor` agent is **not** a workforce role
- there is **no** supervisor role
- the supervisor should not participate in role capacity, role queues, or role instance dispatch

This keeps the supervisor clearly modeled as a privileged named agent rather than a dispatchable worker template.

## Effective permission resolution

Authorization should be additive for the initial implementation.

### Role instance effective permissions

A role instance inherits the union of:
- permissions from all `role.policyIds`
- all `role.directPermissions`

### Agent effective permissions

An agent inherits the union of:
- permissions from the assigned workforce role, if any
  - all `role.policyIds`
  - all `role.directPermissions`
- permissions from all `agent.policyIds`
- all `agent.directPermissions`

If any attached policy grants `*`, the actor has full access.

### No deny rules in the first pass

Do not add deny rules or precedence rules yet.

For the first pass:
- permissions only add capabilities
- effective permissions are the union of all grants
- backend state-transition validation still applies even for supervisor-level actors

## Permissions and scopes

A permission answers whether an actor may perform a class of action.
A scope rule answers which targets that action may apply to.

Examples:
- `tasks.comment` on any task vs only the currently assigned task
- `sessions.message` on any session vs only the actor's current session
- `roles.dispatch` on all roles vs only a specific role family

Permission checks and scope checks should remain separate concepts even if scope rules land after the first permission MVP.

## Permission naming

Use `resource.action` naming.

Examples:
- `projects.read`
- `repositories.read`
- `repositories.write`
- `worktrees.create`
- `worktrees.dispose`
- `agents.read`
- `agents.create`
- `agents.update`
- `roles.read`
- `roles.create`
- `roles.update`
- `roles.dispatch`
- `sessions.read`
- `sessions.create`
- `sessions.message`
- `sessions.interrupt`
- `sessions.model`
- `tasks.read`
- `tasks.create`
- `tasks.update`
- `tasks.comment`
- `tasks.assign`
- `tasks.transition`
- `workflows.read`
- `workflows.create`
- `workflows.update`
- `logs.read`
- `system.inspect`

This gives Orchestra room to express more than a coarse read/write split.

## Tool exposure model

Every Orchestra tool should declare:
- the required permission or permissions
- optional scope rules
- any domain-specific validation rules

Examples:
- `create_task` requires `tasks.create`
- `comment_on_task` requires `tasks.comment`
- `complete_lane_as_success` requires `tasks.transition`
- `dispatch_role_queue` requires `roles.dispatch`
- `update_workflow` requires `workflows.update`

The backend remains authoritative:
- the visible tool set for a session should be derived from its effective permissions
- every tool call must still be validated server-side
- permission changes may require session refresh to expose newly granted tools, but revoked access must still be denied immediately by the backend

## MVP UX

Do not require users to create policies manually at first.

Instead, expose access simply on the role and agent editors:
- Supervisor access: on/off
- Additional permissions: multi-select or chips

Under the hood:
- enabling supervisor access attaches the built-in `supervisor` policy
- additional permissions populate `directPermissions[]`

This keeps the UX lightweight while preserving a strong internal model.

See also: [Frontend permission management design](permission-management-fe.md) for the proposed role/agent editor experience.

## Audit expectations

All privileged orchestration tool calls should be logged with:
- actor type and id
- effective permissions or policy ids
- target object ids
- outcome
- timestamp

This is especially important for the built-in `supervisor` agent.

## Summary

Orchestra should separate workforce behavior from access control:
- roles define how transient workers behave
- policies define what actors may do
- direct permissions keep the UX simple in the first pass
- the built-in supervisor system agent gets the immutable supervisor policy
- there is no supervisor workforce role
