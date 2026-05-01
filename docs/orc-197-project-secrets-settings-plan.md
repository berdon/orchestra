# ORC-197 — Project secrets + tabbed project settings plan

## tl;dr

- Add nested tabs inside `Settings → Projects`: `General`, `Repositories`, `Automation`, `Source Control`, and `Secrets`.
- Keep `Settings → Prompting` where it is for this slice; it is already a dedicated project-scoped editor, and moving it would broaden scope without helping secrets delivery.
- Store secret metadata in SQLite, but store secret values only in the OS secure store via a keyring backend. Scope entries by Orchestra-root fingerprint + stable `project_id` + secret key.
- Expose safe secret tools that never print raw values: metadata listing, env-materializing `get`, and env-sourced add/update. Do not add a transcript-visible raw-value read path.
- Support desktop Tauri and remote-API hosted clients backed by a secure host. In mock/browser or secure-store failure states, show a clear unsupported/unavailable banner and do not fall back to plain app storage.

## Executive summary

`src/settings/ProjectsPanel.tsx` is currently a long single-page detail view with project fields, automation, source-control overrides, and repositories all stacked together. ORC-197 should turn that into a clearer tabbed project-settings surface and add a first-class `Secrets` tab that lets users manage project-scoped secrets without ever storing values in SQLite, JSON, localStorage, or normal tool transcripts.

The cleanest implementation is:

1. keep project metadata in the DB,
2. add a dedicated project-secret metadata table,
3. store only the secret value in the host secure store,
4. use a custom Orchestra tool wrapper so agent secret operations stage values into session env vars instead of echoing them back into chat/tool output.

That gives one project-level definition point, safe cross-task reuse inside the same project, explicit permission boundaries, and a workable support story for desktop plus remote-hosted clients.

## Current-state findings

- `src/settings/ProjectsPanel.tsx` currently mixes all project detail content into one long scroll path.
- `src/pages/tasks/TaskDetailPage.tsx` + `src/styles.css` already have a horizontally scrollable tab-dock pattern worth reusing for project-detail sub-tabs.
- `src/lib/projectSettings.ts` and `src-tauri/src/services/project_settings.rs` already provide the main project-settings client/service seam.
- Project prompting / automation / source-control overrides are already DB-backed via `project_runtime_settings`; worker overlays are the remaining file-backed legacy setting.
- There is no existing secure-store abstraction or project-secret model.
- `extensions/orchestra-tools.ts` mostly wraps bridge commands as JSON-in / JSON-out tools today, which is not safe for raw secret values.

## Recommended product shape

### Project settings tabs

Add a second-level project-detail tab bar inside `Settings → Projects`.

Recommended tabs:

1. `General`
   - name
   - description
   - task prefix
2. `Repositories`
   - existing repository list/actions
   - add repository flow
3. `Automation`
   - auto-dispatch setting
4. `Source Control`
   - project git override fields
   - effective preview table
5. `Secrets`
   - secure-store status
   - secret metadata list
   - create/edit/rotate/delete flow

### Scope note: keep Prompting separate

Do **not** move `Settings → Prompting` into this tab set in ORC-197.

Reason:
- it is already a dedicated project-scoped editor,
- it already has coverage and routing,
- moving it would expand the task beyond the settings content that is actually crowded today inside `ProjectsPanel`.

### Tab interaction pattern

Reuse the task-detail tab treatment where practical:

- horizontally scrollable tab row on desktop/narrow-width detail panes,
- mobile select fallback similar to task detail,
- stable data-role hooks for automated coverage,
- no viewport where the new sub-tabs force horizontal page overflow.

## Secrets UX

### What users should see

For each secret entry, show only metadata:

- secret key
- optional description
- last rotated time
- last metadata update time
- status (`Ready`, `Missing value`, `Store unavailable`, etc. as applicable)

Do **not** show:

- raw value
- masked partial value
- value length
- copy/reveal controls in this slice

### Create/edit behavior

Recommended editor fields:

- `Secret key`
- `Description` (optional)
- `Secret value`

Rules:

- secret keys should be env-var shaped: `^[A-Z][A-Z0-9_]*$`
- reserve / reject dangerous names and prefixes such as `PATH`, `HOME`, `SHELL`, `TERM`, `ORCHESTRA_*`, `PI_*`, and npm prefix vars
- on edit, leave the value field blank by default with copy like `Leave blank to keep the current stored value.`
- after save, clear the value field immediately and never rehydrate it from storage
- delete requires an explicit confirmation action in the UI

### Secrets tab framing copy

The tab should make the model explicit:

- these secrets are **project-scoped**
- values are stored in the host secure store, not normal Orchestra app data
- authorized agent sessions can load them into session environment variables for tool use
- values are not shown again after save

## Storage model

### Metadata: new SQLite table

Add a dedicated metadata table instead of overloading `project_runtime_settings`.

Recommended shape:

```sql
CREATE TABLE project_secret_metadata (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  secret_key TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_rotated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE(project_id, secret_key)
);
```

Notes:

- store normalized uppercase keys so the uniqueness rule stays simple
- keep value timestamps separate from metadata timestamps
- do not store raw values, hashes, or masked previews here

### Secret value: secure store only

Use a Rust keyring backend so the host secure store handles encryption-at-rest:

- macOS: Keychain
- Windows: Credential Manager
- Linux: Secret Service / compatible keyring when available

Recommended secure-store key scheme:

- service: `io.hnsn.orchestra.project-secret.v1`
- account: `scope:<root_fingerprint>:project:<project_id>:secret:<secret_key>`

Where:
- `project_id` is the stable DB id, not the slug
- `root_fingerprint` is a stable hash of the active Orchestra root / database path so separate local installs or test homes do not collide in the same OS store

### Why use `project_id`, not slug

- project rename / slug changes should not orphan active secrets
- project-scoped access across multiple tasks/agents should bind to the same stable project identity

### Expected tradeoff

Secure-store values are host-local and root-local.

That means:
- DB copies/backups do not carry secret values automatically
- moving Orchestra data to a new machine or a different root path will require re-entering secrets unless a future export/import flow is added

That tradeoff is acceptable and should be surfaced in UI copy.

## Failure and fallback behavior

Never fall back to plain SQLite / JSON / localStorage for secret values.

Recommended behavior:

- `unsupported_environment`
  - mock/browser-only host without a secure backend
  - show disabled state + explanatory banner
- `store_locked`
  - secure store exists but is locked/unavailable right now
  - show metadata if it can be loaded from DB, but block create/rotate/load actions until unlocked
- `store_error`
  - keychain/keyring call failed unexpectedly
  - show structured error, keep value hidden, allow retry
- `missing_value`
  - metadata row exists but secure-store item is gone
  - mark the row degraded and allow rotate/delete

### Cleanup behavior

- deleting a secret should remove the secure-store value first, then metadata; treat `not found` as success
- deleting a project should make a best-effort pass to remove all scoped secret entries before/around project deletion
- failure to clean up an orphaned secure-store entry during project delete should not hard-block project deletion, but should be logged and surfaced as a warning if practical

## Agent/tool model

### Permissions

Use dedicated permissions rather than broad `projects.read` / `projects.update`:

- `projects.secrets.read`
  - list/get secret metadata
- `projects.secrets.use`
  - materialize a secret value into the current agent session environment
- `projects.secrets.write`
  - add/update/delete project secrets

This keeps metadata visibility, value use, and mutation separate.

### Safe tool behavior

Do **not** expose a tool that returns a raw secret value in normal tool output.

Recommended tool surface:

- `list_project_secrets`
  - returns metadata only
- `get_project_secret`
  - loads the secret into the current session environment
  - returns masked confirmation only, e.g. `Loaded OPENAI_API_KEY into env var OPENAI_API_KEY for this session.`
- `add_project_secret`
  - creates a secret using a value read from an existing session env var such as `sourceEnvVar: "OPENAI_API_KEY"`
  - does not accept a literal `value` parameter in the agent tool surface
- `update_project_secret`
  - same env-sourced write model for rotation / metadata update
- `delete_project_secret`
  - optional but recommended for parity with the UI and cleanup workflows

### Why env-materializing `get` is the right default

The extension process can safely:

1. call the backend bridge,
2. receive the raw value,
3. place it into `process.env[targetEnvVar]`, and
4. return only a masked confirmation to the model.

That lets later shell/tool use reference `$OPENAI_API_KEY` without the value ever being printed into the transcript by the secret tool itself.

### Extension and `/orchestra-run` requirement

The new secret tools should be **custom wrappers** in `extensions/orchestra-tools.ts`, not generic JSON echo tools.

Also update `/orchestra-run` so these command names route through the same wrapper path instead of generic `invokeBridge(...)` output, otherwise a raw bridge response could leak.

### UI/API vs agent-tool write paths

- UI / remote settings APIs may accept a raw secret value because that path is outside the agent transcript model.
- Agent tools should use env-sourced writes only.

That gives a safe user path for first entry plus a safe agent path for reuse/rotation.

## Supported contexts

### Full support

- local desktop Tauri app
- hosted/shared frontend talking to a remote Orchestra host that exposes the secure-store-backed settings APIs

### Unsupported / degraded

- mock/browser-only host without a secure backend
- desktop/remote hosts where the OS secure store is unavailable or locked

In those cases, keep the tab visible with a clear status message rather than silently pretending the feature works.

## Likely implementation touch points

Frontend:

- `src/settings/ProjectsPanel.tsx`
- `src/styles.css`
- `src/types.ts`
- `src/lib/projectSettings.ts`
- `src/lib/orchestraClient/client.ts`
- `src/lib/orchestraClient/tauriBindings.ts`
- `src/lib/orchestraClient/remoteApiClient.ts`
- `src/lib/orchestraClient/mockBindings.ts`
- `src/lib/access.ts`
- `extensions/orchestra-tools.ts`

Backend:

- `src-tauri/src/services/database.rs`
- `src-tauri/src/services/project_settings.rs` or a new `project_secrets.rs`
- `src-tauri/src/commands/project_settings.rs`
- `src-tauri/src/services/remote_api.rs`
- `src-tauri/src/services/tool_bridge.rs`
- `src-tauri/src/services/command_authorization.rs`
- `src-tauri/src/models.rs`
- `src-tauri/src/lib.rs`
- project deletion seam in `src-tauri/src/services/projects.rs`

## Implementation sequence

1. **Backend storage + types**
   - add metadata table
   - add secure-store helper/service
   - add settings response types for secret metadata + secure-store status
2. **Desktop/settings API plumbing**
   - Tauri commands
   - shared client bindings
   - remote API routes/client
   - mock/browser unsupported-state stub
3. **Project settings UI**
   - add nested project tabs
   - move existing sections into tab panels
   - add the `Secrets` tab and unsupported/error/ready states
4. **Agent tooling**
   - add permission strings
   - add bridge commands
   - add safe custom tool wrappers + `/orchestra-run` routing
5. **Cleanup + edge paths**
   - delete/rotate/missing-value handling
   - best-effort project-delete cleanup
6. **Coverage + validation**
   - Rust service tests
   - client/adapter tests
   - tool wrapper tests
   - UI/e2e coverage across supported and unsupported contexts

## Validation plan

### Automated coverage

Add or update tests for:

- project settings tab rendering / tab switching / mobile overflow behavior
- project secrets create/edit/rotate/delete UX
- unsupported-store and locked-store UX paths
- metadata persistence + secure-store integration in Rust tests
- project delete / secret delete cleanup behavior where practical
- tool wrapper behavior:
  - `get_project_secret` does not return raw value
  - `add/update_project_secret` read from `sourceEnvVar`
  - `/orchestra-run` uses the safe wrapper path for secret commands
- permission/safety enforcement for read/use/write separation

### Suggested manual validation

- Desktop: create a secret, reload the app, confirm metadata persists and the value is not shown again
- Desktop: rotate a secret and confirm `last_rotated_at` changes
- Desktop: simulate unavailable/locked keychain and verify the Secrets tab explains the failure without falling back to plain storage
- Agent session: load a project secret into env, use it in a command without the secret tool printing the value
- Hosted client: verify the remote settings surface works when backed by a secure remote Orchestra host

## Key decisions to carry into implementation

- Keep Prompting separate in ORC-197.
- Use a dedicated metadata table plus secure-store value storage.
- Scope secure-store entries by root fingerprint + `project_id` + secret key.
- Validate secret keys as env-var identifiers and reject dangerous reserved names.
- No raw-value transcript tool.
- Agent `get` means `load into session env`, not `print value`.
- Agent add/update should be env-sourced, not literal-value sourced.
