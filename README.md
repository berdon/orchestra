# Orchestra

Agent orchestration framework focused on getting project work done.

## Docs

- [Product north star](docs/north-star.md)
- [UX north star](docs/ux-north-star.md)
- [UX design guidelines](docs/ux-design-guidelines.md)
- [UX first-pass implementation plan](docs/ux-first-pass-implementation-plan.md)
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
- [Bridge hardening plan](docs/bridge-hardening-plan.md)
- [Mobile driver client design](docs/mobile-driver-client-design.md)

## App scaffold

This repository now includes the first-pass Orchestra application scaffold:
- Vite + React + TypeScript frontend
- `src-tauri/` backend structure for Tauri commands, services, models, and shared state
- left-nav application shell aligned with the design direction
- Settings page log viewer for early backend/session visibility
- a session-first UI flow for creating, resuming, subscribing to, and interacting with sessions

## First-run baseline

A fresh Orchestra install now seeds a ready-to-use baseline automatically:

- one starter project named `Orchestra`
- standard global roles: Architect, Senior Developer, QA, Product Owner, and Project Manager
- ready-to-use Product Strategy, Planning, and Development workflows wired to those role slugs

These seeded records are normal user-managed data, not protected system state. You can edit, archive, duplicate, replace, or delete them as needed.

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

To fan the Podman suite out in parallel batches, set `DESKTOP_E2E_JOBS`:

```bash
DESKTOP_E2E_JOBS=2 ./scripts/run-desktop-e2e-suite-podman.sh tests/desktop-e2e/*.test.ts
```

On macOS, first-time Podman setup may also require:

```bash
brew install podman
/usr/sbin/softwareupdate --install-rosetta --agree-to-license
podman machine init
podman machine set --memory 8192 podman-machine-default
podman machine start
```

The shared web driver now has its own browser E2E coverage:

```bash
npm run test:web-driver:e2e
```

### Tauri desktop app

The repository includes a `src-tauri/` scaffold and matching session command surface, but building/running the desktop app requires a Rust toolchain and Tauri system prerequisites to be installed locally.

#### Prerequisites

- Rust toolchain (`cargo install tauri-cli`)
- macOS: Xcode Command Line Tools (`xcode-select --install`)

#### Running the dev app

```bash
source "$HOME/.cargo/env"
cargo tauri dev
```

#### Building with adhoc signing (notifications enabled)

Orchestra is configured to build with adhoc signing, which enables system notifications without requiring a paid Apple Developer account.

```bash
# Quick build with adhoc signing
./scripts/build-adhoc.sh

# Or manually
source "$HOME/.cargo/env"
cargo tauri build --debug
```

The built app will be at `src-tauri/target/debug/bundle/macos/Orchestra.app`.

See [QUICK_START_ADHOC.md](QUICK_START_ADHOC.md) for more details, or [docs/adhoc-signing.md](docs/adhoc-signing.md) for complete documentation on adhoc signing.

Until then, the frontend can be exercised in browser mode with the built-in mock session adapter.

### Mobile and web remote client

The shared cross-platform remote client lives under `mobile/` and can run as Android, iOS, or web.

```bash
cd mobile
npm install
npm run start   # native Expo dev
npm run web     # shared web frontend
```

### Remote access + Tailscale Serve

In **Settings → Remote**, Orchestra can now optionally manage Tailscale Serve for the remote driver:

- backend/API served on the configured remote API HTTPS port (default `49500`)
- shared web driver served on Tailscale HTTPS port `9443`
- when **Use Tailscale Serve** is enabled, Orchestra binds the backend to `127.0.0.1` and keeps both Serve routes pointed at the local backend/web driver automatically

For packaged builds, the Tauri bundle now includes the exported `mobile/dist-web` assets. During local development, build them once with:

```bash
cd mobile
npm install
npm run web:build
```
