# ORC-135 — Mobile-friendly chat/session UX and E2E plan

## tl;dr

- Keep the current large-screen chat/session experience intact.
- Fix narrow layouts by making the chat/session detail panel own the viewport instead of stacking existing desktop navigation above it.
- Move chat-agent/session switching and touch-only actions into explicit mobile controls instead of relying on the global sidebar or hover-only affordances.
- Add separate desktop and mobile browser E2E coverage in the existing chat/session specs so the two behaviors are protected independently.

## Executive summary

I audited the current chat/session surfaces in code plus representative browser layouts at **1440×1200**, **1024×900**, and **390×844**.

The current **desktop** behavior is broadly healthy and should be preserved. The current **tablet/mobile** behavior is not:

- On **chat @ 390×844**, the stacked sidebar + page header push the chat panel down to roughly **y=809px**, so the actual conversation surface starts below the fold on first load.
- On **sessions @ 390×844**, the list stacks above the detail pane, pushing the detail pane to roughly **y=1015px** and leaving the transcript at roughly **70px** tall.
- On **sessions @ 1024×900**, the current `max-width: 1100px` fallback also stacks list-above-detail, which again leaves the transcript at roughly **70px** tall.
- Session row dismiss affordances are currently **hover-reveal driven**, which is a poor fit for touch/coarse-pointer devices.

The fix should be an intentional responsive shell, not more breakpoint-only squeezing.

## Current-state audit

### Desktop baseline to preserve

Observed at **1440×1200**:

- Chat uses the available page height well.
- Sessions keeps a clear split between list and detail.
- Transcript and composer both remain comfortably usable.
- Existing browser E2E already protects several desktop chat/session behaviors.

### Biggest responsive failures

1. **Chat agent switching is trapped in the global sidebar on narrow screens**
   - The mobile layout stacks the entire app sidebar above the page content.
   - Chat agent selection stays in that sidebar subnav instead of moving into the page.
   - After entering a chat, switching agents requires returning to the top-level sidebar instead of using a page-local control.

2. **Sessions stacks the list above the detail pane too early**
   - The current `@media (max-width: 1100px)` rule collapses `.session-shell` into one column.
   - At 1024px wide this already compresses the transcript too aggressively.
   - At phone widths the session detail panel is pushed far below the fold.

3. **Narrow layouts spend too much height on chrome before reaching transcript content**
   - Global sidebar
   - sticky page header
   - session header/status row
   - stats strip
   - large composer metadata/actions block

4. **The transcript does not get a meaningful viewport share on narrow screens**
   - Representative layouts showed transcript regions around **70px** high on the narrow stacked variants.
   - That makes transcript reading feel secondary to controls/chrome.

5. **Small-screen actions are not intentionally touch-accessible**
   - Session dismiss relies on hover settle timing.
   - Chat/session switching is not exposed as an obvious mobile action.
   - Composer controls currently wrap opportunistically instead of following a deliberate small-screen layout.

## Recommended implementation plan

## 1) Introduce an intentional responsive shell for chat and sessions

### Chat

On narrow widths, expose a **page-local agent switcher** instead of relying on the sidebar subnav.

Recommended shape:

- keep the current desktop sidebar subnav behavior unchanged
- add a compact **"Agents" / current-agent** trigger inside the chat page/header for narrow widths
- show the available agents in a small sheet/popover/list panel that is local to the chat surface
- selecting an agent should keep the user inside the chat page and close the mobile picker

### Sessions

Do **not** use the current list-above-detail stack as the main narrow-layout strategy.

Recommended shape:

- keep the current split layout for desktop / clearly non-mobile widths
- for narrow widths, make the **detail pane primary** and expose the session list through an explicit **mobile picker/sheet**
- selecting a session should close the picker and return focus to the detail pane

Implementation note:

- The current `1100px` fallback is too aggressive for sessions. Either lower that breakpoint materially or replace the stacked fallback with a dedicated mobile/list-sheet mode.

## 2) Make the detail pane itself mobile-usable

The selected chat/session pane should remain the primary viewport occupant on small screens.

Recommended adjustments:

- use a viewport-aware height strategy (`dvh`-friendly where appropriate) so chat/session pages do not feel like a full desktop page inserted underneath stacked app chrome
- reduce header/stats/composer chrome on narrow widths so the transcript gets real room
- keep the composer actions fully reachable without clipping
- move composer actions into a deliberate narrow-screen layout, e.g.:
  - row 1: session actions + model selector
  - row 2: stop/send buttons
- consider reducing the default narrow-screen composer footprint so transcript height wins by default
- keep transcript controls available, but use a compact arrangement that does not fight for width with the title/status row

Success condition: on a phone-sized viewport, the user can read transcript content and use send/stop/model/session actions without first fighting stacked layout chrome.

## 3) Make small-screen actions explicitly touch-accessible

Recommended changes:

- replace hover-only session dismiss visibility with a touch-safe affordance on narrow/coarse-pointer layouts
- ensure any mobile picker trigger uses clear `data-role` hooks and accessible labels/state
- avoid interaction models that require hover settle timing to reveal important controls

## 4) Preserve desktop UX deliberately

Desktop guardrails:

- keep the current large-screen chat single-pane behavior
- keep the current sessions split-pane behavior
- keep the current desktop transcript/composer height behavior
- do not regress existing desktop affordances while adding mobile controls

Where mobile and desktop must differ, make the code paths and tests explicit rather than relying on accidental CSS wrapping.

## E2E plan

## 1) Extend existing browser specs instead of creating ambiguous shared assertions

Primary files:

- `tests/e2e/chat.spec.ts`
- `tests/e2e/sessions.spec.ts`

Recommended structure:

- keep/add explicit **desktop** assertions in dedicated desktop-focused tests
- add separate **mobile** `describe` blocks using a fixed viewport such as **390×844**
- keep mobile expectations clearly separate from desktop expectations

## 2) Desktop/browser expectations to protect

### Chat desktop

Assert that desktop still:

- opens a selected agent chat without a mobile picker flow
- keeps the chat panel filling the usable page height
- keeps transcript/composer layout healthy
- preserves existing session actions and wrap/auto-scroll controls

### Sessions desktop

Assert that desktop still:

- uses the split list/detail layout
- preserves the current list selection workflow
- preserves transcript/composer sizing expectations
- preserves existing session actions/runtime details behaviors

## 3) New mobile/browser expectations to add

### Chat mobile

Recommended flow:

1. Open Chat on a mobile viewport.
2. Use the **mobile chat-agent picker** (not the global sidebar subnav) to open a chat.
3. Assert the selected chat panel is immediately usable:
   - panel top is inside the viewport
   - transcript is visible
   - composer input is visible
   - send/action controls are reachable
4. Switch to another agent through the same mobile picker and confirm the page stays usable.

### Sessions mobile

Recommended flow:

1. Open Sessions on a mobile viewport.
2. Open the **mobile session picker/list**.
3. Select/open a session.
4. Assert:
   - the detail panel is primary in the viewport
   - transcript content is readable
   - composer input is usable
   - important controls/navigation remain reachable
5. Re-open the mobile session picker and switch sessions again.

Recommended mobile assertions should favor **layout/interaction outcomes**, not superficial CSS-only checks. Good examples:

- element top is within viewport bounds
- transcript height exceeds a practical threshold
- send/action buttons are visible without extra page gymnastics
- selecting an item closes the picker and updates the detail pane

## 4) Hosted-web smokes

If selector changes are required, make the smallest necessary updates to:

- `tests/hosted-web-e2e/chat.spec.ts`
- `tests/hosted-web-e2e/sessions.spec.ts`

But the main responsive regression coverage should live in the regular browser E2E suite where viewport control is deterministic.

## Likely file touch list

- `src/App.tsx`
- `src/pages/AgentChatPage.tsx`
- `src/pages/SessionsPage.tsx`
- `src/components/SessionChatPanel.tsx`
- `src/components/ResizableSidebarLayout.tsx`
- `src/styles.css`
- `tests/e2e/chat.spec.ts`
- `tests/e2e/sessions.spec.ts`
- possibly `tests/hosted-web-e2e/chat.spec.ts`
- possibly `tests/hosted-web-e2e/sessions.spec.ts`

## Guardrails for implementation

- Prefer adding page-local mobile controls over teaching users to scroll back into the global sidebar.
- Prefer one intentional mobile mode over several partially-working stacked breakpoints.
- Keep existing desktop selectors/behaviors stable where possible so regression coverage remains easy to reason about.
- Treat this as both a UX pass and a testing task; the mobile behavior should be explainable and intentionally protected.