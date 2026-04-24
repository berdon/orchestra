# ORC-137 inbox Archive All plan

## tl;dr

- Add an `Archive all` action beside `Mark all read`, but scope it to the current inbox view in the active project instead of the entire backend inbox.
- Archive only the currently visible, unarchived user messages; preserve existing read/unread state; never touch already archived items.
- Reuse the existing inbox archive backend/client path by passing explicit `deliveryIds` for the current filtered result set.
- Add a lightweight destructive guard, preferably an inline two-step confirm state with an exact message count.
- Update inbox state immediately from the archive response, then run the existing silent refresh path.
- Cover filter semantics, guard behavior, and UI refresh with focused unit plus Playwright regression coverage.

## Executive summary

`InboxPage` already renders a project-scoped mailbox surface, so the safest and least surprising `Archive all` behavior is: archive the visible unarchived messages in the user’s current inbox view. That means the current `All mail` / `Unread` / `Read` filter and the `Show archived` toggle determine which active rows are eligible. This keeps the action predictable, avoids cross-project surprises, and lets the UI reuse the existing `orchestraClient.inbox.archive(...)` path without inventing any new mailbox/archive model.

The most important implementation detail is to **always pass explicit `deliveryIds`**. The backend archive API already supports “archive everything unarchived” when `deliveryIds` is omitted, but that behavior is broader than this UI and would be too risky for a new bulk action. ORC-137 should use the existing backend path in a narrower, UI-scoped way.

## Current-state findings

### 1. The inbox already has the right single-message archive path

`src/pages/InboxPage.tsx`
- Each row already exposes `Archive` and calls `orchestraClient.inbox.archive({ deliveryIds: [deliveryId] })`.
- After archiving, the page triggers `refresh({ silent: true })`.
- The page already hides archived rows by default and shows them only when `Show archived` is enabled.

This means ORC-137 does **not** need a new backend concept. It only needs a bulk UI affordance plus scoped target selection.

### 2. The visible-message filters already define a natural bulk-action scope

`src/pages/InboxPage.tsx`
- `mailFilter` supports `all`, `unread`, and `read`.
- `showArchived` controls whether archived rows remain visible.
- `filteredMessages` already represents the exact message list the user is looking at.

That makes `filteredMessages.filter((message) => !message.archivedAt)` the clearest and safest target set for `Archive all`.

### 3. The backend default is broader than the UI should be

`src-tauri/src/services/messages.rs`
- `archive_user_messages(connection, delivery_ids)` archives every unarchived user message when `delivery_ids` is omitted.
- Already archived rows are ignored.

That generic backend behavior is fine, but it would be too broad for this ticket because `InboxPage` is project-scoped and filter-scoped. ORC-137 should therefore **not** call `archive({})` / `archive({ deliveryIds: undefined })` for the bulk UI.

### 4. There is already a nearby scoping footgun worth avoiding here

`src/pages/InboxPage.tsx`
- `Mark all read` is labeled as affecting visible unread messages.
- Its current handler calls `orchestraClient.inbox.markRead({ deliveryIds: undefined })`, which relies on the backend “all unread” default.

Even if ORC-137 does not change `Mark all read`, it should **not** copy that pattern for `Archive all`. The new bulk archive action should be explicit and UI-scoped from the start.

### 5. Inbox refresh is event-driven, but immediate local reconciliation would make bulk archive feel safer

`src/lib/orchestraData/inbox.ts`
- The hook refreshes when `inbox.change` or `task.change` events arrive.
- Action handlers also call `refresh({ silent: true })` after mutations.

This is correct, but bulk archive will feel better if the UI also patches local message state from the archive response before the follow-up refresh completes.

## Recommended semantics

### 1. Action scope

`Archive all` should apply to the **current project inbox view** and target the **currently visible unarchived messages**.

Concretely:
- `All mail` archives all visible active rows.
- `Unread` archives only visible unread active rows.
- `Read` archives only visible read active rows.
- If `Show archived` is enabled, archived rows may remain visible in the list, but they are excluded from the bulk target set.

This gives the action a simple rule: **archive the active rows I can currently see in this filtered view**.

### 2. Read/unread interaction

Archiving should **not** mutate read state.

Implications:
- a read message stays read after it is archived
- an unread message stays unread after it is archived
- the main unread badge still drops immediately because the badge already counts only unarchived unread messages
- if the user later enables `Show archived`, archived unread rows should still display the `Unread` badge

This matches the existing single-message archive behavior and avoids introducing a second side effect.

### 3. Already archived items

Already archived items should never be reprocessed.

Implications:
- they should not be included in the archive target list
- they should not change timestamps or state
- when `Show archived` is on, the mixed visible list may include archived rows, but `Archive all` should still act only on the unarchived subset

### 4. Empty / no-op states

The action should remain discoverable but not misleading.

Recommended behavior:
- keep the button visible in the header near `Mark all read`
- disable it when there are zero archivable messages in the current view
- use tooltip/help text that explicitly says it archives the visible unarchived messages in the current view

## Recommended UX / safety treatment

### Preferred guard: inline two-step confirmation

Recommended interaction:
1. default state shows `Archive all`
2. first click arms the action and changes the button to a danger-style confirmation state such as `Confirm archive 3`
3. show an adjacent `Cancel` button while armed
4. second click performs the archive

Why this is the best fit here:
- it is discoverable because the action is always visible
- it is safer than a single destructive click
- it avoids introducing a larger modal flow for a compact toolbar action
- it works well even when only a few messages are visible

Recommended reset behavior:
- changing `mailFilter`
- toggling `showArchived`
- receiving a refresh that changes the candidate count
- completing or canceling the action

Any of those should disarm the confirmation state automatically.

## Implementation plan

### 1. Compute the archivable target set from the existing filtered view

In or near `src/pages/InboxPage.tsx`, derive:
- the visible message list
- the archivable subset (`filteredMessages` without `archivedAt`)
- the target `deliveryIds`
- a count for button copy / confirmation text

If the implementation extracts this into a pure helper, it will be much easier to regression-test the scope rules.

### 2. Add bulk-archive UI state to the inbox header

Expected state additions:
- `archiveAllArmed`
- `archiveAllPending`

Recommended placement:
- next to `Mark all read` in the existing header action cluster
- use explicit `data-role` selectors for the default, confirm, and cancel controls

### 3. Reuse the existing archive path with explicit IDs

Call:

```ts
await orchestraClient.inbox.archive({ deliveryIds: archivableDeliveryIds });
```

Do **not** call the archive API without IDs from the UI.

This preserves the backend contract while keeping ORC-137 safely scoped to the page’s current visible result set.

### 4. Update UI state immediately, then reconcile with refresh

Recommended pattern:
- use the returned updated `MailboxMessage[]` payload to patch local inbox state immediately
- then call `refresh({ silent: true })` as the follow-up source-of-truth reconciliation

Practical options:
- extend `useInboxData` with a small `applyMessageUpdates(updatedMessages)` helper, or
- manage a local page-level reconcile step before refreshing

If the team touches this area anyway, it would be reasonable to reuse the same local reconcile pattern for the existing single-message archive action too, so bulk and single archive feel identical.

### 5. Keep the implementation frontend-scoped unless a small helper extraction improves clarity

The backend already supports bulk archive. ORC-137 should stay focused on:
- `src/pages/InboxPage.tsx`
- inbox local state/reconciliation if needed
- regression coverage

A backend change should only be necessary if the assignee chooses to add more service-level tests around current archive semantics.

## Regression coverage plan

### A. Pure helper coverage for target selection

If target computation is extracted into a helper, add a focused unit test that covers:
- all visible messages unread and unarchived
- mixed read/unread messages under `all`
- `Unread` filter targeting only unread active rows
- `Read` filter targeting only read active rows
- `Show archived` leaving already archived rows out of the target set

This is the easiest place to protect the exact semantics without UI noise.

### B. Playwright coverage for the main inbox UX

Update `tests/e2e/inbox.spec.ts` to cover:
- `Archive all` appearing in the inbox header
- disabled state when no visible unarchived rows are available
- confirmation arming / cancel behavior
- archiving only the intended rows in the current filtered view
- unread badge and message list updating immediately after confirmation
- already archived rows remaining untouched

Recommended scenarios:
1. **all unread**: confirm that `Archive all` archives every visible unread active row
2. **mixed read/unread in `all`**: confirm that both visible active types archive together
3. **filtered view**: confirm that `Unread` or `Read` only archives the visible matching subset
4. **archived rows present**: confirm that pre-archived rows are not modified or double-counted

### C. Hosted-web parity coverage

Update `tests/hosted-web-e2e/inbox.spec.ts` so hosted-web / Remote API coverage also exercises the new bulk action. Even a smaller scenario is valuable here because it proves the UI is still using the same archive backend path over the remote client.

## Files expected to change

Primary implementation:
- `src/pages/InboxPage.tsx`
- `src/lib/orchestraData/inbox.ts` (if local reconcile support is added)

Potential helper extraction:
- a small inbox helper file near the page or under `src/lib/`

Regression coverage:
- `tests/e2e/inbox.spec.ts`
- `tests/hosted-web-e2e/inbox.spec.ts`
- a new focused unit test file if helper extraction happens

## Validation plan

Run focused checks for the affected surface:

```bash
npm run build
npm run test -- <new-inbox-helper-test-if-added>
npm run test:e2e -- tests/e2e/inbox.spec.ts tests/hosted-web-e2e/inbox.spec.ts
```

If the assignee keeps the target-selection logic inline and skips the helper test, the e2e coverage becomes the minimum required validation.

## Recommended implementation note for the assignee

The highest-risk mistake in this ticket is reusing the backend’s implicit “archive everything unarchived” default from the UI. Reuse the **path**, not the **broadest call shape**. The UI should decide the candidate set first, then pass those explicit IDs into the existing archive method.