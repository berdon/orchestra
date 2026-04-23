# ORC-50 — OAuth auth UX polish, reset controls, and device-code entry plan

## Goal

Polish the ORC-45 Settings → Pi provider-auth experience so OAuth/device-code connect flows feel intentional instead of transport-driven.

This task should deliver:

- clean success resolution instead of a lingering finished OAuth panel
- no raw auth URL dumping in the UI
- explicit reset controls for provider auth state
- a clear primary connect action with optional device-code alternatives where supported
- concise, user-facing copy for connected / in-progress / error states
- regression coverage for the main auth UX states

## Relationship to ORC-45

ORC-45 landed the functional baseline for Orchestra-managed Pi auth and OAuth setup. ORC-50 is a focused polish/fix task on top of that work, not a greenfield feature.

The relevant current implementation is now on `origin/main` and primarily lives in:

- `src/settings/PiPanel.tsx`
- `src/App.tsx`
- `src/lib/tauri.ts`
- `src/types.ts`
- `src-tauri/src/services/pi_setup.rs`
- `src-tauri/src/services/pi_oauth.rs`
- `src-tauri/scripts/pi_oauth_helper.mjs`

## Current diagnosed gaps

### 1) Success is treated like a durable render state instead of a transient resolution

Current behavior:

- `src-tauri/src/services/pi_oauth.rs` marks the flow `succeeded`
- `src/App.tsx` refreshes Pi setup state via the `orchestra:pi-setup-change` event
- `src/settings/PiPanel.tsx` keeps rendering the global flow section while `piOAuthFlowState` exists

That means the UI can show a contradictory state like:

- `Connected`
- the raw auth URL
- browser-open helper text
- old progress copy such as `Starting OpenAI Codex sign-in…`

This is the core cause of the reported “completed in browser, but Orchestra still looks mid-flow” bug.

### 2) Dismiss is frontend-local only

`src/App.tsx` currently implements dismiss as:

- `setPiOAuthFlowState(null)`

but `src-tauri/src/services/pi_oauth.rs` keeps the finished flow in the backend `ACTIVE_FLOW` slot.

So:

- reloads
- revisiting Settings → Pi
- re-fetching `get_pi_oauth_flow_state`

can rehydrate the finished flow and bring the janky panel back.

### 3) The UI is rendering transport details, not product-level auth state

`src/settings/PiPanel.tsx` currently shows:

- `Auth URL: <full URL>`
- browser-open bookkeeping text
- generic latest progress text
- generic prompt text

This is useful for debugging, but it is not good product UI. In particular, the raw URL dump is noisy and visually low quality.

### 4) Provider metadata is too coarse for a polished connect affordance

`src-tauri/src/services/pi_setup.rs` and `src/types.ts` currently expose only:

- `authModes`
- `usesCallbackServer`

That is enough to decide “API key vs OAuth”, but not enough to decide:

- which OAuth method is the default
- whether a provider also supports device-code auth
- whether the UI should show a single connect button or a split-button/dropdown
- what label each method should use

### 5) The helper/event bridge is still generic at the wrong layer

`src-tauri/scripts/pi_oauth_helper.mjs` and `src-tauri/src/services/pi_oauth.rs` currently normalize auth progress into broad events like:

- `auth { url, instructions }`
- `prompt`
- `progress`
- `success`

That is enough to make the flow work, but not enough to render a polished device-code UX because the UI has to infer meaning from free-form text like `Enter code: XXXX`.

### 6) The current top-of-panel OAuth section is the wrong visual container

The active OAuth flow is rendered as a global section above the provider cards. That makes the flow feel detached from the provider that owns it and increases the chance that a finished flow looks like a stale banner instead of an inline provider-state transition.

### 7) Browser-mode mock parity is not strong enough yet

`src/lib/tauri.ts` still models Pi OAuth state with the old coarse shape and incomplete provider coverage. That will block reliable browser-mode UI tests unless we upgrade the mock data and mock transitions at the same time as the real implementation.

## Product decisions

## 1) Provider cards should own the auth UX

Remove the current global top-of-panel OAuth flow presentation.

Instead:

- each OAuth-capable provider card owns its own connect/reset state
- the active flow renders inline inside the provider card that started it
- disconnected, connecting, connected, failed, and cancelled states are all visible in the same provider-local context

Why:

- it makes the state transition obvious
- it keeps the success state close to the resulting connected card
- it avoids a detached “OAuth flow” panel that can linger after the real action is done

## 2) Successful auth should resolve into provider state, not remain as a persistent flow panel

Success should be treated as a transient completion event.

Recommended semantics:

1. the helper completes successfully
2. Orchestra refreshes Pi setup state
3. if the provider now reports `connected && usingOAuth`, the flow is cleared from backend state
4. the UI collapses to the normal connected provider card

Important rule:

- a successful OAuth flow should **not** remain reload-persistent in `get_pi_oauth_flow_state()`

If we want positive confirmation, it should be:

- a short-lived inline success flash, or
- a toast / ephemeral status message,

not a durable success panel with raw flow details.

## 3) Failed and cancelled flows should remain dismissible until cleared intentionally

Unlike success, terminal non-success states are still useful to show until the user reacts.

Recommended semantics:

- `failed` and `cancelled` may remain visible inline on the provider card
- they must offer a clear next action:
  - `Try again`
  - `Reset`
  - `Dismiss`
- dismissing a terminal flow must clear the backend flow registry, not only local React state

## 4) Reset is the explicit user control for clearing provider auth state

Add reset controls for provider auth areas.

Recommended semantics:

### OAuth providers

- `Cancel`
  - only available while a flow is in progress
  - stops the running flow
  - does not silently delete an already-working stored credential

- `Reset`
  - clears stored Orchestra-managed auth for that provider
  - clears any finished flow state for that provider
  - returns the provider card to a clean disconnected state

### API-key providers

Use the same explicit reset language for consistency:

- `Reset` clears the stored API key for that provider

This is better than a mix of `Disconnect`, `Dismiss`, and implicit clearing behavior.

## 5) The raw auth URL should never be shown as plain inline text

Browser-based flows should render:

- a labeled link/button such as `Open browser sign-in`
- concise helper copy such as `If nothing opened automatically, use the link above.`

Device-code flows should render:

- a labeled link/button such as `Open verification page`
- the user code as its own first-class field
- a copy button for the user code

The actual URL may still exist in the DOM as the anchor target, but the user-facing text should never dump the full raw URL.

## 6) Device-code-capable providers need explicit auth-method metadata

Add a finer-grained auth-method model.

Recommended frontend/backend shape:

```ts
interface PiProviderAuthMethodSummary {
  id: string; // e.g. "browser_oauth" | "device_code"
  label: string; // e.g. "Browser sign-in" | "Device code auth"
  kind: "browser" | "device_code";
  isDefault: boolean;
}

interface PiProviderSetupSummary {
  id: string;
  name: string;
  authModes: string[];
  connected: boolean;
  usingOAuth: boolean;
  modelCount: number;
  usesCallbackServer: boolean;
  oauthMethods?: PiProviderAuthMethodSummary[];
}
```

Important UI rule:

- if `oauthMethods.length <= 1`, show a normal single connect button
- if `oauthMethods.length > 1`, show a split-button / combo-button:
  - primary action starts the default method
  - dropdown shows alternate methods such as `Device code auth`

That gives us the requested UX without forcing a dropdown for providers that only have one valid method.

## 7) Current built-ins should degrade sensibly

The method model must handle three real cases:

### A. Browser/callback only

Example: current callback-server providers.

UI:

- single `Connect` or `Connect subscription` button
- no dropdown

### B. Device-code only

Example: current GitHub Copilot shape.

UI:

- single connect button
- provider description explains that verification uses a device code
- inline flow shows verification URL + user code

### C. Browser + device-code both supported

UI:

- split-button / combo-button
- primary uses default method
- alternate method shown in dropdown

If no currently bundled provider falls into case C yet, we should still implement the generic split-button infrastructure now so the UI is ready as soon as a provider advertises both methods.

## 8) Device-code data must be structured, not parsed from free-form instructions

Extend the helper-to-backend event model so the frontend gets normalized auth-step data.

Recommended shape:

```ts
interface PiOAuthAuthStep {
  kind: "browser" | "device_code";
  url: string;
  linkLabel: string;
  instructions?: string | null;
  userCode?: string | null;
}
```

Then `PiOAuthFlowState` should carry that structured step instead of unrelated top-level fields only:

```ts
interface PiOAuthFlowState {
  providerId: string;
  providerName: string;
  methodId: string;
  methodKind: "browser" | "device_code";
  status: string;
  authStep?: PiOAuthAuthStep | null;
  prompt?: PiOAuthPromptState | null;
  latestProgressMessage?: string | null;
  error?: string | null;
  startedAt: string;
  finishedAt?: string | null;
}
```

Important implementation note:

- the frontend should not parse `Enter code: ...` out of free-form provider instructions
- helper-side provider-specific normalization is the correct place to convert Pi/provider callbacks into Orchestra UI semantics

This matches the original ORC-45 plan direction better than the current generic payload.

## 9) Copy must become product copy

Replace current debug-style copy with concise user-facing copy.

### Current style to avoid

- `Orchestra is running the provider sign-in flow against its managed Pi auth storage.`
- `Auth URL: ...`
- `Orchestra attempted to open your browser automatically.`
- raw transport/progress fragments lingering after completion

### Recommended style

- `Connect your OpenAI Codex account`
- `Finish sign-in in your browser.`
- `If nothing opened automatically, use the link above.`
- `Paste the redirect URL if you completed sign-in on another device.`
- `Enter the device code on the verification page.`
- `Connected`
- `Couldn’t finish sign-in. Try again or reset this connection.`

## State model

## Provider-card state precedence

For each provider card, render state in this order:

1. active flow for this provider
2. terminal failed/cancelled flow for this provider
3. connected via OAuth
4. connected via API key
5. disconnected

That precedence avoids ambiguous combinations like “Connected” plus a stale old flow panel.

## Flow-status semantics

Recommended status set:

- `starting`
- `running`
- `awaiting_input`
- `awaiting_confirmation`
- `failed`
- `cancelled`

`Succeeded` should be treated as a transient handoff, not a stable reload-persistent state.

If we keep `succeeded` in transport, it should only exist long enough to:

- trigger setup refresh
- clear the backend flow slot
- update the UI to provider-connected state

## Backend/API changes

## 1) Replace local-only dismiss with a real backend clear command

Add:

- `dismiss_pi_oauth_flow()` in `src-tauri/src/commands/app.rs`
- matching `pi_oauth::dismiss_flow()` in `src-tauri/src/services/pi_oauth.rs`
- `dismissPiOAuthFlow()` in `src/lib/tauri.ts`

Rules:

- dismiss only applies to finished flows
- active flows still use `cancel`
- dismiss clears the backend slot and emits `orchestra:pi-oauth-flow-change` with `null`

## 2) Consider a provider-scoped reset command

Recommended:

- `reset_pi_provider_auth(providerId)`

Behavior:

- remove the stored credential for the provider
- clear any retained finished flow for the same provider
- emit both setup and flow change events as needed

This is safer and clearer than making the frontend compose multiple calls in the right order.

## 3) Extend `start_pi_oauth_flow`

Change from:

- `start_pi_oauth_flow(providerId)`

To:

- `start_pi_oauth_flow(providerId, methodId?)`

The backend should default to the provider’s primary method when `methodId` is omitted.

## 4) Upgrade the helper event schema

Current event shape is too generic.

Add distinct normalized auth-step payloads so the frontend knows whether it is rendering:

- browser sign-in
- callback/manual paste fallback
- device-code verification

This normalization should happen in `src-tauri/scripts/pi_oauth_helper.mjs`, not in React.

## 5) Keep the flow registry genuinely ephemeral

`src-tauri/src/services/pi_oauth.rs` should treat the registry as in-memory transient UI state:

- active while a flow is running
- optionally retained for failed/cancelled states until dismissed
- cleared automatically after success resolution

It should not act like stored historical provider state.

## Helper/runtime changes

## 1) Method-aware helper dispatch

`src-tauri/scripts/pi_oauth_helper.mjs` should accept the selected auth method.

Recommended CLI input:

- `--provider-id`
- `--method-id`

Dispatch strategy:

- default browser flow can continue using the current `AuthStorage.login(providerId, callbacks)` path where appropriate
- device-code alternate methods should be dispatched explicitly so Orchestra can emit structured device-code data and persist the result into `AuthStorage`

## 2) Provider-specific normalization is acceptable here

This helper is already the Orchestra ↔ Pi integration boundary.

It is the correct place to handle cases like:

- GitHub Copilot emitting a verification URL + user code
- callback-server providers needing manual redirect/code paste fallback

We should not leak that provider-specific normalization into Rust models or the React layer.

## Frontend/UI changes

## 1) Redesign `src/settings/PiPanel.tsx`

Main changes:

- remove the current global OAuth-flow section
- render flow state inline inside the active provider card
- replace raw auth URL rendering with labeled link/button copy
- add reset actions
- add split-button/combo-button affordance when a provider exposes more than one OAuth method

## 2) Make provider cards the single source of truth

Each provider card should decide between:

- connect controls
- inline active flow
- connected summary + reset
- inline error/cancel state + retry/reset/dismiss

The user should never have to mentally join a provider card with a detached global flow box.

## 3) Update `src/App.tsx`

Needed changes:

- wire the new dismiss command instead of local-only `setPiOAuthFlowState(null)`
- when a success event arrives, refresh Pi setup state and allow the flow to clear cleanly
- keep any local temporary busy state needed so the provider card does not flicker back to disconnected between success and setup refresh

## 4) Upgrade browser-mode mock parity in `src/lib/tauri.ts`

The mock needs to support:

- OAuth-capable providers in `availableProviders`
- method metadata (`oauthMethods`)
- device-code-style flow state
- reset/dismiss behavior
- success clearing behavior

Without that, the requested UI regression coverage will not be trustworthy.

## Likely file touchpoints

### Frontend

- `src/settings/PiPanel.tsx`
- `src/App.tsx`
- `src/lib/tauri.ts`
- `src/types.ts`
- optionally a new small reusable control/component for split-button or auth-step presentation if `PiPanel.tsx` gets too large

### Backend

- `src-tauri/src/models.rs`
- `src-tauri/src/commands/app.rs`
- `src-tauri/src/services/pi_setup.rs`
- `src-tauri/src/services/pi_oauth.rs`
- `src-tauri/scripts/pi_oauth_helper.mjs`
- `src-tauri/src/lib.rs` command registration

## Test plan

## 1) UI/browser-mode regression coverage

Add browser-mode Playwright coverage for Settings → Pi because the requested UX changes are mostly React/UI semantics and mock mode is the fastest way to lock them down.

Representative cases:

1. **successful browser OAuth resolves cleanly**
   - start a provider connect flow
   - complete the mock success path
   - assert the provider card moves to `Connected`
   - assert the old flow UI no longer remains visible

2. **raw auth URL is not displayed as inline text**
   - assert there is no visible `Auth URL:` label
   - assert the visible link text is product copy such as `Open browser sign-in`

3. **reset clears provider state**
   - connect a provider
   - click `Reset`
   - assert the provider returns to disconnected state
   - assert any finished flow state is gone

4. **device-code option appears when supported**
   - for a provider with device-code support in mock data, assert the correct connect affordance is present
   - if the provider has both browser + device-code methods, assert the split-button menu exposes `Device code auth`
   - if the provider is device-code only, assert the card renders device-code-specific flow copy instead of a browser-only UI

5. **unsupported providers do not show device-code controls**
   - assert providers without device-code support do not render the alternate method UI

## 2) Backend/service tests

Add focused Rust tests for `pi_oauth` flow lifecycle:

- dismiss clears finished flow state
- success clears the ephemeral flow after resolution
- cancel keeps the flow as terminal `cancelled` until dismissed
- reset clears provider credential + related retained flow state

## 3) Mock parity tests

Add or extend TypeScript mock tests so browser-mode and Tauri-mode semantics stay aligned for:

- provider auth-method metadata
- success clearing behavior
- reset behavior
- device-code state shape

## Implementation sequence

## Slice 1 — state/model groundwork

- add provider auth-method metadata
- extend `PiOAuthFlowState` with structured auth-step fields
- update mock/provider catalog shapes

## Slice 2 — backend flow lifecycle fix

- add real dismiss/clear behavior
- stop treating success as a persistent flow state
- add provider reset semantics

## Slice 3 — helper event normalization

- make helper method-aware
- emit structured browser/device-code auth-step data

## Slice 4 — PiPanel redesign

- move flow rendering into provider cards
- add reset controls
- replace raw URL text with labeled links
- add split-button/multi-method affordance

## Slice 5 — regression coverage

- browser-mode Playwright coverage for the UI behavior
- targeted Rust/service coverage for lifecycle fixes
- mock parity updates

## Review/acceptance mapping

This plan satisfies the requested acceptance criteria by making these rules explicit:

- **successful browser OAuth completion resolves cleanly**
  - success is transient and collapses into normal connected provider state
- **raw auth URL is no longer dumped inline**
  - only labeled links/buttons remain visible
- **auth areas have reset controls**
  - reset is a first-class provider action
- **device-code-capable providers expose a clear option**
  - provider metadata drives single-button vs split-button behavior
- **unsupported providers do not show unsupported controls**
  - device-code UI only appears when `oauthMethods` advertises it
- **copy is concise and user-facing**
  - debug/transport strings are removed from the UI surface
- **automated coverage prevents regression**
  - browser-mode UI tests + focused backend lifecycle tests
