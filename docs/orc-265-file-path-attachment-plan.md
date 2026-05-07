# ORC-265 file-path task attachment plan

## tl;dr

- Keep `add_task_attachment`, but add a second explicit **file-path input mode** for normal agent use.
- Implement file-path handling in `extensions/orchestra-tools.ts`, not in the backend API.
- Resolve relative paths from the session cwd, allow any **session-accessible readable file**, infer filename/media type when omitted, and keep base64 mode for programmatic/in-memory bytes.
- Preserve the existing backend attachment model by converting file contents to base64 inside the tool before invoking the bridge.
- Update tool help/runtime guidance and add extension-level tests for success, inference/overrides, invalid paths, unreadable files, and base64 compatibility.

## Implemented semantics

The implementation now matches the recommended split:

- `add_task_attachment` accepts either `input.filePath` or `input.base64Data`.
- `filePath` mode is the preferred path for files already on disk. Relative paths resolve from the session cwd, the resolved target must be a readable regular file, and the tool reads the file locally before uploading bytes through the existing bridge/backend attachment flow.
- `filePath` mode allows `fileName` and `mediaType` overrides. When omitted, `fileName` defaults to the resolved basename and `mediaType` is inferred from the effective file name/path with an `application/octet-stream` fallback.
- `base64Data` mode remains the compatibility/programmatic path and still requires explicit `fileName` and `mediaType`.
- Tool execution details now record the chosen input mode and, for file-based attachments, the original `filePath` plus resolved absolute path so direct-file usage stays explicit and auditable.
- Missing files, directories, and unreadable files are rejected before bridge submission with mode-specific errors.

## Executive summary

The cleanest change is to improve the **agent tool surface**, not the persisted attachment API. Agents need a first-class way to say “attach this file from disk,” but the backend should still receive a copied byte payload and store it in Orchestra-managed attachment storage exactly as it does today.

That means `add_task_attachment` should support two explicit input shapes:

1. **preferred file mode** for files already on disk
2. **existing base64 mode** for bytes already in memory or produced outside the local filesystem

This keeps hosted/remote behavior coherent: the session runtime reads the file from its own filesystem, then uploads bytes through the existing attachment path. The Orchestra server never has to interpret a session-local path that may not exist on the server host.

## Current-state findings

- `extensions/orchestra-tools.ts` currently exposes only `{ fileName, mediaType, base64Data, caption? }` for `add_task_attachment`.
- The backend attachment pipeline already does the safe part we want to preserve:
  - decodes bytes
  - writes a copied snapshot into Orchestra-managed task attachment storage
  - records metadata in `task_attachments`
- Existing design docs already point in this direction:
  - `docs/design.md` says `add_task_attachment` should import a local file into Orchestra-managed storage
  - `docs/task-system-plan.md` suggests a `sourcePath`-style flow
- Because attachment creation already accepts raw bytes safely, adding file-path support at the **tool layer** avoids unnecessary Rust/remote API churn.

## Recommended semantics

### 1. Keep one tool, add two explicit input modes

Recommended `input` contract for `add_task_attachment`:

### File mode (preferred)

```json
{
  "filePath": "./logs/test-output.txt",
  "caption": "Failure excerpt",
  "fileName": "ci-output.txt",
  "mediaType": "text/plain"
}
```

- `filePath` required
- `fileName` optional override; defaults to basename of resolved path
- `mediaType` optional override; defaults to inferred type or `application/octet-stream`
- `caption` unchanged

### Base64 mode (compatibility)

```json
{
  "fileName": "error.log",
  "mediaType": "text/plain",
  "base64Data": "ZXhhbXBsZSBsb2c=",
  "caption": "Failure excerpt"
}
```

- Keep current behavior unchanged
- Continue to require explicit `fileName` + `mediaType`
- Use this mode when bytes are already in memory, generated remotely, or not available as a readable local file

### 2. Path resolution and safety

For file mode:

- Accept absolute or relative paths
- Resolve relative paths against the **session process cwd** (`process.cwd()` / runtime cwd)
- Canonicalize before reading so error messages and audit details can include the resolved path
- Require the resolved target to exist and be a readable regular file
- Reject directories and unreadable/missing files with explicit pre-bridge errors
- Do **not** restrict to repo-only paths; allow any **session-accessible** file so agents can attach outputs from worktrees, temp directories, screenshots, and generated artifacts
- Recommend repo/worktree-relative paths in help text for reproducibility, but do not hard-require them

Why not repo-only? Because the most useful attachment artifacts often live outside tracked source trees (`/tmp`, screenshots, exported logs). The safety boundary should be **explicit path selection plus byte-copy import**, not an arbitrary repo-only restriction.

### 3. Filename and media-type handling

For file mode:

- `fileName` override wins when present
- otherwise use `basename(resolvedPath)`
- `mediaType` override wins when present
- otherwise infer from file extension with a small helper
- if inference fails, fall back to `application/octet-stream`

This keeps the new path ergonomic without weakening current explicitness.

### 4. Explicit and auditable behavior

Direct-file usage should stay obvious in tool traces.

Recommended approach:

- keep the backend bridge payload in the existing byte-based shape
- but return tool `details` that include at least:
  - input mode (`filePath` vs `base64Data`)
  - original `filePath`
  - resolved path
  - effective `fileName`
  - effective `mediaType`
- avoid relying on the bridge payload alone for auditability, since that hides the original source-path intent inside a base64-only payload

## Implementation shape

### Extension/tool layer

Update `extensions/orchestra-tools.ts` to:

- change `TaskAttachmentParams` into a union of file mode + base64 mode
- change `taskAttachmentSchema()` to expose both modes in help/examples
- add a resolver that:
  - validates the chosen mode
  - reads bytes from disk in file mode
  - base64-encodes them for bridge submission
  - derives filename/media type defaults
  - emits clear errors before `invokeBridge(...)`
- update `helpNotes` to say:
  - prefer `filePath` for files already on disk
  - use `base64Data` only when bytes are already available in-memory

### Runtime/help text

Update worker-facing guidance in `src-tauri/src/services/task_runtime.rs` so future sessions explicitly mention the preferred `filePath` flow.

## Coverage

Add or update automated coverage in `tests/orchestra-tools-extension.tools.test.ts` for:

- successful attach from `filePath`
- relative-path resolution from cwd
- filename inference and filename override
- media-type inference and media-type override
- missing-path error
- unreadable/non-file error
- existing base64 mode still invoking the same bridge payload shape

No backend storage-model regression work should be necessary beyond keeping existing attachment tests green, because the persisted contract remains byte-based.

## Expected file touchpoints

- `extensions/orchestra-tools.ts`
- `tests/orchestra-tools-extension.tools.test.ts`
- `src-tauri/src/services/task_runtime.rs`
- any prompt/help assertions tied to task-runtime tool guidance

## Recommended implementation order

1. Add the union schema + file resolver in `extensions/orchestra-tools.ts`.
2. Update help examples/notes and runtime prompt guidance.
3. Add extension tests for file mode and compatibility mode.
4. Verify existing attachment creation behavior remains unchanged for base64 callers.

## Expected outcome

Agents will be able to attach a file directly from disk with a single explicit tool call, while Orchestra still stores a copied immutable attachment snapshot through the existing safe backend path. Base64 input remains available, but becomes the fallback mode rather than the normal one.
