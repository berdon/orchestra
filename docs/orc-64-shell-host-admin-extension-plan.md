# ORC-64 Tauri-only shell/host-admin extension plan

## tl;dr

- Keep the shared `OrchestraClient` contract focused on cross-host product services and add optional desktop-only extensions on the client surface: `client.shell` and `client.hostAdmin`.
- Move detached-window helpers, logs-window launch, agent-terminal attach/buffer/input/resize flows, native window context detection, bridge/log diagnostics, system-notification bridge actions, harness admin, and remote-access host admin behind those optional extensions.
- Capability-gate the shared shell so browser/hosted-web runs stop assuming those desktop-only affordances exist.
- Update the app shell, command palette, settings navigation, and agent terminal entrypoints to depend on extension presence + advertised capabilities instead of implicit mock/Tauri behavior.
- Keep the ticket bounded: do not re-open ORC-60’s broad shared-data migration, and do not move genuinely shared admin CRUD surfaces into the new desktop-only extensions.

## Executive summary

ORC-58 and ORC-60 created the right base architecture: the shared frontend now has an injected `OrchestraClient` plus an `orchestraData` layer for the core task/inbox/session surfaces. The remaining leakage is now concentrated in the app shell and a few explicitly desktop-oriented flows. `src/App.tsx` still imports Tauri-only window helpers, diagnostics/log actions, harness setup/admin flows, and `openAgentSessionInTerminal(...)` directly. `src/pages/AgentTerminalWindowPage.tsx` still talks to PTY helpers in `src/lib/agents.ts`, and the command palette/settings shell still advertises logs, harness, remote-host, and terminal actions as if they were part of the required shared frontend.

That is the wrong boundary for the ORC-56 epic. The shared contract should keep owning cross-host product behavior; desktop-only shell and host-admin affordances should become explicit optional extensions. ORC-64 should therefore add typed optional client modules (`client.shell` and `client.hostAdmin`), wire them only in the Tauri adapter, and then gate the shared UI off extension/capability availability so browser/hosted-web surfaces do not assume extra windows, PTY control, native diagnostics, or privileged local-host administration are always present.

## Current findings

- The shared client/provider seam is now present and landed:
  - `src/lib/orchestraClient/*`
  - `src/lib/orchestraData/*`
  - `src/main.tsx`
- The remaining desktop-only leakage is concentrated in the shared app shell and a few edge pages:
  - `src/App.tsx`
    - imports logs-window helpers, detached-window detection, bridge/log diagnostics, system-notification bridge helpers, harness/Pi admin flows, and `openAgentSessionInTerminal(...)`
    - renders detached logs/agent-terminal routes inline
    - always exposes host-admin settings tabs and header actions
  - `src/pages/AgentTerminalWindowPage.tsx`
    - imports terminal buffer/input/resize/shutdown helpers directly from `src/lib/agents.ts`
  - `src/lib/commandPalette.ts`
    - always adds `Open logs window`, `Open Settings → Harness`, and `Open … in terminal`
  - `src/agents/AgentOperationsDetail.tsx`
    - always renders the `Open in terminal` action
  - `src/settings/GeneralPanel.tsx`
    - mixes shared appearance/preferences with desktop diagnostics, runtime logs, and native-notification bridge controls
  - `src/settings/HarnessPanel.tsx`
    - is local-host runtime/auth/model administration
  - `src/settings/RemotePanel.tsx`
    - is host-side remote-access administration
  - `src/components/SessionChatPanel.tsx`, `src/settings/AgentsPanel.tsx`, and `src/settings/RolesPanel.tsx`
    - include `Open Harness settings` style recovery CTAs that assume local-host admin exists
- The current browser suite still treats some desktop-only behavior as normal mock/browser functionality:
  - `tests/e2e/general.spec.ts`
  - `tests/e2e/command-palette.spec.ts`
  - `tests/e2e/agents.spec.ts`
  Those assumptions need to flip: shared browser coverage should verify hiding/gating, while true shell behavior belongs in desktop-e2e or explicit extension-injection tests.

## Implementation shape

### 1. Add optional desktop-only client extensions

Extend the client surface with explicit optional modules instead of growing the required shared service contract.

Recommended shape:

```ts
interface OrchestraClient {
  readonly contractVersion: OrchestraClientContractVersion;
  getBootstrap(): Promise<OrchestraClientBootstrap>;
  readonly app: OrchestraAppService;
  readonly catalog: OrchestraCatalogService;
  readonly tasks: OrchestraTaskService;
  readonly inbox: OrchestraInboxService;
  readonly sessions: OrchestraSessionService;
  readonly events: OrchestraEventService;
  readonly shell?: OrchestraShellExtension;
  readonly hostAdmin?: OrchestraHostAdminExtension;
}
```

Recommended extension split:

- `client.shell`
  - detached-window context / current window-kind detection
  - open logs window
  - open agent session in terminal
  - terminal buffer read / input / resize / shutdown
- `client.hostAdmin`
  - bridge diagnostics + stale-bridge cleanup
  - runtime log read / clear / export
  - native notification bridge status / permission / test send
  - harness runtime settings + Pi setup/admin flows
  - remote-access host administration

Important scope rule: these are **optional** extensions. The shared `app/catalog/tasks/inbox/sessions/events` surface stays required and cross-host.

### 2. Keep the ORC-57 bootstrap model, but extend host capabilities where needed

Do **not** redesign the whole bootstrap contract just to land ORC-64.

Instead:

- keep using bootstrap capability metadata as the UI’s availability source of truth
- keep the existing `capabilities.host.logsWindow`, `capabilities.host.agentTerminal`, and `capabilities.host.systemNotifications`
- extend the existing host-capability block only where the current model is too coarse, for example:
  - bridge diagnostics / runtime logs
  - harness settings
  - remote-access admin
- add small selectors/helpers that combine:
  - advertised host capability
  - extension presence (`client.shell`, `client.hostAdmin`)

That lets the UI gate behavior without making browser/hosted-web code guess from raw host-kind checks.

### 3. Attach the extensions only in the Tauri adapter

Add dedicated extension bindings next to the current adapter files.

Recommended files:

- `src/lib/orchestraClient/extensions.ts`
  - extension interfaces
  - small type guards / access helpers
- `src/lib/orchestraClient/tauriShellExtension.ts`
- `src/lib/orchestraClient/tauriHostAdminExtension.ts`

Adapter behavior:

- `createTauriOrchestraClient(...)`
  - returns the shared services plus concrete `shell` / `hostAdmin` extensions
- `createMockOrchestraClient(...)`
  - returns the shared services only; no default desktop extensions
- hosted-web binding
  - returns the shared services only; no desktop extensions

If a browser/unit test still needs a host-only UI path, inject a custom binding explicitly instead of treating the default mock client as a fake desktop shell.

### 4. Pull current helper calls behind those extensions

Extract the current desktop-only calls out of the shared shell and route them through the new extension modules.

Primary extraction targets:

- from `src/lib/tauri.ts`
  - logs window open / current-window detection helpers
  - bridge diagnostics + cleanup
  - runtime log read / clear / export
  - harness/Pi admin helpers currently driven from the shell
- from `src/lib/agents.ts`
  - `openAgentSessionInTerminal(...)`
  - terminal buffer/input/resize/shutdown helpers
- from `src/lib/systemNotifications.ts`
  - native-notification bridge actions should become `hostAdmin.notifications.*`
- from `src/lib/remote.ts`
  - host-side remote access admin should become `hostAdmin.remoteAccess.*`

Bounded nuance:

- keep genuinely shared reads/writes where they already belong
- do **not** move shared admin CRUD such as projects, agents, roles, workflows, channels, source control, or prompting into the new desktop-only extensions
- do **not** remove shared read-only runtime health state if the core shared UI still needs it; only the local-host recovery/configuration actions need to move behind `hostAdmin`

### 5. Capability-gate the shared shell and settings navigation

Update the shell so unsupported host-only entries disappear or degrade cleanly.

Primary UI gates:

- `src/App.tsx`
  - header `Open logs` button
  - detached logs / agent-terminal route branching
  - settings-tab list and route fallback
  - `Open Harness settings` recovery CTAs
- `src/lib/commandPalette.ts`
  - `Open logs window`
  - `Open Settings → Harness`
  - any remote-host admin page item if present
  - `Open … in terminal`
- `src/agents/AgentOperationsDetail.tsx`
  - terminal button visibility/disabled state
- `src/settings/GeneralPanel.tsx`
  - keep shared appearance/tooltips content
  - gate desktop diagnostics / logs / native notifications sections
- `src/settings/HarnessPanel.tsx`
  - only reachable when host-admin capability is present
- `src/settings/RemotePanel.tsx`
  - only reachable when host-admin capability is present
- `src/components/SessionChatPanel.tsx`
- `src/settings/AgentsPanel.tsx`
- `src/settings/RolesPanel.tsx`
  - show harness-recovery buttons only when that host-admin path is actually available

Route fallback requirement:

- if a browser/hosted-web session lands on `settingsTab=harness` or `settingsTab=remote` without the needed extension/capability, fall back to the nearest shared tab instead of rendering a broken panel
- if a logs/agent-terminal detached route is opened without the corresponding shell extension, render a compact unsupported state or fall back to the main shell intentionally

### 6. Isolate detached-window rendering behind the shell extension

The shared `App` component should stop owning raw Tauri window detection.

Recommended cleanup:

- add a small window-context helper owned by `client.shell`
- extract the inline logs view into a dedicated `LogsWindowPage` component
- keep `AgentTerminalWindowPage` but make it depend on `client.shell.agentTerminal.*` instead of `src/lib/agents.ts`

This keeps extra-window behavior explicit and prevents the main shared shell from depending on raw Tauri/webview details.

## Proposed file plan

Client / capability work:

- `src/lib/orchestraClient/client.ts` — add optional `shell` / `hostAdmin`
- `src/lib/orchestraClient/extensions.ts` — new extension contracts/helpers
- `src/lib/orchestraClient/baseClient.ts` — thread optional extensions through the shared client factory
- `src/lib/orchestraClient/tauriClient.ts` — attach Tauri extensions
- `src/lib/orchestraClient/mockClient.ts` — keep extensions absent by default
- `src/lib/orchestraClient/hostedWeb.ts` — keep extensions absent
- `src/lib/orchestraClient/bootstrap.ts` / `bootstrapFactory.ts` — extend host-capability descriptors only where needed

Extension implementation work:

- `src/lib/orchestraClient/tauriShellExtension.ts`
- `src/lib/orchestraClient/tauriHostAdminExtension.ts`
- optionally small extracted helper files under `src/lib/` if moving code out of `tauri.ts`, `agents.ts`, `systemNotifications.ts`, or `remote.ts` makes the extension bindings cleaner

UI migration targets:

- `src/App.tsx`
- `src/lib/commandPalette.ts`
- `src/pages/AgentTerminalWindowPage.tsx`
- `src/pages/LogsWindowPage.tsx` — new, if the inline logs branch is extracted
- `src/agents/AgentOperationsDetail.tsx`
- `src/settings/GeneralPanel.tsx`
- `src/settings/HarnessPanel.tsx`
- `src/settings/RemotePanel.tsx`
- `src/components/SessionChatPanel.tsx`
- `src/settings/AgentsPanel.tsx`
- `src/settings/RolesPanel.tsx`

## Sequencing

1. Start from the current `origin/main` baseline so the landed ORC-58 / ORC-60 seams are present.
2. Define `OrchestraShellExtension` and `OrchestraHostAdminExtension` plus small extension/capability access helpers.
3. Add Tauri-backed extension implementations and attach them to the Tauri client factory.
4. Leave mock/hosted-web clients extension-free by default and update capability metadata accordingly.
5. Rewire `App` detached-window handling, header actions, settings navigation, and command-palette actions onto the new extension/capability checks.
6. Rewire `AgentTerminalWindowPage` and the agent terminal entrypoints to `client.shell`.
7. Gate General/Harness/Remote and the harness-recovery CTAs so unsupported shared hosts no longer assume local-host admin exists.
8. Update browser vs desktop coverage to match the new boundary.

## Scope boundaries / non-goals

Out of scope for ORC-64:

- another broad `orchestraData` rewrite of the shared task/inbox/session surfaces
- moving shared CRUD/admin surfaces (projects, agents, roles, workflows, channels, source control, prompting) into desktop-only extensions
- inventing remote/browser equivalents for desktop-only diagnostics, detached windows, PTY controls, or host-side remote-access administration
- removing every remaining helper from `src/lib/tauri.ts` / `src/lib/agents.ts` in one pass
- redesigning the shared session/task health UX beyond gating the host-admin recovery affordances correctly

## Validation plan

Expected implementation/review validation:

- `npm run build`
- focused Vitest coverage for the new client extension presence/absence behavior
  - Tauri client exposes `client.shell` / `client.hostAdmin`
  - mock and hosted-web bindings do not expose them by default
- focused coverage for command-palette and settings-tab gating
- browser/e2e coverage proving host-only actions are hidden or gracefully unavailable in default mock/hosted-web mode
- desktop-e2e coverage for the real desktop-only flows:
  - logs window
  - bridge diagnostics / runtime logs
  - agent terminal window
- if a non-desktop test needs host-only UI rendering, inject an explicit fake extension binding rather than relying on default mock shell behavior

## Acceptance-criteria mapping

- **The shared frontend contract no longer requires desktop-only shell or host-admin features**
  - the required client surface stays `app/catalog/tasks/inbox/sessions/events`; desktop-only affordances move behind optional `client.shell` / `client.hostAdmin`
- **Tauri-only capabilities are still available when present, but through explicit optional extensions**
  - the Tauri adapter attaches concrete extension implementations for windows, PTY control, diagnostics, notifications, harness admin, and remote-host admin
- **Shared UI depends on capabilities/extensions instead of raw Tauri availability checks**
  - the app shell, command palette, settings navigation, and terminal entrypoints gate behavior from extension presence + advertised host capabilities instead of assuming mock/browser parity for desktop-only features
