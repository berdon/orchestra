# ORC-255 — Project-secret write semantics

## Permission model
- `projects.secrets.read`
  - list/search project-secret metadata only
  - never loads or returns raw values
- `projects.secrets.use`
  - load one project secret value into the current session environment
  - used by `get_project_secret`
- `projects.secrets.write`
  - create, rotate/update, and delete project secrets
  - used by `add_project_secret`, `update_project_secret`, and `delete_project_secret`

## Agent/tooling safety contract
- Normal agent/operator secret tooling is env-based.
- `add_project_secret` requires `sourceEnvVar` and never accepts a raw `value` tool argument.
- `update_project_secret` accepts `sourceEnvVar` when rotating the stored value, or may omit it for metadata-only updates; it still never accepts a raw `value` tool argument.
- `get_project_secret` materializes the loaded value into `targetEnvVar` (or `secretKey` by default) instead of returning the raw value in normal tool output.
- The extension help text and `/orchestra-run` safe wrapper reject direct `value` payloads for write commands so the standard tool path does not encourage transcript-visible secret writes.
- Metadata commands (`list_project_secrets`, `search_project_secrets`) return only metadata such as `secretKey`, `description`, timestamps, and `valueState`.

## Where raw secret values may exist
Allowed/expected:
- OS secure store / keyring backend
- in-memory process environment for the current trusted session when loading from `targetEnvVar` or reading from `sourceEnvVar`
- internal trusted bridge request/response bodies for local agent flows during `add/update/get`
- remote admin settings HTTP request bodies for hosted-web/admin settings flows

Not allowed in normal usage:
- Orchestra tool arguments for standard secret write tools
- Orchestra tool result details/content for standard secret load/write tools
- project-secret metadata tables in SQLite
- normal list/search/help output

## Remote/admin settings exception
- Local settings UI and hosted-web admin settings CRUD may still accept raw secret values because those flows are outside the agent transcript model.
- Those flows remain admin-scoped today via the broader remote settings surface.
- Agent/bridge tooling remains the explicitly permission-gated path for `read` vs `use` vs `write` semantics.

## Operational notes
- Secret values are stored in the secure store; SQLite stores metadata only.
- Create requires a value and therefore requires `sourceEnvVar` on the standard agent/tool path.
- Update may rotate the value, metadata, or both; metadata-only update does not require secret-value access.
- Delete removes the secure-store entry first and then metadata.
- Representative failure paths are covered for missing env vars, duplicate create, missing update/delete, and secure-store write/delete failures.
