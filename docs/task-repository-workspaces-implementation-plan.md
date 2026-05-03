# Task Repository Workspaces Implementation Plan

## Goal

Make task execution explicitly repository-aware by allowing tasks to associate multiple project repositories, materializing task-scoped repository worktrees for lane sessions, and exposing those repositories clearly in both prompts and tools.

## Requirements

- Tasks can associate multiple project repositories.
- Task creation UI uses a simple multi-select for repositories.
- If the project has a default repository, it is preselected in the create-task flow.
- Agent lane execution uses the agent working location as its base cwd.
- Role lane execution uses a temporary runtime directory created under the Orchestra project storage for that role instance.
- For every repository associated to the task, Orchestra creates a worktree inside the session workspace under `tasks/<task-id>/repos/<repository-slug>`.
- Prompt text must explicitly list the associated repositories and where they are available in the session workspace.
- Sessions get a `get_task_repositories` tool to refresh repository/path info while running.
- Backend tests and desktop E2E tests cover the new behavior.

## Design

### Data model

Add a new task↔repository join table:

- `task_repositories`
  - `task_id`
  - `repository_id`
  - `created_at`
  - primary key `(task_id, repository_id)`

Keep `tasks.repository_id` temporarily as a compatibility/primary repository field derived from the first selected repository. Use it only as a legacy convenience field while runtime logic migrates to the explicit association list.

### Runtime workspace model

#### Agent lanes

- Base cwd = agent runtime cwd / working location.
- Task repository workspaces live under:
  - `<agent-cwd>/tasks/<task-id>/repos/<repository-slug>`

#### Role lanes

- Base cwd = Orchestra-managed role runtime dir under the project, e.g.:
  - `~/.orchestra/projects/<project-slug>/role-runtimes/<role-slug>-<instance-suffix>`
- Task repository workspaces live under:
  - `<role-runtime-dir>/tasks/<task-id>/repos/<repository-slug>`

### Repository materialization

For each task-associated repository:

- use the repository's managed checkout path as the source git repo
- keep the long-lived managed checkout on a dedicated workspace branch so it does not occupy the integration branch by default
- attempt to normalize legacy clean managed checkouts onto that workspace branch before creating task worktrees
- if a managed checkout is still dirty while checked out on `defaultBranch`, fail with a repair message instead of silently leaving that branch occupied; the user must commit/stash/discard or manually move the checkout off `defaultBranch` first
- resolve the detached task worktree base from the repository's `defaultBranch` ref (local branch first, then `origin/<defaultBranch>`), not from the managed checkout `HEAD`
- create a detached worktree at the task workspace destination
- reuse the worktree if it already exists

### Prompt/tooling

Prompt additions:

- explicit task repository section
- base cwd section
- task workspace section
- one line per repository with repository name/slug and workspace path
- guidance to call `get_task_repositories(task_id)` to refresh repository/path info

Tool additions:

- `get_task_repositories(task_id)`
  - returns associated repositories
  - includes managed repository path
  - includes task workspace/worktree path when an active assignment cwd exists

## Implementation phases

1. Add task repository association backend model/storage/load APIs.
2. Update task create/update UI and draft state for repository multi-select.
3. Add runtime workspace/worktree materialization helpers and wire them into agent/role dispatch.
4. Update prompt generation and tool bridge exposure.
5. Add backend and desktop regression coverage.

## Validation

- Rust tests for task repository association syncing and workspace path generation.
- Rust tests for runtime prompt/task repository tool output.
- Desktop E2E for:
  - default repository preselection
  - multi-repository task creation
  - role lane workspace with repo worktrees
  - agent lane workspace under `<agent-cwd>/tasks/<task-id>/repos/...`
  - `get_task_repositories`-driven prompt/tool visibility where practical
