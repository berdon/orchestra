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

## Development

### Frontend only

```bash
npm install
npm run dev
```

### Tauri desktop app

The repository includes a `src-tauri/` scaffold, but building/running the desktop app requires a Rust toolchain and Tauri system prerequisites to be installed locally.

Once those are available, the next step will be wiring the session commands into this scaffold.
