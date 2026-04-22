#!/bin/bash

# Build Orchestra with adhoc signing for macOS.
# Defaults to the fastest local debug bundle, but can also produce a sanitized
# release bundle for verified pre-release scanning.

set -euo pipefail

PROFILE="${ORCHESTRA_BUILD_PROFILE:-debug}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "${PROFILE}" in
  debug)
    TARGET_DIR="debug"
    CARGO_ARGS=(--debug)
    ;;
  release)
    TARGET_DIR="release"
    CARGO_ARGS=()
    ;;
  *)
    echo "Unsupported ORCHESTRA_BUILD_PROFILE: ${PROFILE}. Expected debug or release." >&2
    exit 1
    ;;
esac

# Source Rust environment
source "$HOME/.cargo/env"

if [[ "${ORCHESTRA_SANITIZE_BUILD_PATHS:-0}" == "1" ]]; then
  REMAP_FLAGS=("--remap-path-prefix=${ROOT_DIR}=/workspace/orchestra")
  if [[ -n "${HOME:-}" ]]; then
    REMAP_FLAGS+=(
      "--remap-path-prefix=${HOME}/.cargo=/cargo"
      "--remap-path-prefix=${HOME}/.rustup=/rustup"
    )
  fi

  export RUSTFLAGS="${RUSTFLAGS:-} ${REMAP_FLAGS[*]}"
  export CARGO_PROFILE_RELEASE_STRIP="${CARGO_PROFILE_RELEASE_STRIP:-debuginfo}"
  export CARGO_PROFILE_RELEASE_DEBUG="${CARGO_PROFILE_RELEASE_DEBUG:-0}"
  echo "🧼 Enabling sanitized build-path remapping for verified release output..."
fi

echo "🔨 Building Orchestra with adhoc signing (${PROFILE})..."
echo ""

if (( ${#CARGO_ARGS[@]} > 0 )); then
  cargo tauri build "${CARGO_ARGS[@]}"
else
  cargo tauri build
fi

echo ""
echo "✅ Build complete!"
echo ""
echo "App bundle location:"
echo "  📦 src-tauri/target/${TARGET_DIR}/bundle/macos/Orchestra.app"
echo ""
echo "DMG location:"
echo "  💿 src-tauri/target/${TARGET_DIR}/bundle/dmg/Orchestra_0.1.0_x64.dmg"
echo ""
echo "📝 To verify the signature:"
echo "   codesign -dvvv src-tauri/target/${TARGET_DIR}/bundle/macos/Orchestra.app"
echo ""
echo "🚀 To run the app:"
echo "   open src-tauri/target/${TARGET_DIR}/bundle/macos/Orchestra.app"
echo ""
echo "🔒 For a verified pre-release build with source/history/artifact guardrails:"
echo "   npm run build:adhoc:verified"
