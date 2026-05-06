#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${ORCHESTRA_MACOS_SIGN_PROFILE:-release}"
IDENTITY="${ORCHESTRA_CODESIGN_IDENTITY:-${APPLE_SIGNING_IDENTITY:-}}"
ENTITLEMENTS="${ORCHESTRA_CODESIGN_ENTITLEMENTS:-${ROOT_DIR}/src-tauri/entitlements.plist}"
PI_RUNTIME_ENTITLEMENTS="${ORCHESTRA_PI_RUNTIME_CODESIGN_ENTITLEMENTS:-${ROOT_DIR}/src-tauri/pi-runtime-entitlements.plist}"
NOTARY_PROFILE="${ORCHESTRA_NOTARYTOOL_PROFILE:-}"
NOTARIZE="${ORCHESTRA_NOTARIZE:-1}"
APP_PATH="${ROOT_DIR}/src-tauri/target/${PROFILE}/bundle/macos/Orchestra.app"
DMG_PATH=""
APP_NAME="Orchestra"
DMG_BACKGROUND_GENERATOR="${ROOT_DIR}/scripts/generate-dmg-background.py"

usage() {
  cat <<'EOF'
Usage: ./scripts/sign-macos-app-and-dmg.sh [options]

Options:
  --profile <debug|release>     Build profile root to use (default: release)
  --app <path>                  App bundle to sign
  --dmg <path>                  DMG path to create/sign
  --identity <name>             macOS codesign identity
  --entitlements <path>         App entitlements plist
  --notary-profile <name>       notarytool keychain profile name
  --skip-notarize               Skip notarization/stapling
  -h, --help                    Show this help text
EOF
}

while (( $# > 0 )); do
  case "$1" in
    --profile)
      PROFILE="$2"
      APP_PATH="${ROOT_DIR}/src-tauri/target/${PROFILE}/bundle/macos/Orchestra.app"
      shift 2
      ;;
    --app)
      APP_PATH="$2"
      shift 2
      ;;
    --dmg)
      DMG_PATH="$2"
      shift 2
      ;;
    --identity)
      IDENTITY="$2"
      shift 2
      ;;
    --entitlements)
      ENTITLEMENTS="$2"
      shift 2
      ;;
    --notary-profile)
      NOTARY_PROFILE="$2"
      shift 2
      ;;
    --skip-notarize)
      NOTARIZE=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

run_codesign_sign() {
  if [[ "${IDENTITY}" == "-" ]]; then
    codesign --force --sign "${IDENTITY}" "$@"
  else
    codesign --force --sign "${IDENTITY}" --timestamp "$@"
  fi
}

find_default_dmg_path() {
  local dmg_dir="${ROOT_DIR}/src-tauri/target/${PROFILE}/bundle/dmg"
  local existing
  existing="$(find "${dmg_dir}" -maxdepth 1 -type f -name '*.dmg' | head -n 1 || true)"
  if [[ -n "${existing}" ]]; then
    printf '%s\n' "${existing}"
    return
  fi

  local version arch_suffix
  version="$(python3 - <<'PY' "${ROOT_DIR}/package.json"
import json, pathlib, sys
print(json.loads(pathlib.Path(sys.argv[1]).read_text()).get('version', '0.1.0'))
PY
)"
  case "$(uname -m)" in
    arm64) arch_suffix="aarch64" ;;
    x86_64) arch_suffix="x64" ;;
    *) arch_suffix="$(uname -m)" ;;
  esac
  printf '%s\n' "${dmg_dir}/Orchestra_${version}_${arch_suffix}.dmg"
}

sign_nested_executable() {
  local target="$1"
  echo "🔏 Signing nested executable: ${target}"
  run_codesign_sign --options runtime --entitlements "${PI_RUNTIME_ENTITLEMENTS}" "${target}"
  codesign --verify --strict --verbose=2 "${target}"
}

sign_hardened_helper_executable() {
  local target="$1"
  if [[ ! -f "${target}" ]]; then
    return
  fi
  echo "🔏 Signing helper executable: ${target}"
  run_codesign_sign --options runtime "${target}"
  codesign --verify --strict --verbose=2 "${target}"
}

notarize_and_staple() {
  local target="$1"
  local label="$2"
  local submit_target="$target"
  if [[ "${NOTARIZE}" != "1" ]]; then
    return
  fi
  if [[ -z "${NOTARY_PROFILE}" ]]; then
    echo "ORCHESTRA_NOTARYTOOL_PROFILE is required when notarization is enabled." >&2
    exit 1
  fi
  if [[ "${target}" == *.app ]]; then
    local zip_root zip_path
    zip_root="$(mktemp -d /tmp/orchestra-notary-app.XXXXXX)"
    zip_path="${zip_root}/$(basename "${target}").zip"
    echo "📦 Creating notarization zip for ${label}: ${zip_path}"
    ditto -c -k --keepParent "${target}" "${zip_path}"
    submit_target="${zip_path}"
  fi
  echo "☁️  Notarizing ${label}: ${target}"
  xcrun notarytool submit "${submit_target}" --keychain-profile "${NOTARY_PROFILE}" --wait
  echo "📎 Stapling ${label}: ${target}"
  xcrun stapler staple "${target}"
}

create_signed_dmg() {
  local source_app="$1"
  local target_dmg="$2"
  local staging_dir volume_dir rw_dmg attached_device volume_mount_path volume_name attach_output final_dmg
  staging_dir="$(mktemp -d /tmp/orchestra-dmg-stage.XXXXXX)"
  trap 'if [[ -n "${attached_device:-}" ]]; then hdiutil detach "${attached_device}" >/dev/null 2>&1 || true; fi; rm -rf "${staging_dir}"' RETURN
  volume_dir="${staging_dir}/${APP_NAME}"
  mkdir -p "${volume_dir}"
  ditto "${source_app}" "${volume_dir}/${APP_NAME}.app"

  rw_dmg="${staging_dir}/${APP_NAME}-rw.dmg"
  volume_mount_path="/Volumes/${APP_NAME}"
  mkdir -p "$(dirname "${target_dmg}")"
  rm -f "${target_dmg}"
  final_dmg="${target_dmg}"
  echo "💿 Creating DMG: ${target_dmg}"
  hdiutil create -volname "${APP_NAME}" -srcfolder "${volume_dir}" -fs HFS+ -format UDRW -ov "${rw_dmg}"
  attach_output="$(hdiutil attach -readwrite -noverify -noautoopen "${rw_dmg}")"
  attached_device="$(printf '%s\n' "${attach_output}" | awk '/^\/dev\// && $0 ~ /\/Volumes\// { print $1; exit }')"
  volume_mount_path="$(printf '%s\n' "${attach_output}" | awk '/^\/dev\// && $0 ~ /\/Volumes\// { line=$0; sub(/^[^\t]*\t[^\t]*\t/, "", line); print line; exit }')"
  volume_name="$(basename "${volume_mount_path}")"
  sleep 2

  ln -s /Applications "${volume_mount_path}/Applications"
  mkdir -p "${volume_mount_path}/.background"
  python3 "${DMG_BACKGROUND_GENERATOR}" "${volume_mount_path}/.background/background.png"
  chflags hidden "${volume_mount_path}/.background" || true

  osascript <<EOF
tell application "Finder"
  tell disk "${volume_name}"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set bounds of container window to {120, 120, 800, 540}
    set viewOptions to the icon view options of container window
    set arrangement of viewOptions to not arranged
    set icon size of viewOptions to 128
    set text size of viewOptions to 16
    set background picture of viewOptions to file ".background:background.png"
    set position of item "${APP_NAME}.app" of container window to {170, 210}
    set position of item "Applications" of container window to {510, 210}
    close
    open
    update without registering applications
    delay 1
  end tell
end tell
EOF

  sync
  hdiutil detach "${attached_device}" >/dev/null
  attached_device=""
  hdiutil convert "${rw_dmg}" -format UDZO -imagekey zlib-level=9 -ov -o "${final_dmg}"
  echo "🔏 Signing DMG: ${target_dmg}"
  run_codesign_sign "${target_dmg}"
  codesign --verify --verbose=2 "${target_dmg}"
}

require_command codesign
require_command hdiutil
require_command python3
if [[ "${NOTARIZE}" == "1" ]]; then
  require_command xcrun
fi

if [[ -z "${IDENTITY}" ]]; then
  echo "Set ORCHESTRA_CODESIGN_IDENTITY (or pass --identity) to a valid Developer ID identity." >&2
  exit 1
fi
if [[ ! -d "${APP_PATH}" ]]; then
  echo "App bundle is missing: ${APP_PATH}" >&2
  exit 1
fi
if [[ ! -f "${ENTITLEMENTS}" ]]; then
  echo "Entitlements file is missing: ${ENTITLEMENTS}" >&2
  exit 1
fi
if [[ ! -f "${PI_RUNTIME_ENTITLEMENTS}" ]]; then
  echo "Pi runtime entitlements file is missing: ${PI_RUNTIME_ENTITLEMENTS}" >&2
  exit 1
fi
if [[ ! -f "${DMG_BACKGROUND_GENERATOR}" ]]; then
  echo "DMG background generator is missing: ${DMG_BACKGROUND_GENERATOR}" >&2
  exit 1
fi
if [[ -z "${DMG_PATH}" ]]; then
  DMG_PATH="$(find_default_dmg_path)"
fi

APP_EXECUTABLE="${APP_PATH}/Contents/MacOS/orchestra"
ORC_EXECUTABLE="${APP_PATH}/Contents/MacOS/orc"
PI_EXECUTABLE="${APP_PATH}/Contents/Resources/pi-runtime/runtime/pi"
BUN_EXECUTABLE="${APP_PATH}/Contents/Resources/pi-runtime/bun/bin/bun"
if [[ ! -f "${PI_EXECUTABLE}" ]]; then
  echo "Bundled Pi executable is missing: ${PI_EXECUTABLE}" >&2
  exit 1
fi
if [[ ! -f "${BUN_EXECUTABLE}" ]]; then
  echo "Bundled Bun executable is missing: ${BUN_EXECUTABLE}" >&2
  exit 1
fi

sign_nested_executable "${PI_EXECUTABLE}"
sign_nested_executable "${BUN_EXECUTABLE}"
sign_hardened_helper_executable "${APP_EXECUTABLE}"
sign_hardened_helper_executable "${ORC_EXECUTABLE}"

echo "🔏 Signing outer app bundle with hardened runtime: ${APP_PATH}"
run_codesign_sign --options runtime --entitlements "${ENTITLEMENTS}" "${APP_PATH}"

ORCHESTRA_PACKAGED_RUNTIME_APP_PATH="${APP_PATH}" \
ORCHESTRA_PACKAGED_RUNTIME_RELEASE_ARTIFACT_DIR="${ROOT_DIR}/src-tauri/target/${PROFILE}/bundle/release-signing" \
ORCHESTRA_REQUIRE_GATEKEEPER=0 \
ORCHESTRA_NOTARIZE=0 \
"${ROOT_DIR}/scripts/verify-bundled-pi-release.sh" "${PROFILE}"

notarize_and_staple "${APP_PATH}" "app bundle"
if [[ "${NOTARIZE}" == "1" ]]; then
  echo "🛡️  Verifying notarized app with Gatekeeper: ${APP_PATH}"
  spctl -a -vv "${APP_PATH}"
fi
create_signed_dmg "${APP_PATH}" "${DMG_PATH}"
notarize_and_staple "${DMG_PATH}" "DMG"

echo "✅ Signed app: ${APP_PATH}"
echo "✅ Signed DMG: ${DMG_PATH}"
