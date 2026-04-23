# ORC-48 — Release artifact sanitization plan

## Goal

Make packaged Orchestra release artifacts safe to ship by removing build-time absolute paths, usernames, task-workspace paths, package metadata that exposes local handles, and machine-specific example hosts. The end state should be a repeatable release build that can be scanned and shown clean.

## Confirmed current leak sources

Current source inspection matches the ORC-38 audit findings and identifies these artifact-producing leak paths:

1. **Compile-time checkout paths baked into runtime code**
   - `src-tauri/src/services/pi_sessions.rs` uses `env!("CARGO_MANIFEST_DIR")` to derive a fallback project root.
   - `src-tauri/src/services/projects.rs` uses `env!("CARGO_MANIFEST_DIR")` while seeding the default project repository path.
   - `src-tauri/src/services/remote_api.rs` uses `env!("CARGO_MANIFEST_DIR")` to find `../mobile/dist-web`.
   - In a task workspace build, those macros embed the full checkout path under `.orchestra/projects/.../task-workspaces/...` directly into the binary.

2. **Bundle/package metadata leaks a local handle**
   - `src-tauri/Cargo.toml` currently sets `authors = ["openclaw"]`.
   - Tauri/Cargo bundle metadata can surface this value in packaged app metadata, so it should not use a personal handle.

3. **Bundled mobile web resources ship a real-looking private LAN host**
   - `mobile/App.tsx` returns `http://192.168.1.10:49500` from `defaultHostUrlDraft()` for non-web platforms.
   - Because `mobile/dist-web` is bundled into the desktop app as a resource, that string lands in shipped assets.

4. **Release-build hardening is missing today**
   - There is no repository-level release build wrapper that remaps path prefixes before `cargo tauri build`.
   - There is no artifact scan script that fails the build when usernames, home-directory paths, task-workspace paths, or known bad host strings appear.
   - The current helper `scripts/build-adhoc.sh` is a plain debug build and does not sanitize release outputs.

## Planning decisions

### 1. Shipped runtime code must not depend on compile-time checkout paths

`env!("CARGO_MANIFEST_DIR")` is acceptable for build scripts but not for runtime code that ships in the app binary.

For shipped code, fallback resolution should happen at runtime from explicit runtime signals, in this order:

- `ORCHESTRA_PROJECT_ROOT` when present
- packaged resources via Tauri resource lookup
- runtime/discovery heuristics for a nearby development checkout
- safe null/empty fallback behavior when no development checkout exists

This removes the direct source of embedded task-workspace paths.

### 2. Release packaging should sanitize compiler-generated path strings as a separate hardening layer

Even after removing explicit `env!` path usage, release packaging should still remap and strip build paths so accidental future regressions do not leak a real home directory or checkout location.

Recommended approach:

- use a dedicated release build wrapper script
- compute the active repo root and home-related paths at build time
- pass `RUSTFLAGS` remaps for the repo root and home-family paths to stable placeholders
- strip release binaries/symbols before scanning shipped outputs

This should treat path remapping as a release-build contract, not a one-off manual step.

### 3. Bundle metadata must use project/org-safe values

Personal handles should not appear in package metadata for shipped artifacts. Use an organization/project label instead, or remove the field if the bundle stays valid without it.

### 4. Bundled UI defaults should be neutral and documentation-safe

The mobile/web pairing UI should not ship a private LAN address as its default. On web, deriving a suggestion from the current page host is still useful and not machine-specific. On native, the default should be blank or use neutral placeholder/help text rather than a real host string.

### 5. Artifact scanning should be codified

The build should end with a repeatable scan that checks binaries and bundled resources for known leak markers. That scan should be easy to run locally and easy to promote into CI later.

## Proposed implementation slices

### Slice A — Centralize runtime path discovery and remove compile-time path macros from shipped code

Add a shared runtime helper, likely under `src-tauri/src/services/`, that can locate a development checkout without embedding it at compile time.

Suggested behavior:

- resolve an explicit dev root from `ORCHESTRA_PROJECT_ROOT` when set
- otherwise inspect `current_dir()` and/or ancestor directories for a repo shape such as:
  - `src-tauri/Cargo.toml`
  - `package.json`
  - `mobile/`
- return `None` when no dev checkout is discoverable

Then update the known leak sites:

- `src-tauri/src/services/pi_sessions.rs`
  - replace `fallback_manifest_project_root()` with runtime discovery
- `src-tauri/src/services/remote_api.rs`
  - keep packaged-resource lookup first
  - replace the `env!("CARGO_MANIFEST_DIR")` dev fallback with runtime checkout discovery
- `src-tauri/src/services/projects.rs`
  - stop seeding a default repository path from `env!("CARGO_MANIFEST_DIR")`
  - only seed a repo path when runtime discovery finds a real dev checkout
  - otherwise allow the default project to exist without a checkout-derived repository path

This slice removes the direct binary embedding of build checkout paths.

### Slice B — Add a supported sanitized release build path

Add a release packaging script such as `scripts/build-release-artifacts.sh` that becomes the supported way to produce shippable macOS artifacts.

The script should:

1. compute paths dynamically from the active machine/session:
   - repo root
   - `HOME`
   - `CARGO_HOME` if set
   - `RUSTUP_HOME` if set
2. append `RUSTFLAGS` remaps like:
   - repo root -> `/workspace/orchestra`
   - home dir -> `/workspace/home`
   - cargo home -> `/workspace/cargo-home`
   - rustup home -> `/workspace/rustup-home`
3. enable stripped release output
4. build all bundled assets:
   - `npm run build`
   - `cd mobile && npm run web:build`
   - `cargo tauri build --release`

If it is practical to encode part of the stripping policy in Cargo profile settings as a backstop, do that too. The key requirement is that the official release path always applies remapping before packaging.

### Slice C — Remove personal package metadata from the bundle

Change `src-tauri/Cargo.toml` so the package metadata does not use `openclaw`.

Safer values:

- `Orchestra Contributors`
- `Guppy`
- another project/org label already used elsewhere in release-facing metadata

Then verify the built app metadata no longer contains the personal handle.

### Slice D — Remove the private-host default from bundled mobile assets

Update `mobile/App.tsx` so:

- web keeps deriving a suggested API URL from the current page host
- native no longer returns `http://192.168.1.10:49500`
- the input starts blank or is guided by neutral placeholder/help text instead

Any tests that depended on the old hard-coded value should switch to explicit test inputs or documentation-safe examples such as `example.invalid`, rather than relying on a private LAN IP.

### Slice E — Add an artifact leak scan script

Add a script such as `scripts/scan-artifact-leaks.sh` that scans release outputs and exits non-zero on matches.

The scan should cover at least:

- app binary under `Orchestra.app/Contents/MacOS/`
- bundled resources under `Orchestra.app/Contents/Resources/`
- plist/metadata files
- other shipped sidecars if they are part of the release deliverable

Default patterns should include:

- `/Users/`
- `/home/`
- `.orchestra/projects/`
- `task-workspaces`
- `auhanson`
- `openclaw`
- `192.168.1.10:49500`

It should also support adding caller-provided extra patterns so a release run can scan for the exact active checkout path if desired.

## Validation plan

1. Run the sanitized release build script.
2. Run the artifact scan script against the generated bundle outputs.
3. Manually spot-check the main app binary and resources when needed, for example with:
   - `strings Orchestra.app/Contents/MacOS/orchestra | rg 'Users|auhanson|openclaw|192.168.1.10|task-workspaces'`
   - `rg -n '192\.168\.1\.10:49500|openclaw|auhanson|task-workspaces|/Users/' Orchestra.app/Contents/Resources`
4. Re-run any targeted tests affected by:
   - pairing/default host UI behavior
   - default project/repository-path fallback behavior
5. Treat the task as done only when the packaged release artifact scan is clean and repeatable.

## Scope notes

This task should focus on shipped artifact leakage. Source-only examples and historical git metadata from prior commits are related audit findings, but they are follow-on cleanup unless they still flow into packaged outputs.
