# ORC-216 — Mobile chat/session overflow controls plan

## tl;dr
Lift transcript wrap state out of `SessionTranscript`, add a shared mobile overflow trigger beside the existing chat/session picker row, and move auto-scroll + wrap into that menu on mobile while leaving desktop transcript controls in place.

## Executive summary
Both Chat and Sessions already have page-local mobile picker rows, but the auto-scroll and wrap buttons still live inside `SessionTranscript` as floating transcript pills. Because both routes share `SessionChatPanel`, the change should be implemented once in the shared transcript/control layer and then surfaced through each page’s existing mobile picker row. The lowest-risk path is to lift wrap state above `SessionTranscript`, render a menu trigger directly to the right of each mobile picker trigger, and keep desktop behavior unchanged.

## Current implementation notes
- `src/components/SessionChatPanel.tsx`
  - `SessionTranscript` owns `wrapTranscript` state and renders both transcript controls in `.session-transcript-controls`.
  - Auto-scroll already comes from `scrollState.lockedToBottom` plus `onScrollLockChange`, so that state is already available outside the transcript.
- `src/pages/AgentChatPage.tsx`
  - Already renders a page-local mobile picker above the detail panel.
- `src/pages/SessionsPage.tsx`
  - Already renders a page-local mobile picker above the session detail shell.
- `src/styles.css`
  - Mobile picker styling and floating transcript-control styling are separate today; there is no shared “picker + overflow” row.

## Implementation plan
1. **Lift transcript display state**
   - Move `wrapTranscript` state up from `SessionTranscript` into the page layer.
   - Pass `wrapTranscript` + `setWrapTranscript` back into `SessionChatPanel` so the transcript body and the mobile menu share one source of truth.
   - Keep `scrollState.lockedToBottom` / `onScrollLockChange` as the auto-scroll source of truth.
   - `SessionChatPanel` is only used by `AgentChatPage` and `SessionsPage`, so this prop lift stays contained.

2. **Add a shared mobile overflow trigger beside each picker**
   - In `src/pages/AgentChatPage.tsx` and `src/pages/SessionsPage.tsx`, replace the single-control mobile switcher row with a two-control row: picker trigger in `minmax(0, 1fr)` and a fixed-width overflow button to its right.
   - Reuse the existing lightweight dropdown/menu pattern already used by session/task action menus instead of inventing a new popover system.

3. **Move the mobile toggles into that menu**
   - Add menu actions for:
     - auto-scroll on/off
     - wrap/no-wrap
   - Show those actions from the new page-level overflow button for both Chat and Sessions mobile layouts.
   - Keep the existing floating transcript buttons for non-mobile layouts only.
   - Avoid rendering duplicate active controls for the same viewport so `data-role` selectors stay unambiguous.

4. **CSS and accessibility details**
   - Add shared `page-mobile-switcher__row` and overflow-trigger/dropdown styles in `src/styles.css`.
   - Keep the picker label truncation behavior intact and constrain the new trigger to a touch-friendly fixed size.
   - Preserve pressed-state semantics and descriptive labels/tooltips for both toggles.
   - Ensure the overflow menu layers cleanly above the picker sheet/transcript without creating horizontal overflow.

5. **Regression coverage**
   - Update `tests/e2e/chat.spec.ts` mobile coverage to assert the overflow trigger is present beside the picker and can toggle auto-scroll + wrap.
   - Update `tests/e2e/sessions.spec.ts` with the same mobile flow.
   - Keep existing desktop auto-scroll/wrap behavior covered separately so desktop and mobile expectations stay explicit.
   - Add/adjust layout assertions so the picker still truncates long labels and the extra button does not widen the viewport.

## File touch list
- `src/components/SessionChatPanel.tsx`
- `src/pages/AgentChatPage.tsx`
- `src/pages/SessionsPage.tsx`
- `src/styles.css`
- `tests/e2e/chat.spec.ts`
- `tests/e2e/sessions.spec.ts`

## Guardrails
- Match each page’s existing mobile-picker breakpoint instead of introducing a new responsive threshold.
- Keep desktop transcript-control placement unchanged.
- Prefer one shared control model across Chat and Sessions rather than route-specific menu behavior.
- Avoid hidden duplicate control selectors across desktop/mobile variants.
