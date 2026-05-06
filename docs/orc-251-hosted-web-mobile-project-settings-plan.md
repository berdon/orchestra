# tl;dr

The exact bug does **not** reproduce on the current worktree in a happy-path hosted-web mobile run, but I did confirm a likely failure-mode regression in `src/settings/ProjectsPanel.tsx`: project-scoped tab prefetches mark themselves as "loaded" even when the remote request fails, and the only visible error lives in the desktop sidebar that is hidden on mobile. That combination can leave Automation / Source Control / Secrets looking permanently unresolved on hosted-web mobile without an automatic retry path.

# Executive summary

Current local status:
- Real hosted-web mobile happy path works for default and newly created projects.
- Existing exact regression coverage is missing.
- A forced remote failure against hosted-web mobile reproduces the likely UX failure shape:
  - project-scoped requests fail once during prefetch
  - the mobile detail tabs show only headers / no usable inline error state
  - the hidden sidebar owns the error message
  - `automationLoadedProjectSlug`, `sourceControlLoadedProjectSlug`, and `secretsLoadedProjectSlug` are still set in `finally`, so later tab visits do not retry automatically

This means the most likely implementation bug is **failure handling + retry suppression**, not the basic request wiring for the happy path.

# What I verified

## Real hosted-web mobile repro status

I ran the hosted-web E2E server locally and exercised the real remote path with a mobile viewport.

Happy-path result on the current branch:
- `GET /api/v1/project-settings/task-automation?projectSlug=...` → 200
- `GET /api/v1/project-settings/source-control?projectSlug=...` → 200
- `GET /api/v1/project-settings/secrets?projectSlug=...` → 200
- Automation / Source Control / Secrets all render successfully on mobile
- This also held for a newly created project selected through the mobile project picker

## Failure-mode repro that explains the user report

I forced hosted-web mobile project-settings endpoints to return 500s and observed:
- `.settings-mobile-subnav-panel` is hidden on mobile
- `.error-copy` still exists, but it is only rendered inside that hidden sidebar
- Automation / Source Control / Secrets panels render their section headers only, with no actionable inline error / retry state
- After the initial failed prefetch, revisiting those tabs does **not** issue another request because each `*LoadedProjectSlug` is set in `finally`

This is consistent with a user seeing the tabs as stuck / unresolved on hosted-web mobile.

# Exact code hotspots

## UI / failure handling
- `src/settings/ProjectsPanel.tsx`
  - `loadAutomationSettings()`
  - `loadSourceControlTabSettings()`
  - `loadSecrets()`
  - the prefetch `useEffect()` tied to `projectDetail.slug`
  - mobile rendering path via `SettingsMobileSubnavHeader`

Problem detail:
- each loader sets `setError(...)` on failure
- each loader also sets its `*LoadedProjectSlug` in `finally`
- mobile hides the desktop navigation panel where `{error}` is rendered
- Automation / Source Control have no inline refresh affordance after a failed prefetch
- Secrets has a manual refresh button, but still lacks inline failure context

## Remote request path
- `src/lib/projectSettings.ts`
- `src/lib/sourceControlSettings.ts`
- `src/lib/orchestraClient/remoteApiClient.ts`
- Remote API routes in `src-tauri/src/services/remote_api.rs`

The happy-path wiring looks correct; the likely regression is not the endpoint shape itself.

# Coverage audit

## Coverage that already exists

### Mock/browser-mode coverage
- `tests/e2e/projects.spec.ts`
  - hosted-web-style project-settings API mocking
  - async tab prefetch coverage
  - mobile floating dock / mobile settings layout coverage
  - secrets CRUD coverage

This is useful, but it is **not** the real hosted-web remote/bootstrap/auth path.

### Real hosted-web coverage
- `tests/hosted-web-e2e/projects.spec.ts`
  - project creation / project switcher invalidation
- `tests/hosted-web-e2e/source-control.spec.ts`
  - global Source Control settings through the remote API

These passed locally, but they do **not** cover:
- mobile viewport
- Project Settings → Projects
- project-scoped Automation / Source Control / Secrets tabs
- failure / retry / refreshing-clear behavior

## Bottom line on prior exact coverage

No: we do **not** currently have exact Podman/hosted-web regression coverage for the reported scenario.

# Recommended implementation order

1. Add a real hosted-web E2E spec for mobile Project Settings tabs.
   - mobile viewport
   - pair hosted-web browser
   - open Settings → Projects
   - verify Automation / Source Control / Secrets load for the selected project
   - verify the loading state clears

2. Fix `ProjectsPanel` failure handling.
   - only mark `automationLoadedProjectSlug` / `sourceControlLoadedProjectSlug` / `secretsLoadedProjectSlug` as loaded on success
   - keep failed loads retryable on tab open
   - add inline tab-local error + retry UI so mobile does not hide the only failure signal

3. Re-run the new hosted-web mobile spec plus existing project/settings specs.
   - real hosted-web E2E
   - existing mock/browser-mode projects spec coverage
   - ensure desktop/local settings behavior stays intact

4. If the new real hosted-web mobile happy-path spec still fails after the retry/error-state fix, then inspect environment-specific hosted bootstrap/session state next.
   - browser cookie/session after pairing
   - active project resolution at bootstrap time
   - whether the deployed host differs from the local hosted-web E2E server

# Validation target

Implementation should finish with:
- real hosted-web mobile spec passing for Automation / Source Control / Secrets
- existing hosted-web project creation + source-control specs still passing
- existing mock/browser-mode project-settings specs still passing
- explicit note in the task that the original exact regression path lacked coverage before this work
