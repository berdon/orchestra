# ORC-202 — project notes UI and agent tools plan

## tl;dr

- Add a new top-level `Notes` page backed by a shared `notes` client/service instead of threading more page-specific state through `App.tsx`.
- Store project notes under `<orchestra project root>/docs` and repository notes under `<repository checkout>/docs`; list directories plus `.md` files only.
- Reuse the Sessions-style resizable secondary nav for the notes tree, with `Project` first and repository roots after it.
- Use a lightweight markdown editor that reuses existing `highlight.js` + `MarkdownContent` patterns from task details instead of introducing a new editor dependency.
- Introduce `notes.read` and `notes.write` permissions/capabilities, plus note tools `list_notes`, `get_note`, `update_note`, `delete_note`, `copy_note`, and `move_note` with explicit help/schema coverage.
- Cover the feature with path-safety/backend tests, shared-client parity tests, tool-registration/help tests, and a new end-to-end notes workflow.

## Executive summary

Orchestra already has almost all of the building blocks this feature needs, but they are spread across unrelated seams:

- `src/App.tsx` owns top-level navigation and page routing.
- `src/pages/SessionsPage.tsx` + `ResizableSidebarLayout` already implement the exact split-shell pattern the notes page wants.
- `MarkdownContent` and the task-detail/file-preview surfaces already provide markdown rendering and `highlight.js` integration.
- `src-tauri/src/services/orchestra_paths.rs` already knows how to resolve the Orchestra project root and managed repository checkout roots.
- The shared client, remote API, access catalog, tool bridge, and orchestra-tools extension already provide the parity pattern for cross-host features.

The lowest-risk implementation is to add a dedicated notes domain that treats `docs/` as the only valid storage root, exposes a tree + note-content API through the shared Orchestra client, and builds a self-contained `NotesPage` container on top. The page should keep the UX intentionally simple: tree on the left, selected note in the detail pane, explicit save/revert controls, and modal actions for create/rename/move/copy/delete. For agent tooling, keep the required bridge surface note-centric and map it onto the same backend service so UI and tools cannot drift.

## Current seams to build on

- Navigation/page types
  - `src/types.ts` (`PrimaryPage`)
  - `src/App.tsx` (`NAV_ITEMS`, `APP_ROUTE_PAGES`, main page switch, mobile/desktop nav)
  - `src/lib/commandPalette.ts`
- Sessions-style secondary navigation shell
  - `src/pages/SessionsPage.tsx`
  - `src/components/ResizableSidebarLayout.tsx`
- Existing markdown/highlight primitives
  - `src/components/MarkdownContent.tsx`
  - `src/pages/tasks/TaskDetailPage.tsx` (`highlight.js` helpers and markdown rendering)
- Filesystem root/path resolution
  - `src-tauri/src/services/orchestra_paths.rs`
  - `src-tauri/src/services/projects.rs`
- Permissions/tooling/client parity
  - `src/lib/access.ts`
  - `src/lib/orchestraClient/*`
  - `src-tauri/src/services/command_authorization.rs`
  - `src-tauri/src/services/tool_bridge.rs`
  - `extensions/orchestra-tools.ts`
  - `src-tauri/src/services/remote_api.rs`

## Recommended implementation

### 1. Define the notes storage and location model explicitly

Use one logical note model with two root scopes:

- `project`
  - root path: `<project root>/docs`
- `repository`
  - root path: `<repository.repositoryPath>/docs`

Recommended invariants:

- only directories and `.md` files are part of the notes tree
- roots are always shown even if their `docs/` directory does not exist yet
- writes create missing parent directories lazily
- note paths are always relative to the `docs/` root, never absolute filesystem paths
- note move/copy may cross scopes (project ↔ repository, repository ↔ repository within the same project)
- directory operations are recursive where appropriate, but must reject self/descendant moves

Recommended shared location DTO shape:

```ts
{
  scope: "project" | "repository";
  repositoryId?: string | null;
  path: string; // relative to docs/
}
```

Validation rules:

- reject absolute paths and `..`
- normalize separators to `/`
- require `.md` for note-file operations
- require directory paths to remain inside the chosen `docs/` root

### 2. Add a dedicated backend notes service

Create a focused Rust service such as `src-tauri/src/services/project_notes.rs` rather than folding this into the existing project service.

Recommended responsibilities:

- resolve the concrete root directory for project/repository note scopes
- recursively list directory trees
- read one note file
- create/update a note via atomic write
- delete a note
- copy/move a note across roots
- create/rename/delete/copy/move directories for the UI surface
- expose small path-normalization helpers with direct unit tests

Implementation notes:

- reuse the atomic-write pattern from `src-tauri/src/services/skills.rs`
- sort tree entries deterministically: directories first, then files, both alphabetical
- keep hidden files and non-markdown files out of the note tree
- return friendly metadata the UI can render directly (root label, relative path, kind, child count, updated time if cheap)

### 3. Add shared client + host parity instead of a Tauri-only page

Add a real shared notes service to the Orchestra client contract, plus capability/feature-flag parity across Tauri, remote API, and mock.

Recommended contract additions:

- feature flag: `sharedNotes`
- capability block:

```ts
notes: {
  read: OrchestraCapabilityDescriptor;
  write: OrchestraCapabilityDescriptor;
}
```

- service surface, e.g. `orchestraClient.notes`:
  - `list(projectId)` → returns the full root/tree payload for project + repositories
  - `get(projectId, location)`
  - `update(projectId, location, markdown)`
  - `delete(projectId, location)`
  - `copy(projectId, source, destination)`
  - `move(projectId, source, destination)`
  - UI-only directory mutations for create/rename/delete/copy/move

Touch points:

- `src/lib/orchestraClient/bootstrap.ts`
- `src/lib/orchestraClient/bootstrapFactory.ts`
- `src/lib/orchestraClient/client.ts`
- `src/lib/orchestraClient/serviceBindings.ts`
- `src/lib/orchestraClient/tauriBindings.ts`
- `src/lib/orchestraClient/remoteApiClient.ts`
- `src/lib/orchestraClient/mockBindings.ts`
- `src-tauri/src/models.rs`
- `src-tauri/src/services/remote_api.rs`

Mock guidance:

- mock mode should support notes so browser/e2e coverage can exercise the page
- use `/mock/projects/<slug>/docs` and repository mock roots as the conceptual storage locations
- keep the storage model in the existing mock/localStorage layer rather than special-casing the page as unavailable

### 4. Treat notes as their own permission namespace

Add these permissions:

- `notes.read`
- `notes.write`

Recommended mapping:

| Surface | Permission |
| --- | --- |
| list/get/read-only page access | `notes.read` |
| create/update/delete/copy/move notes | `notes.write` |
| create/rename/delete/copy/move directories | `notes.write` |

Frontend behavior:

- hide the Notes page entirely when `notes.read` is unavailable
- keep the page readable but disable mutating actions when `notes.write` is unavailable
- surface capability-driven copy similar to the existing Skills panel patterns

Touch points:

- `src/lib/access.ts`
- `tests/access.test.ts`
- `src-tauri/src/services/command_authorization.rs`
- any authorization/permission tests that enumerate the catalog

### 5. Add the required Orchestra tools on top of the same service

Required bridge tools:

- `list_notes`
- `get_note`
- `update_note`
- `delete_note`
- `copy_note`
- `move_note`

Recommended semantics:

- `list_notes(projectId)` returns both the project root and repository roots/tree state for that project
- `get_note(...)` returns one note’s markdown plus metadata
- `update_note(...)` is an upsert: create if missing, overwrite if present
- `copy_note(...)` and `move_note(...)` take full source + destination locations so cross-scope operations work naturally

I would keep directory mutations out of the bridge surface for this first pass unless the implementation lane discovers a concrete agent workflow that needs them. The task explicitly requires note tools; directory management still needs to exist in the shared app/client/backend surface for the UI.

Tooling touch points:

- `src-tauri/src/services/command_authorization.rs` — add tool definitions + required permissions
- `src-tauri/src/services/tool_bridge.rs` — add payload parsing/execution
- `extensions/orchestra-tools.ts` — add explicit schemas/examples/help text instead of falling back to generic `inputJson`
- `tests/orchestra-tools-extension.tools.test.ts`
- any bridge/authorization tests that enumerate allowed tools

### 6. Build a self-contained Notes page

Add a new top-level `Notes` page instead of making Notes another Settings tab.

Recommended navigation changes:

- extend `PrimaryPage` with `"notes"`
- insert `Notes` into `NAV_ITEMS` as a normal primary destination
- add a nav icon, route support, and command-palette page item
- update desktop/mobile nav tests that currently hard-code the six-item nav list

Page structure:

- new `src/pages/NotesPage.tsx` container
- reuse `ResizableSidebarLayout`
- left side: expandable tree rooted at:
  1. `Project`
  2. repositories, sorted by name
- right side: empty state or selected note editor/detail

Recommended detail states:

- no project selected / no roots available
- root selected with no note selected yet
- selected note
- create note / create directory modal
- rename/move/copy modal
- delete confirmation modal

Recommended interaction model:

- explicit Save + Revert, not auto-save
- dirty-state confirmation before changing selection or closing a destructive modal target
- after every successful write, refetch the tree and reselect the resulting target instead of trying to hand-maintain a large local tree cache

### 7. Reuse existing markdown primitives for the editor

Do not add a heavy editor dependency in this slice.

Recommended editor shape:

- editable source surface using a lightweight `highlight.js`-backed markdown highlighter (same library family already used in task details/file previews)
- rendered markdown preview using `MarkdownContent`
- desktop can show editor + preview in one detail column; mobile can stack or tab them

This keeps the implementation aligned with the requirement to reuse what task details already use:

- `highlight.js` for syntax highlighting
- `MarkdownContent` for markdown rendering, lists, headings, links, and fenced-code highlighting

If the highlighted editing surface proves too fiddly in the first pass, the fallback should still keep preview/render parity with `MarkdownContent`; do not introduce a third-party editor just to satisfy the initial requirement.

## Suggested API/DTO shape

### Tree/list payload

```ts
{
  projectId: string;
  roots: Array<{
    scope: "project" | "repository";
    repositoryId?: string | null;
    label: string;
    docsExists: boolean;
    children: NoteTreeNode[];
  }>;
}
```

### Note tree node

```ts
{
  kind: "directory" | "note";
  name: string;
  path: string;
  children?: NoteTreeNode[];
}
```

### Note detail

```ts
{
  location: NoteLocation;
  markdown: string;
  exists: boolean;
}
```

These do not need to be the exact final names, but the build lane should keep the transport contracts this simple.

## Regression coverage

### Backend / Rust

- unit tests for path normalization and scope-root resolution
- create/read/update/delete note tests
- cross-scope copy/move tests
- directory rename/copy/move/delete tests
- guardrail tests for path traversal and moving a directory into itself/descendant

### Shared client / transport parity

- bootstrap feature/capability coverage for notes
- tauri binding tests
- remote API client contract tests
- mock binding tests if the notes service is available in mock mode

### Tooling

- tool registration + schema tests in `tests/orchestra-tools-extension.tools.test.ts`
- help output assertions for the new note tools
- permission-filtering/authorization tests for `notes.read` vs `notes.write`

### Frontend

- page-nav regressions (`Notes` appears in desktop/mobile nav and command palette)
- notes tree renders `Project` first and repositories afterward
- create/edit/save/delete note flow
- create/rename/move/copy/delete directory flow
- cross-scope move/copy note flow
- read-only capability state disables mutations cleanly

A dedicated spec such as `tests/e2e/notes.spec.ts` is the cleanest home for the end-to-end workflow; update the existing nav/header tests only for shared chrome expectations.

## Proposed file plan

- `docs/orc-202-project-notes-ui-and-agent-tools-plan.md`
- `src/types.ts`
- `src/App.tsx`
- `src/pages/NotesPage.tsx`
- `src/pages/notes/*` (tree helpers/editor/detail modals if the page needs decomposition)
- `src/components/ResizableSidebarLayout.tsx` (reuse; maybe minor class hooks only)
- `src/components/MarkdownContent.tsx` (reuse; only touch if preview affordances need a small extension)
- `src/lib/access.ts`
- `src/lib/commandPalette.ts`
- `src/lib/orchestraClient/bootstrap.ts`
- `src/lib/orchestraClient/bootstrapFactory.ts`
- `src/lib/orchestraClient/client.ts`
- `src/lib/orchestraClient/serviceBindings.ts`
- `src/lib/orchestraClient/tauriBindings.ts`
- `src/lib/orchestraClient/remoteApiClient.ts`
- `src/lib/orchestraClient/mockBindings.ts`
- `src-tauri/src/models.rs`
- `src-tauri/src/commands/notes.rs` (or equivalent dedicated command module)
- `src-tauri/src/services/project_notes.rs`
- `src-tauri/src/services/command_authorization.rs`
- `src-tauri/src/services/tool_bridge.rs`
- `src-tauri/src/services/remote_api.rs`
- `src-tauri/src/lib.rs`
- `tests/access.test.ts`
- `tests/orchestra-tools-extension.tools.test.ts`
- `tests/e2e/notes.spec.ts`
- nav/header/command-palette regressions that hard-code the primary menu list

## Build-lane guardrails

- Keep the feature rooted in `docs/` only; do not turn this into a general-purpose file browser.
- Keep the first bridge/tool pass note-centric unless a concrete agent need justifies directory tool expansion.
- Prefer full-tree refetch after writes over fragile local tree surgery.
- Reuse existing markdown/highlight primitives before considering new dependencies.
- Keep permission handling capability-driven so desktop, hosted-web, mock, and tools stay aligned.
