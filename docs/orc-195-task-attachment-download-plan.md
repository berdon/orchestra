# ORC-195 task attachment download plan

## tl;dr

- Add a first-class **Download** action to each task attachment card.
- Back it with a real attachment-content path, not preview data:
  - **hosted web / remote API:** `GET /api/v1/task-attachments/:attachment_id/content` returns raw bytes with `Content-Type` and `Content-Disposition: attachment; filename=...`
  - **desktop / Tauri:** add a native `download_task_attachment` command that opens a save dialog and copies the stored file to the chosen destination
  - **mock:** retain source bytes in mock attachment state so the shared UI can exercise the same action
- Extend the shared client with `tasks.downloadAttachment(...)` so React code does not branch on transport details.
- Cover the path with backend tests, remote-client tests, a browser download Playwright test, and a desktop regression that verifies saved file contents.

## Executive summary

Current attachment support stops at upload, preview, and removal. Files are already persisted under the Orchestra project attachment directory, and task detail already exposes enough metadata to render cards, but there is no intentional way to download the original file. The cleanest implementation is to introduce one shared download action in the client contract and then implement that action per host: native save-and-copy on desktop, authenticated HTTP file download in hosted web, and byte-backed mock behavior for local UI tests.

This keeps download behavior out of preview-only state, preserves filenames, works for files that do not render previews, and avoids transport-specific hacks inside React screens.

## Current-state findings

- Attachment storage already exists in `src-tauri/src/services/task_attachments.rs`.
  - Files are written to Orchestra-managed storage under the task attachments directory.
  - Task detail exposes `fileName`, `mediaType`, `byteSize`, `storedPath`, `previewText`, and `imageDataUrl`.
- The shared frontend only supports add/remove attachment today.
  - `src/lib/orchestraClient/client.ts`
  - `src/lib/orchestraClient/tauriBindings.ts`
  - `src/lib/orchestraClient/remoteApiClient.ts`
- The remote API only exposes attachment create/delete routes today.
  - `POST /api/v1/tasks/:task_id/attachments`
  - `DELETE /api/v1/task-attachments/:attachment_id`
- The task-detail UI only renders preview and remove controls.
  - `src/pages/tasks/TaskDetailPage.tsx`
  - `src/pages/TasksPage.tsx`
- Mock attachment state does not currently retain raw bytes, so the mock host cannot faithfully exercise a download action yet.

## Intended UX

### Attachment card action placement

- Add a **Download** secondary action in each attachment card header, beside the existing remove action.
- Keep the action visible for every attachment type, not just previewable ones.
- If the host marks attachment download unavailable, hide or disable the action using the existing capability pattern.

### Filename preservation

- Always default to the stored attachment `fileName`.
- Hosted web should enforce `Content-Disposition: attachment; filename=...` so browsers keep the intended name.
- Desktop save dialogs should prefill the same filename.

### Media-type behavior

- Download always saves the original bytes.
- Existing text/image previews remain unchanged and are not the download source.
- Non-previewable files still show metadata plus the download action.
- Browser downloads should use the attachment media type for the blob/response while still forcing attachment download.

### Desktop vs hosted-web behavior

- **Desktop/Tauri:** clicking Download opens a native save dialog, then copies the stored file directly to the selected path. Cancellation is silent; copy failures surface as task action errors.
- **Hosted web / remote API:** clicking Download performs an authenticated request for the raw attachment content, creates a blob URL, and triggers a browser download.
- **Mock:** clicking Download uses retained mock bytes to trigger the same browser-style download path used in tests.

## Proposed implementation

### 1. Backend attachment-content support

Add explicit raw-content helpers in `src-tauri/src/services/task_attachments.rs`:

- load attachment metadata without preview-only coupling
- load/copy raw attachment bytes from `stored_path`
- centralize filename sanitization for response/save behavior

Recommended command/API shape:

- Tauri command: `download_task_attachment(attachment_id)`
  - resolves attachment
  - prompts for a destination path
  - copies the stored file to that path
  - returns the saved path or attachment metadata
- Remote route: `GET /api/v1/task-attachments/:attachment_id/content`
  - auth required
  - returns raw bytes
  - sets `Content-Type` from attachment `media_type`
  - sets `Content-Disposition: attachment; filename="..."`
  - sets `Content-Length` when known

This route should serve the original bytes even when preview fields are absent.

### 2. Shared client contract

Extend the task client surface with a first-class download method, e.g.

- `downloadAttachment(attachmentId: string): Promise<void>`

Implementation by host:

- `src/lib/orchestraClient/tauriBindings.ts` → invoke `download_task_attachment`
- `src/lib/orchestraClient/remoteApiClient.ts` → fetch the binary attachment-content route
- `src/lib/orchestraClient/mockBindings.ts` / `src/lib/tauri.ts` → synthesize a download from stored mock bytes

To support hosted-web cleanly, add binary transport support in `src/lib/orchestraClient/remoteApiTransport.ts`, e.g. a `requestBlob`/`requestBinary` helper alongside `requestJson` and `requestText`.

### 3. Desktop-native save flow

Add a native save-path picker for the desktop host.

Likely repo touchpoints:

- `src-tauri/Cargo.toml`
- `src-tauri/src/lib.rs`
- `src-tauri/src/commands/tasks.rs`

Preferred behavior:

- use a Tauri dialog plugin or equivalent native chooser
- prefill `attachment.file_name`
- copy bytes in Rust instead of marshaling full files through JS/base64

This keeps the desktop path efficient for larger files and avoids browser-download quirks inside the webview shell.

### 4. UI wiring

Update task detail surfaces:

- `src/pages/tasks/TaskDetailPage.tsx`
- `src/pages/TasksPage.tsx`

Changes:

- add `onDownloadAttachment`
- render a Download button in each attachment card
- keep existing preview/remove behavior unchanged
- surface failures via the existing `taskActionError` path

No new tab or modal is needed.

### 5. Capability and permission behavior

Recommendation:

- Treat download as part of the existing task attachment capability surface.
- In remote bootstrap, continue exposing attachment support through `capabilities.tasks.attachments`.
- In the UI, only render/enable Download when attachment capability is available.
- Do **not** introduce a separate product-level permission split unless there is a broader attachment-read policy effort; current task-read visibility already exposes attachment metadata and the app does not yet distinguish attachment read vs write capabilities.

## Regression coverage

### Backend / Rust

- `task_attachments.rs`
  - raw bytes can be loaded/copied for text, image, and binary attachments
  - filenames are preserved
  - files larger than preview thresholds still download correctly
- `remote_api.rs`
  - `GET /api/v1/task-attachments/:attachment_id/content` returns 200 with expected headers and bytes
  - auth failures remain explicit

### Frontend / client

- remote API client test for binary attachment download route and auth handling
- contract test update for the new shared `tasks.downloadAttachment` method
- mock download test proving the mock host retains original bytes rather than downloading preview text

### UI / end-to-end

- Playwright browser test:
  - upload representative files
  - click Download
  - assert downloaded filename and file contents
- desktop regression:
  - add a deterministic save-path strategy for automation (for example a test-only path override or injectable dialog resolver)
  - verify the saved file exists with the original bytes

Representative fixtures should include:

- small text file
- image file
- binary/non-previewable file
- one file large enough to skip preview generation but still download correctly

## Suggested file touchpoints

- `src/types.ts`
- `src/lib/orchestraClient/client.ts`
- `src/lib/orchestraClient/remoteApiTransport.ts`
- `src/lib/orchestraClient/remoteApiClient.ts`
- `src/lib/orchestraClient/tauriBindings.ts`
- `src/lib/orchestraClient/mockBindings.ts`
- `src/lib/tauri.ts`
- `src/pages/TasksPage.tsx`
- `src/pages/tasks/TaskDetailPage.tsx`
- `src-tauri/src/services/task_attachments.rs`
- `src-tauri/src/commands/tasks.rs`
- `src-tauri/src/services/remote_api.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/Cargo.toml`
- attachment-related tests across `tests/`, `tests/e2e/`, and Rust unit tests

## Recommended implementation order

1. Add backend raw-content support and the remote content route.
2. Add the Tauri desktop download command and native save-path flow.
3. Extend the shared client contract plus remote binary transport support.
4. Wire the Download action into task detail.
5. Add mock byte retention for local UI/e2e coverage.
6. Add regression coverage for backend, hosted web, and desktop paths.

## Expected outcome

After implementation, users will be able to intentionally download any task attachment from the task detail UI, keep the original filename and bytes, and get consistent behavior across desktop and hosted-web contexts without depending on preview data or manual file extraction.