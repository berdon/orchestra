#!/bin/bash

# Build Orchestra with adhoc signing for macOS
# This enables notifications to work without requiring a paid Apple Developer account

set -e

# Source Rust environment
source "$HOME/.cargo/env"

echo "🔨 Building Orchestra with adhoc signing..."
echo ""

# Build with debug flag and adhoc signing
cargo tauri build --debug

echo ""
echo "✅ Build complete!"
echo ""
echo "App bundle location:"
echo "  📦 src-tauri/target/debug/bundle/macos/Orchestra.app"
echo ""
echo "DMG location:"
echo "  💿 src-tauri/target/debug/bundle/dmg/Orchestra_0.1.0_x64.dmg"
echo ""
echo "📝 To verify the signature:"
echo "   codesign -dvvv src-tauri/target/debug/bundle/macos/Orchestra.app"
echo ""
echo "🚀 To run the app:"
echo "   open src-tauri/target/debug/bundle/macos/Orchestra.app"
