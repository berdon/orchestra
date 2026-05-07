# Orchestra automated UI coverage and build-gate semantics

ORC-30 intentionally enforces **two different coverage signals** so the project does not collapse browser, desktop, and helper-layer testing into one misleading number.

## 1. Automated UI coverage = critical-journey coverage

The phrase **"automated UI coverage above 90%"** means the checked-in critical-journey matrix in `tests/ui-coverage-matrix.json`.

### Measurement rule

- Every row in the matrix is a **user-visible journey**, not a file count and not an assertion count.
- A journey counts as covered only when:
  - its mapped spec files exist in the repository, and
  - every required harness for that journey has at least one mapped spec, and
  - any mapped desktop spec is part of the required supported E2E suite resolved from `tests/e2e-suite.json`
- The matrix is validated by:

```bash
npm run test:ui:matrix
```

### Current result

- **30 / 30 critical journeys covered = 100.0%**
- enforced threshold: **>= 90%**

### Surface summary

- Tasks: 10 / 10
- Inbox: 2 / 2
- Agents: 2 / 2
- Settings: 4 / 4
- Remote: 1 / 1
- Chat: 1 / 1
- Sessions: 4 / 4
- Navigation: 3 / 3
- Workflows: 2 / 2
- Infrastructure: 1 / 1

## 2. Build-gated coverage = Vitest V8 coverage for stable UI helper/state modules

The fast build gate is the Vitest/V8 coverage report configured in `vite.config.ts` and run with:

```bash
npm run test:coverage
```

### Enforced threshold

The build fails if any of these overall metrics drop below **90%**:

- statements
- functions
- lines

Branch coverage is reported in every run and written to the same coverage reports, but it is not the blocking threshold for ORC-30.

### Covered code scope

The enforced Vitest gate intentionally targets the deterministic frontend/shared-UI helper layer that already has stable unit/integration coverage:

- `src/lib/access.ts`
- `src/lib/commandPalette.ts`
- `src/lib/defaultInstallBaseline.ts`
- `src/lib/orchestraPaths.ts`
- `src/lib/referenceMentions.ts`
- `src/lib/sessionListMerge.ts`
- `src/lib/taskTags.ts`
- `src/lib/taskUnreadCommentVisibility.ts`
- `src/lib/theme.ts`
- `src/pages/tasks/taskDetailLoadGuards.ts`
- `src/pages/tasks/taskOverviewState.ts`

This scope is deliberate:

- large browser/desktop shells are already protected by the critical-journey UI matrix
- the enforced Vitest layer stays fast and deterministic enough for routine local and CI use
- the gate focuses on shared UI logic/state that is easiest to regress silently in ordinary development

### Current result

Current `npm run test:coverage` output on this branch:

- **Statements:** 96.45%
- **Functions:** 93.10%
- **Lines:** 96.45%
- **Branches:** 81.46% (reported, not blocking)

Reports are emitted to `coverage/vitest/` with:

- text summary in the terminal
- HTML report
- `json-summary`
- `lcov`

## Desktop suite source of truth

ORC-30 also removes the old desktop suite drift where the package scripts listed only a subset of authored desktop specs.

The required desktop suite is now derived from the shared supported E2E manifest:

- `tests/e2e-suite.json`
- `scripts/e2e-suite.mjs`
- `scripts/desktop-e2e-suite.mjs`

Current desktop suite policy:

- include every `tests/desktop-e2e/*.test.ts` file by default
- only exclude a spec by adding an explicit quarantine entry in `tests/e2e-suite.json`
- both `npm run test:e2e:desktop` and `npm run test:e2e:desktop:local` consume the same source of truth

That keeps authored desktop coverage and executed desktop coverage aligned.

## Local and CI entry points

```bash
npm test
npm run test:coverage
npm run test:ui:matrix
npm run test:e2e
npm run test:e2e:browser
npm run test:e2e:hosted-web
npm run test:e2e:web-driver
npm run test:e2e:desktop
npm run test:e2e:desktop:local
npm run verify
```

`npm run verify` is the checked-in fast gate used by CI. It runs:

1. `npm run test:coverage`
2. `npm run test:ui:matrix`

Use the harness-specific Podman-backed commands above when you want to execute one full UI harness directly. Use the explicit `:local` aliases only for host-local debugging.
