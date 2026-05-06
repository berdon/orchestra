# ORC-250 Podman desktop E2E parallel recovery plan

## tl;dr
- Use the repo-supported Podman desktop runner path only: `npm run test:desktop-e2e`, `./scripts/run-desktop-e2e-suite-podman.sh`, and `./scripts/run-desktop-e2e-podman.sh`.
- The current suite manifest is 61 `tests/desktop-e2e/*.test.ts` specs with an empty quarantine list.
- First get a clean failure inventory from the supported suite wrapper, then separate product regressions from test-only breakage, then harden the suite for parallel safety by removing remaining shared names/state assumptions.
- Revalidate with both a serial Podman suite run and a parallel Podman suite run via `DESKTOP_E2E_JOBS`.

## Executive summary
The repo already has the correct execution surface for this work: `tests/desktop-e2e-suite.json` feeds `scripts/desktop-e2e-suite.mjs`, `./scripts/run-desktop-e2e-suite-podman.sh` fans the suite out across isolated containers, and `DESKTOP_E2E_JOBS` is the supported parallelism control. The planning risk is therefore not “invent a new runner,” but “use the existing runner to expose all current failures, then remove the remaining collision points that keep the authored suite from staying green in parallel over time.”

From the current codebase, the main audit targets are clear:
- many desktop specs still create fixed-named projects/repos/roles/workflows/tasks instead of run-scoped names,
- many specs create or mutate repositories under `ORCHESTRA_TEST_HOME/workspace/...` and need to be checked for any path that escapes that sandbox,
- a few specs already use dynamic suffixes (`channels-telegram`, `session-refresh-churn`, `workflow-recovery`) and should be treated as the model for suite-wide isolation,
- runner-level shared resources already exist by design (Podman image, named cache volumes, shared target volume, build locks), so implementation should preserve that supported path and only harden it where real collisions are observed.

## Current suite inventory
- Manifest source: `tests/desktop-e2e-suite.json`
- Manifest loader: `scripts/desktop-e2e-suite.mjs`
- Supported single-spec Podman runner: `./scripts/run-desktop-e2e-podman.sh tests/desktop-e2e/<spec>.test.ts`
- Supported full/subset Podman suite runner: `./scripts/run-desktop-e2e-suite-podman.sh [specs...]`
- Package alias for the full Podman suite: `npm run test:desktop-e2e`
- Supported parallelism knob: `DESKTOP_E2E_JOBS=<n>`
- Current manifest size: 61 desktop specs
- Current quarantine entries: 0

## Likely failure and collision hotspots to audit first

### 1. Fixed test-created entity names
A large portion of the suite still hard-codes mutable names such as:
- projects (`"Dispatch Project"`, `"Workflow Lifecycle Project"`, `"Approval Lane Project"`)
- repositories (`"Dispatch Repo"`, `"Workflow Lifecycle Repo"`)
- roles/agents/workflows/lanes/tasks with similarly fixed labels

Even with per-run home isolation, these are the most likely long-term parallel hazards and the easiest place for hidden ordering/state assumptions to survive. The implementation should prefer one shared helper for unique run suffixes over more ad hoc per-file naming.

### 2. Filesystem and workspace isolation
Many specs write under `ORCHESTRA_TEST_HOME/workspace/...`. That is the correct pattern. The audit should confirm that all writable fixture paths stay under the test home and that no spec writes to:
- the repo checkout,
- a fixed host temp path,
- a shared path outside the per-run home,
- a reused repository path that depends on suite ordering.

Specs that use direct filesystem setup (`execFileSync`, `mkdirSync`, `writeFileSync`, git init, restart flows, task repo file fixtures) should be checked first.

### 3. Multi-session and restart-sensitive flows
Specs that intentionally create multiple UI/runtime sessions or restart Orchestra are more likely to be flaky or stateful even if names are unique. Prioritize:
- `session-restart-resume.test.ts`
- `session-refresh-churn.test.ts`
- `chat-session-recovery.test.ts`
- `lane-approval.test.ts`
- `task-auto-dispatch-on-blocker-completion.test.ts`
- `workflow-lifecycle.test.ts`

### 4. Local mock services and port usage
Runner scripts already randomize webdriver/native ports, and the in-suite Telegram/Z.ai harnesses already bind port `0`. The audit still needs to confirm no remaining spec-level fixed-port assumptions exist outside runner-owned ports.

### 5. Runner-level shared resources
The Podman workflow intentionally shares:
- the desktop E2E image,
- cargo/npm cache volumes,
- the shared target volume,
- build locks.

Implementation should keep those optimizations and only change them if they cause an observed parallel collision. The default assumption should be “fix the test or product first, harden the runner only where evidence says the runner is the problem.”

## Implementation sequence
1. **Baseline inventory and reproduction**
   - Dump the manifest from `scripts/desktop-e2e-suite.mjs`.
   - Run the full supported Podman suite and record every failing spec.
   - Re-run failing specs individually with `./scripts/run-desktop-e2e-podman.sh` to separate deterministic failures from suite-only flake.
2. **Classify each failure**
   - product regression,
   - stale/brittle test expectation,
   - runner/harness issue,
   - parallel collision/shared-state issue.
3. **Fix deterministic regressions first**
   - repair product bugs before weakening assertions,
   - keep a per-spec record of whether the change was product-side or test-only.
4. **Make the suite explicitly parallel-safe**
   - introduce/reuse a shared unique-name helper for test-created entities,
   - convert remaining fixed mutable names and repository paths to run-scoped variants where needed,
   - keep all writable fixtures under `ORCHESTRA_TEST_HOME`,
   - remove any ordering assumptions that depend on leftover data from earlier specs.
5. **Harden runner scripts only if needed**
   - preserve the supported Podman wrapper flow,
   - change suite/runner scripts only when logs show a true runner-level race or unsupported assumption.
6. **Revalidate in supported modes**
   - serial full-suite Podman run,
   - parallel full-suite Podman run with `DESKTOP_E2E_JOBS` set,
   - targeted reruns for any formerly flaky specs.

## Validation plan
Use only repo-supported commands:

```bash
node ./scripts/desktop-e2e-suite.mjs --json
DESKTOP_E2E_JOBS=1 ./scripts/run-desktop-e2e-suite-podman.sh
./scripts/run-desktop-e2e-podman.sh tests/desktop-e2e/<failing-spec>.test.ts
DESKTOP_E2E_JOBS=2 ./scripts/run-desktop-e2e-suite-podman.sh
```

If the suite remains stable at `2` jobs and the machine budget allows it, optionally increase the parallel run once more before signoff.

## Required implementation notes on the task
The implementer should leave durable task comments that capture:
- the initial failing/flaky specs,
- which fixes were product bugs vs test-only fixes,
- what changed for parallel safety,
- the exact final verification commands and pass/fail results,
- any remaining caveats if a higher parallelism level was intentionally not claimed.

## Expected outcome
After implementation, the authored Podman desktop regression suite should remain aligned with `tests/desktop-e2e/*.test.ts`, pass through the supported Podman wrapper scripts, and run safely in parallel without depending on shared names, leftover state, fixed writable paths, or accidental execution order.