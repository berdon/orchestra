# Single-use role runtime plan

## Problem

Orchestra role instances are intended to be transient capacity, not persistent collaborators. In practice, runtime code has reused idle role instances and their attached session/worktree paths. That creates correctness problems:

- stale worktree/session cwd paths can leak across tasks and projects
- runtime paths can point at the Orchestra app checkout instead of the owning project repository
- role behavior starts to overlap with persistent agents
- debugging becomes difficult because a newly dispatched task may silently inherit old runtime state

## Decision

**Role instances are single-use.**

A dispatched role-owned task/lane must create a fresh role instance with a fresh runtime workspace and fresh session scoped to the owning project.

Role instances should not be reused for later queue entries, even within the same project.

If we want continuity, that should be modeled with **agents**, not roles.

## Desired semantics

### Roles

Roles remain reusable **definitions**:
- global template
- provider/model/system-prompt defaults
- capacity limits
- permissions

But spawned role **instances** are:
- transient
- assignment-scoped
- project-scoped
- disposable after completion/failure/cancelation

### Dispatch

When a role-owned lane is dispatched:
1. create a fresh role instance
2. materialize a fresh project-scoped runtime directory/worktree for that instance
3. create a fresh session rooted in that runtime cwd
4. bind the queue entry and task assignment to that instance/session/cwd

### Completion

When the assignment finishes:
- mark the queue entry terminal
- mark the role instance terminal (`completed`, `failed`, or `canceled`)
- do not return it to `idle` for reuse
- leave disposal/cleanup explicit or immediate based on current runtime policy

## Data model implications

Current runtime semantics should become explicitly project-scoped.

Recommended expectations:
- role runtime state must always be attributable to the owning project
- queue-driven role dispatch must not search globally for reusable idle instances
- stale legacy role instances/worktree paths should not be trusted for future dispatches

## Migration / compatibility

Implementation should treat existing reusable role instances as legacy state.

Safe behavior:
- do not reuse preexisting idle instances for new work
- create new instances for new dispatches
- continue showing old instances for inspection/history if present
- allow manual disposal/cleanup of stale instances and runtime directories

## Testing expectations

Add automated proof for:
- a fresh role instance is created for each dispatched role assignment
- a second task does not reuse the first task's role instance/session/worktree
- runtime worktree and session cwd resolve from the owning Orchestra project path
- cross-project dispatch cannot inherit role runtime paths from another project
- desktop UI flows prove the behavior under the real Podman-backed runner

## Non-goal

Do not introduce a new hidden continuity mechanism for roles. That would recreate the same ambiguity under a different shape.
