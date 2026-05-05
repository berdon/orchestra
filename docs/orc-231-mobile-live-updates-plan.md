# ORC-231 — mobile open/reopen live-updates plan

## tl;dr

- Reproduce the failure on a real session surface at mobile width, not just the mock/browser path.
- Fix the session subscribe/recover lifecycle so mobile chat/session entry and re-entry always regain live updates.
- Add Podman desktop regression coverage for mobile-width chat/session open-reopen flows.
- Keep the existing fast browser/mobile viewport tests for UI behavior, but do not treat them as sufficient proof of live-update correctness.

## Executive summary

I audited the current chat/session live-update code paths and the existing regression coverage.

What we already have is helpful but incomplete:

- `tests/e2e/chat.spec.ts` and `tests/e2e/sessions.spec.ts` already verify transcript behavior after open/return, but only in the mock/browser path.
- Those tests do **not** prove real subscription/recovery behavior, and the specific live-update entry/re-entry cases currently covered are desktop-sized, not mobile-sized.
- Podman desktop coverage exists for chat/session recovery behavior (`tests/desktop-e2e/chat-nav.test.ts`, `tests/desktop-e2e/chat-session-recovery.test.ts`, `tests/desktop-e2e/session-refresh-churn.test.ts`), but there is no mobile-width regression that proves live updates survive open/reopen flows.
- The paired mobile-client web-driver harness currently only has pairing smoke coverage (`tests/web-driver-e2e/pairing.spec.ts`), so it also does not protect chat/session live-update lifecycle behavior.

The implementation should therefore start with a real reproduction in the desktop harness at mobile width, then fix the shared session subscription/recovery lifecycle in the main app, and then lock the fix down with Podman-backed desktop coverage.

## Coverage audit

### Existing useful coverage

- Browser mock path:
  - `tests/e2e/chat.spec.ts`
  - `tests/e2e/sessions.spec.ts`
  - `tests/e2e/tasks.spec.ts`
- Real desktop/podman-capable path:
  - `tests/desktop-e2e/chat-nav.test.ts`
  - `tests/desktop-e2e/chat-session-recovery.test.ts`
  - `tests/desktop-e2e/session-refresh-churn.test.ts`

### Gaps that matter for this task

1. No real desktop/mobile-width regression proves that opening or reopening Chat/Sessions still receives live session updates.
2. Existing browser mobile tests prove layout and mock refresh behavior, not real subscribe/unsubscribe/recovery behavior.
3. The paired mobile-client harness has no chat/session live-update lifecycle regression at all.

## Likely implementation targets

Primary inspection targets in the shared app:

- `src/App.tsx`
  - viewed-session subscribe/unsubscribe effect
  - viewed-session record refresh/recovery effects
  - mobile open/reopen entry points (`navigateToSession`, chat open helpers, task-to-session navigation)
- `src/lib/sessionListMerge.ts`
  - preserve/reconcile behavior when refreshed summaries temporarily lag live session state

Secondary target if reproduction lands in the paired mobile client instead of the shared desktop shell:

- `mobile/App.tsx`
  - current WebSocket lifecycle has no explicit foreground/reopen recovery path

## Plan

1. Reproduce the bug in the desktop harness at a phone-sized window (`390x844`-class) using a real live session.
2. Cover at least these flows:
   - mobile Chat open -> live update arrives
   - navigate away/reopen Chat -> live update still arrives
   - mobile Sessions open/select -> live update arrives
   - navigate away/reopen Sessions or reopen via task/session entry -> live update still arrives
3. Fix the shared session lifecycle so surface re-entry does not depend on stale summary state or a lost prior subscription.
4. Add or extend a focused desktop E2E spec that uses `setWindowRect(...)` and runs through the Podman desktop runner.
5. Keep or extend fast browser/mobile viewport tests only where they help protect UI-level open/reopen behavior.

## Validation

Minimum expected validation after implementation:

- targeted browser/mobile viewport regression for any changed UI flow
- targeted desktop regression through the supported Podman runner, likely via:
  - `./scripts/run-desktop-e2e-podman.sh tests/desktop-e2e/<target-spec>.test.ts`
- if the fix spans both chat and sessions in separate specs, run both affected specs through the Podman wrapper

## Expected handoff

Implementation notes should explicitly capture:

- exact reproduction path
- confirmed root cause
- why the chosen lifecycle fix is reliable across mobile open/reopen transitions
- which Podman E2E specs now protect the regression
