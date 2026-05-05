#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORT_DIR="${ROOT_DIR}/.tmp/guardrails"
DEFAULT_CONFIG_PATH="${ROOT_DIR}/.gitleaks.toml"
HISTORY_LOG_OPTS="${ORCHESTRA_GITLEAKS_HISTORY_LOG_OPTS:---all}"
MODE="${1:-all}"
mkdir -p "${REPORT_DIR}"

GITLEAKS_BIN="${GITLEAKS_BIN:-$(${ROOT_DIR}/scripts/ensure-gitleaks.sh)}"
SOURCE_SNAPSHOT_DIR="${REPORT_DIR}/source-snapshot"

prepare_source_snapshot() {
  rm -rf "${SOURCE_SNAPSHOT_DIR}"
  mkdir -p "${SOURCE_SNAPSHOT_DIR}"

  (
    cd "${ROOT_DIR}"
    git ls-files -z --cached --others --exclude-standard
  ) | while IFS= read -r -d '' relative_path; do
    local source_path="${ROOT_DIR}/${relative_path}"
    local snapshot_path="${SOURCE_SNAPSHOT_DIR}/${relative_path}"
    mkdir -p "$(dirname "${snapshot_path}")"
    if [[ -L "${source_path}" ]]; then
      cp -a "${source_path}" "${snapshot_path}"
    else
      cp "${source_path}" "${snapshot_path}"
    fi
  done
}

run_scan() {
  local scan_mode="$1"
  local target="$2"
  local report_stem="$3"
  local config_path="$4"
  shift 4
  local extra_args=("$@")
  local json_report="${REPORT_DIR}/${report_stem}.json"
  local sarif_report="${REPORT_DIR}/${report_stem}.sarif"
  local json_status=0
  local sarif_status=0

  if [[ ! -f "${config_path}" ]]; then
    echo "Missing gitleaks config at ${config_path}" >&2
    exit 1
  fi

  echo "[guardrails] running gitleaks ${scan_mode} scan -> ${report_stem}" >&2
  "${GITLEAKS_BIN}" "${scan_mode}" "${target}" \
    --config "${config_path}" \
    --no-banner \
    --redact \
    --report-format json \
    --report-path "${json_report}" \
    --exit-code 1 \
    "${extra_args[@]}" || json_status=$?

  "${GITLEAKS_BIN}" "${scan_mode}" "${target}" \
    --config "${config_path}" \
    --no-banner \
    --redact \
    --report-format sarif \
    --report-path "${sarif_report}" \
    --exit-code 1 \
    "${extra_args[@]}" || sarif_status=$?

  if (( json_status > 1 || sarif_status > 1 )); then
    echo "gitleaks ${scan_mode} scan failed unexpectedly" >&2
    exit 1
  fi

  if (( json_status == 1 || sarif_status == 1 )); then
    echo "gitleaks ${scan_mode} scan found potential secrets. Reports: ${json_report}, ${sarif_report}" >&2
    return 1
  fi

  echo "[guardrails] gitleaks ${scan_mode} scan passed. Reports: ${json_report}, ${sarif_report}" >&2
}

case "${MODE}" in
  source)
    prepare_source_snapshot
    run_scan dir "${SOURCE_SNAPSHOT_DIR}" "gitleaks-source" "${DEFAULT_CONFIG_PATH}"
    ;;
  history)
    run_scan git "${ROOT_DIR}" "gitleaks-history" "${DEFAULT_CONFIG_PATH}" --log-opts "${HISTORY_LOG_OPTS}"
    ;;
  dir)
    TARGET_DIR="${2:-}"
    REPORT_STEM="${3:-gitleaks-dir}"
    CONFIG_PATH="${4:-${DEFAULT_CONFIG_PATH}}"
    if [[ -z "${TARGET_DIR}" ]]; then
      echo "Usage: $0 dir <target-dir> [report-stem] [config-path]" >&2
      exit 1
    fi
    run_scan dir "${TARGET_DIR}" "${REPORT_STEM}" "${CONFIG_PATH}"
    ;;
  all)
    prepare_source_snapshot
    run_scan dir "${SOURCE_SNAPSHOT_DIR}" "gitleaks-source" "${DEFAULT_CONFIG_PATH}"
    run_scan git "${ROOT_DIR}" "gitleaks-history" "${DEFAULT_CONFIG_PATH}" --log-opts "${HISTORY_LOG_OPTS}"
    ;;
  *)
    echo "Usage: $0 [source|history|dir <target-dir> [report-stem] [config-path]|all]" >&2
    exit 1
    ;;
esac
