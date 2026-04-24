#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_ROOT="${ROOT_DIR}/.tmp/desktop-e2e"
JOBS="${DESKTOP_E2E_JOBS:-1}"
PREVIEW_PORT="${ORCHESTRA_DESKTOP_E2E_PREVIEW_PORT:-1420}"
PREVIEW_URL="${ORCHESTRA_DESKTOP_E2E_PREVIEW_URL:-http://127.0.0.1:${PREVIEW_PORT}}"
mkdir -p "${LOG_ROOT}"
SUITE_RUN_DIR="$(mktemp -d "${LOG_ROOT}/suite-XXXXXX")"
PREVIEW_LOG="${SUITE_RUN_DIR}/vite-preview.log"
SCRIPT_LOG="${SUITE_RUN_DIR}/suite.log"

if [[ "$#" -eq 0 ]]; then
  AUTO_TEST_FILES=()
  while IFS= read -r test_file; do
    [[ -n "${test_file}" ]] || continue
    AUTO_TEST_FILES+=("${test_file}")
  done < <(node "${ROOT_DIR}/scripts/desktop-e2e-suite.mjs")
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

start_detached() {
  if command -v setsid >/dev/null 2>&1; then
    setsid "$@" &
    return
  fi

  python3 - "$@" <<'PY' &
import os
import sys

os.setsid()
os.execvp(sys.argv[1], sys.argv[1:])
PY
}

ensure_port_available() {
  local port="$1"
  if lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port ${port} is already in use. Stop the conflicting process before running desktop E2E in shared-preview mode." >&2
    lsof -nP -iTCP:"${port}" -sTCP:LISTEN >&2 || true
    exit 1
  fi
}

PREVIEW_PID=""
PREVIEW_PGID=""
LAUNCHED_PIDS=()
LAUNCHED_TESTS=()
LAUNCHED_LOGS=()
FAILURES=0

cleanup() {
  local pid
  for pid in "${LAUNCHED_PIDS[@]:-}"; do
    if [[ -n "${pid}" ]] && kill -0 "${pid}" >/dev/null 2>&1; then
      kill -TERM -- "-${pid}" >/dev/null 2>&1 || kill -TERM "${pid}" >/dev/null 2>&1 || true
    fi
  done

  for pid in "${LAUNCHED_PIDS[@]:-}"; do
    if [[ -n "${pid}" ]]; then
      wait "${pid}" 2>/dev/null || true
    fi
  done

  if [[ -n "${PREVIEW_PGID}" ]]; then
    kill -TERM -- "-${PREVIEW_PGID}" 2>/dev/null || true
    wait "${PREVIEW_PID}" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

ensure_preview_assets() {
  if [[ -f "${ROOT_DIR}/dist/index.html" ]]; then
    return
  fi

  echo "[desktop-e2e-suite] frontend dist missing; running npm run build:hosted-web" | tee -a "${SCRIPT_LOG}"
  (
    cd "${ROOT_DIR}"
    npm run build:hosted-web
  ) >>"${SCRIPT_LOG}" 2>&1
}

start_shared_preview() {
  ensure_preview_assets
  ensure_port_available "${PREVIEW_PORT}"
  echo "[desktop-e2e-suite] starting shared vite preview at ${PREVIEW_URL}" | tee -a "${SCRIPT_LOG}"
  start_detached npx vite preview --host 127.0.0.1 --port "${PREVIEW_PORT}" --strictPort >"${PREVIEW_LOG}" 2>&1
  PREVIEW_PID=$!
  PREVIEW_PGID="${PREVIEW_PID}"

  local _
  for _ in $(seq 1 60); do
    if ! kill -0 "${PREVIEW_PID}" 2>/dev/null; then
      echo "shared vite preview exited unexpectedly" >&2
      cat "${PREVIEW_LOG}" >&2 || true
      exit 1
    fi
    if curl -sf "${PREVIEW_URL}" >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done

  echo "shared vite preview did not become ready at ${PREVIEW_URL}" >&2
  cat "${PREVIEW_LOG}" >&2 || true
  exit 1
}

launch_test() {
  local test_file="$1"
  local test_name
  local test_log
  test_name="$(basename "${test_file}" .test.ts)"
  test_log="${SUITE_RUN_DIR}/${test_name}.log"

  echo "==> Running desktop E2E in isolated harness: ${test_file}" | tee -a "${SCRIPT_LOG}"
  (
    cd "${ROOT_DIR}"
    ORCHESTRA_DESKTOP_E2E_REUSE_PREVIEW=1 \
    ORCHESTRA_DESKTOP_E2E_PREVIEW_URL="${PREVIEW_URL}" \
    ORCHESTRA_DESKTOP_E2E_PREVIEW_PORT="${PREVIEW_PORT}" \
    "${ROOT_DIR}/scripts/run-desktop-e2e.sh" "${test_file}"
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

start_shared_preview

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
  echo "[desktop-e2e-suite] completed with ${FAILURES} failure(s). Logs: ${SUITE_RUN_DIR}" >&2
  exit 1
fi

echo "[desktop-e2e-suite] all tests passed. Logs: ${SUITE_RUN_DIR}" | tee -a "${SCRIPT_LOG}"
