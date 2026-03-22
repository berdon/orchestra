# AGENTS.md

## Project

Orchestra is a Tauri + React/Vite app.

## Dev app

### Prereqs

- Node/npm installed
- Rust installed and available in shell
- Tauri CLI installed (`cargo install tauri-cli`)

### Install deps

```bash
npm install
```

### Run frontend only

```bash
npm run dev
```

### Run full Tauri dev app

```bash
source "$HOME/.cargo/env"
cargo tauri dev
```

## Running the dev app in the background

`nohup` was unreliable in this environment. Use a plain background job instead:

```bash
bash -lc 'source "$HOME/.cargo/env"; cargo tauri dev >/tmp/orchestra-dev.log 2>&1 & pid=$!; disown "$pid"; echo "$pid" > /tmp/orchestra-dev.pid; echo "PID $pid"'
```

### Check status

```bash
ps -p $(cat /tmp/orchestra-dev.pid)
tail -f /tmp/orchestra-dev.log
```

## Notes

- The Vite dev server is expected on `http://localhost:1420`.
- Tauri icons live under `src-tauri/icons/`.
- Desktop E2E tests must use the desktop runner scripts (`scripts/run-desktop-e2e.sh`, `scripts/run-desktop-e2e-suite.sh`, and the Podman variants). Do not run desktop specs directly with generic Playwright commands.
