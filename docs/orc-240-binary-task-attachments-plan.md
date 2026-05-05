# ORC-240 binary task attachments plan

## tl;dr
- Stop treating hosted-web attachment upload as a base64 JSON problem; add a binary-first remote upload path so audio files, zip archives, and other binary assets are not gated by text encoding or JSON body limits.
- Keep the existing attachment storage/download model, but refactor storage helpers so every surface preserves `fileName`, `mediaType`, `byteSize`, and raw bytes the same way.
- Separate **attachable** from **previewable** in the task-detail UI: keep text/image previews, and add an explicit non-preview fallback for audio/archive/binary files instead of implying inline text rendering.
- Add regression coverage for representative audio + zip/binary upload, storage, listing, and download flows.

## Executive summary
The backend storage path already persists arbitrary bytes once an attachment record exists, and the download route already serves raw bytes back correctly. The main text-biased failure point is the hosted-web upload path: `src/pages/TasksPage.tsx` base64-encodes every file with `FileReader.readAsDataURL(...)`, `src/lib/orchestraClient/remoteApiClient.ts` sends JSON, and `src-tauri/src/services/remote_api.rs` accepts `Json<TaskAttachmentInput>`. That forces binary files through a text transport, adds base64 overhead, and inherits axum's default JSON body-limit behavior, which makes common audio/archive assets fail much sooner than the storage layer itself would.

Separately, the task-detail UI is preview-first. Text and image attachments get intentional rendering, but non-previewable assets only fall back to raw metadata. ORC-240 should make upload binary-safe end-to-end, keep metadata/download behavior correct, and make non-text attachments feel intentionally supported rather than merely tolerated.

## Current-state findings
- `src-tauri/src/services/task_attachments.rs`
  - already writes decoded bytes to Orchestra-managed task attachment storage
  - already records `file_name`, `media_type`, `byte_size`, `stored_path`, and `created_at`
  - already supports raw-byte download helpers
- `src/pages/TasksPage.tsx`
  - currently converts every browser upload into base64 text before sending it to the client layer
- `src/lib/orchestraClient/remoteApiClient.ts`
  - currently posts attachment creates as JSON `TaskAttachmentInput`
- `src-tauri/src/services/remote_api.rs`
  - currently handles attachment create with `Json<TaskAttachmentInput>`
  - attachment content download already returns raw bytes with `Content-Type` and `Content-Disposition`
- `src/pages/tasks/TaskDetailPage.tsx`
  - currently has only two preview-aware branches: `previewText` and `imageDataUrl`
  - non-text/non-image attachments have no explicit fallback state beyond metadata + actions
- Existing coverage already proves some generic binary download behavior, but it does **not** cover the hosted-web upload transport for representative non-text files or explicit audio/archive presentation.

## Recommended implementation

### 1. Add a binary-first remote upload route
- Change the hosted-web remote upload path to accept multipart/form-data or equivalent raw file upload input.
- Parse filename, media type, optional caption, and raw bytes without routing binary assets through base64 JSON.
- Reuse `task_attachments.rs` storage logic via a byte-oriented helper so remote upload, desktop upload, and tool upload converge on one persistence path.
- Keep the existing `TaskAttachmentInput` tool/desktop contract where it is still useful; ORC-240 does not need to break agent/tool attachment calls.

### 2. Move file-to-wire translation into host bindings
- The shared React page should pass `File` objects or a file-backed upload abstraction instead of eagerly base64-encoding in `TasksPage.tsx`.
- `remoteApiClient` should serialize browser uploads as multipart/form-data.
- `tauriBindings` / mock bindings can continue to base64-encode internally if that remains the least-churn desktop/mock bridge.
- This keeps the UI transport-agnostic while removing the most text-biased surface from hosted web.

### 3. Make non-text rendering intentional
- Preserve existing text and image preview behavior.
- Add an explicit fallback renderer for files that are attachable but not inline-previewable.
  - Suggested categories: `text`, `image`, `audio`, `archive`, `binary/other`.
- Audio files may optionally get a lightweight player if the authenticated host path is low-risk; otherwise they should still render as a deliberate download-first card.
- Archive and generic binary files should show metadata, type/category copy, and download/remove actions without implying a missing text preview.
- Replace the coarse `Math.max(1, Math.round(byteSize / 1024))` UI formatting with a real human-readable size helper.

### 4. Regression coverage
- Rust/backend:
  - attachment storage round-trip for representative binary bytes
  - remote upload route test for non-text assets
  - download route assertions for media type, filename, size, and bytes
- TS client:
  - remote API client test asserting multipart upload behavior and binary download behavior
- Playwright:
  - upload/list/download representative audio and zip/binary files
  - assert intentional non-preview UI state for non-text attachments
  - keep existing text/image preview assertions intact

## Root-cause summary
1. Hosted-web attachment upload is still modeled as **base64 text inside JSON**, not as a binary upload.
2. That adds overhead and inherits axum JSON extractor limits, so common binary attachments fail before backend storage/download logic ever gets a chance to help.
3. The UI still treats previewability as the primary attachment state, which leaves non-text assets under-specified even when storage and download already work.

## Expected file touchpoints
- `src-tauri/src/services/task_attachments.rs`
- `src-tauri/src/services/remote_api.rs`
- `src/lib/orchestraClient/client.ts`
- `src/lib/orchestraClient/remoteApiClient.ts`
- `src/lib/orchestraClient/remoteApiTransport.ts`
- `src/lib/orchestraClient/tauriBindings.ts`
- `src/lib/tauri.ts`
- `src/pages/TasksPage.tsx`
- `src/pages/tasks/TaskDetailPage.tsx`
- `tests/orchestra-client-remote-api.test.ts`
- `tests/e2e/tasks.spec.ts`
- Rust attachment/remote API tests
