# Orchestra

Agent orchestration framework focused on getting project work done.

## Docs

- [Product north star](docs/north-star.md)
- [UX north star](docs/ux-north-star.md)
- [Design draft](docs/design.md)
- [Implementation plan](docs/implementation-plan.md)

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

### Tauri desktop app

The repository includes a `src-tauri/` scaffold and matching session command surface, but building/running the desktop app requires a Rust toolchain and Tauri system prerequisites to be installed locally.

Until then, the frontend can be exercised in browser mode with the built-in mock session adapter.
