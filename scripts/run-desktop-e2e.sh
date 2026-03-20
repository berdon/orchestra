#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REAL_HOME="${HOME}"
LOG_ROOT="${ROOT_DIR}/.tmp/desktop-e2e"
RUN_DIR="$(mktemp -d "${LOG_ROOT}/run-XXXXXX")"
TEST_HOME="${RUN_DIR}/home"
mkdir -p "${RUN_DIR}" "${TEST_HOME}"

DRIVER_LOG="${RUN_DIR}/tauri-driver.log"
BINARY_PATH="${ROOT_DIR}/src-tauri/target/debug/orchestra"
TEST_FILE="${1:-tests/desktop-e2e/desktop-harness.test.ts}"
shift || true
EXTRA_ARGS=("$@")

run_inner() {
  cd "${ROOT_DIR}"

  export HOME="${TEST_HOME}"
  export XDG_CONFIG_HOME="${TEST_HOME}/.config"
  export XDG_CACHE_HOME="${TEST_HOME}/.cache"
  export XDG_DATA_HOME="${TEST_HOME}/.local/share"
  export RUSTUP_HOME="${REAL_HOME}/.rustup"
  export CARGO_HOME="${REAL_HOME}/.cargo"
  export NPM_CONFIG_PREFIX="${REAL_HOME}/.npm-global"
  export PATH="${NPM_CONFIG_PREFIX}/bin:${PATH}"
  mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME"
  rm -rf "${TEST_HOME}/.pi"
  if [[ -d "${REAL_HOME}/.pi" ]]; then
    ln -s "${REAL_HOME}/.pi" "${TEST_HOME}/.pi"
  fi

  npm install
  source "${REAL_HOME}/.cargo/env"
  cargo tauri build --debug --no-bundle

  tauri-driver --native-driver /usr/bin/WebKitWebDriver >"${DRIVER_LOG}" 2>&1 &
  DRIVER_PID=$!

  cleanup() {
    if [[ -n "${DRIVER_PID:-}" ]] && kill -0 "${DRIVER_PID}" 2>/dev/null; then
      kill "${DRIVER_PID}" 2>/dev/null || true
      wait "${DRIVER_PID}" 2>/dev/null || true
    fi
    pkill -f "${BINARY_PATH}" 2>/dev/null || true
    pkill -f "WebKitWebDriver" 2>/dev/null || true
  }
  trap cleanup EXIT

  for _ in $(seq 1 60); do
    if curl -sf http://127.0.0.1:4444/status >/dev/null 2>&1; then
      break
    fi
    if ! kill -0 "${DRIVER_PID}" 2>/dev/null; then
      echo "tauri-driver exited unexpectedly" >&2
      cat "${DRIVER_LOG}" >&2 || true
      exit 1
    fi
    sleep 1
  done

  if ! curl -sf http://127.0.0.1:4444/status >/dev/null 2>&1; then
    echo "tauri-driver did not become ready" >&2
    cat "${DRIVER_LOG}" >&2 || true
    exit 1
  fi

  ORCHESTRA_DESKTOP_E2E=1 \
  ORCHESTRA_TAURI_BINARY="${BINARY_PATH}" \
  ORCHESTRA_TEST_HOME="${TEST_HOME}" \
  ORCHESTRA_WEBDRIVER_URL="http://127.0.0.1:4444" \
  npx vitest run "${TEST_FILE}" "${EXTRA_ARGS[@]}"
}

if [[ -z "${DISPLAY:-}" ]] || [[ -z "${XAUTHORITY:-}" ]]; then
  exec xvfb-run -a --server-args="-screen 0 1440x920x24" "$0" "${TEST_FILE}" "${EXTRA_ARGS[@]}"
else
  run_inner
fi
