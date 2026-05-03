# ORC-224 project repository branch strategy plan

## tl;dr
- Treat `repository.defaultBranch` as the integration branch only.
- Move the long-lived Orchestra-managed checkout off that branch onto a dedicated local workspace branch by default.
- Create task repository worktrees from the integration branch tip, not from the managed checkout's current `HEAD`.
- Migrate the built-in/default-project repo path off the live dev checkout and into the normal managed checkout layout before applying branch normalization there.
- Add backend regression coverage for clone/init/migration/worktree behavior plus one end-to-end proof that `main` stays available for closeout/mainline worktrees.

## Executive summary
Today the backend does not separate “the branch the persistent project checkout lives on” from “the branch task worktrees should start from.” `src-tauri/src/services/projects.rs` clones or initializes the managed checkout and leaves whichever branch git selected checked out, while `src-tauri/src/services/task_runtime.rs` materializes task repo worktrees from that checkout’s `HEAD` via `git worktree add --detach ... HEAD`. In practice that makes the long-lived project checkout occupy `main` by default for many repos, and `defaultBranch` is mostly metadata instead of an enforced runtime invariant.

ORC-224 should split those roles explicitly. Keep `defaultBranch` as the repository’s integration branch (`main` in the common case), park the persistent Orchestra-managed checkout on a dedicated local workspace branch such as `project`, and create task worktrees from the integration branch tip instead of from the workspace checkout branch. That keeps `main` free for merge/rebase/closeout worktrees while preserving a predictable long-lived checkout for normal project operations.

## Current findings
- `src-tauri/src/services/projects.rs:845` (`ensure_managed_repository_checkout`) clones or initializes the managed repo but does not normalize the checked-out branch afterward.
  - remote and local clones inherit whatever branch `git clone` checks out
  - `local_new` repositories explicitly initialize on `defaultBranch`, so the managed checkout starts on `main` in the common case
- `src-tauri/src/services/task_runtime.rs:2038` (`ensure_task_repository_worktree`) always creates detached task worktrees from the managed checkout `HEAD`.
- `src-tauri/src/services/projects.rs:685` (`ensure_default_project`) still seeds the built-in project repository directly from `discover_dev_checkout_root()` instead of creating a managed clone first.
- `repository.defaultBranch` is not currently enforced as an ongoing base-ref rule for task worktrees or for the persistent managed checkout; after creation it behaves mostly as display/config metadata.

## Proposed implementation

### 1. Separate branch roles
- **Integration branch**: `repository.defaultBranch`.
  - This remains the branch task worktrees merge/rebase back into.
  - This remains the branch the UI means by “Default branch.”
- **Managed checkout workspace branch**: a dedicated local branch such as `project`.
  - This is where the long-lived Orchestra-managed checkout lives.
  - It exists specifically so the persistent checkout does not occupy `main`.
- **Task worktree base ref**: the integration branch tip, not the managed checkout `HEAD`.

### 2. Normalize managed checkouts after clone/init
Add a small backend helper that runs after repository materialization and on repair/migration paths:
- ensure the integration branch exists locally at the seeded commit
- create/update the local `project` branch from that same commit
- switch the managed checkout to `project`
- when a remote integration ref exists, wire the workspace branch so update flows can intentionally fast-forward from the integration branch without checking out `main`

This keeps the checkout predictable while leaving `main` available for other worktrees.

### 3. Stop using managed-checkout `HEAD` as the task worktree source
Update task repo worktree materialization so it resolves the integration branch ref explicitly:
- prefer `refs/heads/<defaultBranch>`
- fall back to `refs/remotes/origin/<defaultBranch>` when needed
- create the task worktree detached at that ref

That avoids coupling task workspace creation to whichever branch the persistent checkout happens to be sitting on.

### 4. Migrate the built-in/default project off the live dev checkout
The built-in default project should no longer keep its repository path pointed directly at `discover_dev_checkout_root()`.

Instead:
- seed it through the same managed-checkout path used by normal project repositories
- keep the discovered dev checkout as the repository `sourcePath`
- then apply the same workspace-branch normalization there

This avoids mutating the operator’s live development checkout just to free `main`.

### 5. Safety rules for existing repositories
Migration should be non-destructive and predictable:
- automatically normalize repositories that are clean and still sitting on the integration branch
- avoid silently rewriting repos that are dirty, detached, or already intentionally diverged
- surface a clear repair/error path when normalization cannot be applied safely

## Test and docs plan
- Add Rust coverage around `projects.rs` for:
  - clone/init landing on `project` while `main` remains available
  - legacy/default-project migration into a managed clone
  - dirty/diverged repo guardrails
- Add Rust coverage around task worktree materialization for:
  - task worktrees resolving from `defaultBranch` instead of `HEAD`
- Add/update docs/UI copy so “Default branch” is clearly the merge/mainline branch, not the branch the persistent checkout sits on.
- Add one integration/desktop regression that proves a repo can keep its managed checkout on `project` while another worktree successfully checks out `main` for closeout/mainline work.

## Expected outcome
After implementation, the persistent Orchestra-managed project checkout no longer occupies `main` by default, task worktrees start from the intended integration branch instead of from incidental checkout state, and closeout/mainline work can safely use `main` without colliding with the project repo’s long-lived checkout.