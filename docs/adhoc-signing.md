# Building Orchestra with Adhoc Signing

## Overview

Orchestra can be built with adhoc signing on macOS, which enables system notifications and other macOS features without requiring a paid Apple Developer account.

## What is Adhoc Signing?

Adhoc signing is a lightweight code signing method that:
- Enables macOS features like notifications, filesystem access, and network access
- Works without an Apple Developer account ($99/year)
- Is suitable for development and internal use
- Cannot be distributed outside your organization
- **Enables custom notification icons** (Orchestra logo appears in notifications)

## Configuration

The adhoc signing configuration is in `src-tauri/tauri.conf.json`:

```json
{
  "bundle": {
    "macOS": {
      "signingIdentity": "-",
      "entitlements": "entitlements.plist",
      "hardenedRuntime": false
    }
  }
}
```

Key settings:
- `signingIdentity: "-"` - Tells Tauri to use adhoc signing
- `entitlements` - Points to the entitlements file with required permissions
- `hardenedRuntime: false` - Disabled for adhoc signing (not applicable)

## Entitlements

The entitlements file at `src-tauri/entitlements.plist` contains:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>com.apple.security.app-sandbox</key>
	<false/>
	<key>com.apple.security.application-groups</key>
	<array>
		<string>dev.guppy.orchestra</string>
	</array>
</dict>
</plist>
```

This configuration:
- Disables the app sandbox (needed for notifications and other system features)
- Adds the app to an application group for shared data access

## Building with Adhoc Signing

### Quick Build

Use the provided script:

```bash
./scripts/build-adhoc.sh
```

### Manual Build

```bash
# Source Rust environment
source "$HOME/.cargo/env"

# Build with adhoc signing (automatically uses the config above)
cargo tauri build --debug
```

## Output

After building, you'll find:

- **App Bundle**: `src-tauri/target/debug/bundle/macos/Orchestra.app`
- **DMG Installer**: `src-tauri/target/debug/bundle/dmg/Orchestra_0.1.0_x64.dmg`

## Verifying the Signature

Check that adhoc signing was applied:

```bash
codesign -dvvv src-tauri/target/debug/bundle/macos/Orchestra.app
```

Look for:
- `Signature=adhoc`
- `flags=0x2(adhoc)`

## Running the Built App

```bash
open src-tauri/target/debug/bundle/macos/Orchestra.app
```

## Development vs Production

### Development (`cargo tauri dev`)
- Uses the same adhoc signing configuration
- Automatically signs the dev build
- Notifications work during development

### Production Build
- Use the same build command with release mode:
  ```bash
  cargo tauri build
  ```
- Creates a smaller, optimized binary
- Still uses adhoc signing

## Limitations of Adhoc Signing

1. **Distribution**: Cannot be publicly distributed via App Store or direct download
2. **Gatekeeper**: Users may see warnings when first running the app
3. **Code signature**: Cannot be verified against a trusted certificate
4. **Updates**: Cannot use automatic update mechanisms that require trusted signing

## When to Use Proper Signing

Consider getting an Apple Developer account ($99/year) if:
- You need to distribute Orchestra to users outside your organization
- You want to publish to the Mac App Store
- You need automatic updates
- You want to avoid Gatekeeper warnings for users

## Troubleshooting

### Notifications Not Working

1. Check the app has been signed:
   ```bash
   codesign -dvvv Orchestra.app
   ```

2. Verify notification permissions are enabled:
   - macOS System Settings → Notifications → Orchestra
   - Make sure "Allow Notifications" is enabled

3. Check the app's entitlements:
   ```bash
   codesign -d --entitlements - Orchestra.app
   ```

### Build Failures

If you see signing errors:

1. Ensure Xcode Command Line Tools are installed:
   ```bash
   xcode-select --install
   ```

2. Check that the entitlements file exists:
   ```bash
   ls -la src-tauri/entitlements.plist
   ```

3. Verify Tauri configuration:
   ```bash
   cat src-tauri/tauri.conf.json | grep -A 5 "macOS"
   ```

## Testing Notifications

After building and running the app:

1. Open Orchestra
2. Grant notification permissions when prompted
3. Trigger a notification from Orchestra
4. Verify the notification appears in macOS Notification Center

## Security Considerations

While adhoc signing enables features like notifications, it:
- Does not provide the same security guarantees as proper Apple signing
- Should not be used for public distribution
- Is appropriate for development and internal testing

## References

- [Tauri Code Signing Documentation](https://v2.tauri.app/distribute/sign/)
- [Apple Code Signing Guide](https://developer.apple.com/support/code-signing/)
- [macOS Entitlements Reference](https://developer.apple.com/documentation/bundleresources/entitlements)
