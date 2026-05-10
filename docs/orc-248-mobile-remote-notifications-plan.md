# ORC-248 mobile/remote notification implementation notes

## tl;dr
- Orchestra now has a real hosted-web background notification path via Web Push + service worker, in addition to the existing live-session `notification.intent` path.
- The root cause behind “it only notifies when the web app is open” was that the prior remote/browser path only delivered notification intents to active clients over the websocket/browser event channel.
- A follow-up reliability issue on iPhone Home Screen hosted-web use was that the first Web Push pass suppressed push whenever the device still had any connected hosted-web client, even if that client had moved to the background. The fix now suppresses duplicate push only while that hosted-web client is foregrounded.
- Task-attention trigger coverage now includes a new `task.assigned_to_user` intent for transitions where the current attention owner becomes the user outside the existing approval/intervention states.
- Final semantics are now explicit:
  - open connected clients receive live notification intents
  - paired hosted-web browsers with a registered push subscription receive background Web Push when that device does not currently have a foreground hosted-web client
  - Telegram still receives task-attention notifications through the backend channel adapter

## Executive summary
ORC-248 required fixing both an architecture gap and a trigger-coverage gap.

### Root cause before the fix
Remote/browser notifications previously depended on:
- backend `notification.intent` publication
- an active remote websocket/browser client to receive that event
- a running foreground page to call the browser Notification API

That meant the hosted-web path was effectively a **live-session local notification path**, not a background push path. If the page was closed, suspended, or not connected, nothing on the browser side could receive the event.

### What is implemented now
The implementation adds:
1. a backend Web Push adapter with persisted VAPID key material
2. a hosted-web service worker (`public/orchestra-sw.js`)
3. a remote API push-config route and browser push-subscription registration flow
4. a new `task.assigned_to_user` intent for user-owned lane handoffs
5. explicit UX copy about secure-origin / registration requirements

## Current notification broadcast conditions
### Task-attention intents are emitted when:
- a task starts `awaiting_user_approval`
- a task starts `awaiting_user_intervention`
- a task transitions into a user-owned attention state that is **not** one of the explicit approval/intervention review states (`task.assigned_to_user`)

### Delivery fan-out now works like this
For each notification intent:
- **Telegram**: backend adapter, existing channel-scope behavior
- **Live local notifications**: `notification.intent` to connected desktop/hosted-web clients
- **Hosted-web background push**: Web Push to paired browser devices with a stored subscription and no foreground hosted-web client for that device

### Why foreground client state still matters
Live `notification.intent` delivery remains the correct path for an already-open Orchestra client. The Web Push adapter now suppresses background push only while the same hosted-web device is foregrounded, which avoids duplicate notifications on the active browser/device without starving backgrounded Home Screen or mobile-browser sessions.

## Web Push registration / subscription semantics
Hosted-web background push requires all of the following:
- the client is the hosted Orchestra web app (`remote_api` + same-origin browser session)
- local notifications are enabled in Settings → General on that browser
- browser notification permission is granted
- the origin is secure (`HTTPS` or localhost)
- the browser supports `serviceWorker` + `PushManager`
- Orchestra successfully registers a push subscription and stores it on the paired remote device record

The browser sync path now:
- loads Web Push config from the remote API
- registers `/orchestra-sw.js`
- subscribes via `PushManager`
- stores the serialized subscription through `/api/v1/devices/push-token`
- unregisters/clears the stored subscription when local notifications are disabled or permission is unavailable

## Trigger coverage added in this task
### New intent
- `task.assigned_to_user`

### Emitted for
- worker completion transitions that hand the task off into a user-owned lane/state
- manual re-lane operations that move a task into a user-owned lane/state
- other comparable transitions where the current attention owner becomes the user but the state is not already represented as approval/intervention review

### Not duplicated for
- `awaiting_user_approval`
- `awaiting_user_intervention`
- paused/review states already represented by those explicit review-attention semantics

## Hosted-web / mobile limitations that are now explicit
Web Push is now real and implemented, but browser/platform rules still apply:
- plain insecure HTTP LAN origins cannot register background Web Push
- some mobile browsers may require an installed/home-screen web app context for background push
- if no push subscription is registered, hosted-web background delivery is unavailable and Orchestra falls back to live connected-client notifications plus Telegram/channel delivery

These constraints are now product-visible rather than implicit.

## Key implementation touch points
- `src-tauri/src/services/web_push.rs`
- `src-tauri/src/services/notifications.rs`
- `src-tauri/src/services/task_runtime.rs`
- `src-tauri/src/services/remote_api.rs`
- `public/orchestra-sw.js`
- `src/lib/webPush.ts`
- `src/lib/orchestraData/notifications.ts`
- `src/settings/GeneralPanel.tsx`
- `src/settings/RemotePanel.tsx`

## Regression coverage
Added/updated coverage for:
- backend web-push subscription parsing, eligibility, and stale-subscription cleanup
- notification broker fan-out behavior including the new adapter/result shape
- user-owned lane handoff trigger reasoning (`task.assigned_to_user`)
- hosted-web browser-side Web Push registration/suppression behavior
- local notification rendering for the new task-attention intent

## Validation summary
Validated in-repo with:
- `cargo test web_push --lib`
- `cargo test notifications --lib`
- `cargo test user_handoff --lib`
- `npm run build`
- `npm test -- tests/web-push.test.ts tests/local-notifications.test.ts tests/orchestra-client-hosted-web.test.ts`
- `./scripts/run-desktop-e2e-podman.sh tests/desktop-e2e/system-notifications.test.ts`

The podman-backed desktop e2e run now covers mailbox notifications, approval-needed notifications, and the new user-owned-lane handoff notification path (`task.assigned_to_user`). To make that coverage real for the hosted-web push path, the runner bootstrap was also fixed to carry `github.html` and `public/` assets into the isolated workspace and to hash those inputs for preview rebuild invalidation.
