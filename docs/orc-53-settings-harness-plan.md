# ORC-53 Harness settings IA + settings subnav scroll plan

## Problem summary

ORC-53 is a focused information-architecture cleanup for the Settings experience.

Today, the app mixes a small set of harness-specific runtime controls into `Settings → General`, even though the rest of `General` is broad app configuration and diagnostics. At the same time, the settings sub-item list in the sidebar has grown enough that it needs explicit scroll behavior rather than assuming every item will always fit.

The implementation should solve both problems without turning this ticket into a backend refactor:

- move the misplaced Pi runtime settings out of `General`
- expose them under a dedicated top-level settings section labeled **Harness**
- keep non-harness General content where it is
- make the settings subnav scrollable and ensure the selected item stays visible for deep links and command-palette navigation

## Current-state findings

### 1. The Pi runtime settings live inside `GeneralPanel`

`src/settings/GeneralPanel.tsx` currently renders all of the following in one panel stack:

- theme selection
- session prompt template
- Pi runtime settings (`data-role="pi-runtime-settings-panel"`)
- system notifications
- bridge diagnostics
- runtime logs

The Pi block is the only clearly harness-specific global settings surface in `GeneralPanel`, and it is currently presented with user-facing copy such as:

- eyebrow: `Harness configuration`
- heading: `PI settings`
- button label: `Save PI settings`

That is the exact scope this ticket should extract from General.

### 2. There is no dedicated `Harness` settings route/tab yet

The settings navigation is currently defined in:

- `src/types.ts` via `SettingsTab`
- `src/App.tsx` via `SETTINGS_TABS`
- `src/App.tsx` via `APP_ROUTE_SETTINGS_TABS`
- `src/lib/commandPalette.ts` via `navigate-settings` items

Right now the known settings tabs are:

- `projects`
- `agents`
- `roles`
- `workflows`
- `channels`
- `remote`
- `general`

There is no `harness` tab id, so query-state parsing, selected-tab state, and command-palette navigation cannot currently target a dedicated Harness surface.

### 3. The settings subnav is not scrollable

The sidebar settings list uses the same `.settings-subnav` pattern as the Chat agent list.

Current styling in `src/styles.css` makes it a plain grid with:

- no explicit max-height
- no overflow handling
- no dedicated selector or modifier for the settings version of the subnav

That means the settings section list can grow beyond the comfortable visible area on shorter windows, and there is no built-in affordance to keep the active settings item visible after route-based navigation.

### 4. The relevant test/docs surface is already identifiable

The main affected coverage/docs paths are straightforward:

- `tests/e2e/general.spec.ts` currently asserts Pi runtime settings inside `General`
- `tests/desktop-e2e/general-session-prompt-template.test.ts` also treats runtime-extension controls as part of `General`
- `tests/desktop-e2e/bridge-diagnostics.test.ts` intentionally validates diagnostics in `Settings → General`
- `docs/orc-13-pi-session-reload-compaction-plan.md` still documents Pi settings under General

That means the task is primarily a frontend IA + coverage update, not a storage or data-model rewrite.

## Recommended implementation

### 1. Add a new top-level settings tab: `harness`

Introduce a dedicated settings tab id and user-facing label:

- internal tab id: `harness`
- user-facing label: `Harness`

Recommended updates:

- extend `SettingsTab` in `src/types.ts`
- add `{ id: "harness", label: "Harness" }` to `SETTINGS_TABS` in `src/App.tsx`
- include `harness` in `APP_ROUTE_SETTINGS_TABS`
- render the new panel in the main settings-page switch

Recommended ordering:

- keep it near the existing infrastructure-oriented tabs at the bottom of the list
- e.g. `remote`, `harness`, `general`

That keeps the IA clear while minimizing disruption to the rest of Settings.

### 2. Split the current Pi block into a dedicated `HarnessPanel`

Create a new file:

- `src/settings/HarnessPanel.tsx`

Move the current Pi runtime settings UI from `GeneralPanel` into this new component.

This keeps the ownership boundary clean:

- `GeneralPanel` = broad app settings + diagnostics
- `HarnessPanel` = harness/runtime-specific global controls

Recommended scope for the new panel:

- the existing `PiRuntimeSettings` controls
- current save/reset behavior
- current default compaction window input
- current extra runtime extensions textarea

### 3. Rename user-facing copy from `PI` to `Harness`

The ticket only requires the **user-facing IA and labels** to change. It does **not** require a risky internal rename of types, commands, or storage.

Recommended approach:

- rename the visible heading from `PI settings` to `Harness settings` (or simply `Harness` if the panel structure already makes the context obvious)
- rename visible action copy from `Save PI settings` to `Save Harness settings`
- rename any explanatory copy that frames this as a top-level user-facing `Pi` section
- keep internal implementation names such as:
  - `PiRuntimeSettings`
  - `getPiRuntimeSettings`
  - `updatePiRuntimeSettings`
  - `get_pi_runtime_settings`

That keeps the task tightly scoped to IA/UX while avoiding unnecessary backend churn.

### 4. Keep `General` focused on non-harness content

After the extraction, `src/settings/GeneralPanel.tsx` should continue to own:

- theme selection
- session prompt template
- system notifications
- bridge diagnostics
- runtime logs

This is the least risky change set and directly satisfies the ticket’s acceptance criteria.

### 5. Explicit audit result: what should **not** move

There are Pi-related technical details elsewhere in Settings, especially in:

- `src/settings/AgentsPanel.tsx`
- `src/settings/RolesPanel.tsx`

Those surfaces reference Pi executable/model diagnostics as part of agent/role execution defaults. They are **not** the misplaced global settings from `Settings → General`, so they should remain where they are for this ticket.

That audit conclusion should be preserved during implementation so the task does not expand into a broader runtime-copy rewrite.

### 6. Update routing, command palette, and selected-tab behavior

Because the new Harness section becomes a real settings destination, the following should be updated together:

- route/query-state parsing for `settingsTab=harness`
- command-palette item generation
- selected-tab rendering in the sidebar

Recommended command-palette updates in `src/lib/commandPalette.ts`:

- add `Open Settings → Harness`
- keep `Open Settings → General`, but update the subtitle/keywords if needed so it no longer implies the Harness controls live there

#### Selected-item visibility recommendation

Once the settings list becomes scrollable, route-driven tab changes can leave the active tab out of view on short windows.

To avoid that, add a small active-tab visibility effect in `src/App.tsx`:

- only run when `activePage === "settings"`
- only run when the sidebar is expanded
- on `settingsTab` changes, scroll the active settings button into view with `block: "nearest"`

This is especially important for:

- direct deep links like `?page=settings&settingsTab=harness`
- command-palette navigation into Harness
- restoring a previously selected settings tab when returning to Settings

### 7. Make the settings subnav intentionally scrollable

Do **not** apply broad overflow styling blindly to every `.settings-subnav`, because the Chat page reuses the same class for agent navigation.

Instead, add a dedicated modifier or selector for the settings-sections version, for example:

- `.settings-subnav--settings`
- plus a stable selector such as `data-role="settings-sections-subnav"`

Recommended CSS behavior:

- `overflow-y: auto`
- `overflow-x: hidden`
- a bounded height using a viewport/container-aware `max-height`
- `padding-right` and `scrollbar-gutter: stable` so the scrollbar does not overlap text
- `min-height: 0` on wrapper elements if needed so the overflow container can actually shrink

A simple first-pass constraint such as a clamped max-height is sufficient as long as it works across normal desktop window sizes.

## Coverage plan

### A. Browser Playwright coverage

Primary file:

- `tests/e2e/general.spec.ts`

Recommended updates:

1. Keep the current General assertions for:
   - theme selection
   - session prompt
   - bridge diagnostics
   - runtime logs
2. Add explicit negative coverage that General no longer renders the Harness panel.
3. Navigate to the new `Harness` tab and assert:
   - the moved harness settings render there
   - the old runtime-extension save/reset behavior still works
   - the user-facing label is `Harness`, not `PI`
4. Add deep-link coverage for `/?page=settings&settingsTab=harness`.

### B. Scrollability regression coverage

This can live in the same Playwright suite or a dedicated settings-nav spec.

Recommended assertions:

- use a shorter viewport height so the settings tab list is forced to overflow
- inspect `data-role="settings-sections-subnav"`
- assert that:
  - `overflowY` is `auto` or `scroll`
  - `scrollHeight > clientHeight`
  - the active Harness tab is inside the visible region after direct deep-link load

That last assertion is the regression guard for selected-item visibility after the list becomes scrollable.

### C. Command-palette/unit coverage

Primary file:

- `tests/command-palette.test.ts`

Recommended update:

- assert that a `navigate-settings` command exists for the new `harness` tab

Optional browser coverage:

- use the command palette to open `Settings → Harness` and assert the Harness tab becomes selected

### D. Desktop E2E coverage

Primary files:

- `tests/desktop-e2e/general-session-prompt-template.test.ts`
- `tests/desktop-e2e/bridge-diagnostics.test.ts`

Recommended updates:

- move runtime-extension save/reset assertions from `General` to `Harness`
- keep bridge diagnostics coverage in `General`
- update test descriptions/copy where they still refer to `PI settings` or incorrectly imply that runtime extensions live in General

## Documentation/copy updates

Update the user-facing docs/copy that still describe the old IA, especially:

- `docs/orc-13-pi-session-reload-compaction-plan.md`

Specifically revise wording that says Pi settings live under `Settings → General`.

Do **not** change docs that intentionally describe bridge diagnostics or runtime logs in General if that content remains true after the extraction.

## Files likely affected

- `src/types.ts`
- `src/App.tsx`
- `src/lib/commandPalette.ts`
- `src/settings/GeneralPanel.tsx`
- `src/settings/HarnessPanel.tsx` (new)
- `src/styles.css`
- `tests/e2e/general.spec.ts`
- `tests/command-palette.test.ts`
- `tests/e2e/command-palette.spec.ts` (if browser palette navigation coverage is added)
- `tests/desktop-e2e/general-session-prompt-template.test.ts`
- `tests/desktop-e2e/bridge-diagnostics.test.ts`
- `docs/orc-13-pi-session-reload-compaction-plan.md`

## Scope guardrails

To keep ORC-53 tractable, the implementation should **not** try to do any of the following in the same change:

- rename backend/storage types from `PiRuntimeSettings` to a new internal type
- change harness-settings persistence shape
- move bridge diagnostics or runtime logs out of `General`
- reorganize unrelated agent/role runtime configuration surfaces

The job is a focused IA correction plus sidebar-scroll hardening, not a broad runtime terminology migration.
