# ORC-259 PR tab plan

## tl;dr
- Add a new `PR` task-detail tab backed by a lazy shared client call (`tasks.getPullRequest(taskId)`) instead of bloating the base task-detail payload.
- Build PR data from the task’s associated repositories, preferring the task worktree when it exists and comparing `merge-base(HEAD, defaultBranch)` to the current workspace snapshot.
- Because task worktrees are created as detached `HEAD` worktrees, do **not** key the review model off the current branch name.
- Render one combined diff per file against the chosen base, but label each file `Committed`, `Uncommitted`, or `Mixed` using separate `base..HEAD` and `HEAD..workspace` classification passes.
- Reuse task comments/threads/receipts for PR review comments by extending `TaskComment` with optional diff-anchor metadata instead of inventing a parallel review-comment store.

## Executive summary
`src/pages/tasks/TaskDetailPage.tsx` currently has no PR-oriented review surface: the only repo-centric tab is `Repo files`, which is a tracked-file browser, and the default file preview uses `CommentableFileViewer` for plain file comments rather than diff comments. The shared task client also only exposes file references/content today, so there is no first-class way to ask the backend for a task-scoped cross-repo changeset.

The lowest-risk architecture is to keep the PR tab as a **live derived read model** rather than a persisted PR object. A dedicated backend read path should inspect the task-associated repos, compute a task-scoped diff view, and return structured repo/file metadata plus unified patch text. The UI can load that data only when the `PR` tab is active, render a real diff viewer, and reuse the existing task-comment plumbing for inline review comments.

## Current-state findings
- `TaskDetailPage.tsx` defines these lower panels today: `runtime`, `hierarchy`, `dependencies`, `repo-files`, `todos`, `attachments`, `timeline`, `history`. There is no PR tab.
- The current repo surface is file-reference driven:
  - tracked files live under `task.fileReferences`
  - file content is loaded via `useTaskFileContent()`
  - inline file comments are rendered with `CommentableFileViewer`
- Task comments already carry useful anchor metadata in both TS and Rust:
  - `repositoryId`, `relativePath`, `lineStart`, `lineEnd`, `columnStart`, `columnEnd`, `selectedText`
  - `anchorCommitHash`, `anchorHasUncommittedChanges`
- `src-tauri/src/services/tasks.rs::resolve_comment_anchor(...)` currently validates file anchors against **tracked task file references**. PR comments cannot rely on that path because PR files are discovered from git state, not from manually tracked file references.
- `src-tauri/src/services/task_file_references.rs` already prefers the task worktree over the managed repo when resolving files. The PR tab should use the same task-worktree-first precedence.
- `src-tauri/src/services/task_runtime.rs` materializes repo worktrees with `git worktree add --detach ... HEAD`, so task worktrees are normally **detached HEADs**. That means “current branch vs default branch” is the wrong primary semantic; the correct primitive is `HEAD` plus the repo’s configured default branch merge-base.
- `useTaskAutoRefresh(...)` refreshes task detail on task events, focus, and a 60s interval, but raw git workspace edits do not emit task-change events. PR data therefore needs its own active-tab refresh behavior.

## Proposed diff-source semantics

### 1. Which repository checkout is reviewed
For each repo associated with the task:
- prefer `taskWorktreePath` when it exists and is a valid git worktree
- otherwise fall back to the managed repository path
- if neither path is usable, show the repo in the PR tab as `Unavailable` with a reason

This keeps the review source aligned with task-scoped execution when a task worktree exists, while still giving pre-runtime tasks a meaningful fallback.

### 2. Which refs are compared
Per reviewed repo:
- `headCommit` = `HEAD` in the selected review root, when it exists
- `defaultBranch` = repository-configured default branch
- try default-branch refs in this order:
  1. `refs/heads/<defaultBranch>`
  2. `refs/remotes/origin/<defaultBranch>`
  3. `<defaultBranch>`
- if `HEAD` and one of those refs produce a merge-base, use that merge-base as `baseCommit`
- if the repo has no commits yet, use the empty tree as the base
- if `HEAD` exists but no default-branch ref can be resolved **or** none of the candidates yield a usable merge-base, fall back to `baseCommit = HEAD` and explicitly mark the repo as `worktree-only` so only uncommitted changes are reviewable instead of failing the whole PR tab

This makes detached worktrees safe and keeps the semantics stable even when no feature branch name exists.

### 3. What counts as the task PR changeset
The PR tab should show the combined diff from `baseCommit` to the **current workspace snapshot** of each associated repo.

That means:
- committed task changes ahead of the default-branch merge-base are included
- staged and unstaged changes on top of `HEAD` are also included
- untracked files are treated as `added` + `uncommitted`
- deleted tracked files are treated as `deleted`
- rename detection should use normal git rename heuristics when available (`--find-renames`), but a delete+add fallback is acceptable

Do **not** persist this changeset in the database. It is a live git-derived read model.

### 4. How committed vs uncommitted changes are represented
Use two classification passes:
- `committed` file set = `baseCommit..HEAD`
- `uncommitted` file set = `HEAD..workspace`

Render one combined patch against `baseCommit`, but label each file as:
- `Committed` — only in the committed set
- `Uncommitted` — only in the worktree set
- `Mixed` — touched in both

Also surface repo-level counts for committed/uncommitted/mixed files. Do **not** attempt per-line provenance coloring in v1.

### 5. Multi-repo grouping and empty repos
The PR tab should preserve repo boundaries explicitly:
- overview summary at the top
- per-repo sections beneath it
- changed repos first, then clean repos, then unavailable repos
- stable ordering within each bucket should follow task-repository association order

Repo behavior:
- clean repo: show the repo card with a `No changes` badge and no file list
- unavailable repo: show the repo card with an `Unavailable` badge and the resolution error
- changed repo: show file list + diff viewer under that repo section

## Proposed implementation

### 1. Add a dedicated shared read path
Extend the shared contract with a lazy PR read model instead of stuffing git diffs into `TaskDetail`:

```ts
interface TaskPullRequestDetail {
  taskId: string;
  generatedAt: string;
  repositories: TaskPullRequestRepository[];
}
```

Add:
- `featureFlags.taskPullRequests`
- `capabilities.tasks.pullRequests`
- `tasks.getPullRequest(taskId)` to:
  - `src/lib/orchestraClient/client.ts`
  - `src/lib/orchestraClient/tauriBindings.ts`
  - `src/lib/orchestraClient/remoteApiClient.ts`
  - `src/lib/orchestraClient/mockBindings.ts`

Recommended reason: PR data is expensive/live and should be fetched only when the tab is opened or refreshed.

### 2. Backend: new task pull-request service
Add a new Rust service, e.g. `src-tauri/src/services/task_pull_requests.rs`, responsible for:
- loading task-associated repos + default branch metadata
- resolving the review root per repo
- computing summary counts and file classifications
- generating normalized unified patch text per file
- returning repo/file metadata suitable for a cross-repo review UI

Recommended file payload shape:

```ts
interface TaskPullRequestFile {
  repositoryId: string;
  repositoryName: string;
  repositorySlug: string;
  changeType: "added" | "modified" | "deleted" | "renamed";
  oldPath?: string | null;
  newPath?: string | null;
  displayPath: string;
  origin: "committed" | "uncommitted" | "mixed";
  additions: number;
  deletions: number;
  isBinary: boolean;
  patch?: string | null;
}
```

Keep git execution/parsing on the backend; keep final hunk rendering in the shared UI. Using unified patch text here is fine as long as headers/paths are normalized to repo-relative paths.

### 3. UI: add a real PR tab, not another file viewer mode
In `TaskDetailPage.tsx`:
- add `"pr"` to `TaskDetailTab`, `TAB_OPTIONS`, and `NAV_OPTIONS`
- label it exactly `PR`
- mount a dedicated component such as `TaskPullRequestTab`

Recommended UI split:
- `TaskPullRequestTab.tsx`
  - owns lazy loading / refresh state for `tasks.getPullRequest(...)`
  - groups repos and selects the active diff target
- `TaskDiffViewer.tsx`
  - parses unified patch text
  - renders hunk headers plus old/new line gutters
  - supports added/modified/deleted files and inline review comment affordances

Do **not** overload `CommentableFileViewer` into a diff viewer. Reuse its comment-thread ideas, but keep diff rendering separate.

### 4. Comment model: extend task comments instead of adding a new review-comment system
Reuse task comments so PR comments automatically inherit:
- task ownership
- unread receipts
- replies/threading
- timeline visibility
- existing permissions and transports

Add an optional diff anchor to `TaskComment` / `TaskCommentInput`, for example:

```ts
interface TaskDiffCommentAnchor {
  kind: "task_pr";
  repositoryId: string;
  oldPath?: string | null;
  newPath?: string | null;
  side: "old" | "new";
  oldLineStart?: number | null;
  oldLineEnd?: number | null;
  newLineStart?: number | null;
  newLineEnd?: number | null;
  baseCommitHash?: string | null;
  headCommitHash?: string | null;
}
```

Recommended storage model:
- add an optional `diff_anchor_json` column on `task_comments`
- deserialize it into the shared `TaskComment` model
- keep the existing top-level fields populated too:
  - `repositoryId`
  - `relativePath = newPath ?? oldPath`
  - `lineStart` / `lineEnd` = selected side range for generic badges
  - `anchorCommitHash = headCommitHash`
  - `anchorHasUncommittedChanges` = repo dirty state at comment time

This keeps the current comment list and badge rendering useful while letting PR-specific UI read richer location data.

Validation changes in `tasks.rs`:
- existing file comments keep the current tracked-file-reference validation path
- PR comments should validate that:
  - the repo belongs to the task
  - the path exists in the current PR payload for that repo
  - the side/line ranges are structurally valid
- replies remain normal task replies; they do not need their own diff anchor

### 5. Sync and outdated-comment behavior
Because the PR tab is a live read model:
- load PR data when the tab becomes active
- add an explicit Refresh action in the tab
- refresh on window focus
- poll while the PR tab is active (30s is enough)
- refresh immediately after creating a PR comment

Outdated comments:
- if a stored diff anchor no longer maps to a currently rendered line, keep the comment visible but mark it `Outdated`
- show outdated comments under the matching file/repo section rather than dropping them silently

## Regression coverage

### Rust / backend
- new service tests for:
  - detached-HEAD worktree semantics using default-branch merge-base
  - task-worktree-first root selection
  - default-branch-ref fallback to `worktree-only`
  - clean repo / unavailable repo / untracked file behavior
  - committed vs uncommitted vs mixed classification
- task comment tests for:
  - PR diff-anchor persistence and round-trip loading
  - PR comment validation against task-associated repos/diff files
  - migration coverage for the new comment column(s)

### Shared frontend / Vitest
- tab visibility/rendering for `PR`
- repo grouping + clean/unavailable repo states
- diff viewer hunk rendering for added/modified/deleted files
- PR comment filtering/badge labeling, including outdated comments

### End-to-end
- add a focused desktop e2e flow (recommended: new `tests/desktop-e2e/task-pr-tab.test.ts`) that:
  - creates a task with multiple associated repos
  - produces committed and uncommitted changes in the task worktree
  - verifies cross-repo aggregation and origin badges
  - creates a review comment from a diff line and reloads to confirm persistence
- add shared task-detail/browser coverage for the new tab shell and comment rendering path using mock PR payloads where helpful

## Files expected to change
- `src/pages/tasks/TaskDetailPage.tsx`
- `src/pages/tasks/TaskPullRequestTab.tsx` (new)
- `src/components/TaskDiffViewer.tsx` (new)
- `src/components/TaskCommentMessage.tsx` and/or task-detail comment badge helpers for diff-aware anchor labels
- `src/types.ts`
- `src/lib/orchestraClient/bootstrap.ts`
- `src/lib/orchestraClient/bootstrapFactory.ts`
- `src/lib/orchestraClient/client.ts`
- `src/lib/orchestraClient/tauriBindings.ts`
- `src/lib/orchestraClient/remoteApiClient.ts`
- `src/lib/orchestraClient/mockBindings.ts`
- `src-tauri/src/models.rs`
- `src-tauri/src/services/database.rs`
- `src-tauri/src/services/tasks.rs`
- `src-tauri/src/services/task_pull_requests.rs` (new)
- `src-tauri/src/commands/tasks.rs`
- `src-tauri/src/services/remote_api.rs`
- task-detail/unit/e2e coverage files for the new PR-tab flows

## Final implementation notes
- The shipped PR tab is still a live derived read model. It does **not** persist a PR object; it recomputes from the task-associated repositories whenever the tab is opened/refreshed.
- Review roots are resolved per repo with task-worktree-first precedence, then managed-repository fallback. If neither path is a valid checkout, the repo is surfaced as `Unavailable` in the PR tab.
- Base semantics are implemented as:
  - if `HEAD` exists, Orchestra tries `refs/heads/<defaultBranch>`, `refs/remotes/origin/<defaultBranch>`, then `<defaultBranch>` and uses the first candidate that yields a merge-base with `HEAD`
  - if `HEAD` exists but no default-branch candidate yields a usable merge-base: base falls back to `HEAD` and the repo is flagged `worktree-only`
  - if the repo has no commits yet: the empty tree is used as the base
- The rendered diff is `base -> current workspace` per repo, so committed task changes and tracked workspace edits are shown together. Untracked files are injected as synthetic added files.
- File origin badges come from separate classification passes:
  - `Committed` = present in `base..HEAD`
  - `Uncommitted` = present in `HEAD..workspace` or untracked
  - `Mixed` = present in both sets
- Multi-repo grouping remains explicit in the UI: changed repos first, then clean repos, then unavailable repos, with stable task-association ordering inside each bucket.
- PR review comments are stored in `task_comments` with a new optional `diff_anchor_json` payload that captures repo, old/new paths, side, old/new line ranges, and optional base/head commit hashes.
- The existing top-level task-comment anchor fields are still populated for PR comments (`repositoryId`, `relativePath`, `lineStart`, `lineEnd`, `anchorCommitHash`, `anchorHasUncommittedChanges`) so timeline/discussion views can still show a useful generic anchor label.
- PR comment validation now checks the live PR payload for the task instead of tracked-file references, which keeps diff comments tied to task-associated repo changes even when the file is not a manually tracked task file.
- Current automated coverage added in this implementation:
  - Rust task-pull-request service tests for task-worktree precedence, merge-base semantics, clean repos, and unavailable repos
  - Rust task-comment persistence/validation coverage for PR diff-anchor comments
  - shared frontend tests for diff parsing/rendering and PR review-comment visibility/outdated-comment rendering
