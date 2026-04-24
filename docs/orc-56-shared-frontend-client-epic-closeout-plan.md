# ORC-56 shared frontend client epic closeout

## tl;dr
Yes — ORC-56 now satisfies the intended outcome. Orchestra’s browser-exposed remote frontend is now the same shared `src/` app used by the Tauri host, running in `hosted_web` mode against the remote API on the same origin. Access it from **Settings → Remote** via the **Hosted Orchestra web app URL**: create a pairing code, open that URL in a browser, enter the code, and Orchestra upgrades the browser into a same-origin cookie-backed session. The browser app now shares the same frontend codebase as Tauri, but intentionally desktop-only/native capabilities remain capability-gated instead of pretending full native parity.

## Executive summary
ORC-57..65 established the shared client contracts, adapters, bootstrap, remote API surface, migrated React screens, and parity coverage. ORC-127 then finished hosted-web parity in the main `src/` app, and ORC-128 replaced the old `mobile/dist-web` product browser entrypoint with the main hosted-web Orchestra app.

That means the current accepted child-task state is now:
- the browser remote entrypoint loads the same React app codebase as the Tauri shell
- the browser app uses `/api/v1/frontend/bootstrap`, `/api/v1/*`, `/api/v1/ws`, and `POST /api/v1/pair/complete` on the same origin
- the legacy browser-targeted `mobile/` bundle is no longer Orchestra’s primary exposed web frontend; it is only an explicit paired-client/dev harness
- intentional desktop-only capabilities remain separated behind shell/host-admin extensions and capability checks

## Current repo evidence
This closeout call is based on the completed follow-up work tracked under this epic:
- **ORC-127** landed as `fffa41c` — `feat: finish hosted web parity for main app`
- **ORC-128** landed as `2972dfa` — `feat: expose hosted web app for remote browser access`
- `src/lib/orchestraClient/*`, `src/main.tsx`, and `src/hostedWeb/HostedWebAuthGate.tsx` provide the shared hosted-web bootstrap and browser-pairing path for the main app
- `src-tauri/src/services/remote_api.rs` serves the hosted-web entrypoint from the same origin as `/api/v1/frontend/bootstrap`, `/api/v1/*`, and `/api/v1/ws`, and supports `POST /api/v1/pair/complete`
- `src/settings/RemotePanel.tsx` now instructs users to open the **Hosted Orchestra web app URL** and pair browser or mobile clients from the same remote-access flow
- `README.md` now describes Tailscale Serve as exposing the hosted Orchestra web app on the same origin as the API
- `mobile/README.md` now scopes the `mobile/dist-web` browser build as a paired-client/dev harness, not the main Orchestra browser app

## How to access the browser frontend now
1. In the Tauri app, open **Settings → Remote**.
2. Enable remote access and save.
3. Optional: turn on **Use Tailscale Serve** if you want Orchestra to expose one HTTPS origin for the hosted web app and API.
4. Create a pairing code.
5. Open the **Hosted Orchestra web app URL** shown in Remote settings.
6. On the browser sign-in screen, enter the pairing code.
7. After pairing, Orchestra sets the same-origin browser session cookie and reloads the shared app normally.

## What “same frontend” means now
What is true now:
- the browser entrypoint is the same shared `src/` frontend codebase as the Tauri app
- the browser path uses the shared `OrchestraClient` contract and remote API adapter instead of the old separate web-driver product surface
- core cross-host app surfaces are exercised through hosted-web validation, including tasks, inbox, sessions/chat, agents/settings, source-control settings, and related admin/project flows migrated under ORC-127

What is still intentionally different:
- browser mode does not expose Tauri-only/native host extensions when the host cannot provide them
- desktop-only affordances such as native windows, PTY/log terminals, harness/host-admin controls, and similar machine-local operator tooling remain capability-gated

So the honest answer to “can I do everything in the browser that I can in the Tauri app?” is:
- **yes**, for the shared cross-host Orchestra frontend that ORC-56 set out to deliver
- **no**, for intentionally desktop-only/native capabilities that were explicitly separated from the shared surface

## Validation summary
The epic’s final follow-up tasks closed with direct validation:
- **ORC-127:** `npm run build`, `npm test`, and `npm run test:hosted-web:e2e`
- **ORC-128:** `npm run build:hosted-web`, hosted-web/unit route probes, hosted-web auth/tasks E2E, and desktop Remote settings coverage
- ORC-128 QA explicitly verified that the live browser entrypoint starts unauthenticated, pairs via `POST /api/v1/pair/complete`, re-bootstraps to `same_origin_cookie`, and loads the main shared app rather than the legacy paired-client harness

## Acceptance call
ORC-56 can now be closed as satisfying the user’s intended epic outcome:
- the exposed browser frontend is now the same shared Orchestra frontend codebase used by the Tauri host
- the exposed browser path no longer depends on the legacy separate shared web-driver surface
- remaining differences are the intentional capability-gated desktop-only features, not a missing hosted-web frontend architecture gap
