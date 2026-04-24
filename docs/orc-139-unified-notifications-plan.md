# ORC-139 unified notifications plan

## tl;dr
Add one backend notification broker that emits structured notification intents for user-facing events, routes those intents through channel adapters, and publishes a shared `notification.intent` client event for local delivery. Keep Telegram as a backend adapter, move macOS/web delivery behind one client-local notifications extension, and stop deriving local notifications ad hoc from generic `task.change` / `inbox.change` events.

## Executive summary
Today Orchestra has two unrelated notification paths:
- **Telegram** is delivered directly from Rust task-runtime code through `channels::notify_task_user_attention_channels(...)`.
- **macOS/browser notifications** are synthesized in `src/App.tsx` from generic UI events and then sent through `hostAdmin.notifications.send(...)`.

That split causes three problems:
1. trigger logic is duplicated across backend and frontend
2. hosted web cannot participate cleanly because local notifications are hidden behind a desktop-only host capability
3. there is no single notification model that defines event kinds, payload semantics, fan-out, capability checks, or failure handling

The recommended shape is:
- add a shared **notification intent model**
- add a backend **notification broker** that builds intents once and fans them out to adapters
- keep **Telegram** as a backend adapter
- add a **client-local adapter** for macOS + web by publishing a new `notification.intent` event that the shared frontend consumes
- expose local notifications through a client-local extension instead of the current desktop-only `hostAdmin.notifications` path

## Current-state audit

### 1. Telegram notifications are backend-only and task-attention-only today
Current trigger points:
- `src-tauri/src/services/task_runtime.rs`
  - `complete_lane()` calls `channels::notify_task_user_attention_channels(...)` when a lane moves to:
    - `awaiting_user_approval`
    - `awaiting_user_intervention`
    - `needs_user`

Current payload/formatting:
- `src-tauri/src/services/channels.rs`
  - `format_task_user_attention_notification(...)` builds a multiline plain-text body with:
    - headline
    - project
    - task number/title
    - lane name
    - task id
    - action text
    - optional first-line notes

Current routing semantics:
- `notify_task_user_attention_channels(...)`
  - loads runnable channels
  - filters to `kind == "telegram"`
  - filters by existing Telegram notification scope (`all_projects` vs `active_project`)
  - sends to every matching enabled channel

Current failure semantics:
- delivery is best effort
- one channel failure does not stop others
- failures are recorded via `record_failed_channel_notification(...)`
- no shared notification result object exists beyond per-channel logging

### 2. Local macOS/browser notifications are built in the frontend from generic events
Current trigger points:
- `src/App.tsx`
  - on `inbox.change` with reason `mailbox.sent`:
    - fetch unread deliveries
    - send `Orchestra — New message`
  - on `task.change` with reason:
    - `task.transition.awaiting_user_approval`
    - `task.transition.needs_user`
    - fetch task details
    - send `Orchestra — Approval needed` or `Orchestra — User intervention needed`

Current payload/formatting:
- `buildInboxNotificationBody(...)`
- `buildTaskAttentionNotificationBody(...)`
- dedupe happens in the React app with in-memory sets keyed by delivery id or `reason:taskId:updatedAt`

Current delivery semantics:
- `hostAdmin.notifications.send(...)` -> `src/lib/systemNotifications.ts`
- when running in Tauri:
  - request permission
  - invoke native `send_system_notification`
  - macOS bridge lives in `src-tauri/src/services/system_notifications.rs`
- when running in a plain browser:
  - `systemNotifications.ts` already knows how to use the Web Notification API
  - but the app only enters this path when `supportsSystemNotifications(...)` is true
  - that capability is currently wired as desktop-only, so hosted web does not cleanly participate

Current failure semantics:
- unsupported / denied / thrown errors return `false`
- event handlers swallow failures with `.catch(() => undefined)`
- there is no shared per-intent delivery record

### 3. The current model is split at the wrong boundary
Today the split is:
- backend decides when to notify for Telegram
- frontend decides when to notify for local notifications

The split should instead be:
- backend decides **what notification intent exists**
- channel adapters decide **how that intent is delivered**

## Recommended notification model

### Intent types for this ticket
Start with explicit user-facing intents that already exist in the product surface:
- `mailbox.message_received`
- `task.awaiting_user_approval`
- `task.awaiting_user_intervention`

### Shared intent shape
Recommended canonical fields:
- `id`: stable unique id for the intent
- `eventType`: one of the intent kinds above
- `title`: channel-agnostic primary title
- `body`: channel-agnostic summary body
- `tag`: dedupe/coalescing key
- `projectId`: optional project context
- `taskId`: optional task context
- `deliveryId`: optional mailbox delivery context
- `action`: structured follow-up target
- `occurredAt`: timestamp

Recommended `action` semantics:
- `open_inbox`
- `open_task` with task id
- optionally include a subtarget like `review` vs `details`

Important: `action` is intent metadata, not a promise that every channel supports clickable buttons. Local web/macOS can use it for click navigation/focus. Telegram can render the action as text in v1.

### Channel support matrix for v1
To keep the implementation bounded while still unifying the model:
- **Telegram adapter**
  - supports:
    - `task.awaiting_user_approval`
    - `task.awaiting_user_intervention`
  - preserves current task-attention behavior
- **Local web/macOS adapter**
  - supports:
    - `mailbox.message_received`
    - `task.awaiting_user_approval`
    - `task.awaiting_user_intervention`

This makes the support matrix explicit. Expanding Telegram to mailbox-message notifications later becomes an adapter change, not a trigger rewrite.

## Recommended architecture

### 1. Add a backend notification broker
Add a new Rust service, e.g. `src-tauri/src/services/notifications.rs`, responsible for:
- building notification intents from domain events
- routing intents to backend adapters
- publishing local-delivery intents to connected clients
- returning per-channel outcomes for tests/logging

Keep this broker focused and explicit. A small enum-and-match design is preferable to a large generic framework.

### 2. Keep Telegram as a backend adapter
Refactor the existing outbound Telegram notification path behind a broker-owned adapter boundary:
- reuse current channel loading and scope filtering
- reuse current Telegram send helpers / activity logging
- move the decision about *when* to send out of `task_runtime.rs`

This keeps Telegram-specific transport details isolated while preserving the current channel configuration model.

### 3. Add one shared local adapter for macOS + web
Local notifications should be delivered by the shared frontend after it receives a `notification.intent` event.

Recommended flow:
1. backend broker publishes `notification.intent`
2. shared frontend `NotificationController` subscribes once
3. controller checks local capability + local enabled state + permission
4. controller calls a client-local notifications extension
5. underlying implementation uses:
   - native macOS bridge in Tauri when available
   - Web Notification API in hosted web/browser

This keeps host-specific delivery details out of the shared notification trigger layer.

### 4. Move local notifications out of `hostAdmin`
The current API shape treats notifications as a desktop host-admin feature. That is the main reason hosted web is excluded.

Recommended change:
- expose a **client-local notifications extension** on the shared client binding for `tauri`, `mock`, and `remote_api` browser clients
- stop gating notification support on `capabilities.host.systemNotifications`
- let the local notifications extension report runtime environment + permission state directly

That keeps browser notification capability where it actually lives: on the client, not on the remote backend host.

### 5. Keep configuration split by destination ownership
Use the existing ownership boundary instead of inventing a large new settings system:
- **Telegram** remains configured centrally in Channels settings
- **web/macOS local notifications** are configured per client installation/session in General settings

Recommended local settings behavior:
- explicit local enable/disable toggle separate from OS/browser permission
- show status + request-permission UI in hosted web and desktop
- keep the current Telegram `notificationScope` behavior unchanged

This satisfies “multiple notification targets configured/enabled/disabled” without requiring a new cross-device preferences backend in this ticket.

## Routing, fan-out, failures, and capability rules

### Fan-out behavior
For each generated intent:
- attempt delivery to every enabled eligible adapter
- adapter eligibility is determined independently
- one adapter failure must not block others

### Telegram eligibility
Eligible when:
- channel is enabled/runnable
- kind is `telegram`
- required Telegram config exists
- existing project scope matches the event/project
- adapter supports the intent type

### Local web/macOS eligibility
Eligible when:
- client-local notifications are enabled in local settings
- runtime environment is supported
- permission state allows delivery
- adapter supports the intent type

### Failure/fallback behavior
Recommended v1 semantics:
- broker never fails the underlying task/message mutation because notification delivery failed
- Telegram failures continue to write channel activity / last-error state
- local unsupported/denied states are treated as `suppressed`, not hard failures
- cross-channel “fallback” is simply multi-destination fan-out: if Telegram fails but local succeeds, the intent is still considered partially delivered

## Expected implementation touch points

### Backend
- new: `src-tauri/src/services/notifications.rs`
- update: `src-tauri/src/services/task_runtime.rs`
- update: `src-tauri/src/services/channels.rs`
- update: `src-tauri/src/services/app_events.rs`
- update: mailbox-sent emitters so they can publish notification intents from one shared helper
  - `src-tauri/src/commands/messages.rs`
  - `src-tauri/src/services/remote_api.rs`
  - plus any existing `mailbox.sent` emit sites that should generate local notification intents
- update shared models/contracts as needed in:
  - `src-tauri/src/models.rs`
  - `src/types.ts`

### Frontend/shared client
- add a shared `NotificationController` / hook instead of embedding trigger logic in `src/App.tsx`
- generalize `src/lib/systemNotifications.ts` into the shared local delivery implementation
- update client bindings/interfaces so hosted web gets the same local notifications API surface as mock/tauri
- extend event typing/subscription support for a new `notification.intent` event:
  - `src/lib/orchestraClient/events.ts`
  - `src/lib/orchestraClient/browserEvents.ts`
  - `src/lib/orchestraClient/remoteApiEvents.ts`
- update General settings UI so web can manage local notification permission/status, not only desktop

### Mock parity
If the broker introduces a new client event, the mock/browser path should emit the same event so existing mock/e2e coverage remains realistic.

## Automated coverage plan

### Shared intent generation / routing
Add focused tests around the broker for:
- mailbox delivery -> `mailbox.message_received` intent
- task transition to awaiting approval -> task attention intent
- task transition to awaiting intervention -> task attention intent
- fan-out to multiple eligible destinations
- one adapter failure not blocking other adapters

### Telegram adapter
Keep/add Rust tests for:
- project-scope filtering
- adapter support matrix
- failure logging path
- non-regression of current Telegram message rendering

### Web notification behavior
Add/update TS/browser coverage for:
- hosted web can request permission and receive notification intents
- unsupported/denied permission suppresses delivery cleanly
- click behavior focuses/navigates using the new `action` metadata

### macOS notification behavior
Keep/update desktop coverage for:
- local notification intents still reach the native macOS bridge in Tauri
- permission gating stays correct
- current approval-needed/new-message desktop flows still work through the new controller

## Recommended rollout shape
1. add types + broker + `notification.intent` event
2. migrate task-attention Telegram path onto the broker
3. migrate local task-attention notifications onto the broker/controller
4. migrate mailbox/new-message local notifications onto the broker/controller
5. expose local notifications in hosted web settings and bindings
6. update tests

## Validation targets
After implementation, expect at minimum:
- one shared code path for intent generation
- Telegram still receives task-attention notifications through the broker
- macOS desktop still receives local notifications through the broker/controller path
- hosted web now receives Web Notification API delivery through the same intent path
- multi-destination fan-out works when Telegram + local notifications are both enabled
