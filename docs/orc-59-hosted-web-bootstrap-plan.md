# ORC-59 hosted-web frontend bootstrap and auth negotiation plan

## tl;dr

- Add a hosted-web bootstrap endpoint at `/api/v1/frontend/bootstrap` on the same origin as the remote API.
- Extend the shared bootstrap auth model so hosted web can say `same_origin_cookie`, while paired/device contexts keep `bearer_token` and pre-auth bootstrap stays `none`.
- Keep the browser-first hosted-web path cookie-backed and same-origin; keep the existing mobile/shared-web-driver path bearer-token based.
- Make hosted-web startup explicitly fetch bootstrap and build a remote binding before rendering, instead of treating every non-Tauri browser runtime as `mock`.

## Executive summary

The repo now has the shared `OrchestraClient` seam from ORC-57, but hosted web still has no canonical bootstrap/auth story. `src/lib/orchestraClient/defaultClient.ts` maps every non-Tauri runtime to `mock`, `mobile/src/api.ts` still derives API/WS behavior from an entered base URL plus bearer token storage, and `src-tauri/src/services/remote_api.rs` exposes remote routes without a shared frontend bootstrap route or cookie-aware auth negotiation. ORC-59 should close that gap by defining one hosted-web bootstrap contract, one explicit browser auth strategy, and one initialization path that hands the shared frontend a real `remote_api` binding instead of falling back to mock heuristics.

## Current gaps in the repo

1. **Hosted web cannot enter through the shared client seam yet.**
   - `src/lib/orchestraClient/defaultClient.ts` resolves `hostKind` as `tauri` or `mock` only.
   - `src/main.tsx` always mounts `OrchestraClientProvider` with the default binding, so the browser path never negotiates a remote bootstrap.

2. **Remote endpoint discovery is ad hoc.**
   - `mobile/src/api.ts` infers websocket URLs from the entered API base URL and stores the token/base URL pair directly in client storage.
   - `src-tauri/src/services/remote_api.rs` has `/api/v1/app-info` and `/api/v1/pair/complete`, but no canonical frontend bootstrap route returning the ORC-57 bootstrap shape.

3. **Browser auth transport is implicit and bearer-only today.**
   - `resolve_remote_auth(...)` in `src-tauri/src/services/remote_api.rs` accepts `Authorization: Bearer ...` or a websocket `?token=` query parameter.
   - There is no cookie-backed same-origin path for a hosted browser frontend.

4. **The current web-served remote client is the wrong origin model for cookie auth.**
   - The existing mobile/shared web driver is served separately from the API (`mobile/dist-web` on the dedicated remote web port / Tailscale 9443 path).
   - That is fine for paired bearer-token clients, but it is not the first-class same-origin hosting model the shared Orchestra frontend needs.

## Proposed hosted-web bootstrap contract

### Endpoint

Add a public bootstrap route:

- `GET /api/v1/frontend/bootstrap`

This should return the shared `OrchestraClientBootstrap` payload that ORC-57 introduced, filled with hosted-web values.

### Contract adjustments

ORC-59 should extend the shared auth union in `src/lib/orchestraClient/bootstrap.ts` from:

- `desktop_session`
- `bearer_token`
- `none`

to:

- `desktop_session`
- `same_origin_cookie`
- `bearer_token`
- `none`

Because that changes the shared contract surface, ORC-59 should bump `ORCHESTRA_CLIENT_CONTRACT_VERSION` when the code lands.

### Expected hosted-web payload

```ts
interface OrchestraClientBootstrap {
  contractVersion: "<next contract version>";
  bootstrappedAt: string;
  hostKind: "remote_api";
  authMode: "same_origin_cookie" | "bearer_token" | "none";
  urls: {
    apiBaseUrl: string;
    websocketUrl: string;
  };
  featureFlags: OrchestraClientFeatureFlags;
  capabilities: OrchestraClientCapabilities;
  appInfo: AppInfo | null;
}
```

### Bootstrap population rules

- `hostKind` should be `remote_api` for the hosted-web path.
- `urls.apiBaseUrl` and `urls.websocketUrl` should be explicit absolute URLs derived from the request origin / forwarded headers, not reconstructed in frontend code.
- `featureFlags` / `capabilities` should reflect remote-host reality:
  - shared task/inbox/session/catalog capabilities enabled only when the remote API actually exposes them
  - desktop-only host capabilities marked unavailable with explicit reasons
- `authMode` should describe the current negotiated browser/device transport:
  - `same_origin_cookie` when the request is already authenticated via a valid hosted-web cookie
  - `bearer_token` when the request carries a valid bearer/device token
  - `none` when bootstrap is being read before authentication/pairing completes
- When `authMode` is `none`, protected capabilities should come back as unavailable/unknown with an authentication-required reason instead of pretending the host is fully ready.

## Auth and session negotiation strategy

### Preferred hosted-web path: `same_origin_cookie`

This should be the first-class browser-hosted mode for the shared Orchestra frontend.

Behavior:

- the shared frontend bundle is served from the same origin as `/api/v1/*`
- auth is carried in an HttpOnly cookie
- browser HTTP calls use `credentials: "same-origin"`
- browser websocket connections use the bootstrapped `websocketUrl` and rely on the cookie on the handshake
- no JS-managed bearer token is required for the normal hosted-web path

Implementation note:

- the first cut does **not** need a totally separate browser-session database
- ORC-59 can reuse the existing remote device token model in `remote_access.rs` and allow the backend to transport that token via an HttpOnly cookie for hosted-web requests

That keeps the security model explicit without inventing a second auth store.

### Explicit device / cross-origin path: `bearer_token`

This preserves the current remote/mobile/shared-web-driver behavior.

Behavior:

- mobile/native and explicit token-driven browser contexts keep using the pairing/device token returned by `/api/v1/pair/complete`
- HTTP uses `Authorization: Bearer ...`
- websocket auth can keep the current query-token compatibility path initially, then be tightened later if the transport changes

This mode remains important because the existing remote driver and paired-device flows are not the same product surface as the hosted same-origin shared frontend.

### Pre-auth bootstrap path: `none`

This is the explicit unauthenticated bootstrap state.

Behavior:

- bootstrap is readable before the frontend is authenticated
- the frontend can still learn contract version, host kind, URLs, and the expected auth negotiation mode
- protected domain calls are not assumed to work yet

This keeps the app from encoding hidden “if browser then maybe remote” logic.

## Serving and origin strategy

ORC-59 should make the shared Orchestra hosted-web frontend a **same-origin** client of the remote API.

### Recommended rule

- serve the shared Orchestra frontend bundle from the same origin that serves `/api/v1/frontend/bootstrap`, `/api/v1/...`, and `/api/v1/ws`

### Important boundary

Do **not** treat the existing `mobile/dist-web` remote-driver server as the long-term hosted-web entry for the shared frontend contract.

Why:

- it is intentionally a separate origin/port topology today
- it fits bearer-token pairing well
- it fights the cookie-backed same-origin browser story ORC-59 needs

So the clean split is:

- **shared Orchestra hosted web** → same-origin, bootstrap-driven, cookie-first
- **existing mobile/shared web driver** → paired bearer-token client, can continue to exist during migration

## Shared frontend initialization flow

ORC-59 should make hosted-web startup explicit instead of letting `OrchestraClientProvider` default to mock.

### Proposed startup sequence

1. resolve the frontend host mode explicitly (`tauri`, `hosted_web`, or `mock`)
2. when mode is `hosted_web`, fetch `/api/v1/frontend/bootstrap`
3. construct the remote binding from that bootstrap + negotiated auth mode
4. pass the resolved binding into `OrchestraClientProvider`
5. render the shared app

### Why this matters

This removes the current implicit rule that “browser and not Tauri” means mock.

### Practical shape

Keep the provider seam from ORC-57, but move hosted-web binding resolution **before** render in `src/main.tsx` (or a dedicated hosted-web entry/bootstrap helper). That keeps the provider simple and makes the remote bootstrap path explicit.

### Mock mode

Mock must remain explicit for tests/dev.

Do not replace the current browser test/dev flow with runtime guessing. Use an explicit mock entry, flag, or bootstrap resolver branch so browser-hosted tests keep deterministic mock behavior.

## Backend changes to plan for

### `src-tauri/src/services/remote_api.rs`

Add or change:

- `/api/v1/frontend/bootstrap`
- cookie-aware auth resolution ordering
  - cookie first for hosted-web browser sessions
  - bearer header second
  - websocket query token last for compatibility
- same-origin bootstrap URL construction using forwarded/request headers
- hosted-web websocket URL construction from the same negotiated origin
- CORS handling that does **not** accidentally combine wildcard origins with credentialed cookie auth

### `src-tauri/src/services/remote_access.rs`

Keep `/api/v1/pair/complete` backward-compatible for bearer-token clients, but allow hosted-web auth completion to also establish the cookie-backed browser session.

That means ORC-59 should preserve the JSON token response while optionally setting the hosted-web cookie when the request is part of the same-origin browser flow.

### Shared type surface

Update the bootstrap/auth contract in:

- `src/lib/orchestraClient/bootstrap.ts`
- `src/lib/orchestraClient/client.ts` if needed for hosted-web binding helpers
- `src/types.ts`
- `src-tauri/src/models.rs`

## Frontend/client files likely impacted

- `src/lib/orchestraClient/bootstrap.ts`
- `src/lib/orchestraClient/provider.tsx`
- `src/main.tsx`
- new hosted-web bootstrap / binding helper(s) under `src/lib/orchestraClient/`
- `src-tauri/src/services/remote_api.rs`
- `src-tauri/src/services/remote_access.rs`
- `src-tauri/src/models.rs`

ORC-61 can then consume the finished bootstrap/auth contract to build `RemoteApiOrchestraClient` cleanly.

## Validation plan

### Backend

- Rust route tests for `/api/v1/frontend/bootstrap`
- tests for auth negotiation precedence: cookie vs bearer header vs websocket token
- tests for forwarded-origin URL generation (`http` vs `https`, host/forwarded header cases)

### Frontend/shared client

- TS tests for the expanded auth-mode union and contract-version bump
- tests for hosted-web binding resolution so browser-hosted startup no longer falls through to mock
- remote adapter tests that verify:
  - `same_origin_cookie` uses credentials-based HTTP/WS behavior
  - `bearer_token` uses explicit bearer transport behavior

### Browser-hosted coverage

- end-to-end test that loads the hosted-web frontend, reads bootstrap, authenticates through the intended browser flow, and confirms the app uses the bootstrapped API/WS URLs
- regression coverage that the legacy bearer-token remote driver flow still pairs and connects

## Handoff / sequencing

- ORC-59 should land the bootstrap route, auth negotiation contract, and hosted-web initialization seam.
- ORC-61 should consume that bootstrap output to implement `RemoteApiOrchestraClient`.
- ORC-62 should expand the remote API surface behind the same negotiated auth/bootstrap model.

That keeps ORC-59 narrowly focused on the explicit bootstrap/config/auth handshake while still giving the follow-on adapter/API tasks a concrete contract to build against.
