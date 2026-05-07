# ORC-255 — Project-secret write tooling + permissions plan

## tl;dr
- Most of the requested stack already exists: secure-store-backed CRUD, settings CRUD, bridge/tool exposure, explicit `projects.secrets.read|use|write` permissions, and baseline tests.
- Development should treat ORC-255 as a hardening/consistency pass, not a greenfield build.
- The main open decision is whether the current bridge contract is the final safe contract, because raw values are hidden from tool details/transcripts but still cross the bridge body for `add/update/get`.

## Executive summary
ORC-255 is primarily about closing coherence gaps around an already-landed project-secret feature set. The repo already has first-class project-secret create/update/delete support in the service layer, Tauri settings commands, hosted-web settings API, Orchestra bridge commands, safe extension wrappers, access labels, and multiple test layers.

The implementation lane should therefore avoid rebuilding working surfaces and instead focus on three things:
1. lock the final safety contract for agent/operator flows,
2. make the permission story explicit and consistent across local/remote/managed paths,
3. fill the remaining docs and edge-case coverage gaps.

## Current audit
- **Service/storage:** `src-tauri/src/services/project_secrets.rs`
  - Already implements metadata list/search, secure-store-backed value load, create, update/rotate, delete, validation, and cleanup.
  - Secret values live in the secure store; SQLite holds metadata only.
- **Local settings/UI CRUD:** `src-tauri/src/commands/project_settings.rs`, `src/lib/projectSettings.ts`, `src/settings/ProjectsPanel.tsx`
  - Already exposes create/update/delete project-secret settings flows.
- **Hosted-web/remote settings CRUD:** `src-tauri/src/services/remote_api.rs`, `src/lib/orchestraClient/remoteApiClient.ts`
  - Already exposes `GET/POST/PATCH/DELETE /api/v1/project-settings/secrets...`.
- **Agent/operator tool surface:** `src-tauri/src/services/tool_bridge.rs`, `extensions/orchestra-tools.ts`
  - Already exposes `list_project_secrets`, `search_project_secrets`, `get_project_secret`, `add_project_secret`, `update_project_secret`, and `delete_project_secret`.
  - Extension wrappers already hide raw values from tool details/transcript by using `sourceEnvVar` for writes and `targetEnvVar` materialization for loads.
- **Explicit permissions/help exposure:** `src-tauri/src/services/command_authorization.rs`, `src/lib/access.ts`
  - Already separates `projects.secrets.read`, `projects.secrets.use`, and `projects.secrets.write`.
  - Tool descriptions and access labels already advertise the split.
- **Existing coverage:**
  - `src-tauri/src/services/project_secrets.rs`
  - `src-tauri/src/services/tool_bridge.rs`
  - `src-tauri/src/services/command_authorization.rs`
  - `tests/orchestra-tools-extension.tools.test.ts`
  - `tests/orchestra-client-remote-api.test.ts`
  - `tests/e2e/projects.spec.ts`

## Main gaps to close
1. **Bridge safety contract is still implicit.**
   - `extensions/orchestra-tools.ts` keeps raw values out of tool args/output, but `invokeBridge(...)` still sends `value` for add/update and receives `value` for get.
   - Decide whether this is the accepted internal transport contract or whether value materialization should move deeper into the bridge/runtime.
2. **Remote/operator permission story is broader than the bridge permission story.**
   - Bridge tools are explicitly gated by `projects.secrets.read|use|write`.
   - Hosted-web settings currently ride the broader remote/admin settings path.
   - Development should either align those models or document the intentional admin-only exception clearly.
3. **Coverage is strong but not complete on failure semantics.**
   - Missing-path candidates include unset `sourceEnvVar`, duplicate create, missing update/delete, create-without-value, store write/delete failures, and remote permission/auth failure expectations.
4. **Final docs are still scattered.**
   - The repo has plan history and inline descriptions, but not one clear final reference for secret-write semantics and guardrails.

## Recommended implementation plan
1. **Decide the final agent safety contract first.**
   - Preferred outcome: keep UI/settings raw-value paths where necessary, but make agent/tooling flows explicitly env-based and non-transcript-visible.
   - If bridge payload exposure is considered too loose, move secret load/write materialization behind a dedicated bridge/runtime path instead of generic JSON payloads.
2. **Normalize permission semantics across surfaces.**
   - Keep `projects.secrets.read` for metadata, `projects.secrets.use` for value materialization, and `projects.secrets.write` for create/update/delete.
   - Either map remote/operator flows onto the same split or document why the remote settings path remains admin-scoped.
3. **Harden help/documentation text.**
   - Make `sourceEnvVar` / `targetEnvVar` behavior and “no raw value in normal tool output” explicit in the final tool/help docs.
4. **Fill the remaining tests.**
   - Add/extend tests for permission denials, missing env var handling, representative write/delete failures, and the chosen remote/admin semantics.
5. **Leave implementation notes with final safety semantics.**
   - The development lane should finish with a task comment that states exactly where raw values may exist, where they must not appear, and which permission is required for each operation.

## Files most likely to change in implementation
- `extensions/orchestra-tools.ts`
- `src-tauri/src/services/tool_bridge.rs`
- `src-tauri/src/services/command_authorization.rs`
- `src-tauri/src/services/remote_api.rs`
- `src/lib/orchestraClient/remoteApiClient.ts`
- `src/lib/access.ts`
- `tests/orchestra-tools-extension.tools.test.ts`
- `tests/orchestra-client-remote-api.test.ts`
- `src-tauri/src/services/project_secrets.rs`
- final docs/help text where the chosen semantics are documented
