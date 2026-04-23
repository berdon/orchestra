# ORC-66 — `orc chat` CLI plan

## tl;dr

- Add a new `orc` CLI binary in `src-tauri` and make `chat` and `msg` its first subcommands.
- Implement `orc chat [-a|--agent <agent>]`, defaulting to the built-in `supervisor` agent.
- Reuse Pi’s existing interactive TUI by spawning the `pi` executable against the selected agent’s canonical Orchestra-managed main session file.
- Treat `orc chat` as an **attach-or-create-if-idle** flow: reuse the existing per-project agent main session when it exists, create it first when it does not, but **block instead of attaching** when that agent is already busy or already attached elsewhere.
- Add `orc msg [-a|--agent <agent>] <message>` as the non-interactive fallback path for talking to a busy agent. It should default to the supervisor when no agent is specified.
- Do **not** try to embed Pi SDK `InteractiveMode` into Orchestra for this slice. That would create a second runtime stack instead of cleanly attaching to Orchestra’s existing session model.

## Executive summary

The updated first-slice recommendation is:

1. ship a real `orc` CLI binary,
2. make `orc chat` the interactive path for an **idle** Orchestra-managed agent main session,
3. make `orc msg` the non-interactive path for sending an agent message when the target is already busy.

Orchestra already has the right primitives for both sides of that UX:

- agent main sessions are canonical per-project sessions and are already reused over time,
- Orchestra stores real Pi session JSONL files under the managed session directory,
- `agent_terminal.rs` already proves Pi can open one of those managed sessions directly in interactive mode,
- direct mailbox delivery to agents already exists and already switches behavior based on whether the agent is idle or running.

The key product correction from user feedback is that `orc chat` should **not** try to take over a supervisor session that is currently busy. In that case the CLI should fail fast with a clear message telling the user to use `orc msg` instead. `orc msg` should then reuse Orchestra’s existing mailbox/direct-mail path so the selected agent receives the message safely:

- as an immediate prompt when idle,
- as a queued steer when already running.

This keeps the session model coherent, avoids ambiguous double-attach behavior, and gives users a complete terminal workflow instead of a dead-end error.

## Scope update from user review

The original ORC-66 planning pass only defined `orc chat` plus a busy-session block. User review added one important extension that should stay in this task because it is tightly coupled to the busy-chat decision:

- if the selected agent — especially the default supervisor — is already busy, `orc chat` should block and tell the user to send a message instead,
- therefore ORC-66 should also add `orc msg` for sending messages to agents directly from the terminal.

That means ORC-66 now owns the minimal paired surface:

- `orc chat` for interactive attach when safe,
- `orc msg` for mailbox-style delivery when interactive attach is not appropriate.

## Discovery summary

### 1. Orchestra already has the session semantics we need

Current agent chat behavior is already centered on a canonical per-project main session:

- `src-tauri/src/services/agent_dispatch.rs`
  - `ensure_main_session(...)` reuses `agent_runtime_states.main_session_id` when present
  - otherwise it creates a fresh Orchestra-managed session file and stores it as the agent’s main session
- `src-tauri/src/commands/agent_runtime.rs`
  - `ensure_agent_session(...)` is the current app-facing attach-or-create entrypoint
- `src/App.tsx`
  - the Chat page and quick supervisor chat both recover/reuse the existing main session before creating another one

That means ORC-66 does **not** need to invent new session semantics. It should expose the existing ones through the CLI.

### 2. Orchestra-managed sessions are already real Pi session files

`docs/session-storage.md` and the Rust session services make this explicit:

- Orchestra stores real Pi JSONL sessions under `~/.orchestra/projects/<project>/sessions/`
- Orchestra uses `--session` and `--session-dir` when it runs Pi against those files

This is exactly what makes direct TUI reuse viable: the CLI can point Pi at the same session file the app already owns.

### 3. Pi TUI reuse is viable through the Pi executable, not through SDK embedding

Relevant Pi behavior from the bundled Pi docs:

- Pi interactive mode can resume a specific session with `--session <path|id>`
- Pi supports a custom `--session-dir <dir>`
- Pi supports `--no-extensions` plus explicit `--extension ...`
- Pi SDK `InteractiveMode` runs on top of a Node-created `AgentSessionRuntime`

That last point is the key constraint. `InteractiveMode` is a good API for building a standalone Node app, but it is **not** a clean attach point for Orchestra’s current Rust/Tauri runtime stack.

### 4. Existing Orchestra code already has a close precedent

`src-tauri/src/services/agent_terminal.rs` already launches Pi interactively against an agent main session file inside a PTY-backed window.

That is strong evidence that the direct TUI path is workable for ORC-66. The CLI should reuse the same basic idea, while adding the missing Orchestra bridge/environment wiring that the standalone terminal chat needs.

### 5. Orchestra already has the right direct-message primitive for `orc msg`

The existing mailbox path already supports user-to-agent delivery:

- `src-tauri/src/services/messages.rs`
  - `send_mailbox_message_from_user(...)` stores a mailbox message and delivery
  - `deliver_message(...)` routes agent mail into the agent queue
  - `resolve_agent_mail_delivery_mode(...)` already chooses delivery behavior based on agent runtime state

Current behavior is exactly what the CLI needs:

- if the target agent is idle, mail delivery mode becomes `prompt`
- if the target agent is already running or has a queue entry, mail delivery mode becomes `steer`

That means `orc msg` can be a thin CLI around an existing durable Orchestra concept instead of inventing a separate “message agent” path.

### 6. The main technical wrinkle is backend bootstrap, not session or mail format

The earlier plan understated one real implementation constraint: Orchestra’s extension bridge and several backend operations currently expect more than just a SQLite connection.

Examples:

- Pi sessions launched by Orchestra rely on the tool bridge environment variables (`ORCHESTRA_BRIDGE_URL`, `ORCHESTRA_BRIDGE_TOKEN`, etc.)
- some bridge commands and message-delivery paths currently rely on `AppHandle` / `AppState`-backed behavior for eventing, session retirement, unread delivery, and live runtime notification

So ORC-66 should plan for a reusable **CLI-safe backend bootstrap** layer, not just “open the DB and start a bridge thread.”

The important architecture decision is that `orc chat` and `orc msg` must run against the same real Orchestra backend semantics as the app.

### 7. The current bridge still has desktop-coupled commands that matter for supervisor chat

A more specific discovery from the current code is that the bridge is only **partially** CLI-safe today.

`src-tauri/src/services/tool_bridge.rs` still has several commands that currently require a real `AppHandle`, including at least:

- `stop_session_runtime`
- `send_mail`
- `approve_task_review`
- `mark_task_needs_work`
- `resume_task_lane`
- `pause_task_lane`
- `stop_task_activity`

That matters because a supervisor chat session launched from `orc chat` should still be able to use the normal Orchestra tool surface. If those commands stay desktop-only, a CLI-launched supervisor session would have surprising holes in its capabilities.

### 8. Preferred direction: extract app-independent service helpers instead of inventing a fake desktop app

The plan should now be more explicit about the preferred architecture:

- **Do not** make ORC-66 depend on spinning up a fake or hidden desktop window just to get an `AppHandle`.
- Instead, extract app-independent service functions for the currently desktop-coupled bridge commands.
- Keep app/window event emission as an optional side effect when a real app handle exists.

That gives a cleaner split:

- **service layer:** authoritative state mutation and queue/runtime behavior
- **desktop command layer:** service call + app event emission + UI-specific follow-up
- **CLI / tool bridge layer:** same service call, but without requiring desktop UI state

This is especially important for `send_mail`, because `orc msg` should be able to use the same underlying mailbox logic without pretending to be the desktop app.

## Recommended product semantics

### Command surface

```bash
orc chat
orc chat -a supervisor
orc chat --agent data

orc msg "Check the current project status"
orc msg -a data "Please look at ORC-66 next"
orc msg --agent supervisor "Summarize blockers"
```

Initial ORC-66 CLI scope:

- one top-level binary: `orc`
- two initial subcommands:
  - `chat`
  - `msg`
- one shared agent selector:
  - `-a, --agent <agent>`

`<agent>` should accept either:

- the agent slug (`supervisor`, `data`)
- or the canonical agent id (`agent-supervisor`, etc.)

Slug-first UX is the intended normal path.

### Default agent

If `--agent` is omitted:

- `orc chat` targets the built-in `supervisor` agent
- `orc msg` also targets the built-in `supervisor` agent

This keeps the CLI consistent and matches the original ORC-66 requirement that the default interactive agent is the supervisor.

### Session ownership and mapping

Both commands should map to the agent’s **canonical main session** for the resolved project:

- project scope = Orchestra’s current default project resolution for this first slice
- agent scope = selected agent id/slug
- session = `agent_runtime_states.main_session_id` for `(project_id, agent_id)`

This keeps the CLI aligned with the app’s current agent/runtime model rather than creating a CLI-only concept of “chat sessions.”

### `orc chat` create vs resume behavior

`orc chat` should be **attach-or-create-if-idle**:

1. resolve the project
2. resolve the agent
3. ensure the agent runtime state exists
4. if no main session exists yet, create it and record it as the main session
5. if a main session already exists and the agent is idle, reuse it
6. if the agent is busy or the session is already attached elsewhere, block instead of attaching
7. when allowed, launch Pi against that session file

### What happens when a matching session already exists

If the selected agent already has a main session for the resolved project and is idle:

- `orc chat` reuses that same session file
- the transcript continues in-place
- the same session id remains the source of truth in Orchestra

This is the most important continuity rule for the command.

### Transcript continuity and state preservation

Continuity is preserved because Pi is pointed at the same Orchestra-managed JSONL session file:

- same session id
- same session tree
- same prior transcript
- same future transcript after the CLI exits

No transcript translation or import/export layer is needed.

### Busy-session rule for `orc chat`

The first slice should explicitly avoid opening a competing interactive attach on a session that is already actively busy.

Recommended rule:

- if the agent runtime is currently `running`
- or it has a current queue entry in flight
- or its main session is already attached to another dedicated interactive terminal surface

then `orc chat` should fail fast with a clear error.

Recommended message shape:

- explain that the selected agent is currently busy / already attached
- do **not** start an interactive TUI
- tell the user to use `orc msg` instead

For example:

```text
Supervisor is already busy in an active Orchestra session. Use `orc msg "..."` to send a message instead of attaching interactively.
```

This is the product behavior the user explicitly asked for.

### `orc msg` semantics

`orc msg` should send a direct Orchestra mailbox message to the selected agent.

Recommended first-slice behavior:

- resolve the same project and agent target as `orc chat`
- create a durable mailbox delivery via the existing messages service
- route that delivery using Orchestra’s existing agent mail behavior

Expected delivery behavior:

- if the agent is idle, the message is queued as a `prompt`
- if the agent is busy, the message is queued as a `steer`

This is a good fit because it means the CLI is not bypassing Orchestra’s own task/agent/mail model.

### `orc msg` and transcript continuity

`orc msg` should preserve session continuity indirectly:

- it does not open a new interactive surface
- it does not create an anonymous one-off session
- it delivers into the agent’s existing Orchestra runtime/session path

So the message and resulting reply history remain part of the canonical per-project agent session story.

### Message body semantics for the first slice

For the first ORC-66 slice, `orc msg` can stay minimal:

- one required message body argument
- normal mailbox priority by default

Optional enhancements like explicit `--priority interrupt` can be added later if needed, but they are not required to solve the current UX gap.

### Project semantics for the first slice

The first slice should follow Orchestra’s existing default-project resolution instead of adding a broader project lookup model inside ORC-66.

That means:

- if a default project exists, both `orc chat` and `orc msg` use it
- if no project exists, the command errors with a clear setup message

Explicit project targeting can be added later when the broader CLI surface lands in ORC-67.

## Recommended technical design

### 1. Add a standalone Rust CLI binary

Add a new binary target under `src-tauri`, for example:

- `src-tauri/src/bin/orc.rs`

Use a real subcommand parser so ORC-67 can grow the CLI naturally.

Suggested shape:

- `src-tauri/src/cli/mod.rs`
- `src-tauri/src/cli/chat.rs`
- `src-tauri/src/cli/msg.rs`
- `src-tauri/src/bin/orc.rs`

This keeps the command surface organized without coupling CLI parsing directly to the Tauri desktop entrypoint.

### 2. Add shared agent/project resolution helpers

ORC-66 should centralize:

- default-project resolution
- agent slug/id resolution
- default-supervisor fallback
- canonical main-session resolution
- busy/attached-state checks for `orc chat`

That shared helper layer should drive both subcommands so they make the same targeting decisions.

### 3. Extract a reusable CLI-safe backend bootstrap

This is the most important architecture refinement from the updated discovery.

The CLI needs more than just a DB connection because:

- Pi chat sessions need the Orchestra tool bridge alive while `pi` runs
- some bridge commands and message paths still depend on backend state and currently route through desktop-coupled code
- `orc msg` must deliver through the real mailbox/runtime path, not a fake lightweight shortcut

So ORC-66 should extract a reusable backend bootstrap that can be shared by:

- the desktop app entrypoint
- the new `orc` CLI entrypoint

Preferred scope of that bootstrap:

- initialize/open the SQLite database
- ensure auth bootstrap state
- ensure install baseline seed state where needed
- start the Orchestra tool bridge
- create any shared non-UI backend state that the bridge/services need

Recommended implementation target:

- CLI mode should **not** require a desktop window
- bridge-backed session tools should work correctly from a CLI-launched Pi session
- message delivery paths used by `orc msg` should behave like normal Orchestra actions
- desktop-only concerns like window event emission should stay optional rather than required for core behavior

### 4. Extract a shared “Pi attach launch spec” helper

ORC-66 should not duplicate launch logic across:

- `agent_terminal.rs`
- live session runtime helpers
- the new CLI binary

Introduce a shared helper that can build the interactive Pi launch spec for an Orchestra-managed session.

Suggested responsibilities:

- resolve Pi executable
- resolve Orchestra extension path in dev and bundled installs
- prepare the temp HOME directory currently used by `agent_terminal.rs`
- resolve runtime authorization context from the session id
- compute allowed Orchestra bridge tools for that authorization context
- construct Pi argv (`--session`, `--session-dir`, `--no-extensions`, explicit extensions)
- construct required Orchestra bridge env vars

This helper is the main technical seam that makes ORC-66 and future session-based CLI work maintainable.

### 5. Implement `orc chat` on top of the shared resolution and launch helpers

The `chat` command should:

1. bootstrap CLI-safe Orchestra backend state
2. resolve the default project
3. resolve the requested/default agent
4. ensure or create the canonical main session
5. validate that the agent/session is safe to attach interactively
6. if busy, print a clear blocking message that points to `orc msg`
7. ensure the bridge surface available to that session does not have desktop-only gaps for supervisor-level tools
8. otherwise spawn Pi interactive mode against the managed session file

Important process rules:

- keep the `orc` parent process alive while Pi runs so the in-process tool bridge remains available
- do not let normal terminal interrupts tear down the parent before Pi exits, or the bridge will disappear mid-session

That means the command flow is:

1. CLI starts backend bootstrap + bridge
2. CLI spawns Pi child
3. CLI waits for child exit
4. CLI tears down temporary resources and exits with the child status

### 6. Implement `orc msg` as a thin mailbox command, not a second chat protocol

The `msg` command should:

1. bootstrap the same CLI-safe Orchestra backend state
2. resolve the default project
3. resolve the requested/default agent
4. call an extracted app-independent mailbox send path for a user → agent delivery
5. print a concise success message describing the target and delivery behavior

Recommended implementation principle:

- do **not** invent a custom “send session prompt” CLI path for busy agents
- do **not** bypass mailbox storage
- do **not** bypass agent queue/runtime semantics

Instead, reuse Orchestra’s existing direct-mail behavior because it already preserves durable history and busy-agent delivery rules.

Preferred implementation detail:

- extract the persistence + agent-delivery core from the current app-coupled mailbox command path
- let desktop mode keep emitting UI events when an app handle exists
- let CLI mode call the same core without depending on desktop window state

### 7. Load Orchestra’s extension explicitly for `orc chat`

To make the selected agent session actually useful inside the terminal, the Pi process should be launched with Orchestra’s extension and authorization context, not as a raw standalone Pi session.

Recommended default launch shape:

- `--session <path>`
- `--session-dir <dir>`
- `--no-extensions`
- `--extension <orchestra-tools.ts>`
- plus any configured extra extensions already honored by Orchestra runtime settings

This keeps the CLI aligned with Orchestra’s managed tool surface instead of letting arbitrary extension discovery change behavior.

### 8. Help and output behavior

The CLI should provide crisp help text and actionable error messages.

`orc chat --help` should make these points explicit:

- defaults to the supervisor agent
- reuses the canonical per-project agent main session
- blocks when the selected agent is already busy
- recommends `orc msg` as the fallback

`orc msg --help` should make these points explicit:

- defaults to the supervisor agent
- sends a durable Orchestra mailbox message to the selected agent
- is the intended fallback when `orc chat` cannot attach because the agent is busy

## Why Pi SDK `InteractiveMode` should not be the ORC-66 implementation path

Pi SDK `InteractiveMode` is the wrong primitive for this first slice.

Why:

1. it expects Orchestra to host a Node-side `AgentSessionRuntime`
2. that runtime is a fresh process-local control layer, not an attach API for Orchestra’s Rust-managed runtime state
3. Orchestra would need a new bridge between Rust backend state and a Node runtime host just to open chat
4. that is much more work than ORC-66 needs and creates another session-launch path to maintain

In short:

- **Pi TUI executable reuse:** good fit
- **Pi SDK `InteractiveMode` embedding:** not a good fit for this repo’s current architecture

## Why a custom terminal REPL should be deferred

A custom REPL on top of Orchestra’s own websocket/session events would also work, but it should be a fallback plan, not the first implementation choice.

Reasons to defer it:

- Pi already provides a mature interactive editor/chat surface
- Pi already understands its own session tree, slash commands, image/file UX, and model controls
- a custom REPL would add more UI code while still not matching Pi’s full ergonomics
- ORC-66 now also needs a durable non-interactive message path anyway, which is better modeled as mailbox delivery than as a second terminal UI

Only choose the custom REPL if direct Pi child-process attach proves unworkable during implementation. Current evidence still says the Pi-executable path should be workable.

## Coverage plan

### 1. CLI parser tests

Add focused tests for:

- `orc chat` parses successfully
- `orc chat` defaults `agent` to `supervisor`
- `orc chat -a data` uses `data`
- `orc chat --agent data` uses `data`
- `orc msg` parses successfully
- `orc msg` defaults `agent` to `supervisor`
- `orc msg -a data "hello"` uses `data`
- invalid/missing agent or message values produce clear errors

### 2. Agent/session resolution tests

Add unit tests for the shared resolution helper covering:

- default supervisor mapping
- slug-to-id resolution
- id passthrough resolution
- reuse of an existing `main_session_id`
- creation of a main session when none exists yet
- busy-session detection from runtime status / queue state
- terminal-attached detection where relevant
- clear error when no default project exists
- clear error when the requested agent does not exist

### 3. `orc chat` busy-block tests

Add tests that verify:

- idle supervisor → `orc chat` proceeds
- running supervisor → `orc chat` blocks
- queued supervisor → `orc chat` blocks
- blocked output explicitly points to `orc msg`

This is now a core acceptance behavior, not a side note.

### 4. `orc msg` delivery-path tests

Add tests that verify:

- sending to an idle agent stores the mailbox message and queues a `prompt` delivery
- sending to a busy agent stores the mailbox message and queues a `steer` delivery
- default-agent behavior targets the supervisor
- success output is concise and usable in normal terminal workflows

### 5. Launch-spec tests

Add tests for the extracted Pi launch helper covering:

- Pi argv contains `--session` and `--session-dir`
- Orchestra extension is loaded explicitly
- bridge env vars are present
- allowed-tools JSON is populated
- authorization context reflects the selected agent session

### 6. Fake-pi smoke test

Add one integration-style test that points `ORCHESTRA_PI_EXECUTABLE` at a temporary script which captures argv/env to a temp file and exits.

That test should verify that `orc chat`:

- resolves the intended session
- launches Pi with the expected args/env
- keeps the child process path working without opening the real TUI in CI

This remains the best practical regression test for the launch/attach path.

## Files likely to change in implementation

- `src-tauri/Cargo.toml`
- `src-tauri/src/bin/orc.rs`
- `src-tauri/src/cli/mod.rs`
- `src-tauri/src/cli/chat.rs`
- `src-tauri/src/cli/msg.rs`
- shared CLI/backend bootstrap module, likely under `src-tauri/src/`
- shared launch helper module, likely near `src-tauri/src/services/`
- `src-tauri/src/services/agent_dispatch.rs` or `agents.rs` for agent slug lookup helper(s)
- `src-tauri/src/services/messages.rs` for an app-independent mailbox send/delivery core
- `src-tauri/src/services/tool_bridge.rs` to remove desktop-only gaps from bridge-exposed supervisor tools
- `src-tauri/src/commands/tasks.rs` and/or `src-tauri/src/commands/sessions.rs` if app-handle-dependent command logic is pushed down into service helpers
- `src-tauri/src/services/agent_terminal.rs` if its launch path is refactored to use the new shared helper
- Rust test modules for parser/launch/session resolution/message coverage

## Implementation notes to preserve in the final task comment

When the implementation lane lands, the durable task comment should explicitly call out:

1. that both `orc chat` and `orc msg` default to the supervisor agent
2. that `orc chat` attaches to the canonical per-project agent main session instead of creating anonymous ad hoc sessions
3. that `orc chat` blocks when the selected agent is already busy and points the user to `orc msg`
4. that `orc msg` uses Orchestra’s durable mailbox/agent-delivery path instead of bypassing runtime state
5. that existing transcripts are preserved because the same Orchestra-managed session file/session path is reused
6. that Pi TUI reuse was chosen through the Pi executable/session-file path, not through SDK `InteractiveMode`
7. that the preferred implementation path is service extraction for desktop-coupled bridge commands rather than spinning up a fake desktop window for CLI mode
8. any remaining limitation around default-project-only targeting for the first slice

## Bottom line

ORC-66 should now ship a paired terminal surface:

- `orc chat` for interactive attach when the selected agent is idle and safe to open,
- `orc msg` for durable message delivery when that agent is already busy.

That gives users a complete CLI workflow, preserves Orchestra’s session continuity model, keeps agent messaging on real Orchestra rails, and creates a stronger foundation for the broader `orc` operational command set that follows in ORC-67.
