# OD-29 Telegram notification scope plan

## Problem summary

Telegram channels currently expose a single "default project" concept for command routing, but the product request for OD-29 is broader: users need an explicit setting that controls whether outbound Telegram notifications are sent for **all projects** or only the **active/default project**.

The current implementation couples those two behaviors. That makes the UX ambiguous, and it means the product does **not** currently satisfy the requested default of `all projects` notifications.

## Current-state findings

### 1. There is no explicit notification-scope field today

The Telegram config types only expose bot/chat metadata plus `commandsEnabled`:

- `src/types.ts`
- `src-tauri/src/models.rs`
- `src-tauri/src/services/channels.rs`

`StoredTelegramConfig`, `TelegramChannelConfig`, and `TelegramChannelConfigInput` do **not** include any field that distinguishes:

- command/default project context
- outbound notification scope

So the current product has no user-facing or persisted way to choose between "all projects" and "active project only."

### 2. The current settings UI only exposes a default project, not a notification scope

`src/settings/ChannelsPanel.tsx` currently shows:

- a `Default project` select in the main editor grid
- a `commands enabled` checkbox in Step 4
- a `channel enabled` checkbox in Step 4

There is no copy or control that tells the user what project scope outbound Telegram notifications use.

### 3. Outbound Telegram notifications are currently scoped to the channel's default/active project

The implementation detail that answers the ticket's first question is in `src-tauri/src/services/channels.rs`:

- `notify_task_user_attention_channels(...)` loads runnable Telegram channels
- then filters them with `channel.default_project_id.as_deref() == Some(task.project_id.as_str())`
- only the surviving channels receive the outbound notification

That means the current behavior is **not** "all projects." A Telegram channel only receives task attention notifications for the task's project **when that project matches the channel's current default project**.

### 4. Changing the active/default project silently changes notification routing too

The same `default_project_id` field is also used by Telegram command flows:

- `/project ...` updates the channel's `default_project_id`
- `/projects` renders "Choose the default project for this Telegram channel"
- `/status` reports the current `Default project`
- task/mail command handlers resolve their project context from `default_project_id`

Because outbound notification routing also keys off `default_project_id`, changing the active project in Telegram or in the settings UI also changes which task notifications are delivered.

### 5. The current default is effectively single-project, not all-projects

The backend normalizer falls back to `DEFAULT_PROJECT_ID` (`"orchestra"`) when no explicit project is provided. The mock/frontend path also stores a single `defaultProjectId`.

So the current default behavior is effectively:

- channel commands target one active/default project
- outbound notifications are limited to that same project

This conflicts with the OD-29 requirement that the default notification behavior be `all projects`.

### 6. The outbound message format already includes the project name

`format_task_user_attention_notification(...)` includes a `Project: ...` line in the Telegram message body.

That is useful for the requested `all projects` mode because it means cross-project notifications are already distinguishable without inventing a new message format.

## Recommended implementation

### 1. Add an explicit Telegram notification-scope setting

Add a persisted Telegram config field across TypeScript, Rust models, and stored channel JSON:

- `notificationScope: "all_projects" | "active_project"`

Recommended semantics:

- `all_projects` = deliver outbound Telegram task-attention notifications for every project
- `active_project` = only deliver outbound notifications when `task.project_id` matches the channel's current `default_project_id`

### 2. Make `all_projects` the default when the field is missing

For OD-29, the simplest implementation is:

- treat missing/unset `notificationScope` as `all_projects`
- expose `all_projects` as the default selected value in the UI
- persist it on save so the config becomes explicit going forward

This matches the stated product requirement directly.

#### Compatibility note

This choice will widen notification delivery for existing Telegram channels that were previously behaving like "active project only" through the implicit `default_project_id` filter.

If reviewers want to preserve old behavior for already-configured channels, that would require a deliberate migration/backfill strategy that writes `active_project` onto existing records. That is a product decision, not a technical requirement. Based on the task wording, the recommended plan is to default missing values to `all_projects`.

### 3. Keep "active/default project" and "notification scope" as separate concepts in the UI

Update `src/settings/ChannelsPanel.tsx` so the settings surface makes the distinction obvious.

Recommended UI changes:

- relabel `Default project` to something clearer such as `Active project for commands`
- add helper text explaining that this project is used by Telegram command context (`/tasks`, `/task`, `/mail`, `/approve`, etc.)
- add a new notification-scope control in Step 4, ideally radio buttons or a select:
  - `All projects`
  - `Active project only`
- add supporting copy such as:
  - `All projects: send Telegram notifications for tasks from any project.`
  - `Active project only: only send notifications for the currently selected project above.`

This removes the ambiguity that prompted the ticket.

### 4. Apply the new scope only to outbound notifications, not command routing

The existing `default_project_id` behavior for Telegram commands is still useful and should remain in place.

Recommended split of responsibilities:

- `default_project_id` = active/default project for Telegram commands and operator context
- `notificationScope` = filter for outbound Telegram notifications

That keeps the existing command UX intact while making notification behavior explicit.

### 5. Refactor notification routing behind a helper with clear semantics

Update `src-tauri/src/services/channels.rs` so `notify_task_user_attention_channels(...)` delegates the project filter to a small helper.

Recommended behavior:

- for `all_projects`, every runnable Telegram channel is eligible
- for `active_project`, a channel is eligible only when its current active/default project matches `task.project_id`
- if an `active_project` channel has no stored `default_project_id`, use the same fallback already used elsewhere (`DEFAULT_PROJECT_ID`)

A dedicated helper makes the routing contract easy to test without needing full Telegram API coverage for every case.

### 6. Make active-project changes affect notifications only in `active_project` mode

This behavior should be explicit and tested:

- if `notificationScope = active_project`, switching the channel's active/default project should immediately change which project notifications are delivered
- if `notificationScope = all_projects`, switching the active/default project should **not** change notification delivery

That preserves the requested semantics and avoids accidental regressions.

### 7. Optionally surface the scope in Telegram status output

The settings UI is the required configuration surface, but `src-tauri/src/services/channels.rs`'s `/status` response is also a useful place to reduce ambiguity.

Recommended enhancement:

- add a `Notification scope: all projects` or `Notification scope: active project only` line to `/status`

This is optional for correctness, but it would make the live Telegram-side behavior easier to understand.

## Coverage plan

### A. Rust service/unit coverage

Primary file:

- `src-tauri/src/services/channels.rs`

Add tests for:

1. missing/unset scope defaults to `all_projects`
2. `active_project` matches only the channel's current default project
3. switching the active/default project changes the match result for `active_project`
4. switching the active/default project does **not** change delivery for `all_projects`

A helper-level test suite is the fastest way to pin the core routing contract.

### B. Frontend/mock coverage

Primary files:

- `src/lib/channels.ts`
- `tests/channels.test.ts`
- `tests/e2e/channels.spec.ts`

Add coverage for:

1. new channels default to `all_projects`
2. the setting is persisted through create/update in mock mode
3. the settings UI shows and saves the selected scope

This protects the non-Tauri path that Playwright relies on.

### C. Desktop Telegram end-to-end coverage

Primary file:

- `tests/desktop-e2e/channels-telegram.test.ts`

Extend or add a scenario that proves actual notification routing with the Telegram harness:

1. create at least two projects
2. configure a Telegram channel with `active_project`
3. trigger a task-attention notification in the active project and in a different project
4. verify only the active project notification is delivered
5. switch the channel's active/default project
6. verify the notification routing flips accordingly
7. verify `all_projects` mode delivers notifications for both projects regardless of the active project

This gives OD-29 one real transport-level regression test instead of relying only on helper coverage.

## Files expected to change

- `src/types.ts`
- `src/lib/channels.ts`
- `src/settings/ChannelsPanel.tsx`
- `src-tauri/src/models.rs`
- `src-tauri/src/services/channels.rs`
- `tests/channels.test.ts`
- `tests/e2e/channels.spec.ts`
- `tests/desktop-e2e/channels-telegram.test.ts`

Potentially:

- `src/styles.css` if the new scope control needs layout polish

## Validation plan

Run focused coverage for the touched surfaces:

```bash
npm test -- tests/channels.test.ts
npm run test:e2e -- tests/e2e/channels.spec.ts
npm run test:desktop-e2e:host -- tests/desktop-e2e/channels-telegram.test.ts
```

If the implementation adds a new Rust helper or service-level test module beyond the existing suite, run the corresponding Rust test target as well.
