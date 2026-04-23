# ORC-55 — session/chat latest-message entry scroll plan

## Goal

Make every normal session/chat entry path open at the newest transcript message with auto-scroll enabled, then lock in that behavior with regression coverage.

## Diagnosed root cause

The bug is coming from the frontend transcript initialization path in `src/App.tsx`, not from virtualization.

### 1. Entry reset is keyed to `viewedSession?.id`, not to actually entering a session/chat surface

Current logic resets follow mode with:

```ts
useEffect(() => {
  setSessionScrollState({ lockedToBottom: true });
}, [viewedSession?.id]);
```

That is too weak for the required behavior:

- it only fires when the resolved session id changes
- it does **not** fire when the operator leaves `sessions`/`chat` and later returns to the **same** session
- `viewedSession` is also not a pure “session surface” signal, because outside `chat` it falls back to `selectedSession`

Impact:

- if the user manually turned auto-scroll off or scrolled away from the bottom, that state can survive a later re-entry to the same session
- returning from `tasks`, `inbox`, `settings`, or another page can reopen the transcript without the required “fresh entry” reset

### 2. The initial “lock to bottom” reset races with the passive scroll-state sync effect

The current session effects run in this order near the bottom of `src/App.tsx`:

1. if `lockedToBottom`, scroll transcript to `scrollHeight`
2. on `viewedSession?.id`, set `lockedToBottom: true`
3. on `activePage` / `displayedEvents.length` / `viewedSession?.id`, recompute `lockedToBottom` from the current DOM position with `isScrolledToBottom(node)`

Because all three are passive `useEffect` hooks, the “sync from DOM” step can observe a reused transcript node before the new entry has been deterministically pinned to the bottom. When that happens, it overwrites the reset and flips `lockedToBottom` back to `false`.

This matches the reported symptoms exactly:

- the transcript opens at the top or stale position
- the auto-scroll toggle starts off
- it is intermittent because it depends on the previous DOM scroll position, timing of record loading, and which navigation path reused the transcript container

### 3. The bug is amplified by reused UI state across session/chat entry paths

The same `sessionScrollState` is shared across the session surfaces, and the same transcript ref/container is reused while:

- opening a session directly from the Sessions list
- opening a linked session from Task detail
- switching between `chat` and `sessions`
- leaving the surface and coming back
- restoring via URL/query state or after a refresh while the selected session is rehydrating

So the failure is not one broken button; it is a missing “fresh transcript entry” initialization contract.

## Recommended implementation plan

## 1. Introduce an explicit session-surface entry key in `src/App.tsx`

Derive a key that represents *entering a transcript surface*, not just “some session id exists.”

Recommended shape:

```ts
const sessionSurfaceKey = activePage === "sessions"
  ? (selectedSession?.id ? `sessions:${selectedSession.id}` : null)
  : activePage === "chat"
    ? (chatSession?.id ? `chat:${chatSession.id}` : null)
    : null;
```

That gives the implementation one stable signal for all required entry cases:

- new session selection within Sessions
- opening an agent chat
- task/session link navigation into Sessions
- leaving the transcript surface and returning to the same session later
- refresh/restore flows once the selected session record is present

## 2. Replace the current entry reset with a synchronous layout-phase reset

Move the entry initialization to a `useLayoutEffect` keyed by `sessionSurfaceKey`.

On each new key:

- force `lockedToBottom = true`
- set `transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight`
- do that **before** the passive “sync from DOM” logic runs

Why `useLayoutEffect` is the right tool here:

- it runs after DOM commit but before paint
- it avoids showing the stale top-of-transcript position first
- it guarantees the later passive effect sees the transcript already pinned at the bottom

This is the smallest reliable fix for the race.

## 3. Keep steady-state follow behavior, but do not let it override entry initialization

Retain the existing steady-state behavior that scrolls to bottom when:

- `displayedEvents` changes
- `lockedToBottom` is still true

But make the DOM-derived lock sync a steady-state concern only.

Implementation options:

- simplest: keep the existing passive sync effect, but rely on the layout-phase entry reset so it now reads the correct bottomed-out position
- if needed, add a tiny “just entered” guard so the first sync pass for a new `sessionSurfaceKey` cannot immediately unlock the transcript

The first option is likely enough and keeps the diff focused.

## 4. Treat re-entry as a fresh auto-scroll default, regardless of prior session-local pause state

Required product rule for this task:

- while the user is currently reading a transcript, manual scroll/toggle should still disable follow mode
- once the user *re-enters* a session/chat surface, follow mode should default back on

So the implementation should intentionally **not** preserve a prior paused state across transcript entry boundaries.

That matches the acceptance criteria and prevents stale off-state reuse.

## 5. Keep the change scoped; no virtualization rewrite is needed

Nothing in the current code points to list virtualization as the primary cause.

The failure can be fixed by making transcript-entry initialization deterministic in the existing DOM-scrolling model. That keeps the implementation lane focused on:

- `src/App.tsx`
- possibly a tiny helper/hook if the scroll logic is easier to read that way
- test updates

## Regression coverage

Add or extend browser e2e coverage in `tests/e2e/sessions.spec.ts` and `tests/e2e/chat.spec.ts`.

### 1. Sessions list entry opens at bottom with auto-scroll on

Seed a long transcript, open it from Sessions, and assert:

- `data-auto-scroll-mode="on"`
- `data-scroll-locked="true"`
- `scrollTop + clientHeight >= scrollHeight - 24`

### 2. Task → session navigation opens at bottom with auto-scroll on

Cover the linked worker-session path and assert the same bottom/follow invariants after clicking the task’s open-session control.

This can live in browser e2e if practical, or desktop e2e if that path is only already covered there.

### 3. Leaving and returning to the same session resets follow mode back on

Regression flow:

1. open a long transcript
2. manually scroll up or toggle auto-scroll off
3. navigate away to another page
4. return to the same session
5. assert the transcript re-enters at bottom and auto-scroll is on again

This is the gap the current `[viewedSession?.id]` reset misses.

### 4. Chat page gets the same entry reset behavior

Repeat the same “open → pause follow → leave → return” assertion for `Chat`, since it shares the same global scroll state and transcript plumbing.

### 5. New incoming messages stay followed immediately after entry

After each entry-path assertion above, append a new transcript event and verify the transcript remains pinned to bottom without any manual recovery step.

### 6. Refresh/restore path

Add a route-driven entry test such as:

- seed a session in storage
- `page.goto('/?page=sessions&selectedSessionId=<id>')`
- assert the transcript initializes at bottom with auto-scroll on

That covers restored UI state / reload behavior explicitly instead of assuming the click path is enough.

## Files likely to change

- `src/App.tsx`
- possibly a small new helper/hook if the entry-reset logic is extracted
- `tests/e2e/sessions.spec.ts`
- `tests/e2e/chat.spec.ts`
- possibly `tests/desktop-e2e/task-detail-nav.test.ts` or `tests/desktop-e2e/chat-nav.test.ts` for route-specific regression coverage

## Validation for the implementation lane

Recommended targeted validation:

- `npm test -- tests/e2e/sessions.spec.ts`
- `npm test -- tests/e2e/chat.spec.ts`
- if desktop coverage is updated, run the narrow desktop spec(s) with the repo’s desktop runner script

Success looks like:

- every session/chat entry path lands at the newest message
- auto-scroll always starts enabled on entry
- new messages remain followed immediately after entry
- returning to the same session after visiting another page no longer reuses a stale off/top state
- restored route state behaves the same as a fresh click navigation
