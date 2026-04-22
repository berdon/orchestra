# ORC-33 automated secret and machine-reference guardrails plan

## Problem summary

ORC-33 needs a repeatable pre-release guardrail that checks three different leak surfaces:

1. **current source** for committed secrets and machine-specific references
2. **git history** for older secrets that still exist in reachable commits
3. **built artifacts** for secrets or machine-local paths that get baked into the shipped app bundle

The current repo does not have that guardrail yet:

- `package.json` exposes build/test commands, but no secret or release-preflight scan commands.
- `scripts/build-adhoc.sh` is the current "quick build" entrypoint for macOS bundle output.
- `src-tauri/tauri.conf.json` bundles more than the Rust binary: it also ships `extensions/orchestra-tools.ts`, `mobile/dist-web`, and `icon.png`, so the artifact scan needs to inspect bundled resources as well as the executable.
- `scripts/run-desktop-e2e.sh` already uses `strings` against the built binary to assert the embedded preview URL, which is a good precedent for artifact-string inspection.

## Baseline observations from the current repository

A quick repo audit gives two important constraints for the design:

- the current working tree has **no hits for a representative audited username (for example `example-user`) or `/Users/`**
- the repository has **many intentional `.orchestra` references** in runtime path helpers, tests, and docs

That means the machine-reference guardrail should **not** treat every `.orchestra` mention as a leak. It should distinguish between:

- acceptable product/documentation references such as `~/.orchestra/projects/{project-slug}/...`
- unacceptable machine-bound expansions such as `/Users/<name>/.orchestra/...`, `/home/<name>/.orchestra/...`, or task workspace paths copied from a real workstation

## Goals

1. Catch high-confidence secrets in both the working tree and git history.
2. Catch machine-specific usernames and absolute local paths before release.
3. Scan the actual built bundle contents, not just source files.
4. Keep false positives reviewable with explicit, repo-owned allowlists.
5. Provide a **single verified release command** that humans can run before distributing a build.
6. Keep the implementation repo-local so a future CI system can call the same commands instead of re-implementing them.

## Non-goals

- broad SAST or dependency-vulnerability scanning
- secret rotation or history rewrite work itself
- blocking every local developer build; the guardrail should protect release flow, not slow normal iteration by default
- inventing a generic policy engine for every kind of content check

## Proposed guardrail stack

### 1. Secret scanning with gitleaks

Use **gitleaks** as the main secret scanner because it covers both:

- the current tree
- full git history

#### Proposed repo additions

- `.gitleaks.toml`
- `scripts/ensure-gitleaks.sh`
- `scripts/run-secret-scan.sh`

#### Behavior

`run-secret-scan.sh` should expose two modes:

- **source mode**: scan the current checkout
- **history mode**: scan reachable git history

Recommended implementation details:

- pin one reviewed gitleaks version inside `ensure-gitleaks.sh`
- honor `GITLEAKS_BIN` when CI or a developer already has gitleaks installed
- default to redacted output
- write JSON/SARIF reports under `.tmp/guardrails/` for debugging and future task attachments

#### Allowlist strategy

Keep the gitleaks config surgical:

- allowlist exact known false positives
- allowlist by file path only when the file is generated/vendor/test-fixture content
- avoid a large opaque baseline unless the repo audit proves it is unavoidable

That keeps the history scan trustworthy instead of silently normalizing unknown findings.

### 2. Machine-reference scanner for source and extracted strings

Add a small repo-local scanner for the leak classes that gitleaks does not model well.

#### Proposed repo additions

- `scripts/scan-machine-references.mjs`
- `guardrails/machine-reference-rules.json`
- `guardrails/machine-reference-allowlist.json`

A Node-based scanner is a good fit here because the repo already uses Node tooling and the same logic can be reused for both source files and artifact-derived text.

#### What it should flag by default

1. **Exact machine/user identifiers**
   - keep the committed baseline config-driven and placeholder-safe
   - keep real audited usernames out of committed repo content
   - pass machine-specific usernames via runtime inputs such as an environment variable, CLI flag, or optional gitignored local rules file

2. **Expanded home-directory paths**
   - `/Users/<name>/...`
   - `/home/<name>/...`
   - `C:\Users\<name>\...`

3. **Expanded Orchestra storage/workspace paths**
   - concrete `.orchestra` paths rooted in a real machine path
   - task workspace paths such as `.../.orchestra/projects/.../task-workspaces/tasks/...`
   - role runtime/worktree paths copied from a live machine

4. **Other concrete machine-local temp/workspace paths**
   - path shapes that clearly came from a real execution environment rather than a placeholder

#### What it should *not* fail on by default

- `~/.orchestra/...` documentation placeholders
- `/tmp/orchestra-home/.orchestra/...` style test fixtures when they are explicitly allowlisted
- environment-variable names such as `ORCHESTRA_BRIDGE_TOKEN`
- generic product terms like `secret`, `token`, or `key` when they are identifiers rather than leaked values

#### Allowlist shape

Keep allowlists explicit and reviewable:

- path glob
- regex or literal value
- reason

That allows legitimate docs/tests to stay green without weakening the production leak signal.

### 3. Artifact scan over built bundle output

Add a dedicated artifact scan step that runs **after build** and inspects the bundle contents that would actually ship.

#### Proposed repo additions

- `scripts/scan-release-artifacts.sh`

#### Why a dedicated artifact scan is needed

`src-tauri/tauri.conf.json` shows that the bundle contains:

- the compiled Tauri binary
- bundled web assets from `mobile/dist-web`
- `extensions/orchestra-tools.ts`
- icon/resources

A release check that only scans source can miss:

- strings embedded into the binary during compile/link steps
- copied resources inside the app bundle
- generated frontend output that contains a machine-local URL/path

#### Scan strategy

The artifact scan should inspect:

- `src-tauri/target/<profile>/bundle/macos/Orchestra.app` when present
- `src-tauri/target/<profile>/bundle/dmg/*` when present
- `dist/` and `mobile/dist-web/` when they are part of the release flow

Recommended mechanics:

- run `strings` over executable/binary files
- run text regex checks over text resources
- feed both raw text files and extracted `strings` output through the same machine-reference matcher
- optionally reuse gitleaks on extracted text where practical, but the machine-reference scan is the primary artifact-specific value

The repo already uses `strings` in `scripts/run-desktop-e2e.sh`, so this keeps the implementation consistent with existing tooling.

## Command surface

Add release-oriented commands instead of changing the existing fast-path build command.

### `package.json` scripts

Recommended additions:

- `scan:secrets` — gitleaks current source scan
- `scan:history` — gitleaks git-history scan
- `scan:machine-refs` — machine-reference scan on tracked source files
- `scan:artifacts` — artifact scan against built outputs
- `scan:guardrails` — source + history + machine-reference checks
- `build:adhoc:verified` — `scan:guardrails` → `./scripts/build-adhoc.sh` → `scan:artifacts`

### Why keep `build-adhoc.sh` unchanged

`build-adhoc.sh` is currently documented as the quick local build path. Replacing it with a mandatory deep scan would make ordinary iteration slower and would fail on machines that have not yet installed the guardrail toolchain.

A separate verified build command keeps the release path safe without surprising day-to-day development.

## Expected file layout

A minimal implementation would likely add:

- `.gitleaks.toml`
- `guardrails/machine-reference-rules.json`
- `guardrails/machine-reference-allowlist.json`
- `scripts/ensure-gitleaks.sh`
- `scripts/run-secret-scan.sh`
- `scripts/scan-machine-references.mjs`
- `scripts/scan-release-artifacts.sh`
- docs updates in `README.md` and/or `docs/adhoc-signing.md`

## Validation plan

1. **Unit/fixture coverage** for the machine-reference matcher:
   - catches `/Users/alice/.orchestra/...`
   - catches `C:\Users\alice\...`
   - does not fail on `~/.orchestra/...`
   - respects allowlist entries with reasons

2. **Smoke coverage for gitleaks wrapper**:
   - clear error when gitleaks is unavailable and cannot be bootstrapped
   - stable report output path under `.tmp/guardrails/`

3. **Artifact-scan regression fixture**:
   - synthetic text/binary fixture that embeds a fake machine-local path
   - proves `strings`/text scanning catches it

4. **Repo-level dry run**:
   - `npm run scan:guardrails`
   - `npm run build:adhoc:verified`

## Rollout sequence

1. Add the scanner configs and wrapper scripts.
2. Run them against the repo and fix or explicitly allowlist legitimate hits.
3. Add the verified release command.
4. Update build/release docs to point humans at the verified path.
5. Later, when repo CI exists, call the same commands from CI rather than duplicating the logic there.

## Recommendation summary

Implement ORC-33 as a **three-layer release guardrail**:

- **gitleaks** for source + history secrets
- **repo-local regex scanning** for usernames and machine-bound paths
- **post-build artifact scanning** using `strings` plus text/resource inspection

The most important design choice is precision: **flag concrete machine-bound references, not every `.orchestra` mention**. The repo intentionally documents Orchestra-managed storage under `~/.orchestra`; the guardrail should block leaked workstation paths, usernames, and bundled build-time references without fighting legitimate docs and tests.