# ORC-281 bounded agent task-context plan

## tl;dr
- Keep the existing full `TaskDetail` path for UI/internal callers, but introduce a separate **agent-facing bounded task-context projection** for runtime prompts and bridge `get_task_context` calls.
- Stop inlining attachment preview/content fields and full comment history in agent context; load only bounded recent comment windows plus attachment manifests.
- Make omitted data explicit with counts plus retrieval hints.
- Add on-demand task-context tools for the data we stop eager-loading: at minimum `list_task_attachments` (metadata only) and `search_task_comments`, and expose the already-implemented `search_task_comment_file_mentions` through the bridge/extension.
- Update prompt/tool help so agents are told up front that context is intentionally bounded and that additional comments/attachments/file-path data must be requested with tools.

## Executive summary
The current implementation has two separate problems:

1. **payload size** — agent-facing `get_task_context` currently inherits the full `TaskDetail` payload, including every task comment plus attachment preview fields that can embed large text blobs or image data URLs
2. **load behavior** — even when the prompt only renders a small subset, the backend still eagerly loads all comments and reads attachment bytes in order to build previews

The cleanest fix is **not** to shrink the canonical UI task-detail model. Instead, keep `TaskDetail` as the full internal/UI surface and add a second, explicit **agent context** surface with bounded arrays, truncated text, attachment manifests instead of attachment previews, omitted-count metadata, and clear retrieval guidance. That lets task details stay rich for the app while making worker prompts and bridge tool payloads safe for model consumption.

## Current-state findings
- `src-tauri/src/services/tasks.rs::get_task_context(...)` currently loads:
  - full `task.comments`
  - full `task.attachments`
  - full `task.file_references`
  - full `task.lane_runs`
- `src-tauri/src/services/task_attachments.rs::build_attachment(...)` reads attachment bytes and may inline:
  - `preview_text` up to **64 KiB**
  - `image_data_url` up to **512 KiB**
- `src-tauri/src/services/task_runtime.rs::build_lane_prompt(...)` only renders recent comments textually, but it still starts from the full eager-loaded task context and still renders **all attachments** in the prompt attachment block.
- `src-tauri/src/services/tool_bridge.rs` currently maps bridge `get_task_context` directly to `tasks::get_task_context(...)`, so agent tool calls also receive the unbounded full payload.
- Agent-accessible task tools currently include `list_task_comments` and `list_task_file_references`, but there is:
  - no agent-facing `list_task_attachments`
  - no agent-facing `search_task_comments`
  - no bridge exposure for the already-existing `search_task_comment_file_mentions` command

## Recommended design

### 1. Split full task detail from bounded agent context
Keep:
- `tasks::get_task_context(...) -> TaskDetail` for UI/internal code

Add:
- `tasks::get_agent_task_context(...) -> AgentTaskContext` (or equivalent named projection)

Use the bounded agent-context path in exactly two places first:
- worker/session prompt construction in `src-tauri/src/services/task_runtime.rs`
- bridge `get_task_context` execution in `src-tauri/src/services/tool_bridge.rs`

This avoids breaking task-detail UI while solving the model-facing payload problem where it actually matters.

### 2. Do not build agent context from the full eager-loaded detail object
The bounded path should **not** call full `get_task_context(...)` and then truncate after the fact.

Instead, add bounded loaders so the agent path avoids unnecessary I/O and serialization:
- metadata-only attachment loader
- recent-comments loader
- capped file-reference loader
- capped lane-run loader if lane runs remain included

That is the difference between “smaller JSON after loading everything” and “actually bounded task context generation.”

### 3. Bound repeated collections by policy, not by accident
Recommended rules for the agent-facing context:

#### Attachments
- Never inline `previewText` or `imageDataUrl` in agent context.
- Return **manifest metadata only**:
  - `id`
  - `fileName`
  - `mediaType`
  - `byteSize`
  - `caption`
  - `storedPath`
  - `createdAt`
- Include only the most recent **10** attachments.
- Include `attachmentCount` plus `omittedAttachmentCount` / `attachmentsTruncated` metadata.

#### Comments
- Do not inline full history.
- Include only the most recent **8 comments/messages** in agent context, returned in chronological order after windowing.
- Truncate per-item text:
  - `message`: **500 chars max**
  - `selectedText`: **200 chars max**
- Preserve anchor metadata (`parentCommentId`, `relativePath`, line info, author, timestamps) so the recent window stays actionable.
- Include `commentCount` plus `omittedCommentCount` / `commentsTruncated` metadata.

#### File references
- Keep file-reference metadata, but cap the inlined list to the most recent **20** references.
- Include total count plus truncation metadata.
- Agents can request the full list later with `list_task_file_references` and then use repo tools (`read`, `bash`, `rg`) against the surfaced paths/worktrees.

#### Other repeated arrays
To keep the bridge payload truly bounded, apply a conservative cap to other potentially-growing arrays that are not critical in full:
- `laneRuns`: most recent **10**
- `children`, `blockedBy`, `blocking`, `todos`: cap at **25** each if they remain in the bridge payload

The exact numbers can live as shared constants, but the important rule is: **every agent-facing repeated collection must have a bounded policy**.

As a final backstop, the agent projection can also enforce a serialized-size ceiling after assembly and trim the lowest-priority sections further if a pathological task still exceeds the target budget.

### 4. Make truncation explicit in the payload and prompt
The agent should never have to guess whether it has the full story.

Recommended additions to the bounded payload:
- `contextBounded: true`
- `commentsTruncated`
- `attachmentsTruncated`
- `fileReferencesTruncated`
- omitted-count fields
- an `additionalDataHints` block or equivalent textual note pointing to the follow-up tools

Recommended prompt wording:
- recent comments and attachment manifests are intentionally bounded
- omitted history/content can be requested with tools
- attachments are exposed as manifests/paths rather than inline content

## Retrieval/search tool plan

### 1. Add `list_task_attachments`
Add an explicit agent tool for attachment manifests.

Recommended behavior:
- permission: `tasks.read` for now (matching current attachment visibility via task context)
- input:
  - `taskId`
- output:
  - attachment manifest metadata only
  - no `previewText`
  - no `imageDataUrl`

Why this tool matters even if `get_task_context` already includes recent attachments:
- it lets the agent fetch the full attachment manifest list on demand
- it removes the need to overload `get_task_context` as both summary and attachment index
- it matches the existing task-system design docs more closely than today’s bridge surface

### 2. Add `search_task_comments`
Add a targeted search tool instead of forcing agents to pull the full thread history whenever one older detail matters.

Recommended behavior:
- permission: `tasks.read`
- input:
  - `taskId`
  - `query`
  - optional `limit` (default 10, max 25)
- search fields:
  - `message`
  - `author`
  - `relativePath`
  - `selectedText`
- ordering:
  - newest match first
- output:
  - matching comments with existing anchor/thread metadata

Implementation note:
- simple case-insensitive SQL substring search is sufficient here; this task does not need SQLite FTS unless the implementation already wants it

### 3. Expose `search_task_comment_file_mentions` in the bridge/extension
This command already exists in the backend/client stack and searches repository file paths for task-comment mentions. It should also be exposed to agents through:
- `src-tauri/src/services/command_authorization.rs`
- `src-tauri/src/services/tool_bridge.rs`
- `extensions/orchestra-tools.ts`

That gives agents a targeted path-discovery/search tool without re-expanding the base task context.

### 4. Keep `list_task_comments` as the full-history escape hatch
`list_task_comments` should remain available for the rare case where the agent truly needs the whole conversation.

This ticket does **not** need to remove or redefine that tool; it only needs to stop making full history the default eager payload.

## Prompt/runtime guidance changes
Update the runtime prompt/tool-help text so agents are explicitly told:
- `get_task_context` is intentionally bounded for model practicality
- use `list_task_comments` or `search_task_comments` for older discussion
- use `list_task_attachments` for the full attachment manifest
- use `search_task_comment_file_mentions` and existing repo/file tools for targeted file lookup
- attachment content is not inlined; use the surfaced stored path with normal file-reading tools when needed

The prompt should also label recent comments as **recent** and attachments as **manifest metadata** so the omission is obvious.

## Suggested backend shape

### New/adjusted models
Recommended additions in `src-tauri/src/models.rs`:
- `AgentTaskContext`
- `TaskAttachmentManifest` (metadata only)
- optional small truncation/availability helper structs if that keeps the JSON contract clearer

This keeps the agent-facing contract explicit instead of relying on an ad-hoc partially-redacted `TaskDetail` value.

### New service helpers
Likely touchpoints:
- `src-tauri/src/services/tasks.rs`
  - add `get_agent_task_context(...)`
  - add `search_task_comments(...)`
- `src-tauri/src/services/task_attachments.rs`
  - add metadata-only manifest loader that does **not** read file bytes
- `src-tauri/src/services/task_runtime.rs`
  - build prompt sections from bounded data
- `src-tauri/src/services/tool_bridge.rs`
  - return bounded agent context for bridge `get_task_context`
  - expose new search/retrieval commands
- `src-tauri/src/services/command_authorization.rs`
  - register new command descriptions/permissions
- `src-tauri/src/commands/tasks.rs`
  - add Tauri commands for new retrieval/search services as needed

## Test plan

### Rust/backend
Add coverage for:
- bounded agent context excludes attachment preview fields
- bounded agent context caps recent comments and truncates long comment text
- bounded agent context reports omitted counts correctly
- attachment manifests load without reading preview bytes
- `search_task_comments` matches expected fields and respects limit ordering

### Prompt/runtime
Update `src-tauri/src/services/task_runtime.rs` tests to assert:
- prompt says the task context is bounded
- prompt points agents to the new retrieval/search tools
- attachment block no longer implies inline content availability
- recent comments block is truncated/capped predictably

### Bridge/extension
Add/update tests for:
- bridge `get_task_context` returning the bounded contract
- new `list_task_attachments`
- new `search_task_comments`
- `search_task_comment_file_mentions` appearing in the registered tool list/help

## Non-goals / defer
- Do **not** collapse the full desktop/web task-detail UI onto the bounded contract in this task.
- Do **not** introduce a separate `tasks.attachments.read` permission split unless a broader permission task already needs it; `tasks.read` is enough for parity with current behavior.
- Do **not** require SQLite FTS for comment search in the first pass.

## Expected outcome
After implementation:
- worker prompts stay small and explicit
- bridge `get_task_context` becomes model-safe instead of unbounded
- full comment history and attachment content stop being default eager payloads
- agents still have a clear, targeted way to fetch older comments, attachment manifests, and relevant file paths on demand
- UI/internal task details can remain rich without forcing that same payload shape onto agent runtimes
