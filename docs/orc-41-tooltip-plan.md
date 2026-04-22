# ORC-41 tooltip rollout plan

## Problem summary

Orchestra already exposes a small amount of hover help through scattered native `title` attributes, but it does not have a consistent, user-facing tooltip strategy.

For ORC-41 we want to improve first-run clarity without adding persistent visual noise:
- add concise explanatory hover text to the highest-value controls and form fields
- keep copy short, consistent, and non-internal
- avoid blanketing every label with redundant help
- give users a simple Settings → General preference to disable the explanatory tooltip layer globally
- cover the preference and representative tooltip rendering with regression tests

## Current-state findings

### 1. The app already uses lightweight native tooltips, but only in scattered places

The current codebase contains roughly 25 `title` attributes in `src/`, concentrated in places like:
- `src/App.tsx`
- `src/components/ProjectSwitcher.tsx`
- `src/components/SessionChatPanel.tsx`
- `src/components/CommentableFileViewer.tsx`
- `src/pages/SessionsPage.tsx`
- `src/pages/tasks/TaskCompactCard.tsx`

That matters because ORC-41 does **not** need a heavyweight floating tooltip library to satisfy the product goal. The app already accepts native hover text as a UI pattern.

### 2. There is no shared tooltip preference or abstraction boundary

Today each tooltip-like string is hardcoded inline. There is:
- no central helper for adding/removing tooltip props
- no global enable/disable switch
- no distinction between explanatory help, overflow disclosure, and disabled-state reasons

Without a small shared abstraction, the ORC-41 work would become brittle and inconsistent.

### 3. The audit surface is large, so prioritization matters

The current UI has roughly 100 `field-group__label` occurrences across task flows, inbox, and settings. Adding help to every label would quickly become noisy.

The best value is in controls that are either:
- common entry points for new users, or
- domain-specific enough that the visible label alone is not self-explanatory

### 4. The right persistence model is the existing user-preference path, not PI runtime settings

`src/App.tsx` and `src/lib/theme.ts` already treat theme selection as an immediate, UI-level preference stored in browser/local desktop storage.

That is a better fit for tooltip visibility than `PiRuntimeSettings`, which currently models harness/runtime behavior in:
- `src/lib/harnessSettings.ts`
- `src-tauri/src/services/harness_settings.rs`

Recommendation: store the tooltip toggle alongside other UI preferences, not in the PI runtime settings payload.

### 5. Existing tests already assert `title` behavior in a few places

Relevant examples already exist in:
- `tests/e2e/app-header.spec.ts`
- `tests/desktop-e2e/navigation-layout.test.ts`

That makes a lightweight native-tooltip rollout lower risk than introducing a brand-new rendered tooltip system.

## Recommended implementation

### 1. Introduce a small explanatory-tooltip preference layer

Add a new helper module for tooltip preferences, for example:
- `src/lib/tooltips.ts`

Recommended responsibilities:
- define a storage key such as `orchestra.preferences.explanatory-tooltips`
- load the stored preference with default `true`
- persist changes immediately to `localStorage`
- apply a root marker like `data-explanatory-tooltips="enabled|disabled"` to `document.documentElement` and `body`

Mirror the theme preference pattern already used in `src/lib/theme.ts`.

### 2. Add a tiny shared tooltip helper instead of sprinkling raw `title` logic everywhere

Add either:
- a provider/hook pair, or
- a small helper like `getExplanatoryTooltipProps(copy)`

Recommended behavior:
- when explanatory tooltips are enabled, return native tooltip props (`title`, optionally a test-friendly `data-tooltip` attribute)
- when disabled, omit those props entirely
- keep the API trivial so rollouts are cheap

This should stay intentionally lightweight. ORC-41 does not need a custom floating overlay system unless native `title` behavior later proves insufficient.

### 3. Treat explanatory help separately from overflow/diagnostic titles

This is the most important scoping decision.

Recommendation:
- the new **global toggle controls explanatory helper text**
- existing utility titles that reveal truncated content or disabled reasons can remain outside that toggle in the first pass

Examples that should probably stay in the utility category for now:
- full task title / assignee hover text in `TaskCompactCard`
- tag expansion hover text in `TaskTagList`
- disabled reason hover text for unsupported compact/reload actions in `SessionChatPanel`
- comment/message preview titles used for dense file/comment UIs

Examples that should move into the explanatory-help category:
- collapse/expand navigation
- create session / new task / command palette
- session auto-scroll and wrap controls
- task dispatch / approve / needs work / whip / re-lane actions
- ambiguous form fields like workflow, whip max attempts, overlap policy, trigger source, task prefix, bind host, notification scope

This gives users a meaningful “turn off the help layer” setting without unexpectedly stripping all hover disclosure from dense UI surfaces.

### 4. Put the new toggle in Settings → General as an immediate preference

Recommended placement:
- `src/settings/GeneralPanel.tsx`
- near the existing theme section, either in the same Appearance panel or in a nearby Help/Usability subsection

Recommended control:
- checkbox label: **Show explanatory tooltips**
- short hint: “Hover supported controls and fields to see brief help text.”

Recommended behavior:
- no Save button required
- update state immediately
- persist immediately
- reflect the state at app root so all consumers update consistently

### 5. Roll out tooltip copy in priority order

#### Priority 1: app chrome and first-run entry points

Target files:
- `src/App.tsx`
- `src/components/ProjectSwitcher.tsx`
- `src/pages/SessionsPage.tsx`

Recommended targets and copy direction:
- **Collapse navigation** → “Collapse the sidebar to make more room for work.”
- **Project switcher trigger** → “Switch the active project and update the app to that project’s data.”
- **Create session** → “Start a new session in the active project.”
- **New task** → “Create a new task draft in the active project.”
- **Search · Ctrl+O** → “Search pages and common actions from anywhere in the app.”
- **Supervisor · Ctrl+T** → “Open a quick message window for the supervisor session.”
- **Dismiss session** → “Hide this session from the list without deleting its stored history.”

Notes:
- top-level nav destinations usually do not need explanatory copy beyond their visible label; keep them label-only unless collapsed-mode discoverability needs a minimal tooltip

#### Priority 2: task creation, scheduling, and high-value task actions

Target files:
- `src/pages/tasks/TaskCreatePage.tsx`
- `src/pages/tasks/TaskEditorForm.tsx`
- `src/pages/tasks/TaskScheduleEditorForm.tsx`
- `src/pages/tasks/TaskDetailPage.tsx`
- `src/components/TaskActionMenu.tsx`
- `src/pages/tasks/TasksOverviewPage.tsx`

Recommended targets and copy direction:
- **Publish / Dispatch** → explain that the task is saved and moved into workflow execution
- **Save changes** → explain that the task remains a draft or saved definition
- **Create as a scheduled task definition** → explain one-off task vs reusable schedule
- **Workflow** → explain that it determines lane ownership and transitions
- **Whip max attempts** → explain automatic re-prompt escalation behavior
- **Task repositories** → explain which repos workers should use
- **Overlap policy** → explain whether a new trigger waits or creates another task
- **Trigger source** → explain time-based vs event-based creation
- **Domain event key** → explain which Orchestra event materializes a task
- **Dispatch / Approve / Needs work / Pause / Stop / Whip / Re-lane** → give short action/result descriptions
- **Add dependency** → explain blocker relationship
- **Add file reference** → explain keeping important repo artifacts visible on the task
- **Add todo** → explain lane-scoped checklist behavior
- **Send mail** → explain mailbox delivery to the active worker session
- **Task overview filter toggle** → optional, but valuable if the collapsed filter summary feels opaque

Implementation note:
- for form fields, prefer attaching tooltip props to the outer `label.field-group` or checkbox wrapper so the help is discoverable from either the label or field area

#### Priority 3: sessions and inbox controls

Target files:
- `src/components/SessionChatPanel.tsx`
- `src/pages/InboxPage.tsx`

Recommended targets and copy direction:
- **Session actions trigger** → “Open session tools.”
- **New session / Compact / Reload** → explain the effect of each action
- **Open task** → explain that it opens the active task detail
- **Auto-scroll toggle** → explain transcript follow behavior
- **Wrap toggle** → explain transcript line wrapping
- **Compose** → explain sending mailbox messages to agents
- **Mark all read** → explain unread mailbox cleanup
- **Interrupt recipient** → explain interrupt-vs-normal delivery priority

#### Priority 4: advanced settings fields that are currently jargon-heavy

Target files:
- `src/settings/ProjectsPanel.tsx`
- `src/settings/RemotePanel.tsx`
- `src/settings/ChannelsPanel.tsx`
- optionally `src/settings/WorkflowsPanel.tsx`, `src/settings/AgentsPanel.tsx`, `src/settings/RolesPanel.tsx`

Recommended targets and copy direction:
- **Task prefix** → explain task number prefix behavior
- **Enable auto task dispatching…** → explain automatic dispatch when blockers clear
- **Use Tailscale Serve** → explain managed HTTPS exposure through Tailscale
- **Bind host** → explain network interface binding
- **Port** → explain which port the remote API listens on
- **Active project for commands** → explain Telegram command context
- **Notification scope** → explain which projects can send notifications
- **Commands enabled** → explain supervisor command availability
- **Owner reference / Success review / Compaction window override / Thinking** → only if the implementation still has room after the higher-value surfaces land

## Copy conventions

Use these rules consistently:
- one sentence when possible
- start with user intent or outcome, not implementation details
- avoid internal backend words unless the visible label already uses them
- do not restate the label without adding meaning
- skip fields that already include clear inline helper text unless the control is still ambiguous
- prefer plain verbs: “Start”, “Open”, “Choose”, “Send”, “Limit”, “Move”

Good examples:
- “Choose which workflow owns this task’s lane transitions.”
- “Limit how many automatic re-prompts happen before Orchestra escalates to a user.”
- “Send this as an interrupt instead of a normal mailbox message.”

Bad examples:
- “Workflow field.”
- “This button dispatches the lane assignment workflow runtime.”
- “Set the configuration for orchestration semantics.”

## Regression coverage plan

### 1. Add a small preference-level test

Recommended new unit test or small utility test:
- validate default enabled behavior
- validate storage round-trip
- validate root dataset application

This can live near the helper if the repo already keeps small storage utilities under test.

### 2. Extend General settings coverage

Update:
- `tests/e2e/general.spec.ts`
- optionally `tests/desktop-e2e/general-session-prompt-template.test.ts`

Recommended assertions:
- Settings → General shows the tooltip toggle
- toggling it updates the stored preference
- toggling it updates the root dataset marker
- the setting persists across reloads

### 3. Add representative tooltip-on / tooltip-off UI assertions

Update or add:
- `tests/e2e/app-header.spec.ts`
- `tests/desktop-e2e/navigation-layout.test.ts`
- optionally a new focused spec like `tests/e2e/tooltips.spec.ts`

Recommended representative assertions:
- when enabled, high-value controls expose explanatory tooltip metadata (`title`, or helper-generated `data-tooltip` if added)
- when disabled, the same controls no longer expose explanatory tooltip metadata
- a representative task form field also follows the preference

Good representative targets:
- `[data-role="toggle-sidebar-collapse"]`
- `[data-role="create-session"]` or `[data-role="new-task"]`
- `label:has([data-role="task-workflow"])`
- `[data-role="session-scroll-lock-toggle"]`

### 4. Keep the tests focused on representative behavior, not exhaustive copy snapshots

We do not need a brittle spec that snapshots every tooltip string in the app.

Prefer tests that prove:
- the preference exists
- the preference persists
- the preference is applied consistently on a few high-value buttons/fields across different surfaces

## Files likely to change

Core preference plumbing:
- `src/App.tsx`
- new helper such as `src/lib/tooltips.ts`
- optionally a tiny provider/hook component if that keeps prop passing manageable

Primary rollout surfaces:
- `src/settings/GeneralPanel.tsx`
- `src/App.tsx`
- `src/components/ProjectSwitcher.tsx`
- `src/pages/SessionsPage.tsx`
- `src/components/SessionChatPanel.tsx`
- `src/pages/InboxPage.tsx`
- `src/pages/tasks/TaskCreatePage.tsx`
- `src/pages/tasks/TaskEditorForm.tsx`
- `src/pages/tasks/TaskScheduleEditorForm.tsx`
- `src/pages/tasks/TaskDetailPage.tsx`
- `src/components/TaskActionMenu.tsx`
- `src/pages/tasks/TasksOverviewPage.tsx`

Secondary rollout surfaces if time allows:
- `src/settings/ProjectsPanel.tsx`
- `src/settings/RemotePanel.tsx`
- `src/settings/ChannelsPanel.tsx`
- optionally `src/settings/WorkflowsPanel.tsx`
- optionally `src/settings/AgentsPanel.tsx`
- optionally `src/settings/RolesPanel.tsx`

Likely tests:
- `tests/e2e/general.spec.ts`
- `tests/e2e/app-header.spec.ts`
- `tests/desktop-e2e/general-session-prompt-template.test.ts`
- `tests/desktop-e2e/navigation-layout.test.ts`
- optionally a new focused tooltip spec

## Recommended handoff summary

Implement ORC-41 as a lightweight, native-tooltip-backed help layer with a single global preference for explanatory copy.

The most important architectural choices are:
1. store the toggle as a normal UI preference, not a PI runtime setting
2. add a shared helper so the app can consistently opt tooltip text in or out
3. prioritize ambiguous, high-value controls instead of trying to annotate every label
4. keep explanatory help distinct from overflow/diagnostic titles so the toggle stays useful without breaking dense UI affordances
