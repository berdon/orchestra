#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JOBS="${DESKTOP_E2E_JOBS:-2}"
LOG_ROOT="${ROOT_DIR}/.tmp/desktop-e2e"
mkdir -p "${LOG_ROOT}"
SUITE_RUN_DIR="$(mktemp -d "${LOG_ROOT}/suite-podman-XXXXXX")"
SCRIPT_LOG="${SUITE_RUN_DIR}/suite.log"

if [[ "$#" -eq 0 ]]; then
  mapfile -t AUTO_TEST_FILES < <(node "${ROOT_DIR}/scripts/desktop-e2e-suite.mjs")
  if (( ${#AUTO_TEST_FILES[@]} == 0 )); then
    echo "No desktop E2E specs were discovered by tests/desktop-e2e-suite.json" >&2
    exit 1
  fi
  set -- "${AUTO_TEST_FILES[@]}"
fi

if ! [[ "${JOBS}" =~ ^[0-9]+$ ]] || (( JOBS < 1 )); then
  echo "DESKTOP_E2E_JOBS must be a positive integer. Got: ${JOBS}" >&2
  exit 1
fi

"${ROOT_DIR}/scripts/build-desktop-e2e-image.sh"

LAUNCHED_PIDS=()
LAUNCHED_TESTS=()
LAUNCHED_LOGS=()
FAILURES=0

cleanup() {
  local pid
  for pid in "${LAUNCHED_PIDS[@]:-}"; do
    if [[ -n "${pid}" ]] && kill -0 "${pid}" >/dev/null 2>&1; then
      kill -TERM "${pid}" >/dev/null 2>&1 || true
    fi
  done

  for pid in "${LAUNCHED_PIDS[@]:-}"; do
    if [[ -n "${pid}" ]]; then
      wait "${pid}" 2>/dev/null || true
    fi
  done
}

trap cleanup EXIT INT TERM

launch_test() {
  local test_file="$1"
  local test_name
  local test_log
  test_name="$(basename "${test_file}" .test.ts)"
  test_log="${SUITE_RUN_DIR}/${test_name}.log"

  echo "==> Running desktop E2E in isolated container: ${test_file}" | tee -a "${SCRIPT_LOG}"
  (
    cd "${ROOT_DIR}"
    "${ROOT_DIR}/scripts/run-desktop-e2e-podman.sh" "${test_file}"
  ) >"${test_log}" 2>&1 &

  LAUNCHED_PIDS+=("$!")
  LAUNCHED_TESTS+=("${test_file}")
  LAUNCHED_LOGS+=("${test_log}")
}

rebuild_active_arrays() {
  local keep_pids=()
  local keep_tests=()
  local keep_logs=()
  local index
  for index in "${!LAUNCHED_PIDS[@]}"; do
    if [[ -n "${LAUNCHED_PIDS[$index]}" ]]; then
      keep_pids+=("${LAUNCHED_PIDS[$index]}")
      keep_tests+=("${LAUNCHED_TESTS[$index]}")
      keep_logs+=("${LAUNCHED_LOGS[$index]}")
    fi
  done
  LAUNCHED_PIDS=()
  LAUNCHED_TESTS=()
  LAUNCHED_LOGS=()
  if (( ${#keep_pids[@]} > 0 )); then
    LAUNCHED_PIDS=("${keep_pids[@]}")
    LAUNCHED_TESTS=("${keep_tests[@]}")
    LAUNCHED_LOGS=("${keep_logs[@]}")
  fi
}

wait_for_one_completion() {
  local index
  local pid
  local test_file
  local test_log
  while true; do
    for index in "${!LAUNCHED_PIDS[@]}"; do
      pid="${LAUNCHED_PIDS[$index]}"
      test_file="${LAUNCHED_TESTS[$index]}"
      test_log="${LAUNCHED_LOGS[$index]}"
      if kill -0 "${pid}" >/dev/null 2>&1; then
        continue
      fi

      if wait "${pid}"; then
        echo "PASS ${test_file}" | tee -a "${SCRIPT_LOG}"
      else
        FAILURES=$((FAILURES + 1))
        echo "FAIL ${test_file} (log: ${test_log})" | tee -a "${SCRIPT_LOG}"
        tail -n 80 "${test_log}" >&2 || true
      fi

      unset 'LAUNCHED_PIDS[$index]'
      unset 'LAUNCHED_TESTS[$index]'
      unset 'LAUNCHED_LOGS[$index]'
      rebuild_active_arrays
      return
    done
    sleep 1
  done
}

for test_file in "$@"; do
  while (( ${#LAUNCHED_PIDS[@]} >= JOBS )); do
    wait_for_one_completion
  done
  launch_test "${test_file}"
done

while (( ${#LAUNCHED_PIDS[@]} > 0 )); do
  wait_for_one_completion
done

if (( FAILURES > 0 )); then
  echo "[desktop-e2e-suite-podman] completed with ${FAILURES} failure(s). Logs: ${SUITE_RUN_DIR}" >&2
  exit 1
fi

echo "[desktop-e2e-suite-podman] all tests passed. Logs: ${SUITE_RUN_DIR}" | tee -a "${SCRIPT_LOG}"
