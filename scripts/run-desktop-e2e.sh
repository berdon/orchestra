#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REAL_HOME="${HOME}"
LOG_ROOT="${ROOT_DIR}/.tmp/desktop-e2e"
mkdir -p "${LOG_ROOT}"
RUN_DIR="$(mktemp -d "${LOG_ROOT}/run-XXXXXX")"
TEST_HOME="${RUN_DIR}/home"
mkdir -p "${RUN_DIR}" "${TEST_HOME}"

choose_unused_port() {
  local base="$1"
  while true; do
    local candidate="$((base + (RANDOM % 10000)))"
    if ! ss -ltn "( sport = :${candidate} )" 2>/dev/null | tail -n +2 | grep -q .; then
      echo "${candidate}"
      return
    fi
  done
}

SCRIPT_LOG="${RUN_DIR}/runner.log"
DRIVER_LOG="${RUN_DIR}/tauri-driver.log"
PREVIEW_LOG="${RUN_DIR}/vite-preview.log"
BINARY_PATH="${ROOT_DIR}/src-tauri/target/debug/orchestra"
WEBDRIVER_PORT="$(choose_unused_port 30000)"
NATIVE_WEBDRIVER_PORT="$(choose_unused_port 45000)"
TEST_FILE="${1:-tests/desktop-e2e/desktop-harness.test.ts}"
shift || true
if [[ "$#" -gt 0 ]]; then
  echo "run-desktop-e2e.sh accepts exactly one test file. Use run-desktop-e2e-suite.sh for multiple files." >&2
  exit 1
fi

exec > >(tee -a "${SCRIPT_LOG}") 2>&1
set -x
echo "[desktop-e2e-runner] root_dir=${ROOT_DIR}"
echo "[desktop-e2e-runner] run_dir=${RUN_DIR}"
echo "[desktop-e2e-runner] test_file=${TEST_FILE}"
echo "[desktop-e2e-runner] webdriver_port=${WEBDRIVER_PORT} native_port=${NATIVE_WEBDRIVER_PORT}"

run_inner() {
  cd "${ROOT_DIR}"

  export HOME="${TEST_HOME}"
  export XDG_CONFIG_HOME="${TEST_HOME}/.config"
  export XDG_CACHE_HOME="${TEST_HOME}/.cache"
  export XDG_DATA_HOME="${TEST_HOME}/.local/share"
  export RUSTUP_HOME="${REAL_HOME}/.rustup"
  export CARGO_HOME="${REAL_HOME}/.cargo"
  export NPM_CONFIG_CACHE="${TEST_HOME}/.npm"
  export PATH="/workspace/orchestra/node_modules/.bin:${PATH}"
  export ORCHESTRA_AGENT_TERMINAL_TEMPLATE="${ORCHESTRA_AGENT_TERMINAL_TEMPLATE:-sleep 8}"
  mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME"
  rm -rf "${TEST_HOME}/.pi"
  if [[ -d "${REAL_HOME}/.pi" ]]; then
    ln -s "${REAL_HOME}/.pi" "${TEST_HOME}/.pi"
  fi

  setsid npx vite preview --host 127.0.0.1 --port 1420 --strictPort >"${PREVIEW_LOG}" 2>&1 &
  PREVIEW_PID=$!
  PREVIEW_PGID="${PREVIEW_PID}"

  for _ in $(seq 1 60); do
    if curl -sf "http://127.0.0.1:1420" >/dev/null 2>&1; then
      break
    fi
    if ! kill -0 "${PREVIEW_PID}" 2>/dev/null; then
      echo "vite preview exited unexpectedly" >&2
      cat "${PREVIEW_LOG}" >&2 || true
      exit 1
    fi
    sleep 1
  done

  if ! curl -sf "http://127.0.0.1:1420" >/dev/null 2>&1; then
    echo "vite preview did not become ready" >&2
    cat "${PREVIEW_LOG}" >&2 || true
    exit 1
  fi

  setsid tauri-driver --port "${WEBDRIVER_PORT}" --native-port "${NATIVE_WEBDRIVER_PORT}" --native-driver /usr/bin/WebKitWebDriver >"${DRIVER_LOG}" 2>&1 &
  DRIVER_PID=$!
  DRIVER_PGID="${DRIVER_PID}"

  cleanup() {
    if [[ -n "${DRIVER_PGID:-}" ]]; then
      kill -TERM -- "-${DRIVER_PGID}" 2>/dev/null || true
      wait "${DRIVER_PID}" 2>/dev/null || true
    fi
    if [[ -n "${PREVIEW_PGID:-}" ]]; then
      kill -TERM -- "-${PREVIEW_PGID}" 2>/dev/null || true
      wait "${PREVIEW_PID}" 2>/dev/null || true
    fi
  }
  trap cleanup EXIT

  for _ in $(seq 1 60); do
    if curl -sf "http://127.0.0.1:${WEBDRIVER_PORT}/status" >/dev/null 2>&1; then
      break
    fi
    if ! kill -0 "${DRIVER_PID}" 2>/dev/null; then
      echo "tauri-driver exited unexpectedly" >&2
      cat "${DRIVER_LOG}" >&2 || true
      exit 1
    fi
    sleep 1
  done

  if ! curl -sf "http://127.0.0.1:${WEBDRIVER_PORT}/status" >/dev/null 2>&1; then
    echo "tauri-driver did not become ready" >&2
    cat "${DRIVER_LOG}" >&2 || true
    exit 1
  fi

  ORCHESTRA_DESKTOP_E2E=1 \
  ORCHESTRA_AGENT_TERMINAL_TEMPLATE="${ORCHESTRA_AGENT_TERMINAL_TEMPLATE:-sleep 8}" \
  ORCHESTRA_TAURI_BINARY="${BINARY_PATH}" \
  ORCHESTRA_TEST_HOME="${TEST_HOME}" \
  ORCHESTRA_WEBDRIVER_URL="http://127.0.0.1:${WEBDRIVER_PORT}" \
  npx vitest run "${TEST_FILE}"
}

run_inner
