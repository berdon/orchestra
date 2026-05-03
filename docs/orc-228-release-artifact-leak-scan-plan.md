# ORC-228 — Release artifact leak scan hardening plan

## tl;dr
- Keep `scripts/scan-release-artifacts.sh` as the canonical built-artifact scanner.
- Extend it to run both **artifact secret scanning** and **artifact machine-reference/path scanning** over the extracted bundle snapshot.
- Classify artifact findings so **first-party leaks fail** the scan while **known third-party embedded build-path findings** are reported separately with reasons.
- Update `build-release-artifacts.sh`, `README.md`, and `docs/adhoc-signing.md` so there is one documented release-scan workflow and clear pass/fail guidance.

## Executive summary
The repo already has most of the needed pieces, but they are split. `scripts/scan-release-artifacts.sh` is the package-wired artifact scanner, while the older `scripts/scan-artifact-leaks.sh` is still called by `scripts/build-release-artifacts.sh`. The current artifact flow already snapshots bundle text plus `strings`, but it only reports raw machine-reference matches. It does not yet scan built-artifact snapshots for secrets, and it does not distinguish actionable first-party leaks from expected third-party embedded path noise.

The lowest-churn fix is to consolidate on `scan-release-artifacts.sh`, reuse the existing gitleaks bootstrap plus machine-reference matcher, and add artifact-specific classification/reporting plus operator docs.

## Current state and gaps
- `package.json` already exposes `scan:artifacts`, `scan:artifacts:release`, and `build:adhoc:verified`.
- `scripts/scan-release-artifacts.sh` already prepares a text/`strings` snapshot of `Orchestra.app`, DMG outputs, and `dist/`.
- `scripts/scan-machine-references.mjs` already supports reusable rule + allowlist driven scanning and JSON reporting.
- `scripts/run-secret-scan.sh` already wraps gitleaks, but its current config intentionally excludes build-output-shaped paths such as `src-tauri/target` and `dist`, so it cannot be reused for artifact snapshots unchanged.
- `scripts/scan-artifact-leaks.sh` is now redundant/legacy and still creates a second artifact-scan path with different behavior.

## Proposed implementation

### 1. Canonicalize the artifact scan entrypoint
- Treat `scripts/scan-release-artifacts.sh` as the only supported built-artifact scanner.
- Update `scripts/build-release-artifacts.sh` to call the canonical artifact scan instead of `scripts/scan-artifact-leaks.sh`.
- Either remove `scripts/scan-artifact-leaks.sh` or turn it into a thin compatibility wrapper that delegates to `scan-release-artifacts.sh`.

### 2. Add artifact secret scanning
- Reuse `scripts/ensure-gitleaks.sh`, but add a helper path that can scan an explicit directory snapshot with a dedicated report stem such as `gitleaks-artifacts-release`.
- Add an **artifact-specific gitleaks config** or mode that does **not** exclude copied `src-tauri/target/...` / `dist/...` snapshot paths.
- Run gitleaks against the extracted artifact snapshot, not just the source tree, so secrets baked into binaries/resources can be caught after build.
- Keep gitleaks output redacted and report-backed under `.tmp/guardrails/` like the existing source/history scans.

### 3. Distinguish first-party failures from known third-party findings
- Extend the artifact scan/reporting layer so findings can be classified by bundle path ownership:
  - **fail:** first-party Orchestra binaries/resources (`orchestra`, `orc`, first-party bundled app assets)
  - **documented/known:** vetted third-party runtime assets that embed upstream build paths but are not Orchestra-local leaks
- Store that classification in a narrow artifact-specific config/allowlist with human-readable reasons.
- Keep the output actionable:
  - failing section for release-blocking first-party leaks
  - separate known-findings/suppressed section for acceptable third-party noise
- Do not blanket-allowlist generic path patterns; allowlist by concrete bundle path scope plus reason.

### 4. Document the release workflow and interpretation rules
Update `README.md` and `docs/adhoc-signing.md` with:
- the canonical commands:
  - `npm run scan:artifacts:release`
  - `npm run build:adhoc:verified`
- what counts as a hard failure:
  - any unsuppressed artifact gitleaks hit
  - any unsuppressed first-party machine/path leak in the built `.app`
- what may be reported but tolerated today:
  - explicitly documented third-party embedded build-path findings, if any remain
- remediation guidance:
  - fix first-party leaks in source/build config/path remapping
  - only add allowlist entries for vetted third-party findings with a reason and path scope

## Validation plan
- Add unit coverage for any new artifact-classification helper/config logic.
- Add a smoke test or fixture-driven check that artifact secret scanning catches a fake secret inside a build-output-shaped snapshot path that source-mode scanning intentionally ignores today.
- Manually validate with:
  - `npm run scan:artifacts:release`
  - `npm run build:adhoc:verified`
- Confirm the resulting reports clearly separate:
  - release-blocking first-party findings
  - documented third-party accepted findings

## Implementation order
1. Consolidate script entrypoints around `scan-release-artifacts.sh`.
2. Add artifact gitleaks support with artifact-specific config/report names.
3. Add artifact ownership classification + known-third-party handling.
4. Update README/adhoc-signing docs and re-verify the end-to-end release command.
