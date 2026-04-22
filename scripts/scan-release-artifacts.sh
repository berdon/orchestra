#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${1:-debug}"
EXTRACT_DIR="${ROOT_DIR}/.tmp/guardrails/artifact-scan/${PROFILE}"
SNAPSHOT_DIR="${EXTRACT_DIR}/snapshot"
mkdir -p "${SNAPSHOT_DIR}"
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
  "${ROOT_DIR}/dist" \
  "${ROOT_DIR}/mobile/dist-web"
do
  if [[ -e "${candidate}" ]]; then
    TARGETS+=("${candidate}")
  fi
done

if [[ "${#TARGETS[@]}" -eq 0 ]]; then
  echo "No release artifacts found for profile ${PROFILE}. Expected build outputs under src-tauri/target/${PROFILE}, dist/, or mobile/dist-web/." >&2
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

for target in "${TARGETS[@]}"; do
  echo "[guardrails] preparing artifact scan input from ${target}" >&2
  scan_target "${target}"
done

node "${ROOT_DIR}/scripts/scan-machine-references.mjs" \
  --mode paths \
  --root-dir "${SNAPSHOT_DIR}" \
  --report-name "machine-references-artifacts-${PROFILE}" \
  "${SNAPSHOT_DIR}"

echo "[guardrails] artifact scan passed for profile ${PROFILE}" >&2
