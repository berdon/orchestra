#!/bin/bash

# Build Orchestra with adhoc signing for macOS.
# Defaults to the fastest local debug bundle, but can also produce a sanitized
# release bundle for verified pre-release scanning.

set -euo pipefail

PROFILE="${ORCHESTRA_BUILD_PROFILE:-debug}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_AND_RELAUNCH=0
APP_NAME="Orchestra"
APP_BUNDLE_NAME="${APP_NAME}.app"
INSTALL_PATH="/Applications/${APP_BUNDLE_NAME}"

usage() {
  cat <<'EOF'
Usage: ./scripts/build-adhoc.sh [--install-and-relaunch]

Options:
  --install-and-relaunch  Quit any running Orchestra app, replace
                          /Applications/Orchestra.app with the newly built
                          bundle, and relaunch it.
  -h, --help              Show this help text.
EOF
}

while (( $# > 0 )); do
  case "$1" in
    --install-and-relaunch)
      INSTALL_AND_RELAUNCH=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

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

BUILT_APP_PATH="${ROOT_DIR}/src-tauri/target/${TARGET_DIR}/bundle/macos/${APP_BUNDLE_NAME}"
DMG_PATH="${ROOT_DIR}/src-tauri/target/${TARGET_DIR}/bundle/dmg/Orchestra_0.1.0_x64.dmg"

run_as_root_if_needed() {
  if [[ -w "$1" ]]; then
    shift
    "$@"
  else
    sudo "$@"
  fi
}

quit_running_orchestra() {
  osascript -e 'tell application id "dev.guppy.orchestra" to quit' >/dev/null 2>&1 || true

  local pid=""
  for _ in {1..20}; do
    pid="$(pgrep -x orchestra || true)"
    if [[ -z "${pid}" ]]; then
      return 0
    fi
    sleep 0.25
  done

  if [[ -n "${pid}" ]]; then
    echo "⚠️  Orchestra is still running; forcing it to exit..."
    pkill -TERM -x orchestra >/dev/null 2>&1 || true
  fi

  for _ in {1..20}; do
    pid="$(pgrep -x orchestra || true)"
    if [[ -z "${pid}" ]]; then
      return 0
    fi
    sleep 0.25
  done

  if [[ -n "${pid}" ]]; then
    echo "⚠️  Orchestra is still running after SIGTERM; killing it..."
    pkill -KILL -x orchestra >/dev/null 2>&1 || true
  fi
}

install_and_relaunch_app() {
  echo ""
  echo "🛑 Stopping any running Orchestra app..."
  quit_running_orchestra

  echo "📥 Replacing ${INSTALL_PATH}..."
  if [[ -e "${INSTALL_PATH}" ]]; then
    run_as_root_if_needed "/Applications" rm -rf "${INSTALL_PATH}"
  fi
  run_as_root_if_needed "/Applications" ditto "${BUILT_APP_PATH}" "${INSTALL_PATH}"

  echo "🚀 Relaunching ${INSTALL_PATH}..."
  open "${INSTALL_PATH}"
}

# Source Rust environment
# shellcheck source=/dev/null
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

if (( INSTALL_AND_RELAUNCH )); then
  install_and_relaunch_app
fi

echo ""
echo "✅ Build complete!"
echo ""
echo "App bundle location:"
echo "  📦 src-tauri/target/${TARGET_DIR}/bundle/macos/Orchestra.app"
echo ""
echo "DMG location:"
echo "  💿 ${DMG_PATH}"
echo ""
echo "📝 To verify the signature:"
echo "   codesign -dvvv src-tauri/target/${TARGET_DIR}/bundle/macos/Orchestra.app"
echo ""
echo "🚀 To run the app:"
echo "   open src-tauri/target/${TARGET_DIR}/bundle/macos/Orchestra.app"
if (( INSTALL_AND_RELAUNCH )); then
  echo "   open -a /Applications/Orchestra.app"
fi
echo ""
echo "🔒 For a verified pre-release build with source/history/artifact guardrails:"
echo "   npm run build:adhoc:verified"
