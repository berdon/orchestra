# Quick Start: Adhoc Signing for Orchestra

## Build with Adhoc Signing (Notifications Enabled)

```bash
# One-line build with adhoc signing
./scripts/build-adhoc.sh
```

Or manually:

```bash
source "$HOME/.cargo/env"
cargo tauri build --debug
```

## Run the Built App

```bash
open src-tauri/target/debug/bundle/macos/Orchestra.app
```

## Verify Adhoc Signature

```bash
codesign -dvvv src-tauri/target/debug/bundle/macos/Orchestra.app
# Look for: Signature=adhoc
```

## Key Files

- `src-tauri/tauri.conf.json` - Contains adhoc signing config
- `src-tauri/entitlements.plist` - macOS entitlements for notifications
- `scripts/build-adhoc.sh` - Quick build script

## What's Configured

✅ **Adhoc Signing**: `"signingIdentity": "-"`
✅ **Notifications**: Entitlements allow system notifications
✅ **Custom Notification Icons**: Orchestra logo appears in notifications
✅ **No Apple Developer Account Required**: Works without $99/year

## Dev Mode Also Works

```bash
source "$HOME/.cargo/env"
cargo tauri dev
```

`src-tauri/Cargo.toml` sets `default-run = "orchestra"`, so `cargo tauri dev` still works when helper binaries are present.

The dev build also uses adhoc signing automatically.

## Troubleshooting

**Notifications not showing?**
1. Check macOS System Settings → Notifications → Orchestra
2. Verify the app is signed: `codesign -dvvv Orchestra.app`

**Build errors?**
1. Ensure Xcode CLI tools: `xcode-select --install`
2. Check entitlements file exists: `ls src-tauri/entitlements.plist`

## Full Documentation

See `docs/adhoc-signing.md` for complete details.
