# ORC-166 — Sessions Mobile UX Plan

## tl;dr
Fix Sessions mobile by reusing the Chat mobile containment model: mobile picker row stays auto-sized, chat panel owns the remaining viewport height, transcript flexes, composer/actions stay inside the visible viewport, and long session labels truncate without widening the page.

## Executive summary
The remaining mismatch is primarily CSS/layout, not data flow. `AgentChatPage` has mobile-only height/flex containment that keeps the picker, transcript, and composer in one viewport; `SessionsPage` uses the same `SessionChatPanel` surface but does not apply the same page-level mobile grid/flex rules. That lets the Sessions picker/detail shell consume the wrong row height and can push composer controls below the fold. The fix should be scoped to mobile breakpoints and selector/dropdown intrinsic sizing so desktop Sessions remains unchanged.

## Current mismatches to audit/fix
- Sessions mobile stack does not mirror Chat's `auto + minmax(0, 1fr)` page layout when the page-local picker is visible.
- Sessions detail column can scroll/size independently instead of constraining the chat panel to the remaining mobile viewport.
- Chat has mobile flex behavior for `[data-surface="page-mobile-detail"]`; Sessions currently only gets the shared padding/action rules, not the full containment behavior.
- Session picker/trigger/sheet need explicit `min-width: 0`, `max-width: 100%`, and overflow containment so long labels cannot expand the viewport.
- Existing Sessions mobile coverage uses a relatively tall viewport; add a shorter/narrower representative viewport and long-label overflow assertions.

## Implementation plan
1. **Layout parity**
   - In `src/styles.css`, add mobile rules for Sessions matching Chat:
     - `.panel-stack--sessions-layout { grid-template-rows: auto minmax(0, 1fr); align-content: stretch; }` when the mobile picker is active.
     - Ensure `.session-shell`, `.session-detail-column`, and `.session-chat-panel[data-surface="page-mobile-detail"]` have `min-height: 0`, `height: 100%`, and no page-level overflow that hides the composer.
     - Prefer generic `session-chat-panel[data-surface="page-mobile-detail"]` mobile flex rules over Chat-only selectors where safe, so Chat and Sessions share behavior.
2. **Keep controls reachable**
   - Make the mobile chat panel a column: stats/header area fixed, transcript `flex: 1 1 auto`, composer `flex: 0 0 auto` with safe-area bottom padding.
   - Keep the composer action grid within the composer width at 320–390px; adjust fixed column widths only inside mobile media queries if needed.
3. **Prevent selector overflow**
   - Harden `.page-mobile-switcher`, trigger, current label, sheet, `.sessions-mobile-picker`, session list rows/links with `min-width: 0`, `max-width: 100%`, `box-sizing: border-box`, and `overflow-x: hidden` where appropriate.
   - Preserve current ellipsis behavior on `.page-mobile-switcher__current` and `.session-list-link__title`; add/keep accessible full labels via existing text/title if implementation needs it.
4. **Regression coverage**
   - Extend `tests/e2e/sessions.spec.ts` mobile coverage using a long session title at `375x667` and ideally `320x568`/`360x640`.
   - Assert:
     - mobile picker is above the chat panel and does not overflow viewport width;
     - `document.documentElement.scrollWidth <= window.innerWidth`;
     - long selected label computes `text-overflow: ellipsis` and trigger/sheet right edge stays within viewport;
     - transcript remains usable and composer/send/model/action controls bottom out within the viewport;
     - desktop layout assertions still pass.
   - Keep/compare the existing `tests/e2e/chat.spec.ts` mobile assertions to ensure Sessions mirrors Chat rather than diverging.
5. **Verification**
   - Run `npm run build`.
   - Run targeted Playwright: `npm run test:e2e -- tests/e2e/sessions.spec.ts tests/e2e/chat.spec.ts`.
   - If time permits, run hosted-web Sessions/Chat smoke specs to catch host-mode regressions.

## Risk controls
- Scope structural changes to mobile breakpoints (`max-width: 900px`/`1100px`) to avoid desktop nav/detail regressions.
- Prefer shared mobile `SessionChatPanel` rules instead of duplicating Sessions-only behavior, but avoid changing desktop panel sizing.
- Avoid changing session selection state/data behavior; this task should be layout and coverage only unless audit discovers a functional picker bug.
