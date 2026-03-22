# Orchestra

Agent orchestration framework focused on getting project work done.

## Docs

- [Product north star](docs/north-star.md)
- [UX north star](docs/ux-north-star.md)
- [Design draft](docs/design.md)
- [Authorization model](docs/authorization-model.md)
- [Frontend permission management design](docs/permission-management-fe.md)
- [Permission management implementation plan](docs/permission-management-implementation-plan.md)
- [Implementation plan](docs/implementation-plan.md)
- [Session storage](docs/session-storage.md)
- [Role runtime plan](docs/role-runtime-plan.md)
- [Single-use role runtime plan](docs/role-runtime-single-use-plan.md)
- [Agent runtime plan](docs/agent-runtime-plan.md)
- [Task system plan](docs/task-system-plan.md)

## App scaffold

This repository now includes the first-pass Orchestra application scaffold:
- Vite + React + TypeScript frontend
- `src-tauri/` backend structure for Tauri commands, services, models, and shared state
- left-nav application shell aligned with the design direction
- Settings page log viewer for early backend/session visibility
- a session-first UI flow for creating, resuming, subscribing to, and interacting with sessions

## Development

### Frontend only

```bash
npm install
npm run dev
```

### Tests

```bash
npm test
```

### Desktop E2E policy

Desktop end-to-end tests must use the desktop runner scripts only. Do not run desktop specs directly with generic `npx playwright test` invocations or ad hoc Tauri/cargo commands.

Use:

```bash
./scripts/run-desktop-e2e.sh tests/desktop-e2e/<spec>.test.ts
./scripts/run-desktop-e2e-suite.sh tests/desktop-e2e/<spec-a>.test.ts tests/desktop-e2e/<spec-b>.test.ts
```

For containerized runs, use the Podman wrappers:

```bash
./scripts/run-desktop-e2e-podman.sh tests/desktop-e2e/<spec>.test.ts
./scripts/run-desktop-e2e-suite-podman.sh tests/desktop-e2e/<spec-a>.test.ts tests/desktop-e2e/<spec-b>.test.ts
```

### Tauri desktop app

The repository includes a `src-tauri/` scaffold and matching session command surface, but building/running the desktop app requires a Rust toolchain and Tauri system prerequisites to be installed locally.

Until then, the frontend can be exercised in browser mode with the built-in mock session adapter.
