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

Tauri dev runs now default to `~/.orchestra-dev` so development does not touch the normal `~/.orchestra` state. To target a different storage root explicitly, set `ORCHESTRA_STORAGE_ROOT` or run `cargo tauri dev -- --orchestra-home "$HOME/.orchestra"`.

`src-tauri/Cargo.toml` sets `default-run = "orchestra"`, so the command works even though the crate also contains helper binaries.

## Running the dev app in the background

`nohup` was unreliable in this environment. Use a plain background job instead:

```bash
bash -lc 'source "$HOME/.cargo/env"; cargo tauri dev >/tmp/orchestra-dev.log 2>&1 & pid=$!; disown "$pid"; echo "$pid" > /tmp/orchestra-dev.pid; echo "PID $pid"'
```

That background dev app also uses `~/.orchestra-dev` by default.

### Check status

```bash
ps -p $(cat /tmp/orchestra-dev.pid)
tail -f /tmp/orchestra-dev.log
```

## Notes

- The Vite dev server is expected on `http://localhost:1420`.
- Tauri icons live under `src-tauri/icons/`.
- Desktop E2E tests must use the desktop runner scripts (`scripts/run-desktop-e2e.sh`, `scripts/run-desktop-e2e-suite.sh`, and the Podman variants). Do not run desktop specs directly with generic Playwright commands.
- Demo recordings should use the repo-managed Podman capture script from this worktree, not manual host screen capture:
  - `./scripts/record-desktop-e2e-video-podman.sh --trim-start <seconds> tests/desktop-e2e/<spec>.test.ts <demo-name>.webm`
  - The script captures the Xvfb-backed desktop run, trims startup time from the beginning, and writes the final `.webm` into `.tmp/demo-videos/`.
  - Use a trim that excludes app spin-up; `--trim-start 12` worked for the task-todos demo flow.
- Always use PRs for Orchestra changes.
- Default model for Orchestra subagents and teammate agents is `openai-codex/gpt-5.4` unless a task explicitly needs something else.
- Before reusing an existing Orchestra branch or PR, always check whether that PR was already merged.
- If the existing PR was merged, do **not** keep pushing to that old branch or reopen/reuse that PR. Create a fresh branch and open a new PR instead.
