# ORC-295 repo-file rendering unification plan

## tl;dr
- `TaskDetailPage` currently renders the default repo file through `CommentableFileViewer`, but the `Repo files` tab still renders selected files through a plain highlighted `<pre>` with no comment wiring.
- The fix should route both surfaces through the same comment-capable viewer and remove the divergent repo-tab rendering path.
- The only non-obvious part is multi-instance safety: once the repo tab also uses `CommentableFileViewer`, the page can have two viewers mounted at once, so viewer-specific `data-role`s and open-draft event routing must be scoped instead of hard-coded to `default-file-*`.
- Backend file-anchor validation already works for any tracked task file reference, so this is primarily a frontend rendering/test refactor.
- Add regression coverage that comments on at least one non-default tracked repo file in both browser and desktop harnesses.

## Executive summary
The gap is in `src/pages/tasks/TaskDetailPage.tsx`, not in task-comment storage. The default summary card already uses `CommentableFileViewer`, which means it gets inline line comments, selected-text comments, thread popovers, replies, and shared task-comment submission. The `Repo files` tab does not reuse that path: it loads file content separately and renders the selected file through a plain syntax-highlighted `<pre>`, so non-default tracked files never get the anchored comment UI.

The implementation should standardize all task repo-file previews on `CommentableFileViewer` and make that component safe to mount more than once on the same page. That keeps the existing default-file experience intact while giving the repo-tab viewer the same comment affordances, anchor metadata, and submission flow.

## Current-state findings
- `src/pages/tasks/TaskDetailPage.tsx`
  - default repo-file summary card renders `CommentableFileViewer`
  - `Repo files` tab renders selected file content with `highlightCode(...)` into a plain `<pre>`
  - both paths already resolve a `TaskFileReference` plus file content, but only the default path passes comment handlers and `task.comments`
- `src/components/CommentableFileViewer.tsx`
  - already implements the right behavior: line comment buttons, selection comments, anchored thread popovers, replies, edits, deletes, mention links, wrap/minimize controls
  - is still implicitly “default-file-only” because its `data-role`s, perf key, and test helper/event wiring are hard-coded as `default-file-*`
  - registers a global `window.__orchestraOpenFileCommentDraft` helper and document listeners, which becomes ambiguous if more than one viewer is mounted
- `src-tauri/src/services/tasks.rs`
  - `resolve_file_comment_anchor(...)` validates anchors against tracked task file references, not just the default file
  - that means frontend reuse of the tracked-file reference object is sufficient; no backend schema change is required for this task

## Proposed implementation

### 1. Generalize `CommentableFileViewer` for multi-instance use
Add a small instance-scoping layer instead of forking the component:
- add props such as:
  - `viewerId` or `viewerKey`
  - `dataRolePrefix` (keep `default-file` for the existing summary viewer)
- derive viewer-specific `data-role`s from that prefix instead of hard-coding `default-file-*`
- scope open-draft routing so tests/app code can target the intended viewer when multiple viewers exist
  - example: include `viewerId` in the custom-event detail and ignore events for other viewers
  - keep the existing default-viewer helper behavior for backward compatibility where practical
- replace any remaining default-only assumptions inside outside-click handling and perf markers

This keeps one reusable file-comment surface instead of maintaining parallel viewers.

### 2. Replace the repo-tab `<pre>` path with `CommentableFileViewer`
In `src/pages/tasks/TaskDetailPage.tsx`:
- keep the existing repo-file selection UI, metadata card, missing-file state, and add/remove/set-default actions
- replace the selected-file `file-content-viewer__code` `<pre>` block with `CommentableFileViewer`
- pass the same comment-related props used by the default summary viewer:
  - `taskId`
  - `task.tags`
  - `tasks`, `agents`, `roles`
  - `task.comments`
  - `commentDraft.author`
  - `commentDraft.interruptAgent`
  - `onAddComment`, `onUpdateComment`, `onDeleteComment`
  - `handleOpenCommentFileReference`, `onOpenTask`, `onOpenAgent`, `onOpenRole`
- use the selected `TaskFileReference` plus loaded file content as the viewer input
- prefer a shared render helper for the default viewer and repo-tab viewer so future comment-viewer changes do not drift again

Once this lands, any tracked repo file opened from task detail will hit the same comment-capable path as the default file.

### 3. Clean up now-dead divergent code
After the repo-tab swap:
- remove the task-detail-local `highlightCode(...)` path if it is no longer used
- trim any repo-tab-only viewer markup/classes that only existed for the plain `<pre>` implementation
- keep `detectLanguage(...)` if still needed for `CommentableFileViewer`

## Regression coverage
Update coverage to prove the non-default path now comments correctly.

### Browser Playwright
Either extend `tests/e2e/task-default-file-comments.spec.ts` or add a dedicated repo-file-comment spec that:
- seeds at least two tracked files
- keeps one as default
- opens the other from the `Repo files` tab
- verifies the repo-tab viewer shows the same comment affordances
- submits at least one anchored line comment on the non-default file
- asserts the resulting task comment is anchored to the non-default file path/line

### Desktop E2E
Extend `tests/desktop-e2e/task-repo-files-tab.test.ts` or add a new spec that:
- creates at least two tracked files in a real repo/worktree
- opens a non-default tracked file from the repo tab
- submits a line comment (and ideally one reply or selection comment)
- verifies the anchor metadata references the selected non-default file

### Coverage matrix
If new spec files are added, update `tests/ui-coverage-matrix.json` so repo-file comments are represented alongside the existing default-file comment journey.

## Risks / watch-outs
- Two viewers can exist on the page at once (summary default viewer + repo-tab viewer), so unscoped document listeners/helpers will cause flaky comment-popover behavior.
- Reusing the component without distinct `data-role`s will make selectors ambiguous and regress existing tests.
- The change should preserve current repo-tab behaviors: file selection, default badge/actions, missing-file messaging, and `$file` mention navigation back into the repo-files tab.

## Suggested handoff
Implementation should be a frontend-only refactor plus regression coverage update. No database or API contract change is expected unless the implementer decides to formalize the viewer-targeted test helper/event shape.