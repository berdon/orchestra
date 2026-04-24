# ORC-128 hosted-web remote entrypoint plan

## tl;dr

- Replace the product-exposed browser surface with the main `src/` app built in `hosted_web` mode and served from the same origin as `/api/v1/frontend/bootstrap`, `/api/v1/*`, and `/api/v1/ws`.
- Fold browser serving into the remote API host path instead of continuing to expose `mobile/dist-web` on the separate 8788/9443 web-driver topology.
- Add a lightweight hosted-web auth gate in the main app so an unauthenticated browser can complete pairing on the same origin, receive the existing HttpOnly cookie, then re-bootstrap into `same_origin_cookie` mode.
- Keep `mobile/` as the paired-client codebase for Android/iOS and, if its browser build stays at all, make it explicit dev/QA-only paired-client tooling rather than Orchestra’s default browser entrypoint.
- Validate on a live Orchestra host by enabling remote access in the desktop app, opening the exposed browser URL, completing the hosted-web auth flow, and asserting the loaded UI is the main shared app rather than the legacy web-driver bundle.

## Executive summary

The repo already has almost everything needed for the desired browser architecture, but it is split across the wrong runtime path. The main app can already run in `hosted_web` mode (`src/main.tsx`, `src/lib/orchestraClient/hostedWeb.ts`), and the remote API already exposes the same-origin bootstrap/auth contract (`/api/v1/frontend/bootstrap`, cookie-aware auth resolution, `/api/v1/ws`). The remaining gap is that Orchestra’s actual host-exposed browser URL still comes from `src-tauri/src/services/remote_api.rs` serving `mobile/dist-web` on the separate remote-web server (`127.0.0.1:8788` / Tailscale `9443`), while the desktop packaging and Remote settings copy still describe that legacy “shared web driver” flow.

ORC-128 should therefore be implemented as a production-entrypoint migration, not as another browser-capability spike. The production host should serve the main `dist/` app from the remote API origin, the main app should own the browser pairing/auth bootstrap flow, and the mobile/browser driver surface should stop being the default product browser URL.

## Current repo footing

### Already in place

- Main shared frontend hosted-web bootstrap path:
  - `src/main.tsx`
  - `src/lib/orchestraClient/hostedWeb.ts`
  - `src/lib/orchestraClient/remoteApiTransport.ts`
- Same-origin hosted-web backend contract already exists:
  - `src-tauri/src/services/remote_api.rs`
  - `/api/v1/frontend/bootstrap`
  - cookie-first auth resolution with bearer/query-token fallback
  - `POST /api/v1/pair/complete` already sets the HttpOnly auth cookie
- Hosted-web E2E already proves the correct topology in a non-production harness:
  - `scripts/run-hosted-web-e2e.sh`
  - `src-tauri/src/services/remote_api.rs::run_hosted_web_e2e_server()`
  - `tests/hosted-web-e2e/*`

### Still pointing at the legacy browser surface

- Separate browser server and ports in `src-tauri/src/services/remote_api.rs`:
  - `resolve_mobile_web_root(...)`
  - `start_remote_web_server(...)`
  - `REMOTE_WEB_PORT = 8788`
  - `REMOTE_WEB_TAILSCALE_PORT = 9443`
- Desktop packaging/build wiring still bundles the browser-facing `mobile/dist-web` assets:
  - `src-tauri/build.rs`
  - `src-tauri/tauri.conf.json`
- Remote settings and docs still describe the product browser URL as the shared web driver:
  - `src/settings/RemotePanel.tsx`
  - `src/lib/remote.ts`
  - `src/types.ts`
  - `README.md`
  - `mobile/README.md`
- Browser validation still treats the old paired-client surface as the exposed browser entrypoint:
  - `playwright.web-driver.config.ts`
  - `tests/web-driver-e2e/pairing.spec.ts`
  - `tests/ui-coverage-matrix.json`

## Migration decision

### Product-facing browser entrypoint

The host-exposed browser URL should become the main shared Orchestra app from `src/`, built with `VITE_ORCHESTRA_HOST_MODE=hosted_web` and served from the same origin as the remote API.

### Fate of the legacy `mobile/` browser surface

Keep `mobile/` as the paired-client codebase for Android/iOS. If the browser-targeted Expo build remains, it should be treated as an explicitly separate paired-client/dev/QA surface only. It should no longer be:

- bundled as Orchestra’s packaged remote browser app
- auto-exposed by Remote settings/Tailscale Serve as the primary browser URL
- described to users as the shared Orchestra browser experience

That yields a clean product split:

- **Hosted Orchestra web app** → main `src/` app, same-origin, cookie-backed browser session
- **Mobile paired client** → native mobile app, plus optional explicitly scoped browser/dev harness if retained

## Implementation plan

### 1. Serve the main hosted-web app from the remote API origin

Replace the separate remote-web-driver serving path with a same-origin hosted-web path rooted in the main frontend build.

Concrete work:

- Add a production `resolve_hosted_web_root(...)` helper that resolves the main built frontend assets from packaged resources or the repo `dist/` directory.
- Reuse the `run_hosted_web_e2e_server()` serving shape in production: API routes remain explicit, then `/` and non-API frontend routes fall back to the hosted-web static bundle.
- Remove the dedicated `start_remote_web_server(...)` / `stop_remote_web_server(...)` product path and the fixed 8788/9443 browser topology from remote-access management.
- Keep `/api/v1/frontend/bootstrap`, `/api/v1/*`, and `/api/v1/ws` on that same origin.

Primary files:

- `src-tauri/src/services/remote_api.rs`
- `src-tauri/src/state.rs` if remote web server state is removed

### 2. Switch build and packaged-resource wiring to the main app

The packaged remote browser assets should come from the main shared frontend build, not from `mobile/dist-web`.

Concrete work:

- Make the packaged frontend build explicit: `VITE_ORCHESTRA_HOST_MODE=hosted_web npm run build`.
- Bundle a hosted-web resource sourced from the main app build output so the remote server can serve filesystem-visible static assets in packaged mode.
- Remove the `mobile/dist-web` fallback/resource wiring that only exists to keep the old browser entrypoint alive.
- Update artifact scanning/release expectations anywhere they currently treat `mobile/dist-web` as part of the product browser packaging path.

Primary files:

- `src-tauri/build.rs`
- `src-tauri/tauri.conf.json`
- `package.json`
- `scripts/scan-release-artifacts.sh`
- any release/build docs that mention packaged `mobile/dist-web`

### 3. Add the hosted-web auth gate inside the main app

Today the hosted-web main app works once a cookie already exists, but the production browser entrypoint still needs a first-run auth/pairing path.

Concrete work:

- When hosted-web bootstrap returns `authMode: "none"`, render a lightweight hosted-web connection/auth gate from the main `src/` app instead of dumping the user into an unauthorized shell.
- Use the existing same-origin `POST /api/v1/pair/complete` flow to exchange the pairing code, let the backend set the HttpOnly cookie, then re-bootstrap into `same_origin_cookie` mode.
- Keep mobile/native bearer-token pairing behavior unchanged.
- Avoid importing the `mobile/` shell as the browser entrypoint; at most, reuse isolated pairing form logic if that meaningfully reduces duplication.

Primary files:

- `src/main.tsx`
- hosted-web bootstrap/auth helpers under `src/lib/orchestraClient/`
- a new small hosted-web auth screen/component under `src/`
- `src-tauri/src/services/remote_api.rs` only where backend response details need small adjustments

### 4. Rewrite remote-access UX and Tailscale integration around the hosted Orchestra web app

The settings surface and user instructions should stop teaching users to open a separate shared web-driver URL.

Concrete work:

- Replace “shared web driver” terminology with “Hosted Orchestra web app” / “browser app” in `RemotePanel` and docs.
- Collapse endpoint presentation around the same-origin browser/API model. If a distinct browser URL field remains in types, it should still resolve to the same origin as the API rather than a separate 9443/8788 surface.
- Update Tailscale Serve wiring so the exposed browser experience comes from the same port/origin as the remote API instead of a second HTTPS browser port.
- Keep any remaining mobile pairing instructions explicit: they are for the mobile paired client, not Orchestra’s primary browser surface.

Primary files:

- `src/settings/RemotePanel.tsx`
- `src/lib/remote.ts`
- `src/types.ts`
- `README.md`
- `mobile/README.md`
- `src-tauri/src/services/remote_api.rs`

### 5. Make any surviving `mobile/` browser support explicit and separate

If the Expo web build remains, rename its role everywhere it is user-visible so it is not confused with the hosted Orchestra app.

Concrete work:

- Remove product/user-facing references that imply the `mobile/` web build is Orchestra’s primary browser UI.
- Either rename the browser-specific harness/tests/copy away from “shared web driver”, or remove them if they no longer justify maintenance.
- Ensure the mobile paired-client browser flow is not bundled, auto-served, or recommended from the desktop host.

Likely files:

- `playwright.web-driver.config.ts`
- `scripts/run-web-driver-e2e.sh`
- `tests/web-driver-e2e/*`
- `tests/ui-coverage-matrix.json`
- `mobile/README.md`

### 6. Add live-host validation for the new browser entrypoint

The new validation needs to prove the production remote host now exposes the main shared frontend end-to-end.

Concrete work:

- Add a live-host browser validation that:
  1. starts a real Orchestra host
  2. enables remote access from the desktop app
  3. opens the exposed browser URL
  4. completes the hosted-web pairing/auth flow
  5. confirms the loaded UI is the main app shell (`Tasks`, `Inbox`, `Sessions`, `Settings`, etc.), not the mobile/web-driver pairing shell
  6. confirms bootstrap/auth/websocket behavior works on the served origin
- Extend lower-level route/probe coverage so production serving asserts the root HTML/static bundle comes from the hosted-web app path rather than the legacy mobile bundle.

Primary files:

- `tests/desktop-e2e/remote-access.test.ts` or a new dedicated remote-hosted-web desktop/browser test
- `src-tauri/src/services/remote_api.rs` route probes/tests
- any packaged-runtime or release-validation runbooks that should exercise the exposed browser app

## Suggested delivery order

1. Replace serving/build/resource wiring.
2. Add the hosted-web auth gate.
3. Rewrite Remote settings/docs/Tailscale UX.
4. Cleanly separate or retire the `mobile/` browser surface.
5. Land live-host validation.

## Acceptance mapping

- **Main `src/` app is the exposed browser URL**
  - production serving comes from the hosted-web main frontend build, not `mobile/dist-web`
- **Same-origin hosted-web topology is used**
  - root, bootstrap, API, and websocket all share one browser origin
- **Remote settings/docs no longer point users at the shared web driver**
  - copy and endpoint presentation describe the hosted Orchestra web app instead
- **Any remaining `mobile/` browser support is explicit**
  - no longer primary, packaged, or auto-exposed
- **Validation proves the real host works**
  - live-host browser test exercises auth/bootstrap and confirms the main shared UI loads
