# Orchestra

<p align="center">
  <a href="https://berdon.github.io/orchestra/"><strong>GitHub Page</strong></a>
  &nbsp;•&nbsp;
  <a href="https://hnsn.io/Orchestra_0.1.0_aarch64.dmg"><strong>Download Orchestra for macOS</strong></a>
</p>

Orchestra is an agent orchestration workbench for running real project work.

It brings together **tasks, workflows, repositories, worktrees, agents, role-based workers, sessions, permissions, and human oversight** in one system so teams can coordinate delivery instead of juggling chat threads, issue trackers, and ad hoc scripts.

Orchestra is built for people who want more than a ticket board and more control than a generic chat UI.

<p align="center">
  <img src="public/github-landing/workflow-ticket-board.png" alt="Orchestra task board showing work distributed across workflow lanes." />
</p>

## Why Orchestra

Use Orchestra when you want to:

- run work through **custom workflows** instead of a fixed pipeline
- keep **tasks, repo context, and execution state** connected
- coordinate **persistent agents** and **disposable role-owned work**
- keep a **human supervisor in control** through natural-language commands
- manage orchestration across **desktop, mobile, Telegram, and CLI**

## Screenshots

### Workflow orchestration

<p>
  <img src="public/github-landing/workflow-lanes.png" alt="Orchestra Development workflow lanes shown in the workflow settings view." width="49%" />
  <img src="public/github-landing/workflow-controls.png" alt="Orchestra workflow lane editor showing worktree and approval controls." width="49%" />
</p>

Design lane structure, ownership, transitions, approvals, and worktree behavior directly in the workflow.

### Task flow and context

<p>
  <img src="public/github-landing/workflow-ticket-board.png" alt="Orchestra tasks page showing work distributed across workflow lanes." width="49%" />
  <img src="public/github-landing/task-detail.png" alt="Orchestra task detail page showing a task summary, description, and comments." width="49%" />
</p>

<p>
  <img src="public/github-landing/repo-worktrees.png" alt="Orchestra repo files panel showing multiple repositories and a task worktree." width="49%" />
  <img src="public/github-landing/supervisor-chat-desktop.png" alt="Orchestra desktop supervisor chat session." width="49%" />
</p>

Keep the board, task detail, repository state, worktrees, and live supervisor control in one place.

### Permissions, chat ops, and mobile

<p>
  <img src="public/github-landing/permissions.png" alt="Orchestra permissions editor showing effective permissions and supervisor access." width="49%" />
  <img src="public/github-landing/telegram.png" alt="Orchestra Telegram channel setup screen." width="49%" />
</p>

<p>
  <img src="public/github-landing/mobile.png" alt="Orchestra mobile tasks view." width="49%" />
  <img src="public/github-landing/themes.png" alt="Orchestra general settings screen showing theme selection." width="49%" />
</p>

Extend orchestration beyond the desktop with granular permissions, Telegram integration, mobile access, and theme customization.

## Getting started

### Current status

Orchestra is a Tauri + React desktop app under active development.

Today, the main way to use it is to run it locally from source.

### Prerequisites

- Node.js / npm
- Rust
- Tauri CLI

```bash
cargo install tauri-cli
```

### Install and run

```bash
npm install
source "$HOME/.cargo/env"
cargo tauri dev
```

Frontend-only development is also available:

```bash
npm run dev
```

### First run

A fresh Orchestra install seeds a baseline workspace with:

- one starter project: `Orchestra`
- standard roles: Architect, Senior Developer, QA, Product Owner, Project Manager
- starter workflows for Product Strategy, Planning, and Development

## Features

### Workflow orchestration

- Fully customizable kanban-style workflows
- Flexible lane structures and transition paths
- Lane ownership by user, role, or agent
- Approval gates and human intervention states
- Workflow-native worktree and execution rules

### Task management

- Workflow-aware task board and task detail views
- Task comments and review loops
- Task dependencies and subtasks
- Attachments, file references, and task-linked context
- Lane movement, pause/resume, approval, and needs-work flows

### Projects, repos, and execution context

- Multiple repositories per project
- Task-linked repository context
- Native task-scoped worktrees
- Visible repo/file context while work is in flight
- Project-scoped storage and session management

### Agents, roles, and sessions

- Persistent supervisor and agent sessions
- Disposable role-owned runtime sessions for parallel work
- Natural-language supervisor control
- Session history, resume flows, and runtime visibility
- Agent-to-agent coordination across related work

### Permissions and governance

- Granular permission model
- Protected actions for sensitive operations
- Supervisor-level access when explicitly granted
- Auditable, visible control surfaces instead of hidden automation

### Operator surfaces

- Desktop workbench
- Mobile client support
- Telegram orchestration and notifications
- Hosted web / remote access support
- `orc` CLI for task and chat operations

### Customization and platform foundations

- Built on Pi
- Support for local or cloud models
- Themes and workbench customization
- Extension and skill-oriented architecture
- Secure project secret support

## Development

### Quick commands

Install dependencies:

```bash
npm install
```

Run the frontend:

```bash
npm run dev
```

Run the desktop app:

```bash
source "$HOME/.cargo/env"
cargo tauri dev
```

Run tests:

```bash
npm test
npm run verify
```

### Developer docs

The previous README has been moved to [dev-readme.md](dev-readme.md) and contains the more detailed development guide, including:

- coverage and verification commands
- desktop E2E policy
- adhoc signing and release guardrails
- mobile harness details
- remote access notes
- deeper CLI and build information

## Documentation

- [dev-readme.md](dev-readme.md)
- [docs/implementation-plan.md](docs/implementation-plan.md)
- [docs/ux-north-star.md](docs/ux-north-star.md)
- [docs/authorization-model.md](docs/authorization-model.md)
- [docs/session-storage.md](docs/session-storage.md)
- [docs/adhoc-signing.md](docs/adhoc-signing.md)
