# ORC-13 — Pi-backed session reload/compaction plan

## Goal

Replace Orchestra’s prompt-hack session controls with real runtime controls, then add Orchestra-owned auto-compaction with explicit settings, capability detection, and observable UI state.

## Current state

### What exists today

- Manual **reload** in the UI still calls `queueSessionMessage(sessionId, "/reload")` from `src/App.tsx`.
- Manual **compaction** already reaches the backend via `compact_session`, but the frontend still appends a synthetic `"Session compacted."` event in `src/lib/tauri.ts` instead of treating compaction as a first-class runtime action.
- Session UI state only understands streaming/tool/error activity. It does not have a dedicated runtime-control lifecycle for reload/compact.
- Global harness settings currently expose extra runtime extensions under `Settings → Harness` via `PiRuntimeSettings`.
- Agent and role definitions currently carry provider/model/thinking defaults, but no compaction override.

### What Pi exposes today

From the currently installed Pi runtime code:

- RPC mode supports `compact`
- RPC mode supports `set_auto_compaction`
- agent-session has an internal `reload()` implementation
- RPC mode does **not** currently expose a first-class `reload` command in the command switch

That means:

1. real compaction is already reachable from Orchestra
2. Orchestra can disable Pi’s own auto-compaction and own the policy itself
3. real reload needs either:
   - a Pi runtime version that exposes reload over RPC, or
   - an equivalent explicit control hook that Orchestra can call without going through a prompt

## Planning decisions

## 1) Orchestra should own session control policy and observability

Orchestra should not depend on prompt text like `/reload` or `/compact` for control actions.

Instead, Orchestra should treat reload/compact as runtime control operations with:

- explicit capability detection
- explicit start/success/failure states
- explicit UI messaging
- explicit backend/domain logging

## 2) Orchestra-managed runtimes should disable Pi’s built-in auto-compaction

Pi’s default auto-compaction is enabled and thresholded by the global harness settings surface.

That conflicts with the requested Orchestra behavior because:

- Orchestra needs configurable thresholds in its own settings surfaces
- Orchestra needs per-agent and per-role override precedence
- Orchestra needs UI clarity about *why* compaction happened
- Orchestra needs deterministic tests

So when Orchestra spawns a live runtime it should immediately send `set_auto_compaction(false)` and then enforce Orchestra’s own compaction policy.

This keeps compaction ownership in one place.

## 3) Compaction-window settings should be Orchestra-native, not raw Pi reserve-token settings

The task asks for `10% remaining headroom` semantics and future configurability.

Use a worker-facing **compaction window spec** instead of exposing raw reserve tokens.

Recommended value format:

- percentage remaining headroom: `10%`
- absolute remaining tokens: `16000`
- disabled: `off`

This is flexible enough for the requested default and maps cleanly onto different model context windows.

## 4) Override precedence should follow worker specificity

Recommended effective precedence:

1. agent override
2. inherited role override for that agent
3. role override for role-owned sessions
4. global default

More concretely:

- detached/manual session: global default
- role-owned session: role override -> global default
- agent-owned session without attached role: agent override -> global default
- agent-owned session with attached role: agent override -> role override -> global default

`null`/empty means “inherit”.
`off` means “explicitly disable auto-compaction for this scope”.

## Proposed Orchestra contract

Add a first-class control contract to session records/runtime details.

## Session control capabilities

Add a nested capability object on `SessionRecord` and `SessionRuntimeDetails`.

Suggested shape:

```ts
interface SessionControlCapability {
  status: "supported" | "unsupported" | "unknown";
  reason?: string | null;
}

interface SessionControlCapabilities {
  reload: SessionControlCapability;
  compact: SessionControlCapability;
  autoCompact: SessionControlCapability;
  effectiveCompactionWindow?: string | null;
}
```

### Semantics

- `supported`: Orchestra can execute the real control action
- `unsupported`: Orchestra knows it cannot execute the real action and should explain why
- `unknown`: Orchestra has not confirmed support yet; UI may show a neutral/loading explanation instead of pretending support

Recommended unsupported reasons:

- `pi_unavailable`
- `terminal_attached`
- `runtime_control_unsupported`
- `context_usage_unavailable`
- `compaction_window_disabled`
- `session_busy`

## Session control operation state

Add an operation-state object to `SessionRecord` so the UI can reflect in-progress and last-result state without guessing from transcript text.

Suggested shape:

```ts
interface SessionControlOperationState {
  kind: "reload" | "compact";
  trigger: "manual" | "auto";
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt?: string | null;
  message?: string | null;
}
```

This should be ephemeral backend state decorated onto list/detail records, not something inferred from the transcript.

## Runtime lifecycle events

Extend streamed session events with explicit control events, e.g.

- `session_control_start`
- `session_control_end`

Suggested payload:

```json
{
  "type": "session_control_start",
  "control": "compact",
  "trigger": "auto"
}
```

```json
{
  "type": "session_control_end",
  "control": "compact",
  "trigger": "auto",
  "success": true,
  "message": "Session compacted.",
  "error": null
}
```

These events drive immediate UI state. The session record reload remains the source of truth after completion.

## Backend plan

## 1) Extend live runtime controls

In `src-tauri/src/services/live_sessions.rs` add:

- `reload()`
- `set_auto_compaction_enabled(enabled: bool)`
- helper(s) for control capability resolution

`compact()` already exists.

### Reload behavior

The reload button must call a real runtime control path.

Recommended implementation order:

1. preferred: call a real Pi RPC `reload` command once the runtime supports it
2. if the runtime returns `Unknown command: reload` or equivalent, mark reload capability unsupported and surface that clearly
3. never fall back to sending `/reload` as a prompt

## 2) Disable Pi auto-compaction at runtime spawn

After runtime creation in `ensure_runtime` / spawn path:

- send `set_auto_compaction(false)`
- if that command fails because the runtime is too old, log and mark auto-compaction capability unsupported

This makes Orchestra’s auto-compaction behavior explicit and testable.

## 3) Add manual reload command

Add a new Tauri command, e.g. `reload_session`, parallel to `compact_session`.

Responsibilities:

- resolve/ensure runtime
- fail if terminal-attached or otherwise unavailable
- update session control state to `running`
- call the real runtime reload action
- update control state to `succeeded` or `failed`
- emit session stream/control events
- emit `session_change`
- record a session domain event

### Important difference from compaction

Pi compaction persists a compaction entry into the session file.
Reload does not naturally create a transcript artifact.

So Orchestra should surface reload success/failure as control state and streamed/system UI feedback, not by inventing a fake user prompt.

## 4) Rework manual compaction command

Keep `compact_session`, but treat it as a real control operation instead of a transcript hack.

Changes:

- set operation state before calling runtime compaction
- emit streamed control lifecycle events
- stop the frontend from appending its own synthetic compaction line on top of the backend result
- keep file-backed compaction parsing as the durable transcript artifact

Because the session file already records `compaction` entries, the authoritative transcript entry should come from reloading the session record, not from a frontend append.

## 5) Add auto-compaction evaluation

Implement auto-compaction in Orchestra backend, not in the frontend.

### Trigger points

Use two trigger points:

1. **post-run check** after `agent_end`
2. **pre-prompt safety check** in `send_session_message`

Why both:

- post-run check gives proactive behavior and visible state
- pre-prompt check prevents stale near-limit sessions from skipping compaction before the next turn

### Trigger algorithm

For a given session:

1. resolve effective compaction window
2. verify auto-compaction capability is supported
3. fetch session stats from the live runtime
4. compute remaining headroom:
   - `remaining = contextWindow - contextTokens`
5. compare against resolved threshold:
   - `10%` => compact when `remaining <= ceil(contextWindow * 0.10)`
   - `16000` => compact when `remaining <= 16000`
6. do nothing if already compacting/reloading or a prompt is active
7. launch compaction with trigger `auto`

### Guardrails

- no auto-compaction while a prompt/tool run is active
- no duplicate auto-compactions for the same post-compaction state
- no auto-compaction when `contextUsage` is missing or `contextWindow <= 0`
- no auto-compaction for terminal-attached sessions
- no auto-compaction when the resolved window is `off`

## 6) Resolve configuration in one backend helper

Add a backend helper that resolves the effective compaction window for a session based on current ownership.

Suggested helper output:

```rust
struct ResolvedCompactionPolicy {
    window_spec: Option<String>,
    source: String, // agent | role | global | disabled | unavailable
}
```

Use this helper in:

- manual control capability decoration
- auto-compaction evaluation
- runtime details/debug UI

## Configuration plan

## Global setting

Extend `PiRuntimeSettings` and harness settings storage.

### UI surface

Settings -> Harness -> Harness settings:

- new field/control: `default-compaction-window`
- default value: `10%`

### Backend storage

Extend `~/.orchestra/settings.json` harness settings with a new field under the PI block.

Recommended API field name:

- `defaultCompactionWindow` over Tauri/TypeScript

Recommended stored JSON shape:

```json
{
  "harness": {
    "pi": {
      "extraExtensions": [],
      "defaultCompactionWindow": "10%"
    }
  }
}
```

## Agent setting

Add nullable `compaction_window` storage to agents.

Expose as:

- TypeScript: `compactionWindow?: string | null`
- Rust serde: `compaction_window: Option<String>`

Update:

- DB schema + migration
- `AgentDefinition`
- `AgentUpsertInput`
- create/update/validation paths
- `AgentsPanel`
- mock agent storage

## Role setting

Add nullable `compaction_window` storage to roles.

Expose as:

- TypeScript: `compactionWindow?: string | null`
- Rust serde: `compaction_window: Option<String>`

Update:

- DB schema + migration
- `RoleDefinition`
- `RoleUpsertInput`
- create/update/validation paths
- `RolesPanel`
- mock role storage

## Validation rules

Recommended validation for compaction window spec:

- `%` form: integer 1-99 followed by `%`
- token form: positive integer
- `off`
- empty/null => inherit

Reject:

- `0%`
- negative numbers
- decimals in first pass
- malformed suffixes

## UI plan

## Session action menu

Replace today’s implicit controls with capability-aware controls.

### Button behavior

- `Compact`
  - enabled only when real compaction is supported and session is not busy
- `Reload`
  - enabled only when real reload is supported and session is not busy

### Menu/help copy

When unsupported, show copy like:

- `Reload unavailable: current PI runtime does not expose a real reload control.`
- `Auto-compaction unavailable: context usage is not reported for this session/model.`

## In-session status feedback

Use the new operation state to show:

- `Compacting…`
- `Reloading…`
- `Auto-compacted`
- `Compaction failed`
- `Reload failed`

Recommended placements:

- session header badge/state
- non-persistent system event in transcript for start/failure/success
- runtime details modal for capability/source/debug information

## Transcript behavior

- stop showing `/reload` as a user message for manual reload
- stop synthesizing duplicate compaction transcript entries
- keep real compaction summaries from the session file as durable transcript content
- for reload, show Orchestra-generated system feedback only

## Runtime details modal

Extend runtime details with:

- reload capability
- compact capability
- auto-compaction capability
- effective compaction window
- last control failure reason, if any

## Frontend files likely affected

- `src/lib/tauri.ts`
- `src/App.tsx`
- `src/lib/sessionTranscriptReducer.ts`
- `src/components/SessionChatPanel.tsx`
- `src/pages/SessionsPage.tsx`
- `src/settings/HarnessPanel.tsx`
- `src/settings/AgentsPanel.tsx`
- `src/settings/RolesPanel.tsx`
- `src/types.ts`
- mock helpers in `src/lib/harnessSettings.ts`, `src/lib/agents.ts`, `src/lib/roles.ts`

## Backend files likely affected

- `src-tauri/src/services/live_sessions.rs`
- `src-tauri/src/commands/sessions.rs`
- `src-tauri/src/state.rs`
- `src-tauri/src/services/harness_settings.rs`
- `src-tauri/src/services/agents.rs`
- `src-tauri/src/services/roles.rs`
- `src-tauri/src/services/database.rs`
- `src-tauri/src/models.rs`
- possibly `src-tauri/src/commands/app.rs`, `src-tauri/src/commands/agents.rs`, `src-tauri/src/commands/roles.rs`

## Test plan

## Backend/unit tests

Add Rust coverage for:

- compaction window parsing
- precedence resolution:
  - global only
  - role override
  - agent override
  - agent-over-role precedence
  - explicit `off`
- manual compaction lifecycle success/failure
- manual reload lifecycle success/failure
- auto-compaction triggering when threshold is crossed
- no auto-compaction when capability is unsupported
- no duplicate auto-compaction while one is already running

## Frontend/unit tests

Add/extend tests for:

- transcript reducer handling of control start/end/failure events
- action menu enabled/disabled behavior from capability state
- runtime details modal capability display

## Browser/e2e tests

Update existing tests that currently assert prompt hacks:

- `tests/e2e/sessions.spec.ts`
- `tests/e2e/chat.spec.ts`
- `tests/desktop-e2e/chat-nav.test.ts`

New expectations:

- reload does **not** append `/reload`
- compaction does **not** rely on frontend-only fake transcript text
- action state is visible during and after control execution
- auto-compaction triggers near threshold
- settings changes persist and affect effective policy

## Desktop fake-Pi/test-runtime work

Extend the test runtime/fake Pi handlers so e2e coverage can simulate:

- successful reload
- failed reload
- supported vs unsupported reload
- auto-compaction threshold crossings
- control lifecycle events

## Pi assumptions and dependency note

## Assumptions confirmed from current Pi code

- RPC compaction exists
- RPC auto-compaction toggle exists
- session reload exists internally on the Pi side

## Assumption not yet satisfied by current RPC surface

- a first-class RPC `reload` command is not present in the currently inspected Pi RPC command switch

## Resulting implementation note

Real Orchestra-backed reload requires a Pi runtime version or hook that exposes reload without going through prompt text.

Therefore the implementation should:

1. add Orchestra-side `reload_session` plumbing now
2. treat reload capability as explicit, not assumed
3. surface `unsupported` clearly if the connected Pi runtime cannot perform real reload
4. never regress to `/reload` prompt injection as a fallback

## Recommended delivery order

1. add config fields and precedence resolution
2. add backend control-state/capability model
3. disable Pi auto-compaction on Orchestra-managed runtimes
4. rework manual compaction to use the new contract end-to-end
5. add real reload path and unsupported handling
6. add backend auto-compaction evaluation
7. update UI and runtime details surfaces
8. update browser + desktop + backend tests

## Reviewer summary

The key architectural choice is: **Orchestra owns the policy, Pi performs the operation**.

That gives us:

- real runtime control instead of prompt hacks
- explicit reload/compact availability
- explicit success/failure UX
- deterministic threshold behavior
- clean override precedence across global/role/agent scopes
- testable auto-compaction without hidden Pi defaults
