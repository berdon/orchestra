# Packaged Pi runtime release QA checklist

This checklist is the manual counterpart to `scripts/run-packaged-runtime-validation.sh` and `scripts/verify-bundled-pi-release.sh`.

## Preconditions

- Start from a fresh macOS VM or clean macOS user profile.
- Have a packaged Orchestra `.app` or `.dmg` built from the release candidate.
- If you want to run a real prompt, prepare an Orchestra-managed Pi setup fixture containing:
  - `auth.json`
  - `models.json`
- Confirm the clean environment does **not** rely on a personal `~/.pi/agent` directory.

## Automated release validation

1. Build or obtain the packaged app.
2. Run the packaged-runtime smoke harness:
   ```bash
   ORCHESTRA_PACKAGED_RUNTIME_AGENT_FIXTURE_DIR=/path/to/pi-agent \
   ./scripts/run-packaged-runtime-validation.sh
   ```
3. Run the release verification pass against the built app:
   ```bash
   ./scripts/verify-bundled-pi-release.sh release
   ```
4. Review the generated artifacts under `src-tauri/target/release/bundle/release-artifacts/`:
   - `bundled-pi-runtime-release-summary.json`
   - `manifest-verification.json`
   - `codesign-app.txt`
   - `codesign-runtime.txt`
   - `spctl.txt`
   - `notarization.txt` when notarization was requested

## Manual checklist

### Clean-machine contract

- [ ] The validation home does not contain a legacy `~/.pi/agent` directory.
- [ ] Orchestra still launches successfully from the packaged app bundle.
- [ ] `scripts/run-packaged-runtime-validation.sh` completes with an empty `path-tool-trap.log`, proving the packaged app did not attempt to resolve `pi`, `node`, or `npm` from PATH even if the host machine still has those tools installed globally.

### Bundled runtime validation

- [ ] Runtime diagnostics report **packaged mode** and **bundled** runtime source.
- [ ] Runtime diagnostics point at the app-bundled `pi-runtime` resource path.
- [ ] Session runtime details show a bundled runtime manifest path.
- [ ] The bundled runtime manifest verifies successfully with no checksum mismatches.
- [ ] The packaged app can create a real Pi-backed session.
- [ ] With seeded Orchestra-managed auth/models, the packaged app can complete a prompt.

### Auth/model setup validation

- [ ] The app uses `~/.orchestra/runtime/pi/agent`, not `~/.pi/agent`, as the managed Pi state directory.
- [ ] Missing setup surfaces a setup CTA rather than a generic bundled-runtime failure.
- [ ] Invalid `auth.json` produces a clear auth repair message.
- [ ] Invalid `models.json` produces a clear models repair message.
- [ ] Legacy import messaging is still available when a legacy `~/.pi/agent` exists and Orchestra-managed files do not.

### Failure injection

Use a staged copy of the packaged app or the `ORCHESTRA_BUNDLED_PI_RUNTIME_ROOT` override when testing these paths.

- [ ] Removing `manifest.json` reports a manifest-missing bundled-runtime error.
- [ ] Corrupting `manifest.json` reports a manifest-parse bundled-runtime error.
- [ ] Editing a hashed bundled-runtime file reports a checksum-mismatch bundled-runtime error.
- [ ] Removing the bundled runtime executable reports a missing-file bundled-runtime error.
- [ ] Making the bundled runtime executable non-executable reports an unexecutable bundled-runtime error.
- [ ] Configuring `npm:` / `git:` / URL-based extra extensions in packaged mode is rejected clearly.

### Release hardening

- [ ] `codesign --verify --deep --strict --verbose=2` succeeds for the packaged app.
- [ ] `codesign --verify --strict --verbose=2` succeeds for the bundled Pi runtime executable.
- [ ] `spctl -a -vv` accepts the packaged app.
- [ ] If notarization is enabled for this build, notary submission and stapling succeeded.
- [ ] The packaged app resources include `THIRD_PARTY_NOTICES.txt` for the bundled runtime.
- [ ] The packaged app resources include `sbom.cyclonedx.json` for the bundled runtime.
- [ ] The packaged runtime release summary artifact is attached to the release or archived with the build.

## Notes for release owners

- `scripts/run-packaged-runtime-validation.sh` intentionally launches the packaged app through a wrapper that strips `ORCHESTRA_PI_EXECUTABLE`, redirects HOME into a throwaway validation directory, and prepends failing trap binaries for `pi`, `node`, and `npm` ahead of the sanitized PATH. That makes the validation authoritative on both clean hosts and developer machines: if the packaged app tries to use PATH-discovered tooling, the trap log records it and the run fails.
- `scripts/verify-bundled-pi-release.sh` verifies the packaged app bundle, the nested runtime executable, the bundled manifest file inventory, and the bundled notice/SBOM artifacts. For adhoc development builds it records Gatekeeper output without requiring acceptance; for non-adhoc release-signed builds it requires `spctl` acceptance by default unless `ORCHESTRA_REQUIRE_GATEKEEPER=0` is set explicitly.
- For failure injection, prefer overriding `ORCHESTRA_BUNDLED_PI_RUNTIME_ROOT` to point at a staged copy of the runtime resources instead of mutating the real packaged app in place.
