#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARNESS="${1:-}"
JOBS="${PLAYWRIGHT_E2E_JOBS:-1}"
LOG_ROOT="${ROOT_DIR}/.tmp/${HARNESS:-playwright-e2e}"
mkdir -p "${LOG_ROOT}"
SUITE_RUN_DIR="$(mktemp -d "${LOG_ROOT}/suite-podman-XXXXXX")"
SCRIPT_LOG="${SUITE_RUN_DIR}/suite.log"

if [[ -z "${HARNESS}" ]]; then
  echo "Usage: $0 <browser|hosted-web|web-driver> [playwright args...]" >&2
  exit 1
fi
shift || true

case "${HARNESS}" in
  browser|hosted-web|web-driver)
    ;;
  *)
    echo "Unsupported Playwright E2E harness: ${HARNESS}" >&2
    exit 1
    ;;
esac

if ! [[ "${JOBS}" =~ ^[0-9]+$ ]] || (( JOBS < 1 )); then
  echo "PLAYWRIGHT_E2E_JOBS must be a positive integer. Got: ${JOBS}" >&2
  exit 1
fi

positional_args=()
option_args=()
for arg in "$@"; do
  if [[ "${arg}" == tests/* ]]; then
    positional_args+=("${arg}")
  else
    option_args+=("${arg}")
  fi
done

if (( ${#positional_args[@]} == 0 )); then
  AUTO_TEST_FILES=()
  while IFS= read -r test_file; do
    [[ -n "${test_file}" ]] || continue
    AUTO_TEST_FILES+=("${test_file}")
  done < <(node "${ROOT_DIR}/scripts/e2e-suite.mjs" --harness "${HARNESS}")
  if (( ${#AUTO_TEST_FILES[@]} == 0 )); then
    echo "No ${HARNESS} E2E specs were discovered by tests/e2e-suite.json" >&2
    exit 1
  fi
  positional_args=("${AUTO_TEST_FILES[@]}")
fi

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
  local test_name="$(basename "${test_file}" .spec.ts)"
  local test_log="${SUITE_RUN_DIR}/${test_name}.log"
  local -a command=("${ROOT_DIR}/scripts/run-playwright-e2e-podman.sh" "${HARNESS}")

  if (( ${#option_args[@]} > 0 )); then
    command+=("${option_args[@]}")
  fi
  command+=("${test_file}")

  echo "==> Running ${HARNESS} E2E in isolated Podman container: ${test_file}" | tee -a "${SCRIPT_LOG}"
  (
    cd "${ROOT_DIR}"
    "${command[@]}"
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

for test_file in "${positional_args[@]}"; do
  while (( ${#LAUNCHED_PIDS[@]} >= JOBS )); do
    wait_for_one_completion
  done
  launch_test "${test_file}"
done

while (( ${#LAUNCHED_PIDS[@]} > 0 )); do
  wait_for_one_completion
done

if (( FAILURES > 0 )); then
  echo "[playwright-e2e-suite-podman] completed with ${FAILURES} failure(s). Logs: ${SUITE_RUN_DIR}" >&2
  exit 1
fi

echo "[playwright-e2e-suite-podman] all ${HARNESS} tests passed. Logs: ${SUITE_RUN_DIR}" | tee -a "${SCRIPT_LOG}"
