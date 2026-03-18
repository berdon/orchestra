# Orchestra Session Storage

## Decision

All Orchestra-managed pi sessions should be created with a custom `sessionDir` under `~/.orchestra` instead of using pi's default global session location.

Default pi behavior:

```text
~/.pi/agent/sessions/--<cwd>--/<timestamp>_<uuid>.jsonl
```

Orchestra-managed behavior:

```text
~/.orchestra/projects/{project-slug}/sessions/<timestamp>_<uuid>.jsonl
```

## Why

This keeps Orchestra-managed execution separate from a user's general pi history and makes project ownership explicit.

Benefits:
- clearer session ownership by project
- simpler resume/list behavior for Orchestra
- safer integration testing against isolated session directories
- easier cleanup, migration, and backup of Orchestra state

## Required integration rule

Whenever Orchestra creates, resumes, lists, or forks pi sessions, it should pass the Orchestra session directory explicitly.

Use the pi SDK APIs like this:

```ts
import { SessionManager } from "@mariozechner/pi-coding-agent";

const sessionDir = "~/.orchestra/projects/orchestra/sessions";

const created = SessionManager.create(cwd, sessionDir);
const resumed = SessionManager.continueRecent(cwd, sessionDir);
const listed = await SessionManager.list(cwd, sessionDir);
const opened = SessionManager.open(sessionPath, sessionDir);
const forked = SessionManager.forkFrom(sourcePath, cwd, sessionDir);
```

## Current helper paths

This repository now includes path helpers that formalize the layout:
- TypeScript: `src/lib/orchestraPaths.ts`
- Rust: `src-tauri/src/services/orchestra_paths.rs`

Both map project sessions to:

```text
~/.orchestra/projects/{project-slug}/sessions/
```

## Automated verification

The repository includes an integration test that verifies pi's `SessionManager` respects the Orchestra-managed `sessionDir`:

- `tests/pi-session-manager.integration.test.ts`

What it checks:
1. a session file is created inside `.orchestra/.../sessions`
2. messages are appended into that file
3. listing sessions reads from the custom directory
4. resuming continues the same file instead of creating a new one

Run it with:

```bash
npm test
```

## Manual inspection

To inspect Orchestra-managed session files locally:

```bash
find ~/.orchestra/projects/orchestra/sessions -maxdepth 1 -name '*.jsonl' | sort
```

To inspect default pi sessions for comparison:

```bash
find ~/.pi/agent/sessions -maxdepth 2 -name '*.jsonl' | sort | sed -n '1,20p'
```

To inspect a specific session file header:

```bash
head -n 5 ~/.orchestra/projects/orchestra/sessions/<timestamp>_<uuid>.jsonl
```

The first line should be a `session` header with the original `cwd`, while the file location itself should live under `.orchestra`.
