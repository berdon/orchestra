# ORC-257 in-app browser + DOM comment plan

## tl;dr

- Make the browser a **task-bound desktop webview window**, not an iframe inside the React app. An iframe cannot satisfy arbitrary-origin DOM inspection/commenting safely.
- Add a persisted `task_browser_sessions` domain with one active browser surface per task, plus task-scoped APIs/tools for reveal, navigate, state, DOM query/control, and inspect-mode toggling.
- Inject a **minimal Orchestra browser bridge** into that window to track navigation + DOM revisions, power an inspect overlay, and create DOM-anchored task comments without exposing full Tauri IPC to arbitrary page code.
- Generalize task comment anchors from **file-only** to **file + DOM** so element comments reuse the existing threaded task comment model, unread flows, timeline/history, and task review context.
- Validate with Rust persistence/auth tests, tool-schema/help tests, shared UI anchor-formatting tests, and desktop E2E against a small local DOM-mutation harness page.

## Executive summary

Orchestra already has the two key seams this feature should reuse:

- detached desktop surfaces owned by the Tauri host (`logs`, `agent-terminal`)
- task comments with durable anchor metadata and threaded review UI

The missing piece is a task-aware browser domain that sits between them. The safest implementation is **not** an embedded iframe in `TaskDetailPage`: that would immediately fail the cross-origin DOM-inspection requirement for remote pages and would make inspect-mode/comment overlays unreliable for arbitrary origins. Instead, ORC-257 should add a dedicated Orchestra-owned browser window per task, backed by a persisted browser-session record and a tightly scoped injected page bridge.

That gives Orchestra a real interactive page surface the user can click/type/scroll normally, while also giving the host a controlled way to:

- reveal the surface on demand
- navigate it to local or remote URLs
- observe load/DOM revision changes
- run targeted DOM queries/actions
- enter an inspect mode that highlights hovered elements, captures a locator bundle, and turns a selection into a durable task comment

The element-comment model should extend the existing task comment system instead of creating a parallel annotation store. File comments stay intact, but comments gain a generic anchor kind/payload so DOM element anchors can render in the same thread list, timeline, task runtime prompt, and later “reveal this anchor again” flows.

## Current seams to build on

### Detached desktop window patterns already exist

- `src-tauri/src/commands/app.rs`
- `src-tauri/src/commands/agent_runtime.rs`
- `src/lib/orchestraClient/extensions.ts`
- `src/lib/orchestraClient/tauriShellExtension.ts`

These already cover the core show/focus/reuse/close lifecycle for Orchestra-owned secondary windows.

### Task comment/file anchor plumbing already exists

- `src/types.ts`
- `src-tauri/src/models.rs`
- `src-tauri/src/services/tasks.rs`
- `src-tauri/src/services/database.rs`
- `src/components/CommentableFileViewer.tsx`
- `src/pages/tasks/TaskDetailPage.tsx`
- `src-tauri/src/services/task_runtime.rs`

The current comment model is file-anchor-centric, but it already has the right durable shape: comments belong to tasks, support replies/unread flows, and preserve anchor metadata.

### Capability + tooling seams already exist

- `src/lib/orchestraClient/bootstrap.ts`
- `src/lib/orchestraClient/bootstrapFactory.ts`
- `src/lib/access.ts`
- `src-tauri/src/services/command_authorization.rs`
- `src-tauri/src/services/tool_bridge.rs`
- `extensions/orchestra-tools.ts`

ORC-257 should extend these seams rather than inventing a side-channel browser control path.

## Recommended implementation

### 1. Add a task-bound browser session domain

Create a dedicated backend service and persistence table for task browser state, e.g. `task_browser_sessions`.

Recommended fields:

- `id`
- `task_id`
- `window_label`
- `current_url`
- `page_title`
- `inspect_mode`
- `dom_revision`
- `last_mutation_at`
- `last_ready_state`
- `last_selected_anchor_json` (optional)
- `bridge_secret`
- `created_at`
- `updated_at`

Recommended scope rule for the first slice:

- **one active browser surface per task**
- `show/open` is idempotent and reuses the existing task browser window when present

This gives Orchestra a stable answer for task association: the browser surface is already bound to exactly one task, so element comments never need the page itself to decide which task they belong to.

### 2. Use a dedicated desktop browser window, not an iframe

Recommended shape:

- create/reuse a Tauri webview window for the task browser surface
- allow navigation to `http:` and `https:` only
- explicitly reject `file:`, `data:`, and `javascript:` URLs
- support `localhost` / `127.0.0.1` so agents can drive local dev servers

Important design rule:

- **do not** implement the browser as a React iframe panel for arbitrary pages

Why:

- parent-page DOM inspection fails across origins
- inspect-mode overlays become origin-fragile
- user interaction would be subject to iframe restrictions instead of a real page surface

The task detail view should still gain a `Browser` tab, but that tab should be the **control/status surface** for the task browser session, not the primary renderer of arbitrary web content.

### 3. Add a minimal injected browser bridge

The loaded page must not inherit Orchestra’s normal Tauri command surface.

Recommended model:

- inject a small Orchestra-owned script into the browser window
- keep the privileged transport in a closure scoped to that injected script
- expose only narrowly validated browser-session actions
- authenticate page-to-host messages with the session’s `bridge_secret`

That bridge should own:

- navigation/load notifications
- `document.title`, `location.href`, and ready-state updates
- a debounced `MutationObserver` that bumps `dom_revision`
- targeted DOM query/control helpers used by agent/browser tools
- inspect-mode hover/highlight/select/comment behavior

Important safety rule:

- remote page JS must **not** receive generic `invoke` access or arbitrary Orchestra command access

### 4. Keep real-time page observation lightweight

Do not stream full HTML on every mutation.

Recommended model:

- track `dom_revision` + `last_mutation_at`
- let tools/UI fetch targeted state on demand
- optionally add a wait primitive keyed off revision changes instead of inventing a long-lived streaming browser tool immediately

That is enough for “observe and react to real-time DOM/page updates” without turning the browser into a high-volume snapshot pipeline.

### 5. Generalize task comment anchors to support DOM elements

The current task comment shape is file-anchor-only. ORC-257 should extend it to a generic anchor model while preserving existing file-comment behavior.

Recommended additive shape:

```ts
anchor?:
  | {
      kind: "file";
      repositoryId: string;
      relativePath: string;
      lineStart: number;
      lineEnd: number;
      columnStart?: number | null;
      columnEnd?: number | null;
      selectedText?: string | null;
      commitHash?: string | null;
      hasUncommittedChanges?: boolean | null;
    }
  | {
      kind: "dom";
      browserSessionId: string;
      url: string;
      pageTitle?: string | null;
      domRevision: number;
      locator: {
        cssPath?: string | null;
        xpath?: string | null;
        role?: string | null;
        accessibleName?: string | null;
        textSnippet?: string | null;
        testId?: string | null;
        ordinalPath?: Array<{ tag: string; index: number }>;
      };
      snapshot: {
        tagName: string;
        id?: string | null;
        classList?: string[];
        textPreview?: string | null;
        attributes?: Record<string, string>;
        outerHtmlSnippet?: string | null;
      };
    };
```

Practical migration guidance:

- keep the existing file fields working during the migration
- update rendering helpers to prefer the generic anchor model when present
- do not break `CommentableFileViewer` or existing file-comment tests while DOM anchors land

### 6. Implement inspect mode as an injected overlay, not a static preview

Recommended behavior:

- default mode: the page behaves normally; no click interception
- inspect mode on:
  - hovered elements get a visible highlight
  - clicking selects the target element instead of activating the page control
  - Orchestra shows a small anchored comment composer for that element
  - `Esc` exits inspect mode / clears selection

Implementation notes:

- render the overlay in a shadow root so site CSS does not destroy it
- capture multiple locator strategies, not just one brittle selector
- include enough snapshot context to be useful later even if the page changes

This directly satisfies the “normal interactive page” requirement while making inspect mode explicit and reversible.

### 7. Put the browser control surface on the task domain

Unlike logs or the agent terminal, this feature is task-bound and comment-producing. The API surface should therefore live with task services/capabilities, even though the actual renderer is a desktop webview window.

Recommended client/task methods:

- `showBrowser(taskId)`
- `getBrowserState(taskId)`
- `navigateBrowser(taskId, url)`
- `setBrowserInspectMode(taskId, enabled)`
- `queryBrowserElements(taskId, query)`
- `getBrowserElement(taskId, locator)`
- `clickBrowserElement(taskId, locator)`
- `setBrowserElementValue(taskId, locator, value)`
- `waitForBrowserDomChange(taskId, sinceRevision, timeoutMs)`

Recommended tool-bridge surface should mirror that shape with task-scoped naming.

### 8. Add a Browser tab and anchor reveal affordances in task detail

Recommended task-detail UX:

- add a `Browser` tab in `TaskDetailPage`
- show current URL/title, DOM revision, inspect-mode state, and open/reveal controls there
- let the browser tab navigate the task surface explicitly
- render DOM-anchor badges in the existing comments thread/timeline UI
- add a `Reveal in browser` action for DOM-anchored comments that reopens the task browser and attempts to reselect the stored locator bundle

This keeps the browser discoverable from the task while still letting the actual page live in a real browser surface.

## Permissions, capabilities, and safety

### Actor permissions

Recommended new permissions:

- `tasks.browser.read`
- `tasks.browser.control`

Recommended mapping:

- read browser session state / DOM metadata → `tasks.browser.read`
- show, reveal, navigate, query, click, fill, toggle inspect → `tasks.browser.control`
- element comment creation still also requires the existing `tasks.comment` path

### Frontend capabilities

Extend the shared bootstrap/task capability model so the UI can hide or disable the browser surface intentionally when unsupported.

Recommended additions:

- feature flag: `taskBrowser`
- capability descriptor: `tasks.browser`

Desktop Tauri should advertise it as available once the host/browser service exists. Hosted-web and mock can advertise it as unavailable until a safe equivalent exists.

### Tauri/webview safety

This is separate from actor permissions and is the highest-risk part of the feature.

Recommended rule:

- add an explicit restricted capability profile for the browser window so arbitrary web content cannot inherit Orchestra’s normal IPC surface

## Proposed validation plan

### Rust/backend

- browser-session persistence + reuse tests
- URL validation tests
- bridge-secret validation tests
- DOM-anchor comment persistence tests
- permission/authorization mapping tests

### Shared TS/frontend

- anchor-label formatting tests for DOM comments
- task-browser tab state tests
- inspect-overlay locator/snapshot serialization tests (where practical in unit scope)

### Tooling

- `command_authorization` allowed-tool coverage
- `extensions/orchestra-tools.ts` schema/help coverage
- tool-bridge invocation tests for browser commands

### Desktop E2E

Use a tiny local harness page with deterministic selectors plus a live-updating counter/toggle.

Minimum flows:

1. open/reveal the browser surface for a task
2. navigate to a local test page
3. prove the page is still normally interactive when inspect mode is off
4. prove DOM revision/state updates after a live page mutation
5. enable inspect mode and verify hover highlight + click selection
6. create a task comment from the selected element
7. verify the saved task comment preserves DOM anchor context and can reveal the element again

## Proposed file plan

- `docs/orc-257-in-app-browser-plan.md`
- `src-tauri/src/services/task_browser.rs` (new)
- `src-tauri/src/commands/task_browser.rs` or task-command extensions
- `src-tauri/src/services/database.rs`
- `src-tauri/src/models.rs`
- `src/lib/orchestraClient/bootstrap.ts`
- `src/lib/orchestraClient/bootstrapFactory.ts`
- `src/lib/orchestraClient/client.ts`
- `src/lib/orchestraClient/tauriBindings.ts`
- `src/lib/orchestraClient/remoteApiClient.ts` / `mockBindings.ts` capability handling
- `src/lib/access.ts`
- `src/pages/tasks/TaskDetailPage.tsx`
- `src/components/TaskBrowserPanel.tsx` (recommended new UI component)
- `src-tauri/src/services/command_authorization.rs`
- `src-tauri/src/services/tool_bridge.rs`
- `extensions/orchestra-tools.ts`
- desktop/browser tests for the new surface and comment workflow

## Explicit non-goals for the first slice

- multi-tab browser management
- full browser-history UI parity with a consumer browser
- cross-frame/iframe comment anchoring beyond storing frame-path metadata if it is cheap
- remote/hosted-web parity for opening the desktop browser surface
- screenshot-only or static-preview implementations
