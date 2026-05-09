#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${1:-debug}"
EXTRACT_DIR="${ROOT_DIR}/.tmp/guardrails/artifact-scan/${PROFILE}"
SNAPSHOT_DIR="${EXTRACT_DIR}/snapshot"
REPORT_DIR="${ROOT_DIR}/.tmp/guardrails"
ARTIFACT_GITLEAKS_CONFIG="${ROOT_DIR}/.gitleaks-artifacts.toml"
ARTIFACT_MACHINE_ALLOWLIST="${ROOT_DIR}/guardrails/artifact-machine-reference-allowlist.json"
ARTIFACT_GITLEAKS_REPORT="${REPORT_DIR}/gitleaks-artifacts-${PROFILE}.json"
ARTIFACT_MACHINE_REPORT="${REPORT_DIR}/machine-references-artifacts-${PROFILE}.json"
mkdir -p "${SNAPSHOT_DIR}" "${REPORT_DIR}"
rm -rf "${SNAPSHOT_DIR}"
mkdir -p "${SNAPSHOT_DIR}"

if ! command -v strings >/dev/null 2>&1; then
  echo "Missing required tool: strings" >&2
  exit 1
fi

if ! command -v file >/dev/null 2>&1; then
  echo "Missing required tool: file" >&2
  exit 1
fi

TARGETS=()
for candidate in \
  "${ROOT_DIR}/src-tauri/target/${PROFILE}/bundle/macos/Orchestra.app" \
  "${ROOT_DIR}/src-tauri/target/${PROFILE}/bundle/dmg" \
  "${ROOT_DIR}/dist"
do
  if [[ -e "${candidate}" ]]; then
    TARGETS+=("${candidate}")
  fi
done

if [[ "${#TARGETS[@]}" -eq 0 ]]; then
  echo "No release artifacts found for profile ${PROFILE}. Expected build outputs under src-tauri/target/${PROFILE} or dist/." >&2
  exit 1
fi

copy_text_file() {
  local source_path="$1"
  local relative_target="$2"
  mkdir -p "$(dirname "${SNAPSHOT_DIR}/${relative_target}")"
  cp "${source_path}" "${SNAPSHOT_DIR}/${relative_target}"
}

extract_strings_file() {
  local source_path="$1"
  local relative_target="$2"
  mkdir -p "$(dirname "${SNAPSHOT_DIR}/${relative_target}")"
  strings -a -n 6 "${source_path}" > "${SNAPSHOT_DIR}/${relative_target}" || true
}

should_copy_text() {
  local mime_type="$1"
  case "${mime_type}" in
    text/*|application/json|application/xml|application/javascript|application/x-javascript|image/svg+xml)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

should_extract_strings() {
  local path="$1"
  local mime_type="$2"
  if [[ -x "${path}" ]]; then
    return 0
  fi

  case "${mime_type}" in
    application/octet-stream|application/x-mach-binary|application/x-executable|application/x-sharedlib|application/x-dosexec|application/x-apple-diskimage)
      return 0
      ;;
  esac

  case "${path}" in
    *.dylib|*.so|*.dll|*.node|*.exe|*.wasm|*.bin|*.a|*.o|*.dmg)
      return 0
      ;;
    */Contents/MacOS/*)
      return 0
      ;;
  esac

  return 1
}

scan_target() {
  local target="$1"
  while IFS= read -r -d '' file_path; do
    local relative_path="${file_path#${ROOT_DIR}/}"
    local mime_type
    mime_type="$(file -b --mime-type "${file_path}")"

    if should_copy_text "${mime_type}"; then
      copy_text_file "${file_path}" "${relative_path}"
      continue
    fi

    if should_extract_strings "${file_path}" "${mime_type}"; then
      extract_strings_file "${file_path}" "${relative_path}.strings.txt"
    fi
  done < <(find "${target}" -type f -print0)
}

print_machine_reference_summary() {
  local report_path="$1"
  node --input-type=module - "${report_path}" <<'NODE'
import { readFileSync } from "node:fs";

const reportPath = process.argv[2];
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const findings = report.findings ?? [];
const suppressed = report.suppressed ?? [];

if (findings.length > 0) {
  console.error(`[guardrails] release-blocking first-party machine/path finding(s): ${findings.length}`);
  for (const finding of findings) {
    console.error(`  - ${finding.relativePath}:${finding.line}:${finding.column} [${finding.ruleId}] ${finding.match}`);
  }
}

if (suppressed.length > 0) {
  const grouped = new Map();
  for (const item of suppressed) {
    const key = `${item.relativePath}::${item.reason}`;
    const current = grouped.get(key) ?? {
      relativePath: item.relativePath,
      reason: item.reason,
      count: 0,
      sampleMatch: item.match,
    };
    current.count += 1;
    grouped.set(key, current);
  }

  console.log(`[guardrails] documented third-party machine/path finding(s): ${suppressed.length}`);
  for (const entry of grouped.values()) {
    console.log(`  - ${entry.relativePath} (${entry.count} match(es))`);
    console.log(`    reason: ${entry.reason}`);
    console.log(`    sample: ${entry.sampleMatch}`);
  }
}
NODE
}

for target in "${TARGETS[@]}"; do
  echo "[guardrails] preparing artifact scan input from ${target}" >&2
  scan_target "${target}"
done

# Exclude known generated false-positive files from artifact secret scanning.
# Source scans still cover the original first-party code these assets derive from.
find "${SNAPSHOT_DIR}" \
  \( \
    -path '*/dist/assets/orchestraClient-*.js' -o \
    -path '*/Contents/Resources/hosted-web/assets/orchestraClient-*.js' -o \
    -path '*/Contents/Resources/pi-runtime/runtime/pi.strings.txt' \
  \) \
  -type f -delete

secret_status=0
set +e
"${ROOT_DIR}/scripts/run-secret-scan.sh" dir "${SNAPSHOT_DIR}" "gitleaks-artifacts-${PROFILE}" "${ARTIFACT_GITLEAKS_CONFIG}"
secret_status=$?
set -e

if (( secret_status != 0 )); then
  echo "[guardrails] artifact secret scan failed. Any unsuppressed gitleaks hit in the extracted artifact snapshot is release-blocking. Reports: ${ARTIFACT_GITLEAKS_REPORT}, ${REPORT_DIR}/gitleaks-artifacts-${PROFILE}.sarif" >&2
fi

machine_status=0
set +e
node "${ROOT_DIR}/scripts/scan-machine-references.mjs" \
  --mode paths \
  --root-dir "${SNAPSHOT_DIR}" \
  --allowlist "${ARTIFACT_MACHINE_ALLOWLIST}" \
  --report-name "machine-references-artifacts-${PROFILE}" \
  "${SNAPSHOT_DIR}"
machine_status=$?
set -e

print_machine_reference_summary "${ARTIFACT_MACHINE_REPORT}"

if (( secret_status != 0 || machine_status != 0 )); then
  exit 1
fi

echo "[guardrails] artifact scan passed for profile ${PROFILE}" >&2
