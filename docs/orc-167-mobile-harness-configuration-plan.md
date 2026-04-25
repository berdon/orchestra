# ORC-167 Mobile Harness configuration plan

## tl;dr

Expose Harness configuration in the mobile/hosted UX by making the existing Harness settings surface reachable from mobile navigation and by adding the missing hosted-web Harness transport. Keep desktop Tauri behavior intact, and lock the flow down with mobile Playwright plus remote-client/API coverage.

## Executive summary

Current audit: `Settings → Harness` and `HarnessPanel` already exist for Tauri/mock, and the mobile navigation sheet can show settings sections when `supportsHarnessSettings` is true. The remaining gap is that the real hosted/mobile client is `remote_api`, where `host.harnessSettings` is still marked unavailable and `createRemoteApiOrchestraClientBinding` exposes no `hostAdmin.harness` implementation. There are also a few navigation/layout sharp edges in the shared mobile UI.

## Current-state findings

- Frontend IA exists: `src/types.ts`, `src/App.tsx`, `src/settings/HarnessPanel.tsx`, and `src/settings/PiPanel.tsx` define a Harness settings tab with runtime, auth, models, legacy import, and OAuth controls.
- Mobile navigation exists: `src/App.tsx` renders settings sections in the hamburger sheet for mobile viewports, but existing mobile coverage only asserts General, not Harness.
- Hosted/mobile transport is missing: `src-tauri/src/services/remote_api.rs` marks `host.harnessSettings` unavailable, and the remote API client has no `hostAdmin.harness` methods, so a paired mobile browser cannot configure Harness today.
- Banner CTAs are inconsistent: some Harness-related app-status buttons only call `setSettingsTab("harness")` instead of navigating to `page=settings`, which can be ineffective from non-settings pages.
- Narrow layout needs explicit guards: Harness provider cards, action clusters, runtime paths, and the raw `models.json` editor should be checked for no horizontal overflow and touch-usable controls on ~390px viewports.

## Implementation plan

1. **Add remote Harness capability and endpoints**
   - Mark `capabilities.host.harnessSettings` available for authenticated hosted-web bootstrap responses only.
   - Add authenticated `/api/v1/harness/*` routes mirroring the current Tauri commands for runtime settings, setup state, models JSON, provider API keys, provider credential reset, legacy import/dismiss, and OAuth flow state/start/input/cancel/dismiss.
   - Reuse existing Rust services/commands (`harness_settings`, `pi_setup`, `pi_oauth`, `pi_runtime`) rather than creating new storage.

2. **Implement remote `hostAdmin.harness` client methods**
   - Add a remote host-admin harness adapter that calls the new `/api/v1/harness/*` endpoints.
   - Keep other host-admin capabilities (logs window, bridge diagnostics, remote access, system notifications, agent terminal) unavailable in hosted web.
   - Update bootstrap/client contract tests for authenticated vs unauthenticated Harness capability behavior.

3. **Tighten mobile navigation into Harness**
   - Ensure `Settings → Harness` is visible in the mobile navigation sheet whenever `supportsHarnessSettings` is true.
   - Route all Harness CTAs through `navigateToHarnessSettings()` so they set both `activePage="settings"` and `settingsTab="harness"`.
   - Preserve desktop sidebar behavior and command-palette navigation.

4. **Make Harness settings comfortable on narrow viewports**
   - Add small, scoped mobile CSS/classes if needed so Harness action clusters, provider card buttons, text inputs, and large textareas stack without horizontal overflow.
   - Ensure long runtime paths and model/auth messages wrap safely.
   - Keep desktop layout unchanged except for shared wrap fixes that are intentional.

5. **Regression coverage**
   - Browser/mobile Playwright: from a 390px viewport, open mobile nav → Settings → Harness, verify the sheet closes, Harness settings render, runtime settings can save/reset, and `document.scrollWidth <= viewportWidth`.
   - Hosted-web/remote client tests: verify Harness bootstrap capability, remote adapter methods, and representative API routes for get/update runtime settings plus setup/models/provider flows.
   - Existing desktop/general tests should continue to prove Harness remains separated from General and desktop behavior is not regressed.

## Suggested validation

- `npm run test -- tests/orchestra-client-remote-api.test.ts tests/orchestra-client-remote-api-contract.test.ts tests/orchestra-client-adapters.test.ts`
- `npx playwright test tests/e2e/app-header.spec.ts tests/e2e/general.spec.ts` (or the new Harness mobile spec)
- Targeted Rust/remote API tests if the repo’s usual Tauri test harness is available.
