# Orchestra Notification Icon Implementation

## Summary

Added support for custom notification icons to Orchestra, allowing the Orchestra logo/image to be displayed in system notifications instead of the default macOS notification icon.

## Changes Made

### 1. Backend (Rust)

#### Updated Models (`src-tauri/src/models.rs`)
- Added `icon_path` field to `SystemNotificationRequest` struct:
```rust
pub struct SystemNotificationRequest {
    pub title: String,
    pub body: String,
    pub tag: Option<String>,
    pub icon_path: Option<String>,  // New field
}
```

#### Updated macOS Notification C Code (`src-tauri/src/native/macos_notifications.m`)
- Added `icon_path` parameter to `orchestra_macos_notifications_send()` function
- Implemented icon attachment using `UNNotificationAttachment` API
- Icons are loaded from file paths and attached to notifications

#### Updated Notification Service (`src-tauri/src/services/system_notifications.rs`)
- Updated FFI bindings to include `icon_path` parameter
- Implemented icon path resolution relative to app bundle resources
- Default icon path resolves to `Contents/Resources/icon.png` in the app bundle

### 2. Frontend (TypeScript)

#### Updated Notification Interface (`src/lib/systemNotifications.ts`)
- Added `iconPath` field to `SystemNotificationInput` interface:
```typescript
export interface SystemNotificationInput {
  title: string;
  body: string;
  tag?: string;
  iconPath?: string;  // New field
}
```

#### Updated Notification Sending
- Modified `sendSystemNotification()` to pass icon path to backend
- Default icon path set to `"icon.png"`

### 3. Build Configuration (`src-tauri/tauri.conf.json`)
- Added `icon.png` to bundle resources:
```json
"resources": {
  "../extensions/orchestra-tools.ts": "extensions/orchestra-tools.ts",
  "icons/icon.png": "icon.png"  // Added icon resource
}
```

## How It Works

1. **Icon Bundling**: The `icon.png` file is automatically bundled with the macOS app at build time
2. **Path Resolution**: At runtime, the icon path is resolved relative to the app bundle's `Contents/Resources/` directory
3. **Notification Attachment**: The icon is attached to notifications using macOS's `UNNotificationAttachment` API
4. **Display**: macOS displays the Orchestra logo in notification banners and notification center

## Usage

### Sending Notifications with Custom Icon

```typescript
import { sendSystemNotification } from './lib/systemNotifications';

// Use default Orchestra icon
await sendSystemNotification({
  title: "Orchestra Notification",
  body: "This notification shows the Orchestra logo",
});

// Use custom icon (if available)
await sendSystemNotification({
  title: "Custom Notification",
  body: "This notification shows a custom icon",
  iconPath: "custom-icon.png",
});
```

## Building and Testing

### Build with Icon Support

```bash
./scripts/build-adhoc.sh
```

### Test Notifications

1. Run the built app:
```bash
open src-tauri/target/debug/bundle/macos/Orchestra.app
```

2. Trigger a test notification from the app's settings
3. The notification should display the Orchestra logo instead of the default macOS icon

## Technical Details

### Icon Path Resolution

The icon path is resolved using this logic:
1. Check if the app is running from an app bundle (`.app`)
2. If yes, construct the full path: `<bundle>/Contents/Resources/<icon_path>`
3. If the icon file exists, use it; otherwise, fall back to no icon

### Fallback Behavior

- If no icon path is specified, notifications use the default macOS notification icon
- If the specified icon file is not found, notifications proceed without the icon
- The system is designed to fail gracefully if icons cannot be loaded

### Supported Icon Formats

macOS supports these image formats for notification icons:
- PNG (recommended)
- JPEG
- GIF
- HEIC

Recommended size: 32x32 to 64x64 pixels (will be displayed as a small thumbnail)

## Troubleshooting

### Icon Not Showing in Notifications

1. **Check if icon is bundled**:
```bash
ls -la Orchestra.app/Contents/Resources/icon.png
```

2. **Verify path resolution**:
Check the app logs for any errors related to icon path resolution.

3. **Test with dev mode**:
```bash
cargo tauri dev
```
Note: Icon may not work in dev mode if not running from app bundle.

### Build Issues

If you encounter build errors:
1. Ensure the `icon.png` file exists in `src-tauri/icons/`
2. Check the resources configuration in `tauri.conf.json`
3. Verify the Rust build succeeds with `cargo build`

## Future Enhancements

Potential improvements to the notification icon system:

1. **Dynamic Icons**: Support for different notification types with different icons
2. **Icon Themes**: Allow users to customize notification appearance
3. **Fallback Icons**: Automatic fallback to app icon if custom icon fails
4. **Icon Configuration**: UI settings for users to choose notification icons
5. **Accessibility**: Support for high-resolution icons and dark mode variants

## Files Modified

- `src-tauri/src/models.rs` - Added icon_path field
- `src-tauri/src/services/system_notifications.rs` - Added icon path resolution
- `src-tauri/src/native/macos_notifications.m` - Added icon attachment
- `src/lib/systemNotifications.ts` - Added iconPath parameter
- `src-tauri/tauri.conf.json` - Added icon to resources
- `scripts/build-adhoc.sh` - Existing build script (no changes needed)

## Testing Notes

The implementation has been tested with:
- ✅ App builds successfully with adhoc signing
- ✅ Icon is properly bundled in the app bundle
- ✅ Icon path resolution works correctly
- ⏳ Manual testing of notifications with Orchestra logo (pending)

To test the notification icon:
1. Build and run the app
2. Trigger a notification from the app
3. Verify the Orchestra logo appears in the notification banner

## References

- [UNNotificationAttachment Documentation](https://developer.apple.com/documentation/usernotifications/unnotificationattachment)
- [Tauri Resources Documentation](https://v2.tauri.app/develop/resources/)
- [macOS Notification Best Practices](https://developer.apple.com/documentation/usernotifications/local_notifications)
