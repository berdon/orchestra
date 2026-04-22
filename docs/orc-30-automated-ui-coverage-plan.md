# ORC-30 automated UI coverage and coverage-gate plan

## What I found in the current repo

### 1. The repo already has a lot of automated UI tests, but no authoritative coverage definition

Current test topology:

- `tests/*.test.ts` contains **26** Vitest unit/integration suites.
- `tests/e2e/*.spec.ts` contains **19** browser Playwright specs, auto-discovered by `playwright.config.ts`.
- `tests/web-driver-e2e/*.spec.ts` contains **1** shared web-driver Playwright spec, auto-discovered by `playwright.web-driver.config.ts`.
- `tests/desktop-e2e/*.test.ts` contains **55** desktop end-to-end specs plus helper files. These run through the custom desktop harness and ultimately execute with `npx vitest run <spec>` inside `scripts/run-desktop-e2e.sh`.

So the repo is not starting from zero coverage. It already has broad authored automation across browser, desktop, remote-client, and unit/integration layers.

The actual problem is different:

- there is **no single documented definition** of what “UI coverage above 90%” means here
- there is **no numeric coverage output** today
- there is **no enforced threshold** in local scripts or repo-managed CI
- the desktop suite inventory has drifted enough that authored coverage and actually executed coverage are not the same thing

### 2. Coverage is not currently measured numerically

The current checked-in config proves that coverage reporting/gating does not exist yet:

- `package.json`
  - `test` is just `vitest run`
  - there is no `test:coverage`, `coverage`, `verify`, or similar script
  - there is no coverage dependency such as `@vitest/coverage-v8`, `c8`, `nyc`, or Istanbul tooling
- `vite.config.ts`
  - the `test` config sets `environment: "node"` and `include: ["tests/**/*.test.ts"]`
  - there is **no** `coverage` section, no reporters, and no threshold configuration
- `playwright.config.ts` and `playwright.web-driver.config.ts`
  - configure browser E2E execution only
  - do not emit or enforce coverage thresholds
- repo root
  - there are no checked-in `.github/workflows/*` or `.forgejo/workflows/*` files, so there is no repo-managed CI gate to fail on coverage regressions

Current state summary: the project has many tests, but **coverage is qualitative, not measured**.

### 3. The desktop suite has real drift between authored tests and the suite scripts

The biggest operational issue I found is the desktop suite wiring in `package.json`.

- `test:desktop-e2e`
- `test:desktop-e2e:host`

both hard-code the desktop spec list inline.

That hard-coded list currently includes **32** desktop specs, while the repository actually contains **55** desktop E2E spec files.

That means **23 authored desktop specs are not part of the package-managed suite today**.

Missing from the suite lists:

- `tests/desktop-e2e/agent-terminal-window.test.ts`
- `tests/desktop-e2e/autonomous-workflow.test.ts`
- `tests/desktop-e2e/chat-mention-autocomplete.test.ts`
- `tests/desktop-e2e/general-session-prompt-template.test.ts`
- `tests/desktop-e2e/lane-workspace-selection.test.ts`
- `tests/desktop-e2e/navigation-badges.test.ts`
- `tests/desktop-e2e/navigation-layout.test.ts`
- `tests/desktop-e2e/project-task-scoping.test.ts`
- `tests/desktop-e2e/remote-access.test.ts`
- `tests/desktop-e2e/scoped-agents.test.ts`
- `tests/desktop-e2e/session-transcript.test.ts`
- `tests/desktop-e2e/sessions-delete-closed.test.ts`
- `tests/desktop-e2e/task-comment-ordering.test.ts`
- `tests/desktop-e2e/task-default-file-comments.test.ts`
- `tests/desktop-e2e/task-detail-reorg.test.ts`
- `tests/desktop-e2e/task-dispatch.test.ts`
- `tests/desktop-e2e/task-file-viewer-controls.test.ts`
- `tests/desktop-e2e/task-markdown-lists.test.ts`
- `tests/desktop-e2e/task-repository-info-pane.test.ts`
- `tests/desktop-e2e/task-table-row.test.ts`
- `tests/desktop-e2e/workflow-lifecycle.test.ts`
- `tests/desktop-e2e/workflow-recovery.test.ts`
- `tests/desktop-e2e/workforce-filters.test.ts`

So even before adding new tests, ORC-30 should treat **desktop suite inventory drift** as a first-class coverage bug.

### 4. Existing automated coverage is broad by surface, but not visible or enforceable

High-level audit by user-facing surface:

| Surface | Existing automation today | Current issue |
| --- | --- | --- |
| Tasks | Strong browser coverage in `tests/e2e/tasks.spec.ts`, `tests/e2e/task-schedules.spec.ts`, `tests/e2e/task-default-file-comments.spec.ts`; extensive desktop coverage across task details, comments, files, todos, approvals, schedules, whip, dispatch-adjacent flows | Several important authored desktop task specs are not in the package-managed suite |
| Inbox | Browser `tests/e2e/inbox.spec.ts`; desktop `tests/desktop-e2e/inbox-messaging.test.ts` | Covered, but not tied to a coverage definition |
| Agents / workforce | Browser `tests/e2e/agents.spec.ts` and `tests/e2e/scoped-agents.spec.ts`; desktop queue/scoped/workforce coverage exists | Some authored desktop workforce/scoped coverage is omitted from suite wiring |
| Chat / sessions | Browser `tests/e2e/chat.spec.ts` and `tests/e2e/sessions.spec.ts`; many desktop session-control/runtime specs exist | Some authored desktop chat/session specs are omitted from suite wiring |
| Navigation / shell / theme | Browser app-header, navigation-badges, command-palette, theme specs; desktop navigation/theme specs exist | Desktop navigation specs are currently ungated because they are not in the suite list |
| Settings / admin panels | Browser projects, roles, workflows, channels, remote, general coverage; desktop project setup/local repo/theme/system notification coverage exists | No single matrix says which settings panels are required for “UI coverage” |
| Remote client | Browser `tests/e2e/remote.spec.ts`; shared web-driver spec under `tests/web-driver-e2e`; desktop remote access spec exists | Desktop remote coverage is authored but not currently in package-managed suite |

Bottom line: the repo has **broad authored UI automation**, but it is still **operationally opaque**.

### 5. Current suite organization also hides risk

Two additional structural issues make today’s coverage hard to reason about:

- Browser coverage is concentrated in a few very large specs, especially:
  - `tests/e2e/tasks.spec.ts` (~3300 lines)
  - `tests/e2e/sessions.spec.ts` (~2050 lines)
- Desktop coverage is split across many focused specs, but the package scripts do not derive their suite from the filesystem or a manifest.

That means the project currently has:

- good raw test volume
- poor visibility into which critical journeys are guaranteed
- no trustworthy percentage to gate on

## Coverage semantics I recommend for ORC-30

The task explicitly asks us to remove ambiguity between:

- automated UI / end-to-end coverage expectations
- unit/integration coverage metrics used for build gating

The cleanest way to do that is to **treat them as two different metrics on purpose**.

### A. Automated UI coverage = critical-journey coverage

This should be the metric behind the phrase **“automated UI coverage above 90%.”**

Definition:

- Create a checked-in **critical-journey matrix** for Orchestra’s user-facing surfaces.
- Each row represents one user-visible journey, not a file count and not a raw assertion count.
- A journey counts as covered only when at least one checked-in automated spec is mapped to it and runs in the required suite.
- Valid automation sources are:
  - browser Playwright (`tests/e2e`)
  - desktop E2E (`tests/desktop-e2e` via the dedicated runner)
  - web-driver Playwright where the remote/mobile client is the surface under test

Suggested journey categories:

1. primary navigation surfaces: Tasks, Inbox, Agents, Chat, Sessions, Settings
2. task workflows: overview, detail, comments, todos, files, schedules, approvals/dispatch, blocking/whip/workflow progression
3. session workflows: create, reload, compact, new-session, transcript refresh, runtime visibility
4. settings/admin: projects, roles, workflows, channels, remote, general, notifications, themes
5. cross-cutting shell UX: app header, command palette, unread/navigation badges, detached windows where relevant
6. remote/shared-client flows: pairing and remote-driver access

Recommended measurement rule:

- **UI coverage % = covered critical journeys / total critical journeys**

Recommended ORC-30 success target:

- **>= 90%** of the critical-journey matrix covered by automation
- every primary page and every required settings surface represented at least once
- no row allowed to reference a spec that exists in the repo but is not actually part of the required suite

This gives the project a coverage number that actually answers the product question: “how much of the user-visible Orchestra experience is automated?”

### B. Build-gated coverage = Vitest code coverage on the frontend/shared UI layer

This should be the fast, reproducible, deterministic **build gate**.

Definition:

- Add Vitest V8 coverage reporting for the TypeScript frontend layer.
- Scope the enforced metric to the code that drives Orchestra’s UI and shared frontend behavior, not the Rust backend.

Recommended initial include scope:

- `src/**/*.{ts,tsx}`

Recommended initial exclude scope:

- test files
- `src-tauri/**`
- `mobile/**`
- generated/build output
- purely static assets

Recommended enforced threshold:

- **lines >= 90%**
- **functions >= 90%**
- **statements >= 90%**
- branch coverage reported visibly; if the current branch baseline is already close enough, promote it to 90% as part of implementation, otherwise document the branch target separately instead of hiding it

Why this is the right gate:

- it is fast enough for routine development and CI
- it is reproducible locally with one command
- it protects against silent regressions in UI logic and state shaping
- it does not pretend that a browser-only code coverage number can represent the desktop runtime path

### Why I do **not** recommend one single cross-harness “90%” number

Orchestra’s automated UI surface spans three different execution models:

- browser Playwright against the frontend/mock path
- desktop E2E through the dedicated Tauri/webdriver harness
- shared web-driver browser tests for the remote/mobile client

Trying to collapse that into one code-instrumentation number would be misleading and brittle:

- browser-only instrumentation would miss real desktop runtime behavior
- desktop instrumentation across the custom Tauri harness would add a lot of complexity and flake risk
- remote-client coverage has a different runtime again

So ORC-30 should explicitly separate:

- **journey coverage** for “how much of the product is automated?”
- **Vitest code coverage** for “when should the build fail?”

That split is the least ambiguous and the most maintainable.

## Recommended implementation plan

### 1. Fix suite inventory drift first

Before adding lots of new tests, remove the mismatch between authored desktop tests and executed desktop tests.

Recommended change:

- stop duplicating desktop spec lists inline in `package.json`
- move the required desktop suite inventory into one checked-in manifest or derive it programmatically
- have both `test:desktop-e2e` and `test:desktop-e2e:host` consume the same source of truth

Two acceptable patterns:

1. **manifest-driven**
   - checked-in file listing required desktop specs
   - optional explicit quarantine section with reasons
2. **glob-driven with explicit excludes**
   - default to all `tests/desktop-e2e/*.test.ts`
   - keep any exclusions small, explicit, and documented

This change alone will make the current UI automation picture much more honest.

### 2. Add real coverage reporting for local development and CI

Recommended changes:

- add `@vitest/coverage-v8`
- extend `vite.config.ts` with coverage config
- emit at least:
  - text summary
  - HTML report
  - `json-summary`
  - `lcov`

Recommended scripts:

- `npm run test:coverage` → unit/integration coverage with thresholds enforced
- `npm run test:ui:matrix` → validates the critical-journey matrix and prints coverage percentage
- `npm run verify` or `npm run ci` → one entry point for the full repo-managed gate

### 3. Introduce an explicit UI coverage matrix

Add a checked-in artifact such as:

- `docs/ui-coverage-matrix.md`
- plus a machine-readable companion like `tests/ui-coverage-matrix.json`

Each matrix row should include:

- surface/category
- user journey name
- required harness (`browser`, `desktop`, `web-driver`)
- mapped spec file(s)
- current status: covered, missing, quarantined

This gives ORC-30 a metric that is visible to humans and checkable by scripts.

### 4. Raise the actual UI journey coverage above 90%

Once the matrix exists, implementation work should happen in this order:

1. bring existing authored but omitted desktop specs into the required suite where stable
2. identify truly uncovered critical journeys from the matrix
3. add new tests only for the remaining missing journeys
4. split oversized browser specs where that improves maintainability and reviewability

The important point is to avoid a fake “coverage increase” that comes only from relabeling or counting already-written but ungated tests.

### 5. Add repo-managed build/CI enforcement

Because there is no checked-in workflow today, ORC-30 should add a repo-managed automation entry point.

Likely direction given the current host setup:

- add a workflow under `.forgejo/workflows/` if that matches the project’s actual forge runner
- otherwise add the equivalent checked-in CI workflow for the host actually used by this repo

The required gate should call a single repo-defined verification command rather than re-embedding logic in the CI YAML.

Recommended gate contents:

1. install dependencies
2. run unit/integration coverage gate
3. run browser E2E
4. run required desktop E2E suite
5. run web-driver E2E where the remote client is part of the required UI surface
6. fail if the documented coverage threshold or matrix percentage is below target

### 6. Make flake handling explicit instead of accidental

For this task to stay healthy, “not in the suite list” cannot remain the project’s de facto flake policy.

Recommended rule:

- a failing/flaky test is either
  - fixed and kept in the required suite, or
  - quarantined explicitly with a checked-in reason and a visible debt entry
- it should never disappear silently because somebody forgot to add it to a hard-coded package script list

## Immediate implementation priorities for the next lane

1. **Desktop suite manifest/source-of-truth**
   - remove the 32-vs-55 drift first
2. **Vitest coverage plumbing**
   - add reporters and thresholds
3. **Critical-journey matrix**
   - define the denominator for the “>90% UI coverage” claim
4. **Gap-closing tests**
   - only after the denominator and suite inventory are trustworthy
5. **Repo-managed CI/workflow gate**
   - make the threshold fail automatically

## Acceptance-criteria mapping

- **“Orchestra automated coverage is increased to above 90% according to the documented coverage definition used by the project.”**
  - satisfied by the critical-journey matrix with a documented >=90% rule
- **“The project clearly documents what coverage metric(s) are being enforced.”**
  - satisfied by explicitly documenting journey coverage vs Vitest coverage thresholds
- **“CI/build fails automatically when coverage falls below the enforced 90% threshold.”**
  - satisfied by a repo-managed gate invoking Vitest coverage thresholds and the matrix check
- **“Coverage reporting and threshold behavior are reproducible for developers and in CI.”**
  - satisfied by repo scripts like `test:coverage`, `test:ui:matrix`, and `verify`
- **“Relevant tests pass cleanly and provide durable regression protection rather than a brittle one-time coverage spike.”**
  - satisfied by fixing the desktop suite source of truth, keeping flake policy explicit, and measuring journeys rather than raw file counts

## Recommended files to touch during implementation

Likely core files:

- `package.json`
- `vite.config.ts`
- new coverage/matrix helper script(s) under `scripts/`
- new matrix artifact under `docs/` and/or `tests/`
- desktop suite manifest/source-of-truth file
- checked-in CI workflow file
- selected test files in `tests/e2e/`, `tests/desktop-e2e/`, and possibly root Vitest suites where gaps are real

## Local/CI commands the finished solution should expose

At minimum, the final implementation should make these workflows obvious:

```bash
npm run test:coverage
npm run test:e2e
npm run test:web-driver:e2e
npm run test:desktop-e2e
npm run test:ui:matrix
npm run verify
```

That command set would make the coverage story understandable both for contributors and for CI.