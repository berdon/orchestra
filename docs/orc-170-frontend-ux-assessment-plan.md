# ORC-170 frontend UX assessment and improvement plan

## tl;dr

- Orchestra already has a strong workbench foundation: stable project context, clear top-level areas, task/session/workforce surfaces, split panes, and theme tokens.
- The main UX debt is not missing features; it is **too much chrome, too many equally loud panels, and too much explanatory text before the user reaches the next action**.
- Desktop should become a denser, attention-first operations workbench with clearer rows, toolbars, and one obvious primary action per state.
- Mobile should stop mirroring desktop boards/forms. It should prioritize review/intervention, task status, and session messaging with labeled navigation, compact controls, and no overlapping floating actions.
- Recommended sequence: quick polish/fix pass first, then task/session IA improvements, then a component/design-system consolidation.

## Executive summary

Orchestra is directionally aligned with its product north star: it feels like software for supervising agent work rather than a generic chat app. The current frontend makes core concepts visible — tasks, sessions, agents/roles, inbox, settings — and recent work has improved theming, mobile navigation, task detail sections, and session containment.

The next UX gains should come from simplification. The interface often explains itself with persistent helper text, stacked cards, repeated eyebrow labels, and several equal-weight actions. This slows scanning and makes the actual operational question harder to answer: **what needs my attention, and what should I do next?**

The plan below focuses on practical improvements that can be turned into implementation tickets. It uses the referenced UI/UX Pro Max skill as a checklist source, especially around accessibility, touch targets, mobile-first layout, navigation labels, focus states, progressive disclosure, and avoiding hidden/hover-only interactions. The skill's generated design-system suggestion for Orchestra pointed toward an operations/dashboard pattern with neutral/dark surfaces and strong status colors; this plan adapts that to Orchestra's own workbench direction and avoids motion-heavy or decorative recommendations that would add noise.

## Assessment approach

Reviewed:
- Repository UX docs: `docs/north-star.md`, `docs/ux-north-star.md`, `docs/ux-design-guidelines.md`.
- Recent UX plans: mobile navigation, mobile sessions, task detail mobile section select, minimized nav, copy polish.
- Key frontend code paths:
  - `src/App.tsx`
  - `src/styles.css`
  - `src/pages/tasks/*`
  - `src/pages/SessionsPage.tsx`
  - `src/components/SessionChatPanel.tsx`
  - `src/pages/InboxPage.tsx`
  - `src/agents/AgentsPage.tsx`
  - `src/settings/*`
  - `mobile/App.tsx`
- Local mock screenshots at desktop (`1440x1000`) and phone (`390x844`) for Tasks, Task detail, Sessions, Inbox, Agents, Settings, and mobile navigation.
- UI/UX Pro Max checklist/search items most relevant here:
  - `ux` search for enterprise/mobile/dashboard guidance: visible focus, accessible names, keyboard navigation, 44px+ touch targets, and 8px+ spacing between adjacent mobile controls
  - `product`/`style` search for operations dashboards: data-dense but readable workbench patterns, clear hierarchy, functional status colors, and compact scan rows
  - mobile-first responsive behavior with no horizontal overflow
  - nav items should use icon + text labels on mobile
  - one primary action per screen/state
  - progressive disclosure for advanced forms/debug details
  - concise empty states and helper text
  - no structural emoji/glyph-only icons without labels

## What is working

- **Workbench shell:** The desktop left rail and project switcher provide stable orientation.
- **Major IA is understandable:** Tasks, Inbox, Agents, Chat, Sessions, Settings are the right high-level areas.
- **Task and session concepts are visible:** Lane state, comments, todos, file references, sessions, and worker ownership are available without leaving the app.
- **Theming foundation exists:** CSS variables and multiple themes already support a more systematic visual pass.
- **Mobile groundwork exists:** A top bar, navigation sheet, mobile session picker, and task detail section select are already in place.
- **Interaction safety is improving:** Destructive actions, busy states, unread badges, and read-only session states are represented.

## Desktop UX assessment

### 1. Scan speed is lower than it should be

The app shows useful operational data, but the first visible layer often contains filters, panels, labels, and helper copy instead of a sharp attention summary.

Examples:
- Tasks opens with filter buttons, a filter disclosure card, then a `Needs attention` area and workflow board. The same task can appear in attention and in its lane, creating duplication before the user knows the priority.
- Inbox separates mailbox messages and workflow attention, but the page still reads as two generic cards rather than a single attention queue.
- Agents shows role lists and forms before making queue pressure or active work the dominant signal.

User impact:
- Users must parse the whole page to decide what matters.
- Attention states compete with navigation/filter chrome.

### 2. Visual hierarchy is too uniform

Many surfaces use the same pattern: rounded card, uppercase eyebrow, section heading, muted copy, controls. This creates consistency, but it also makes high-value work states and low-frequency settings look equally important.

Examples:
- Task detail description, default repo file, comments, history, dependencies, and empty states all look like similar cards.
- Settings pages use the same card and header rhythm for basic fields, advanced diagnostics, source-control previews, and repository forms.
- Status badges are helpful but frequent enough that they sometimes become decoration rather than signal.

User impact:
- Important state does not stand out quickly.
- The UI feels heavier and more text-heavy than the underlying workflows require.

### 3. Action priority is often ambiguous

Many pages expose several equal-weight buttons, or place the primary action in a floating/remote location.

Examples:
- Task detail can show `Re-lane`, `Dispatch`, `Edit Task`, `Close`, `Delete`, and tab navigation at once.
- Session detail shows create/new, model, stop, send, wrap, auto-scroll, copy, expand, runtime details, and stats controls in close proximity.
- Agents role detail presents dispatch/reset/enqueue form at the same level as operational metrics.

User impact:
- The obvious next action is not always obvious.
- Risky/advanced actions visually compete with the safest default action.

### 4. Copy and labels over-explain

The UI frequently uses sentence-long helper text, uppercase metadata styling, or repeated labels where structure could do the work.

Examples:
- Task detail: `Overview` + `Current context` + `Description` + `Task description` repeats the hierarchy.
- Empty-state copy such as default repo-file guidance is useful but too prominent and wordy.
- Settings panels often include permanent explanatory paragraphs for concepts users only need occasionally.

User impact:
- Dense pages feel denser.
- Users skim past copy that may contain important exceptions.

### 5. Fixed chrome can obscure content

Desktop task detail has a fixed bottom section dock that can overlap controls/content near the bottom of the viewport. Mobile floating CTAs can similarly sit on top of task cards or session composer content.

User impact:
- Users may miss or struggle to tap controls under fixed elements.
- The app feels less reliable on shorter screens.

## Mobile UX assessment

### 1. Mobile navigation is functional but not discoverable enough

The mobile top bar and navigation sheet are a strong improvement over a squeezed sidebar. However, the open navigation sheet currently presents the primary destinations as icon-only tiles. The UI/UX Pro Max checklist explicitly warns against icon-only navigation for discoverability.

User impact:
- New users must learn icons by trial and error.
- Badges appear without enough text context.

Recommended divergence from desktop:
- Desktop can use a compact icon rail when collapsed.
- Mobile navigation should always show text labels, because it is a temporary wayfinding surface, not a persistent expert rail.

### 2. Too much control chrome appears above mobile content

On Tasks mobile, the top area includes project/top bar, filter select, card/table toggle, filter disclosure, then content. This consumes a large portion of the first viewport.

User impact:
- The actual work starts too far down.
- Controls feel more prominent than the task queue.

### 3. Desktop board metaphors leak into mobile

Workflow lanes and wide boards work on desktop, but on mobile they become long vertical/horizontal compositions with partial columns and overlapping CTAs.

User impact:
- Mobile users get a shrunken desktop command center instead of a focused review/intervention flow.
- Horizontal overflow risk remains for boards/tables/settings.

Recommended divergence from desktop:
- Desktop Tasks can keep board/table modes.
- Mobile Tasks should default to an attention-first list with lane/status chips and drill-in detail.

### 4. Floating CTAs collide with content

Observed cases:
- Mobile Tasks `New task` FAB overlaps workflow card content.
- Mobile Sessions `Create session` FAB overlaps the composer area.
- Mobile task detail bottom section selector/fixed chrome can overlap summary content in full-page/short-height scenarios.

User impact:
- Reduced trust and higher mis-tap risk.
- Important controls feel bolted on rather than integrated.

### 5. Mobile task detail is still text-heavy

Task detail mobile correctly switches from a tab row to a select, but the screen still begins with large title/meta, multiple action buttons, repeated labels, cards, and explanatory copy.

User impact:
- The task's current workflow state and next action are less prominent than the page structure.
- The mobile detail page feels like a long document, not an intervention surface.

### 6. Native mobile client is useful but visually/product-wise separate

`mobile/App.tsx` is a compact paired-client implementation. It has safe areas, touch controls, task approvals, inbox, chat, sessions, and settings, but it uses a separate light visual language and simpler tab model.

User impact:
- It works as an operator utility, but does not yet feel like the same product system.
- It exposes broad surfaces rather than a sharply mobile-optimized attention/review experience.

## Prioritized improvement plan

### Quick wins

#### Q1. Add text labels to mobile navigation sheet

Scope:
- `src/App.tsx`
- `src/styles.css`
- mobile navigation tests

Change:
- Replace the icon-only mobile nav row with a labeled list or 2-column grid: icon, label, badge.
- The labels are already rendered in `src/App.tsx`; make the mobile sheet override the narrow-screen `.nav-item__label` rule in `src/styles.css` so labels are visible inside `.mobile-navigation__primary`.
- Keep active state visible.
- Ensure each item has an accessible name and at least 44px height.

Rationale:
- Mobile navigation should be discoverable, not expert-only.

Expected benefit:
- Faster orientation for new and returning users.
- Better accessibility and reduced wrong taps.

#### Q2. Fix fixed/floating action overlap

Scope:
- Task detail dock/FAB styles.
- Sessions mobile composer/FAB layout.
- Tasks mobile FAB positioning.

Change:
- Ensure bottom padding always exceeds fixed dock height.
- Convert mobile FABs into contextual sticky action rows when they would overlap content.
- Hide or relocate `Create session` when the composer is visible.

Rationale:
- Primary controls must never cover other controls or content.

Expected benefit:
- More trustworthy mobile and short-viewport behavior.

#### Q3. Run a focused copy/hierarchy tightening pass

Scope:
- `src/pages/tasks/TaskDetailPage.tsx`
- high-noise Settings panels
- `src/styles.css`

Change:
- Keep `.muted-copy` for short metadata; use sentence-case supporting text for longer helper copy.
- Remove repeated labels such as `Overview` + `Current context` + `Task description`.
- Shorten empty states to one sentence plus one action.

Rationale:
- Less text makes the actual operational state easier to scan.

Expected benefit:
- Pages feel calmer without removing useful information.

#### Q4. Simplify mobile Tasks controls above the fold

Scope:
- `TasksOverviewPage.tsx`
- task overview CSS

Change:
- Collapse filter/sort/view controls into one `View options` control on mobile.
- Default mobile to an attention-first task list.
- De-emphasize or hide board/table mode toggles unless explicitly opened.

Rationale:
- Mobile users need content and next actions first, configuration second.

Expected benefit:
- More work visible in the first viewport.

#### Q5. Make the primary next action explicit on task detail

Scope:
- `TaskDetailPage.tsx`
- `taskDetailHeaderActions.ts`

Change:
- Show one dominant action based on state: `Dispatch`, `Approve`, `Resume`, `Send back`, or `Comment`.
- Move secondary/risky actions into `Actions`.
- Keep destructive actions separated.

Rationale:
- Orchestra should answer “what do I do next?” immediately.

Expected benefit:
- Lower decision friction and safer workflows.

### Medium-effort improvements

#### M1. Redesign Tasks overview as an attention-first command center

Scope:
- `TasksOverviewPage.tsx`
- `TaskCompactCard.tsx`
- `WorkflowTaskBoardSection.tsx`

Change:
- Add a compact summary strip: needs attention, active, blocked, review, queued.
- Make `Needs attention` the first-class queue.
- Desktop: use table/list rows as the default high-density view; keep board as a secondary workflow view.
- Mobile: no lane board by default; use grouped lists by attention/status/lane.

Rationale:
- The task area should be a command center, not primarily a board browser.

Expected benefit:
- Faster morning scan and intervention discovery.

#### M2. Rework task detail into summary + activity + inspector

Scope:
- `TaskDetailPage.tsx`
- task detail CSS/components

Change:
- Desktop: split into main content and right/side inspector for workflow state, ownership, dependencies, and actions.
- Mobile: show compact state card first, then comments/files/todos as progressive sections.
- Remove duplicated summary cards and repeated headings.

Rationale:
- Task detail currently reads as a long document. It should read as a control surface.

Expected benefit:
- Clearer task state, fewer scrolls, faster intervention.

#### M3. Tighten Sessions into a live execution console

Scope:
- `SessionsPage.tsx`
- `SessionChatPanel.tsx`

Change:
- Make transcript + composer the dominant surface.
- Move context stats, runtime details, copy/expand controls, and model selection into compact toolbar/overflow areas.
- Replace floating `Create session` with inline empty-state/action behavior.

Rationale:
- Sessions are core execution surfaces; their chrome should stay out of the way.

Expected benefit:
- More transcript visible, clearer messaging, fewer competing controls.

#### M4. Make Settings progressive and less admin-heavy

Scope:
- `src/settings/*`

Change:
- Split common settings from advanced/diagnostic settings.
- Use sticky save/actions per detail panel.
- Collapse low-frequency diagnostics/logs/source-control previews behind disclosure.
- Keep one short supporting sentence per section.

Rationale:
- Settings currently has too much always-visible configuration and explanation.

Expected benefit:
- Easier setup and less intimidation for non-developer users.

#### M5. Refine Workforce around queue pressure

Scope:
- `AgentsPage.tsx`
- `AgentOperationsDetail.tsx`
- `RoleOperationsDetail.tsx`

Change:
- Lead with active work, queued work, idle capacity, and blocked/error states.
- Move manual enqueue form behind an `Enqueue work` action or collapsible panel.
- Use rows instead of broad cards for workers and queue items.

Rationale:
- The page should answer “who is busy and where is pressure?” before offering manual controls.

Expected benefit:
- Better operational scan and less form-first UI.

### Larger structural changes

#### L1. Consolidate a workbench component system

Scope:
- shared components and CSS tokens

Change:
- Define canonical patterns for toolbar, list row, inspector, status badge, empty state, action menu, fixed footer, and mobile action sheet.
- Standardize density, radii, icon sizes, focus states, and semantic color usage.
- Replace structural glyph/emoji controls with consistent SVG icons plus accessible labels.

Rationale:
- Many UX issues come from page-specific styling instead of a strict component language.

Expected benefit:
- More consistent product feel and faster future UX work.

#### L2. Establish adaptive IA rules for desktop vs mobile

Scope:
- frontend architecture and route/page layouts

Change:
- Desktop: panes, tables, boards, inspectors, keyboard-friendly density.
- Mobile: attention/review-first lists, detail drill-in, bottom/sticky action bars, action sheets, no wide boards by default.
- Native mobile client: align visual tokens and narrow scope around approval/intervention/session messaging.

Rationale:
- Mobile should not be a compressed desktop app.

Expected benefit:
- Better phone usability without weakening desktop power.

#### L3. Add a dedicated “Today / Attention” operational home

Scope:
- new or evolved Tasks/Inbox landing surface

Change:
- Combine urgent review, intervention, blocked tasks, active sessions, and worker queue pressure into one scan surface.
- Link into task/session detail for action.

Rationale:
- The product north star asks users to know what needs attention within seconds.

Expected benefit:
- Stronger daily-use workflow and clearer product promise.

## Implementation-ready backlog detail

| Priority | Ticket | Primary files/screens | Acceptance checks |
| --- | --- | --- | --- |
| P0 quick win | Mobile nav labels | `src/App.tsx`, `src/styles.css`, mobile navigation e2e | At `390x844`, the navigation sheet shows icon + text label + badge context for every top-level destination; labels are not clipped/opacity-hidden; items are at least 44px tall; choosing a destination closes the sheet. |
| P0 quick win | Fixed chrome/FAB overlap cleanup | task detail chrome, task overview FAB, sessions FAB/composer CSS | At `390x844`, `375x667`, and `360x640`, no fixed dock/FAB covers task cards, action buttons, or the session composer; page bottom padding accounts for safe area and dock height. |
| P1 quick win | Task detail primary action | `TaskDetailPage.tsx`, task action menu helpers | Each task state exposes exactly one dominant primary action; secondary actions live in an `Actions` menu; destructive actions remain visually separated and require existing confirmation paths. |
| P1 quick win | Mobile Tasks above-fold simplification | Tasks overview controls and task overview CSS | First mobile viewport shows the attention/task list before advanced filters/board controls; filters/sort/view mode are available from one `View options` entry point. |
| P1 medium | Attention-first Tasks command center | Tasks overview/list/board components | Desktop default emphasizes attention/active/blocked/review summary and scan rows; board view remains available but is not the only primary mental model. |
| P2 medium | Sessions console polish | `SessionsPage.tsx`, `SessionChatPanel.tsx` | Transcript and composer occupy the dominant area; create/session/model/runtime controls move to inline empty state, toolbar, or overflow without reducing message visibility. |
| P2 medium | Progressive Settings | `src/settings/*` | Common settings are visible first; diagnostics/source-control previews/advanced forms are collapsed; each section uses one short helper sentence or less. |
| P3 structural | Workbench component standards | shared components/CSS tokens | Shared toolbar/list row/inspector/status/action/empty-state patterns exist and are used by new UX follow-up work; focus, density, icon, and status color rules are documented. |
| P3 structural | Adaptive desktop/mobile IA rules | route/page layout architecture, native mobile client | Desktop uses panes/tables/inspectors; mobile uses attention lists, drill-in detail, sticky primary action, and action sheets; native mobile token language aligns with web. |

## Suggested follow-up ticket list

1. **Mobile nav labels:** Replace icon-only mobile navigation sheet with labeled, touch-friendly destinations.
2. **Fixed chrome cleanup:** Prevent task detail/session/task FAB and dock overlap on mobile and short desktop viewports.
3. **Copy hierarchy pass:** Shorten task detail/settings helper text and stop styling full helper sentences as metadata.
4. **Mobile task overview simplification:** Convert mobile Tasks default from board/control-heavy view to attention-first list.
5. **Task detail primary action:** Promote one state-aware primary action and move secondary actions into overflow.
6. **Desktop task overview density:** Rebalance Tasks overview toward scan rows, summary metrics, and optional board view.
7. **Sessions console polish:** Reduce session chrome, integrate create/session actions, and prioritize transcript/composer.
8. **Settings progressive disclosure:** Split common vs advanced settings and reduce always-visible diagnostics.
9. **Workbench component standards:** Define shared toolbar/list/inspector/status/action patterns and token rules.
10. **Mobile/native client alignment:** Align paired mobile client visuals and scope around intervention/review/session control.

## Desktop vs mobile divergence rules

- **Navigation:** desktop may use a collapsible icon rail; mobile navigation must show labels.
- **Tasks:** desktop can offer board/table/list; mobile should default to attention-first list and drill-in detail.
- **Actions:** desktop can show grouped toolbar actions; mobile should show one primary sticky/contextual action plus action sheet overflow.
- **Settings:** desktop can expose richer admin panels; mobile should emphasize connection/account/basic preferences and hide advanced admin flows.
- **Sessions:** desktop can show list + transcript split pane; mobile should use picker + full-height transcript/composer without overlapping CTAs.
- **Text density:** desktop can show compact metadata; mobile should reduce helper copy and use progressive disclosure.

## Validation guidance for implementation tickets

For each follow-up implementation:
- Test desktop at `1440px` and `1024px`.
- Test mobile at `390x844`, `375x667`, and one short viewport around `360x640`.
- Assert no horizontal overflow: `document.documentElement.scrollWidth <= window.innerWidth`.
- Assert visible focus states and accessible names for icon-only controls.
- Assert all mobile touch targets are at least 44px high/wide or have equivalent hit area.
- Check both dark and light themes for contrast and selected/disabled states.
- Respect `prefers-reduced-motion` for any new transitions.
