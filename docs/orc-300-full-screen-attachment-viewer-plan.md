# ORC-300 full-screen attachment viewer plan

## tl;dr
- Keep the existing attachment storage and download paths; add a separate **read-for-viewing** path so the UI can open viewable attachments without changing unsupported-file behavior.
- Build a dedicated full-screen attachment viewer overlay in task detail.
- Treat **image** and **text/code** attachments as viewable via media-type **and filename** heuristics, so code/config files with weak MIME data still open correctly.
- Reuse highlight.js for text/code rendering, add image zoom/pan + fit/fill controls, and leave non-viewable attachments on the current download/remove path.

## Executive summary
The current attachment tab is still preview-first: task detail renders small inline `imageDataUrl` / `previewText` snippets when available, and everything else falls back to metadata plus Download/Remove. That is enough for thumbnails, but not for the requested full-screen viewer.

The lowest-risk design is to keep the current persisted attachment model exactly as-is and add an **on-demand viewer path** on top of it. Remote/hosted web already has a raw attachment-content route (`GET /api/v1/task-attachments/:attachment_id/content`), and the backend storage layer already knows how to load raw bytes from `stored_path`. The missing pieces are:

1. a shared client method for reading attachment content for display
2. a dedicated full-screen viewer UI in `TaskDetailPage`
3. better viewability detection for text/code files that do not arrive with strong MIME types

That keeps download semantics unchanged, avoids inflating `TaskDetail` further, and scopes the task to frontend viewer work plus a small desktop/mock client addition.

## Current-state findings
- `src/pages/tasks/TaskDetailPage.tsx`
  - attachments render inline cards only
  - cards expose Download/Remove but no open/view action
  - text rendering is plain `<pre>` preview text, not a dedicated reader
- `src/lib/taskAttachments.ts`
  - attachment kind detection is mostly MIME-driven
  - `text/*` and `application/json` are treated as text
  - many common code/config files can still land as `application/octet-stream`, so they would currently miss text-viewer treatment
- `src-tauri/src/services/task_attachments.rs`
  - already stores raw bytes safely
  - already has `load_attachment_bytes(...)`
  - preview payloads are intentionally capped (`64 KiB` text, `512 KiB` image), so they are not a good full-view source
- `src/lib/orchestraClient/remoteApiClient.ts`
  - already downloads binary attachment content through the existing remote route
  - but only exposes that path as `downloadAttachment(...)`, not as a reusable viewer-content read
- desktop/Tauri currently has `download_task_attachment` for save-to-disk, but no JS-facing read-content command for opening a viewer
- `TaskDetailPage` already contains filename-based language detection and highlight.js usage for repo-file rendering, so the text viewer can reuse that approach instead of inventing a second formatter

## Proposed implementation

### 1. Add explicit viewability + language helpers
Create a shared attachment-view helper surface, most likely in `src/lib/taskAttachments.ts` or a sibling helper module:
- `getTaskAttachmentViewKind(...)` → `"image" | "text" | null`
- `isTaskAttachmentViewable(...)`
- `detectTaskAttachmentLanguage(fileName, mediaType?)`
- optional `shouldSyntaxHighlightAttachment(byteSize)` guard for large text files

Rules:
- images stay media-type driven (`image/*`)
- text/code should use both media type and filename heuristics
  - `text/*`, `application/json`, XML/YAML/TOML-like types, etc.
  - known code/config/document extensions should count as text-viewable even when MIME is generic
- keep the existing fallback-kind categories (`audio`, `archive`, `binary`) for non-viewable cards

This is the key fix for “text-based attachments” that arrive without helpful browser MIME metadata.

### 2. Add a shared attachment-content read path
Extend the task client with a read method distinct from download, e.g.
- `tasks.getAttachmentContent(attachmentId)`

Recommended return shape:
- `fileName`
- `mediaType`
- `blob`

Host behavior:
- **remote API / hosted web:** reuse `GET /api/v1/task-attachments/:attachment_id/content` via `requestBlob(...)`; no server route change should be required
- **desktop / Tauri:** add a new command that loads raw attachment bytes and returns base64 + metadata to JS, where the binding converts it to a `Blob`
- **mock:** build the blob from the stored mock base64 bytes already retained for download tests

Important scope choice:
- do **not** replace `downloadAttachment(...)`
- do **not** expand `TaskDetail` payloads with bigger inline previews
- read full content only when the user explicitly opens a viewer

### 3. Build a dedicated full-screen viewer component
Add a focused viewer component such as:
- `src/components/TaskAttachmentViewerModal.tsx`

Integrate it from `TaskDetailPage` with local state:
- selected attachment
- loading/error state
- loaded blob URL / text content
- image transform state

Behavior:
- open from a clear attachment action/target for viewable files
- render as a full-screen overlay/dialog that keeps the user on the same task detail context underneath
- close via close button, backdrop click, and `Escape`
- return focus to the launcher when closed
- keep Download available inside the viewer so the full-screen path does not remove existing download affordances

I would keep this as an overlay, not a new route, because the acceptance criteria only require returning to the prior task context and the task-detail page already uses overlay/modal patterns.

### 4. Image viewer interactions
The image viewer should be a dedicated viewport with:
- zoom in / zoom out controls
- fit / fill controls
- reset control
- draggable panning when zoomed or when fill mode exceeds the viewport

Recommended model:
- compute a base scale from the viewport and natural image size
  - `fit` = contain
  - `fill` = cover
- apply a user zoom multiplier on top of that base scale
- keep pan offsets in local state and clamp them to the visible bounds
- support wheel zoom and pointer-drag panning; toolbar buttons remain the deterministic path for testing

This avoids adding a new dependency just for zooming while still meeting the interaction requirements.

### 5. Text/code viewer interactions
For text-based attachments:
- load attachment text from the blob on demand
- render it in a scrollable `<pre><code>` surface with preserved whitespace and normal text selection
- reuse highlight.js with filename/media-type language detection when practical
- fall back to plain escaped text if language detection fails

Important performance guard:
- do not blindly syntax-highlight arbitrarily large text files
- for large text attachments, render plain selectable text (or disable auto-detect) once a size threshold is exceeded

That keeps the viewer responsive while still satisfying “syntax highlighting or sensible formatting where supported.”

### 6. Attachment-tab UX changes
For the card surface in `TaskDetailPage`:
- keep inline image/text previews if they already exist
- add a clear open affordance for viewable attachments
- make the preview/body region clickable for viewable files, but leave Download/Remove as separate buttons
- non-viewable attachments should remain download-first and should not open the viewer

I would not broaden the backend preview-generation rules in this task. The full-screen viewer should work from on-demand raw-content reads, even if the inline card itself still falls back to metadata for some text/code files.

### 7. Shared highlighting cleanup
`TaskDetailPage` already has language-detection/highlight helpers for repo files. Extract those into a reusable helper so the attachment viewer and repo-file viewer do not drift.

That likely means moving:
- filename → language mapping
- `highlightCode(...)`

into a shared lib module and updating both call sites.

## Regression coverage

### Unit/client coverage
- add helper tests for:
  - viewable vs non-viewable attachment classification
  - filename-based text/code detection with weak MIME types
  - language detection mapping
- add remote client coverage for the new read-content method using the existing binary attachment route
- add mock/Tauri contract updates for the new client method

### UI coverage
- add a focused viewer test for:
  - opening a text attachment viewer
  - opening an image attachment viewer
  - close behavior
  - loading/error fallback

### Playwright coverage
Extend task attachment e2e coverage to assert:
- clicking a viewable image attachment opens the viewer
- zoom controls visibly change the viewer zoom state
- clicking a viewable text attachment opens a full-screen selectable text/code surface
- known code/text formats receive highlighted/readable rendering where supported
- closing the viewer returns to the same task attachment context
- archive/audio/binary attachments still use the existing fallback/download behavior

To keep those tests stable, add explicit `data-role` hooks for:
- open attachment viewer trigger
- viewer shell
- close button
- image viewport
- text viewport
- zoom display / fit-fill toggles

## Expected file touch list
- `src/pages/tasks/TaskDetailPage.tsx`
- `src/components/TaskAttachmentViewerModal.tsx` (new)
- `src/lib/taskAttachments.ts`
- shared highlight helper file (new or extracted from `TaskDetailPage.tsx`)
- `src/lib/orchestraData/tasks.ts`
- `src/lib/orchestraClient/client.ts`
- `src/lib/orchestraClient/remoteApiClient.ts`
- `src/lib/orchestraClient/tauriBindings.ts`
- `src/lib/orchestraClient/mockBindings.ts`
- `src/lib/tauri.ts`
- `src/types.ts`
- `src/styles.css`
- `src-tauri/src/commands/tasks.rs`
- `src-tauri/src/lib.rs`
- attachment-related client tests and task attachment e2e tests

## Recommended implementation order
1. Add the shared attachment view/language helpers.
2. Add the shared attachment-content read method across remote, Tauri, and mock clients.
3. Extract shared highlight helpers from `TaskDetailPage`.
4. Build the full-screen viewer component and wire it into the attachments tab.
5. Add image zoom/pan/fit/fill behavior.
6. Add regression coverage.

## Expected outcome
After implementation, viewable task attachments will open in a dedicated full-screen viewer without changing the existing storage model or unsupported-file behavior. Images will support zoom/pan and fit/fill controls, text/code files will open in a readable selectable viewer with highlighting where appropriate, and download-first behavior will remain unchanged for non-viewable attachments.