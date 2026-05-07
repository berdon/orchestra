# ORC-268 — Podman E2E consolidation plan

## tl;dr
- Orchestra currently has **94** checked-in E2E specs: **61 desktop**, **24 browser**, **8 hosted-web**, and **1 web-driver**.
- Only the **61 desktop specs** already run through the repo-supported Podman runner (`npm run test:desktop-e2e`).
- The remaining **33 specs** still run through direct Playwright or host-local scripts with fixed ports and fixed runtime roots, so the supported E2E story is split and not uniformly parallel-safe.
- Recommended end state: **every supported E2E command becomes a Podman-backed command**, driven by a checked-in suite manifest, with old non-Podman entry paths removed or demoted to explicit local-debug status.
- Implementation should first **Podmanize browser/hosted-web/web-driver execution**, then **retire split runner paths**, then **fix failures and harden parallel isolation**.

## Executive summary
The repo already has the right model for desktop coverage: manifest-driven discovery, containerized execution, per-spec isolation, and optional parallel fan-out. The rest of the E2E surface still uses direct Playwright or host-local cargo flows, which is the real source of the current split execution model.

The plan is to extend the existing Podman runner pattern across the full supported E2E surface instead of forcing every spec into the desktop harness immediately. That keeps genuinely distinct coverage — especially hosted-web and paired mobile/browser flows — while still giving developers one supported execution model. Where older browser-only coverage is purely redundant, the migration should prune or fold it into the Podman-backed suites so the final surface is smaller and clearer.

## Current inventory

### Runner-level classification

| Suite | Specs | Current entry path | Already on supported Podman runner? | Notes |
| --- | ---: | --- | --- | --- |
| `tests/desktop-e2e` | 61 | `npm run test:desktop-e2e` / `./scripts/run-desktop-e2e-suite-podman.sh` | Yes | Authoritative desktop suite already derives from `tests/desktop-e2e-suite.json`. |
| `tests/e2e` | 24 | `npm run test:e2e` | No | Direct Playwright against fixed `127.0.0.1:4173`; mostly browser/mock and route-intercepted coverage. |
| `tests/hosted-web-e2e` | 8 | `npm run test:hosted-web:e2e` | No | Direct Playwright against fixed `127.0.0.1:4175`; shared storage root is currently fixed. |
| `tests/web-driver-e2e` | 1 | `npm run test:web-driver:e2e` | No | Direct Playwright against fixed `127.0.0.1:4174`; script also contains host desktop-routing behavior. |
| Host desktop aliases | n/a | `npm run test:desktop-e2e:host` / `./scripts/run-desktop-e2e-suite.sh` | No | Useful for local debugging, but not the desired supported path. |

### Critical-journey matrix summary
- `tests/ui-coverage-matrix.json` defines **28** critical journeys.
- Required harness counts today:
  - `desktop`: **28 / 28** journeys
  - `browser`: **17 / 28** journeys
  - `hosted-web`: **5 / 28** journeys
  - `web-driver`: **1 / 28** journeys
- Browser-only critical journeys today:
  - `roles-and-workflows-settings`
  - `general-settings`
- Supplemental specs outside the critical-journey matrix still count toward the actual supported surface:
  - browser: **5**
  - desktop: **9**
  - hosted-web: **3**

### Existing split-path problems
1. **Non-desktop E2E bypasses the Podman runner entirely.**
   - `package.json` maps `test:e2e` straight to `playwright test`.
   - `package.json` maps `test:hosted-web:e2e` to direct Playwright with `playwright.hosted-web.config.ts`.
   - `package.json` maps `test:web-driver:e2e` to `scripts/run-web-driver-e2e.sh`.
2. **Fixed ports prevent clean parallel fan-out across suites.**
   - `playwright.config.ts`: `4173`
   - `playwright.hosted-web.config.ts`: `4175`
   - `playwright.web-driver.config.ts`: `4174`
3. **Hosted-web state is not isolated enough for parallel runs.**
   - `scripts/run-hosted-web-e2e.sh` uses a fixed `ORCHESTRA_STORAGE_ROOT` default (`.tmp/hosted-web-e2e-runtime`).
   - The same script kills "stale" listeners on the configured port instead of allocating a unique run-local port.
4. **The repo currently documents multiple supported execution stories.**
   - README documents Podman for desktop, but still points to standalone browser/web-driver flows.
5. **Desktop already solved most of the hard isolation work.**
   - `scripts/run-desktop-e2e-suite-podman.sh` fans out isolated containers.
   - `scripts/run-desktop-e2e.sh` chooses random webdriver/native ports and an isolated test home.
   - `scripts/run-desktop-e2e-container-entry.sh` creates a per-container workspace copy and reuses cached build volumes safely via a lock.

## Target end state
1. **Podman is the only supported E2E execution model.**
   - Developers should not need to decide between direct Playwright, host-local desktop, and Podman paths.
2. **A checked-in top-level suite manifest defines the supported E2E inventory.**
   - Suggested artifact: `tests/e2e-suite.json` or similar.
   - Each entry should record at least: spec path, harness kind, supported runner, and optional quarantine metadata.
3. **Each supported harness runs through a Podman wrapper.**
   - Desktop stays on the current Podman runner.
   - Browser, hosted-web, and web-driver get equivalent Podman wrappers or a generalized Podman entrypoint.
4. **Old direct host/browser execution paths are removed or clearly demoted.**
   - Keep them only if they remain valuable as explicit `:local` or `:debug` escape hatches.
   - They should not be the default documented or CI-facing commands.
5. **Parallel-safe isolation is enforced at the runner boundary.**
   - Unique ports, unique storage roots, unique homes, unique temp roots, and no suite-global listener killing.
6. **Coverage stays split by product surface only when the surface is genuinely different.**
   - Hosted-web and paired mobile-browser coverage can remain if they validate distinct behavior.
   - Pure duplicate runner paths should be retired.

## Recommended migration plan

### Phase 1 — Make the supported E2E inventory explicit
- Add a repo-wide manifest for all supported E2E suites.
- Treat the manifest, not directory globbing plus `package.json`, as the source of truth for:
  - what is supported
  - what is quarantined
  - what harness each spec belongs to
- Keep `tests/desktop-e2e-suite.json` if useful, but either compose it into the top-level manifest or generate the desktop subset from the same shared source.

### Phase 2 — Podmanize the remaining non-desktop harnesses
- Add Podman wrappers for:
  - browser/mock Playwright
  - hosted-web Playwright
  - web-driver/mobile pairing Playwright
- Reuse the existing `Containerfile.desktop-e2e` image where practical; extend it with the browser/runtime dependencies needed for non-desktop Playwright execution.
- Generalize the container entry flow so each harness receives:
  - a unique workspace copy
  - a unique HOME / XDG root / temp root
  - unique ports injected via env
  - harness-specific boot commands

### Phase 3 — Repoint package scripts and retire split runner paths
- Change the supported commands so they all funnel through Podman.
- Strong recommendation:
  - `npm run test:e2e` becomes the umbrella supported Podman suite
  - harness-specific commands remain available, but also call Podman wrappers
- Retire or demote:
  - direct `playwright test` as the supported `test:e2e` path
  - direct hosted-web Playwright startup as the supported path
  - `test:desktop-e2e:host` as a supported path
  - the desktop-routing behavior currently embedded in `scripts/run-web-driver-e2e.sh`

### Phase 4 — Run the full migrated suite, fix failures, and prune obsolete duplication
- Run the full Podman-backed suite after the wrapper migration.
- For each failure, classify it as:
  - runner bug
  - test bug/flaky assertion
  - real product defect
- Only after the full suite is green should the repo remove any duplicated legacy coverage.
- If a non-desktop spec is still needed because it validates a distinct hosted-web/mobile/browser behavior, keep it — but keep it on the Podman runner.

### Phase 5 — Parallel-safety hardening
Hard requirements for the final suite:
- no fixed ports shared across concurrent runs
- no fixed `ORCHESTRA_STORAGE_ROOT` / temp directories / homes
- no global listener-kill behavior as a control path
- no shared seeded project names or repo names when state crosses process boundaries
- no ordering assumptions between spec files
- deterministic cleanup on success and failure

Implementation notes for this phase:
- Parameterize all Playwright configs from env instead of hard-coding `4173` / `4174` / `4175`.
- Replace the hosted-web stale-listener cleanup with run-local port selection.
- Give each harness run a unique storage root and workspace root.
- If any test still depends on a globally stable project slug, repo name, or working directory, add a per-run suffix helper.
- Preserve the desktop shared-build cache lock pattern for expensive build artifacts, but keep runtime state isolated per shard.

### Phase 6 — Final verification and documentation
Minimum final verification should include:
- the full supported Podman suite
- the per-harness supported Podman commands
- a parallel run of the intended full suite (or the maximum supported sharded subset)
- recorded notes on:
  - migrated coverage
  - retired old paths
  - test-only failures vs product bugs
  - parallel-safety changes
  - final pass commands/results

## Concrete implementation recommendations

### Recommended command shape
Suggested supported command surface after migration:
- `npm run test:e2e` → full supported Podman-backed suite
- `npm run test:e2e:desktop` → desktop subset via Podman
- `npm run test:e2e:browser` → browser/mock subset via Podman
- `npm run test:e2e:hosted-web` → hosted-web subset via Podman
- `npm run test:e2e:web-driver` → mobile pairing subset via Podman

If host-local commands remain, rename them to make their status obvious, e.g.:
- `test:e2e:desktop:local`
- `test:e2e:browser:local`

### Recommended scope boundaries
- **Keep** desktop Podman as the baseline architecture.
- **Keep but Podman-wrap** hosted-web and mobile pairing coverage if they still represent distinct product surfaces.
- **Review for retirement** browser-only coverage whose value is just duplicating behavior already proven in desktop or hosted-web Podman runs.
- **Do not** keep multiple equally supported runner families with different isolation rules.

## Verification targets for the implementation lane
The implementation lane should aim to leave behind commands equivalent to:

```bash
npm run test:e2e
npm run test:e2e:desktop
npm run test:e2e:browser
npm run test:e2e:hosted-web
npm run test:e2e:web-driver
E2E_JOBS=4 npm run test:e2e
```

Exact names may differ, but the key requirement is that the supported commands all execute through Podman and that at least one full parallel run is part of the final verification record.

## Appendix A — Full current spec inventory

### `tests/desktop-e2e` (61)
- `tests/desktop-e2e/agent-queue-delete.test.ts`
- `tests/desktop-e2e/agent-terminal-window.test.ts`
- `tests/desktop-e2e/autonomous-workflow.test.ts`
- `tests/desktop-e2e/bridge-diagnostics.test.ts`
- `tests/desktop-e2e/channels-telegram.test.ts`
- `tests/desktop-e2e/chat-mention-autocomplete.test.ts`
- `tests/desktop-e2e/chat-nav.test.ts`
- `tests/desktop-e2e/chat-session-recovery.test.ts`
- `tests/desktop-e2e/command-palette.test.ts`
- `tests/desktop-e2e/desktop-harness.test.ts`
- `tests/desktop-e2e/file-workflow.test.ts`
- `tests/desktop-e2e/general-session-prompt-template.test.ts`
- `tests/desktop-e2e/harness-model-limits.test.ts`
- `tests/desktop-e2e/inbox-messaging.test.ts`
- `tests/desktop-e2e/lane-approval.test.ts`
- `tests/desktop-e2e/lane-workspace-selection.test.ts`
- `tests/desktop-e2e/navigation-badges.test.ts`
- `tests/desktop-e2e/navigation-layout.test.ts`
- `tests/desktop-e2e/packaged-runtime-smoke.test.ts`
- `tests/desktop-e2e/project-local-repo.test.ts`
- `tests/desktop-e2e/project-setup.test.ts`
- `tests/desktop-e2e/project-task-scoping.test.ts`
- `tests/desktop-e2e/remote-access.test.ts`
- `tests/desktop-e2e/review-action-regression.test.ts`
- `tests/desktop-e2e/role-runtime-single-use.test.ts`
- `tests/desktop-e2e/scoped-agents.test.ts`
- `tests/desktop-e2e/session-controls.test.ts`
- `tests/desktop-e2e/session-error-logging.test.ts`
- `tests/desktop-e2e/session-missing-cwd-logging.test.ts`
- `tests/desktop-e2e/session-refresh-churn.test.ts`
- `tests/desktop-e2e/session-restart-resume.test.ts`
- `tests/desktop-e2e/session-runtime-details.test.ts`
- `tests/desktop-e2e/session-transcript.test.ts`
- `tests/desktop-e2e/sessions-delete-closed.test.ts`
- `tests/desktop-e2e/skills-settings.test.ts`
- `tests/desktop-e2e/system-notifications.test.ts`
- `tests/desktop-e2e/task-auto-dispatch-on-blocker-completion.test.ts`
- `tests/desktop-e2e/task-board-scroll.test.ts`
- `tests/desktop-e2e/task-close-button.test.ts`
- `tests/desktop-e2e/task-comment-file-links.test.ts`
- `tests/desktop-e2e/task-comment-file-mentions.test.ts`
- `tests/desktop-e2e/task-comment-ordering.test.ts`
- `tests/desktop-e2e/task-comment-replies.test.ts`
- `tests/desktop-e2e/task-comment-unread-badges.test.ts`
- `tests/desktop-e2e/task-default-file-comments.test.ts`
- `tests/desktop-e2e/task-detail-nav.test.ts`
- `tests/desktop-e2e/task-detail-reorg.test.ts`
- `tests/desktop-e2e/task-dispatch.test.ts`
- `tests/desktop-e2e/task-file-viewer-controls.test.ts`
- `tests/desktop-e2e/task-markdown-lists.test.ts`
- `tests/desktop-e2e/task-quick-comment-file-mentions.test.ts`
- `tests/desktop-e2e/task-repo-files-tab.test.ts`
- `tests/desktop-e2e/task-repository-info-pane.test.ts`
- `tests/desktop-e2e/task-schedules.test.ts`
- `tests/desktop-e2e/task-table-row.test.ts`
- `tests/desktop-e2e/task-todos.test.ts`
- `tests/desktop-e2e/task-whip.test.ts`
- `tests/desktop-e2e/theme-selection.test.ts`
- `tests/desktop-e2e/workflow-lifecycle.test.ts`
- `tests/desktop-e2e/workflow-recovery.test.ts`
- `tests/desktop-e2e/workforce-filters.test.ts`

### `tests/e2e` (24)
- `tests/e2e/agents.spec.ts`
- `tests/e2e/app-header.spec.ts`
- `tests/e2e/channels.spec.ts`
- `tests/e2e/chat.spec.ts`
- `tests/e2e/command-palette.spec.ts`
- `tests/e2e/general.spec.ts`
- `tests/e2e/github-landing.spec.ts`
- `tests/e2e/inbox.spec.ts`
- `tests/e2e/navigation-badges.spec.ts`
- `tests/e2e/notes.spec.ts`
- `tests/e2e/pi-auth.spec.ts`
- `tests/e2e/projects.spec.ts`
- `tests/e2e/remote.spec.ts`
- `tests/e2e/roles.spec.ts`
- `tests/e2e/scoped-agents.spec.ts`
- `tests/e2e/sessions.spec.ts`
- `tests/e2e/system-notifications.spec.ts`
- `tests/e2e/task-comment-deletion.spec.ts`
- `tests/e2e/task-default-file-comments.spec.ts`
- `tests/e2e/task-mobile-typography.spec.ts`
- `tests/e2e/task-schedules.spec.ts`
- `tests/e2e/tasks.spec.ts`
- `tests/e2e/theme.spec.ts`
- `tests/e2e/workflows.spec.ts`

### `tests/hosted-web-e2e` (8)
- `tests/hosted-web-e2e/agents.spec.ts`
- `tests/hosted-web-e2e/auth.spec.ts`
- `tests/hosted-web-e2e/chat.spec.ts`
- `tests/hosted-web-e2e/inbox.spec.ts`
- `tests/hosted-web-e2e/projects.spec.ts`
- `tests/hosted-web-e2e/sessions.spec.ts`
- `tests/hosted-web-e2e/source-control.spec.ts`
- `tests/hosted-web-e2e/tasks.spec.ts`

### `tests/web-driver-e2e` (1)
- `tests/web-driver-e2e/pairing.spec.ts`
