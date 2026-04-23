#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${1:-${ORCHESTRA_PACKAGED_RUNTIME_PROFILE:-release}}"
APP_INPUT="${ORCHESTRA_PACKAGED_RUNTIME_APP_PATH:-${ROOT_DIR}/src-tauri/target/${PROFILE}/bundle/macos/Orchestra.app}"
OUTPUT_DIR="${ORCHESTRA_PACKAGED_RUNTIME_RELEASE_ARTIFACT_DIR:-${ROOT_DIR}/src-tauri/target/${PROFILE}/bundle/release-artifacts}"
mkdir -p "${OUTPUT_DIR}"

resolve_app_bundle() {
  local input_path="$1"
  if [[ "${input_path}" == *.app ]]; then
    printf '%s\n' "${input_path}"
  elif [[ "${input_path}" == */Contents/MacOS/* ]]; then
    printf '%s\n' "$(cd "$(dirname "${input_path}")/../.." && pwd)"
  else
    echo "Unable to infer .app bundle from ${input_path}" >&2
    exit 1
  fi
}

APP_BUNDLE="$(resolve_app_bundle "${APP_INPUT}")"
RESOURCE_ROOT="${APP_BUNDLE}/Contents/Resources/pi-runtime"
MANIFEST_PATH="${RESOURCE_ROOT}/manifest.json"
SUMMARY_PATH="${OUTPUT_DIR}/bundled-pi-runtime-release-summary.json"
APP_CODESIGN_LOG="${OUTPUT_DIR}/codesign-app.txt"
APP_CODESIGN_DETAILS_LOG="${OUTPUT_DIR}/codesign-app-details.txt"
RUNTIME_CODESIGN_LOG="${OUTPUT_DIR}/codesign-runtime.txt"
RUNTIME_CODESIGN_DETAILS_LOG="${OUTPUT_DIR}/codesign-runtime-details.txt"
SPCTL_LOG="${OUTPUT_DIR}/spctl.txt"
NOTARIZATION_LOG="${OUTPUT_DIR}/notarization.txt"

if [[ ! -d "${APP_BUNDLE}" ]]; then
  echo "App bundle is missing: ${APP_BUNDLE}" >&2
  exit 1
fi

if [[ ! -f "${MANIFEST_PATH}" ]]; then
  echo "Bundled runtime manifest is missing from packaged app resources: ${MANIFEST_PATH}" >&2
  exit 1
fi

if ! command -v codesign >/dev/null 2>&1; then
  echo "Missing required macOS tool: codesign" >&2
  exit 1
fi
if ! command -v spctl >/dev/null 2>&1; then
  echo "Missing required macOS tool: spctl" >&2
  exit 1
fi

python3 - "${MANIFEST_PATH}" "${RESOURCE_ROOT}" > "${OUTPUT_DIR}/manifest-verification.json" <<'PY'
import hashlib
import json
import pathlib
import sys

manifest_path = pathlib.Path(sys.argv[1])
resource_root = pathlib.Path(sys.argv[2])
manifest = json.loads(manifest_path.read_text())
files = manifest.get("files") or []
failures = []

for entry in files:
    file_path = resource_root / entry["path"]
    if not file_path.exists():
        failures.append({"path": entry["path"], "reason": "missing"})
        continue
    digest = hashlib.sha256(file_path.read_bytes()).hexdigest()
    if digest.lower() != str(entry.get("sha256", "")).lower():
        failures.append({
            "path": entry["path"],
            "reason": "checksum_mismatch",
            "expected": entry.get("sha256"),
            "actual": digest,
        })

notice = manifest.get("noticeRelativePath")
sbom = manifest.get("sbomRelativePath")
if notice and not (resource_root / notice).exists():
    failures.append({"path": notice, "reason": "notice_missing"})
if sbom and not (resource_root / sbom).exists():
    failures.append({"path": sbom, "reason": "sbom_missing"})

output = {
    "manifestPath": str(manifest_path),
    "runtimeResourceRoot": str(resource_root),
    "executableRelativePath": manifest.get("executableRelativePath"),
    "noticeRelativePath": notice,
    "sbomRelativePath": sbom,
    "verifiedFileCount": len(files),
    "failures": failures,
}
print(json.dumps(output, indent=2))
if failures:
    raise SystemExit(1)
PY

RUNTIME_EXECUTABLE="$(python3 - "${MANIFEST_PATH}" "${RESOURCE_ROOT}" <<'PY'
import json
import pathlib
import sys
manifest = json.loads(pathlib.Path(sys.argv[1]).read_text())
print(pathlib.Path(sys.argv[2]) / manifest["executableRelativePath"])
PY
)"

codesign --verify --deep --strict --verbose=2 "${APP_BUNDLE}" >"${APP_CODESIGN_LOG}" 2>&1
codesign -dv --verbose=4 "${APP_BUNDLE}" >"${APP_CODESIGN_DETAILS_LOG}" 2>&1 || true
codesign --verify --strict --verbose=2 "${RUNTIME_EXECUTABLE}" >"${RUNTIME_CODESIGN_LOG}" 2>&1
codesign -dv --verbose=4 "${RUNTIME_EXECUTABLE}" >"${RUNTIME_CODESIGN_DETAILS_LOG}" 2>&1 || true

APP_SIGNATURE_KIND="$(python3 - "${APP_CODESIGN_DETAILS_LOG}" <<'PY'
import pathlib
import sys
text = pathlib.Path(sys.argv[1]).read_text()
print("adhoc" if "Signature=adhoc" in text else "signed")
PY
)"
RUNTIME_SIGNATURE_KIND="$(python3 - "${RUNTIME_CODESIGN_DETAILS_LOG}" <<'PY'
import pathlib
import sys
text = pathlib.Path(sys.argv[1]).read_text()
print("adhoc" if "Signature=adhoc" in text else "signed")
PY
)"
SPCTL_REQUIREMENT_MODE="${ORCHESTRA_REQUIRE_GATEKEEPER:-auto}"
if [[ "${SPCTL_REQUIREMENT_MODE}" == "auto" ]]; then
  if [[ "${APP_SIGNATURE_KIND}" == "adhoc" ]]; then
    REQUIRE_SPCTL=0
  else
    REQUIRE_SPCTL=1
  fi
elif [[ "${SPCTL_REQUIREMENT_MODE}" == "1" || "${SPCTL_REQUIREMENT_MODE}" == "true" ]]; then
  REQUIRE_SPCTL=1
else
  REQUIRE_SPCTL=0
fi

SPCTL_STATUS="accepted"
if spctl -a -vv "${APP_BUNDLE}" >"${SPCTL_LOG}" 2>&1; then
  SPCTL_EXIT_CODE=0
else
  SPCTL_EXIT_CODE=$?
  SPCTL_STATUS="rejected"
fi

if [[ "${APP_SIGNATURE_KIND}" != "adhoc" && "${RUNTIME_SIGNATURE_KIND}" == "adhoc" ]]; then
  echo "Bundled Pi runtime executable is still adhoc-signed while the app bundle is non-adhoc signed. Re-sign the embedded runtime with the release identity before notarization." >&2
  exit 1
fi
if [[ "${REQUIRE_SPCTL}" == "1" && "${SPCTL_EXIT_CODE}" -ne 0 ]]; then
  echo "Gatekeeper assessment failed for packaged app; see ${SPCTL_LOG}" >&2
  exit 1
fi

NOTARIZATION_SUBMITTED=false
NOTARIZATION_STAPLED=false
: > "${NOTARIZATION_LOG}"
if [[ "${ORCHESTRA_NOTARIZE:-0}" == "1" ]]; then
  if ! command -v xcrun >/dev/null 2>&1; then
    echo "xcrun is required for notarization" >&2
    exit 1
  fi
  if [[ -z "${ORCHESTRA_NOTARYTOOL_PROFILE:-}" ]]; then
    echo "Set ORCHESTRA_NOTARYTOOL_PROFILE to a stored notarytool credential profile before running notarization." >&2
    exit 1
  fi
  NOTARIZE_TARGET="${ORCHESTRA_NOTARIZE_TARGET:-${APP_BUNDLE}}"
  xcrun notarytool submit "${NOTARIZE_TARGET}" \
    --keychain-profile "${ORCHESTRA_NOTARYTOOL_PROFILE}" \
    --wait >"${NOTARIZATION_LOG}" 2>&1
  NOTARIZATION_SUBMITTED=true
  xcrun stapler staple "${APP_BUNDLE}" >>"${NOTARIZATION_LOG}" 2>&1
  NOTARIZATION_STAPLED=true
fi

python3 - \
  "${SUMMARY_PATH}" \
  "${APP_BUNDLE}" \
  "${RESOURCE_ROOT}" \
  "${RUNTIME_EXECUTABLE}" \
  "${OUTPUT_DIR}/manifest-verification.json" \
  "${APP_CODESIGN_LOG}" \
  "${APP_CODESIGN_DETAILS_LOG}" \
  "${RUNTIME_CODESIGN_LOG}" \
  "${RUNTIME_CODESIGN_DETAILS_LOG}" \
  "${SPCTL_LOG}" \
  "${NOTARIZATION_LOG}" \
  "${NOTARIZATION_SUBMITTED}" \
  "${NOTARIZATION_STAPLED}" \
  "${APP_SIGNATURE_KIND}" \
  "${RUNTIME_SIGNATURE_KIND}" \
  "${SPCTL_STATUS}" \
  "${REQUIRE_SPCTL}" <<'PY'
import json
import pathlib
import sys

summary_path = pathlib.Path(sys.argv[1])
manifest_report = json.loads(pathlib.Path(sys.argv[5]).read_text())
summary = {
    "appBundlePath": sys.argv[2],
    "runtimeResourceRoot": sys.argv[3],
    "runtimeExecutablePath": sys.argv[4],
    "manifest": manifest_report,
    "codesign": {
        "appLogPath": sys.argv[6],
        "appDetailsLogPath": sys.argv[7],
        "appSignatureKind": sys.argv[14],
        "runtimeLogPath": sys.argv[8],
        "runtimeDetailsLogPath": sys.argv[9],
        "runtimeSignatureKind": sys.argv[15],
    },
    "spctl": {
        "logPath": sys.argv[10],
        "status": sys.argv[16],
        "required": sys.argv[17] == "1",
    },
    "notarization": {
        "logPath": sys.argv[11],
        "submitted": sys.argv[12].lower() == "true",
        "stapled": sys.argv[13].lower() == "true",
    },
}
summary_path.write_text(json.dumps(summary, indent=2) + "\n")
PY

echo "[bundled-pi-release] summary written to ${SUMMARY_PATH}" >&2
