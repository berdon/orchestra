# Role runtime plan

This plan covers the runtime half of Orchestra roles: how role-owned workflow lanes resolve into queue entries, transient role instances, sessions, and disposable worktrees.

## Goals

- Keep **role definitions** focused on reusable global configuration.
- Make **project-scoped runtime state** durable enough to survive app restarts.
- Keep dispatch logic centralized and auditable.
- Support a useful first-pass workforce UI before full task management lands.

## Boundary: static vs runtime

### Static role definitions

Role definitions are global templates managed in **Settings > Roles**.

They own:
- name/slug/description
- provider/model/system prompt defaults
- thinking level defaults
- concurrency capacity
- attached policy ids and direct permissions for spawned role instances
- archived state

Important boundary:
- roles remain workforce templates, not authorization policies
- Orchestra's protected `supervisor` actor is a system agent with the immutable `supervisor` policy, not a workforce role

### Runtime role state

Runtime state is separate and project-scoped:
- queue entries waiting for a role in a project
- active/paused/completed role instances
- linked sessions
- linked worktree paths
- timestamps, status, and lightweight operator notes

Runtime role state belongs to the **Agents / workforce** area for the current project.

## Runtime data model

### Role queue entry

Represents a unit of work assigned to a role-owned workflow lane.

Suggested fields:
- `id`
- `projectId`
- `roleId`
- `status` (`queued`, `assigned`, `completed`, `canceled`)
- `sourceType` (`workflow_lane`, `manual`)
- `sourceTaskId?`
- `sourceWorkflowId?`
- `sourceLaneId?`
- `title`
- `summary?`
- `entryPrompt?`
- `assignedInstanceId?`
- `createdAt`
- `updatedAt`
- `startedAt?`
- `completedAt?`

Notes:
- `manual` source type is useful for exercising the runtime before full task/lane integration exists.
- The queue entry is the durable record of work waiting on a role inside a project.

### Role instance

Represents a transient worker spawned from a global role definition inside a project.

Suggested fields:
- `id`
- `projectId`
- `roleId`
- `displayName`
- `status` (`idle`, `running`, `waiting`, `completed`, `failed`, `canceled`)
- `currentQueueEntryId?`
- `sessionId?`
- `worktreePath?`
- `lastHeartbeatAt?`
- `lastError?`
- `createdAt`
- `updatedAt`

Notes:
- Role instances are single-use transient workers and must not be reused for later queue entries.
- The instance owns the runtime session/worktree association for exactly one dispatched assignment.
- Effective permissions for the instance should be resolved from the role's attached policies plus direct permissions.

## Dispatch model

### Queueing

When work enters a role-owned lane:
1. create a queue entry for the target role in the active project
2. log `role.queue.updated`
3. attempt dispatch

### Dispatch rules

When dispatch runs for a role in a project:
1. count non-terminal instances for the role in that project
2. if active instance count is below `role.capacity`, create a fresh instance for the queued entry
3. assign the oldest queued entry (FIFO)
4. provision a disposable worktree/runtime directory for that instance
5. create a fresh session for the instance
6. mark queue entry `assigned`
7. mark instance `running`
8. log `role.instance.assigned`

### Completion/release

When work finishes or is manually released:
1. mark queue entry terminal (`completed`/`canceled`)
2. update instance to a terminal state
3. do not return the instance to `idle` for reuse
4. keep the session/worktree inspectable until disposed according to current cleanup policy
5. run dispatch again for the next queued entry using a fresh instance

## Session policy

### First pass

- A role instance gets one Orchestra-managed session.
- That session is reused while the instance stays alive.
- Manual queue entries are enough to exercise the runtime before full task/lane automation exists.

### Later task/lane integration

When real workflow tasks arrive:
- queue entries should capture `sourceTaskId` + `sourceLaneId`
- lane-run/session continuity rules should decide whether to reuse an existing lane session
- if a task re-enters the same lane, resume the previously recorded lane session instead of creating a new one

## Worktree policy

### First pass

- Disposable role worktrees live under the project repository worktrees directory.
- Use a deterministic prefix such as `runtime-<role-slug>-<instance-short-id>`.
- Provision via `git worktree add --detach` from the current project main branch.
- Store the created path on the role instance.

Suggested location:

```text
~/.orchestra/projects/{project-slug}/repositories/{repo-slug}/worktrees/roles/{instance-slug}/
```

### Disposal

Disposal should be explicit in the first pass:
- operator can release/dispose an instance
- runtime removes the git worktree if it still exists
- log `role.worktree.disposed`

If disposal fails, record the error and leave the instance inspectable.

## Backend service split

Keep runtime logic out of workflow/session CRUD code.

Recommended runtime services:
- `role_runtime.rs`
  - queue CRUD
  - instance CRUD
  - aggregation/snapshots for workforce UI
- `role_dispatch.rs`
  - capacity checks
  - queue assignment
  - session/worktree provisioning
  - release/dispose flows
- `git_worktrees.rs`
  - focused helper for creating/removing disposable worktrees
- `dispatcher.rs`
  - periodic poll loop for queued agent and role work

This avoids monolithic orchestration code and keeps side-effectful logic isolated.

## Initial command surface

### Runtime inspection
- `list_role_operations(projectId)`
- `get_role_operations(projectId, roleId)`

### Runtime control
- `enqueue_role_work(input)`
- `dispatch_role_queue(projectId, roleId?)`
- `release_role_instance(instanceId, outcome)`
- `dispose_role_instance(instanceId)`

These commands are enough for a first-pass workforce UI and for later task integration.

## Workforce UI shape

The Agents area should show roles as operational workers, not config records.

For each role show:
- name
- capacity used / total
- queue depth in the current project
- active instance count
- latest assignment
- latest failure

For each active instance show:
- display name
- status
- assigned work title
- session id
- worktree path
- last updated time
- last error if present

Operator actions:
- enqueue manual work
- run dispatch
- release instance
- dispose instance

## Logging

Log these runtime events at minimum:
- `role.queue.updated`
- `role.instance.created`
- `role.instance.assigned`
- `role.instance.released`
- `role.instance.failed`
- `role.worktree.created`
- `role.worktree.disposed`
- `role.session.created`
- `role.session.reused`
- `dispatcher.tick.started`
- `dispatcher.tick.completed`

## Delivery order

1. **Persistence foundation**
   - project-scoped runtime tables
   - snapshots/queries
   - tests
2. **Dispatch + side effects**
   - queue assignment
   - session creation/reuse
   - worktree create/dispose
   - logs
3. **Workforce UI**
   - operational view in Agents
   - manual enqueue + dispatch controls
   - instance inspection/actions
4. **Later task integration**
   - create queue entries from workflow lane transitions
   - connect lane-run continuity and task detail surfaces

## Explicit non-goals for this slice

Do not block first runtime delivery on:
- automatic task creation flows
- comment interruption semantics
- advanced queue reordering
- durable event sourcing
- sophisticated worker health monitoring
- cross-project runtime sharing for one live role instance
