# ORC-241 task comment delete overflow plan

## tl;dr
- Add a per-comment overflow trigger in `TaskDetailPage` immediately to the right of `Reply` for both top-level comments and nested replies.
- Route `Delete` through the existing `TasksPage` delete-impact → confirm → delete flow; do not add a direct destructive path in the row.
- Surface delete availability explicitly in frontend capabilities so the menu can show `Delete` only when it is allowed, or render it disabled with a reason when it is not.
- Strengthen regression coverage around menu rendering, permission gating, confirm/cancel, and post-delete UI refresh.

## Executive summary
The backend/client delete plumbing already exists. `TasksPage` owns the guarded flow by loading `getCommentDeleteImpact(...)`, opening the confirmation modal, then deleting and reloading task data on confirm. The missing piece is the task-comment affordance in `src/pages/tasks/TaskDetailPage.tsx`, which currently renders `Reply` only.

The clean implementation is to add a small reusable comment action menu for both parent comments and nested replies, keep `Reply` visible inline, and place the overflow trigger directly beside it. `Delete` should only open the existing guarded modal path. To satisfy the permission requirement cleanly, the frontend should stop inferring delete availability from runtime failures and instead receive an explicit delete capability/reason.

## Current findings
- `src/pages/tasks/TaskDetailPage.tsx`
  - top-level comments render `Reply`
  - nested replies also render `Reply`
  - there is no task-comment overflow affordance or delete action today
- `src/pages/TasksPage.tsx`
  - `handleDeleteComment()` already fetches delete impact and opens `task-comment-delete-confirm`
  - `handleConfirmDeleteComment()` already performs delete and reloads task list + task detail
- `src/components/CommentableFileViewer.tsx`
  - anchored file comments still use direct edit/delete icon buttons
  - that is adjacent, but the requested task comment surface work is in `TaskDetailPage`
- client capability plumbing is slightly inconsistent today
  - Rust frontend bootstrap models already expose `commentDeleteImpact`
  - TS bootstrap types/factories do not expose that field yet
  - there is no dedicated frontend delete capability for task comments

## Proposed implementation
1. Extract a small comment-actions helper/component used by both top-level and nested task comments.
   - inline `Reply` button
   - overflow trigger to its right
   - menu item(s) rendered from props
2. In `TaskDetailPage`, use that helper for:
   - parent thread comments
   - nested replies
3. Keep the delete UX guarded:
   - menu `Delete` → `onDeleteComment(commentId)`
   - `TasksPage` continues to fetch delete impact first
   - existing confirmation modal remains the only destructive confirmation path
4. Add explicit delete availability to frontend capability data.
   - add a dedicated task-comment delete capability in TS + Rust bootstrap models/factories
   - use the capability to decide whether `Delete` is enabled/visible
   - also wire the existing `commentDeleteImpact` capability through TS so impact fetch gating is accurate
5. Refresh/stale-state handling:
   - after confirm delete, continue reloading tasks + task detail in `TasksPage`
   - in `TaskDetailPage`, clear any local reply/menu state that points at a comment no longer present after reload

## UX decisions
- `Reply` stays visible as the primary inline action.
- The overflow trigger sits immediately to the right of `Reply` on both top-level and nested comments.
- Preferred unavailable state: keep the overflow trigger for layout consistency, but show `Delete` disabled with the capability reason when delete is unavailable.
- Guardrail behavior is the existing impact modal. There are no hard delete blockers in the current backend design; the guarded behavior to preserve is inspect-impact + confirm/cancel.

## Coverage plan
- Update `tests/e2e/task-comment-deletion.spec.ts` to open delete from the overflow menu instead of a direct row button.
- Add coverage that top-level and nested comments both render the overflow trigger beside `Reply`.
- Add a permission-gated coverage case for unavailable delete capability.
- Keep confirm/cancel coverage for the impact modal and ensure deleted comments disappear after refresh.
- If a small comment-actions helper is extracted, add a focused component/unit test for permitted vs disabled menu states.

## Files likely in scope
- `src/pages/tasks/TaskDetailPage.tsx`
- `src/pages/TasksPage.tsx`
- `src/components/TaskActionMenu.tsx` or a new small comment-actions/menu component
- `src/lib/orchestraClient/bootstrap.ts`
- `src/lib/orchestraClient/bootstrapFactory.ts`
- `src/lib/orchestraClient/remoteApiClient.ts`
- `src-tauri/src/models.rs`
- `src-tauri/src/services/remote_api.rs`
- `tests/e2e/task-comment-deletion.spec.ts`
- related client/bootstrap contract tests
