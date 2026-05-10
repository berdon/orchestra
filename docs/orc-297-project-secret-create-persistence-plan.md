# ORC-297 — project secret create persistence + Podman regression plan

## tl;dr

- Treat this as a desktop secure-store persistence bug first, with a UI-state fallback check.
- Investigate the create flow from `ProjectsPanel` through `project_settings` into `project_secrets.rs`, focusing on the immediate read-after-write state returned from `create_project_secret`.
- Strengthen the real desktop Podman regression in `tests/desktop-e2e/project-secrets-persistence.test.ts` so it explicitly proves a newly created secret never stays in `Missing value`, still shows `Ready` after reload, and is later usable through `get_project_secret`.

## Executive summary

The browser/mock secrets CRUD test already proves the React form path can submit `secretKey`, `description`, and `value` and render a `Ready` state when the backend responds correctly (`tests/e2e/projects.spec.ts`). The environment-specific seam is the desktop backend, especially Linux/Podman secure-store persistence in `src-tauri/src/services/project_secrets.rs`. That backend writes the value, then immediately reloads secret metadata/state before returning to the UI; if the UI shows `Missing value` right after save, the most suspicious path is the secure-store write/read seam rather than the form itself.

## Current findings

- UI save path: `src/settings/ProjectsPanel.tsx`
  - `handleSaveSecret()` calls `createProjectSecret()` / `updateProjectSecret()` and replaces `projectSecretsState` with the authoritative backend response.
  - If the badge is wrong immediately after save, the backend response is likely already wrong, or a stale state replacement is happening nearby.
- Client/command seam:
  - `src/lib/projectSettings.ts`
  - `src-tauri/src/commands/project_settings.rs`
- Persistence seam:
  - `src-tauri/src/services/project_secrets.rs`
  - `write_project_secret_with_store()` writes the secure-store value, persists metadata, then calls `get_project_secrets_with_store()`.
  - On Linux/Podman this routes through `SecretToolProjectSecretStore`, so read-after-write behavior there is the highest-risk regression point.
- Existing coverage already present:
  - browser/mock CRUD: `tests/e2e/projects.spec.ts`
  - desktop persistence/use flow: `tests/desktop-e2e/project-secrets-persistence.test.ts`

## Implementation plan

1. Reproduce on the real desktop Podman runner with the existing focused spec.
2. Compare the post-create backend state returned by `create_project_secret` against the UI badge shown after save.
3. Fix the failing seam:
   - if backend returns `missing_value`, repair the secure-store/account/read-after-write behavior in `src-tauri/src/services/project_secrets.rs`;
   - if backend returns `ready` but the UI stays stale, fix the secret-tab state/update path in `src/settings/ProjectsPanel.tsx`.
4. Add/strengthen regression coverage so the spec explicitly asserts:
   - create with a value succeeds;
   - the secret row does **not** show `Missing value` after save;
   - the row shows the correct post-save state after save and after reload;
   - downstream `get_project_secret` usage still succeeds without revealing the secret.
5. Keep browser/mock coverage aligned if any UI copy or status rendering changes.

## Validation

- Focused Podman desktop run:
  - `./scripts/run-desktop-e2e-podman.sh tests/desktop-e2e/project-secrets-persistence.test.ts`
- Relevant fast checks after code changes:
  - targeted frontend test(s) if `ProjectsPanel.tsx` changes
  - targeted Rust tests for `project_secrets.rs` if backend persistence logic changes
