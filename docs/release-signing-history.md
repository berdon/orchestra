# Orchestra macOS release signing / notarization history

This note captures the previously successful local macOS release-signing workflow so it is not lost.

## Evidence sources

- Pi session log:
  - `/Users/auhanson/.orchestra/projects/orchestra-dev/sessions/2026-05-05T10-28-49-086182+00-00_6ec1cb5b-b551-4444-b980-6267be03cb1a.jsonl`
- Current automation:
  - `scripts/build-release-artifacts.sh`
  - `scripts/sign-macos-app-and-dmg.sh`
  - `scripts/verify-bundled-pi-release.sh`

## Known-good local signing identity

Use this Developer ID cert:

- `Developer ID Application: Austin Hanson (P53CT5M3KX)`

The team ID is:

- `P53CT5M3KX`

## Known-good notarytool profile

The successful prior session created and used this keychain profile:

- profile name: `orchestra-notary`

It was created with:

```bash
xcrun notarytool store-credentials orchestra-notary \
  --key "$HOME/Downloads/AuthKey_2SSBKV2GGZ.p8" \
  --key-id 2SSBKV2GGZ \
  --issuer 38b6984d-c0f6-44ad-8547-0a0855007e65
```

The prior session output confirmed:

- `Credentials validated.`
- `Credentials saved to Keychain.`
- `To use them, specify --keychain-profile "orchestra-notary"`

## Previously successful app notarization flow

The prior successful app flow was:

### 1) Build a sanitized release bundle

```bash
ORCHESTRA_BUILD_PROFILE=release ORCHESTRA_SANITIZE_BUILD_PATHS=1 ./scripts/build-adhoc.sh
```

### 2) Re-sign nested binaries with the Developer ID cert

The session explicitly re-signed:

- `Contents/Resources/pi-runtime/runtime/pi`
- `Contents/Resources/pi-runtime/bun/bin/bun`
- `Contents/MacOS/orc`
- `Contents/MacOS/orchestra`

using hardened runtime + timestamp.

### 3) Refresh the bundled runtime manifest hashes

Because signing changes binary bytes, the session updated `Contents/Resources/pi-runtime/manifest.json` for:

- `runtime/pi`
- `bun/bin/bun`

### 4) Re-sign the outer app bundle

After refreshing manifest hashes, the outer app bundle was re-signed with:

- `src-tauri/entitlements.plist`
- hardened runtime
- secure timestamp

### 5) Notarize a ZIP of the app, not the raw `.app`

Direct `notarytool submit "$APP"` was not the winning path.

The successful command path was:

```bash
APP="src-tauri/target/release/bundle/macos/Orchestra.app"
ZIP="src-tauri/target/release/bundle/macos/Orchestra-notary.zip"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"
xcrun notarytool submit "$ZIP" --keychain-profile orchestra-notary --wait
xcrun stapler staple "$APP"
spctl -a -vv "$APP"
```

### 6) Successful result from the prior session

The prior session recorded:

- submission accepted
- app stapling succeeded
- `spctl` result:
  - `accepted`
  - `source=Notarized Developer ID`
- `codesign -dvvv` showed:
  - `Authority=Developer ID Application: Austin Hanson (P53CT5M3KX)`
  - `Notarization Ticket=stapled`

## Important caveat: manifest refresh is required after signing nested runtime binaries

The prior session explicitly noted that the bundled runtime manifest must be updated after signing `pi` and bundled `bun`, otherwise `verify-bundled-pi-release.sh` reports checksum mismatches.

## DMG history

In that same prior session:

- the app notarization succeeded
- an initial DMG notarization attempt failed
- the failure was investigated as a race / invalid submission problem while recreating the DMG
- the final assistant summary from that session said the app was signed + notarized, while the DMG was still not yet notarized

So the strongest previously verified signal is:

- **app notarization:** yes
- **DMG notarization in that session:** not the final successful path

## Current repo automation

The repo now contains `scripts/sign-macos-app-and-dmg.sh`, which codifies the intended release flow:

1. sign nested runtime binaries
2. sign helper executables
3. sign outer app
4. verify bundled runtime release artifacts
5. notarize/staple the app by first zipping it internally
6. create a signed DMG
7. notarize/staple the DMG

Expected env/config for that script:

- `ORCHESTRA_CODESIGN_IDENTITY` or `APPLE_SIGNING_IDENTITY`
- `ORCHESTRA_NOTARYTOOL_PROFILE=orchestra-notary`

Recommended invocation from the repo root:

```bash
./scripts/build-release-artifacts.sh
ORCHESTRA_CODESIGN_IDENTITY="Developer ID Application: Austin Hanson (P53CT5M3KX)" \
ORCHESTRA_NOTARYTOOL_PROFILE=orchestra-notary \
./scripts/sign-macos-app-and-dmg.sh --profile release
```

## Practical takeaway

If local env vars are empty, do **not** assume notarization is impossible until checking whether the keychain profile already exists under the name:

- `orchestra-notary`

That is the profile name used in the last known-good local notarization flow.
