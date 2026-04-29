#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REAL_HOME="${HOME}"
LOG_ROOT="${ROOT_DIR}/.tmp/desktop-e2e"
mkdir -p "${LOG_ROOT}"
RUN_DIR="$(mktemp -d "${LOG_ROOT}/run-XXXXXX")"
TEST_HOME="${RUN_DIR}/home"
mkdir -p "${RUN_DIR}" "${TEST_HOME}"
PREVIEW_URL="${ORCHESTRA_DESKTOP_E2E_PREVIEW_URL:-http://127.0.0.1:1420}"
PREVIEW_PORT="${ORCHESTRA_DESKTOP_E2E_PREVIEW_PORT:-1420}"
REUSE_PREVIEW="${ORCHESTRA_DESKTOP_E2E_REUSE_PREVIEW:-0}"
TARGET_DEBUG_DIR="${ROOT_DIR}/src-tauri/target/debug"
BINARY_PATH="${TARGET_DEBUG_DIR}/orchestra"
BUILD_LOCK_DIR="${TARGET_DEBUG_DIR}/.desktop-e2e-build-lock"

binary_matches_preview_url() {
  [[ -x "${BINARY_PATH}" ]] || return 1
  strings "${BINARY_PATH}" 2>/dev/null | grep -F "${PREVIEW_URL}" >/dev/null 2>&1
}

ensure_binary_matches_preview_url() {
  if binary_matches_preview_url; then
    return
  fi

  (
    set -euo pipefail

    mkdir -p "${TARGET_DEBUG_DIR}"

    while ! mkdir "${BUILD_LOCK_DIR}" 2>/dev/null; do
      echo "[desktop-e2e-runner] waiting for desktop E2E build lock ${BUILD_LOCK_DIR}"
      sleep 1
    done
    trap 'rmdir "${BUILD_LOCK_DIR}" 2>/dev/null || true' EXIT

    if binary_matches_preview_url; then
      exit 0
    fi

    local_tauri_config="$(python3 - "${PREVIEW_URL}" <<'PY'
import json
import sys

print(json.dumps({"build": {"devUrl": sys.argv[1]}}))
PY
)"

    echo "[desktop-e2e-runner] building Tauri debug binary for preview ${PREVIEW_URL}"
    TAURI_CONFIG="${local_tauri_config}" cargo build --manifest-path "${ROOT_DIR}/src-tauri/Cargo.toml"

    if ! binary_matches_preview_url; then
      echo "desktop E2E binary did not embed preview URL ${PREVIEW_URL} after rebuild" >&2
      exit 1
    fi
  )
}

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

ensure_port_available() {
  local port="$1"
  if lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port ${port} is already in use. Stop the conflicting process before running desktop E2E." >&2
    lsof -nP -iTCP:"${port}" -sTCP:LISTEN >&2 || true
    exit 1
  fi
}

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

SCRIPT_LOG="${RUN_DIR}/runner.log"
DRIVER_LOG="${RUN_DIR}/tauri-driver.log"
PREVIEW_LOG="${RUN_DIR}/vite-preview.log"
WEBDRIVER_PORT="$(choose_unused_port 30000)"
NATIVE_WEBDRIVER_PORT="$(choose_unused_port 45000)"
PLATFORM="$(uname -s)"
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
echo "[desktop-e2e-runner] preview_url=${PREVIEW_URL} reuse_preview=${REUSE_PREVIEW}"

ensure_preview_assets() {
  bash "${ROOT_DIR}/scripts/ensure-desktop-e2e-preview-assets.sh"
}

run_inner() {
  cd "${ROOT_DIR}"

  export HOME="${TEST_HOME}"
  export XDG_CONFIG_HOME="${TEST_HOME}/.config"
  export XDG_CACHE_HOME="${TEST_HOME}/.cache"
  export XDG_DATA_HOME="${TEST_HOME}/.local/share"
  export RUSTUP_HOME="${REAL_HOME}/.rustup"
  export CARGO_HOME="${REAL_HOME}/.cargo"
  export NPM_CONFIG_CACHE="${TEST_HOME}/.npm"
  export ORCHESTRA_PROJECT_ROOT="${ROOT_DIR}"
  export ORCHESTRA_DESKTOP_E2E=1
  export IS_DESKTOP_E2E=1
  export ORCHESTRA_ENABLE_WEBDRIVER_AUTOMATION=1
  export PATH="${REAL_HOME}/.cargo/bin:/workspace/orchestra/node_modules/.bin:${PATH}"
  if [[ "${IS_DESKTOP_E2E}" != "1" ]]; then
    unset PI_CODING_AGENT_DIR PI_PACKAGE_DIR ORCHESTRA_PI_EXECUTABLE ORCHESTRA_BUNDLED_PI_RUNTIME_ROOT
  fi
  mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME"
  ensure_preview_assets
  rm -rf "${TEST_HOME}/.pi"
  if [[ -d "${REAL_HOME}/.pi" ]]; then
    ln -s "${REAL_HOME}/.pi" "${TEST_HOME}/.pi"
  fi
  rm -rf "${TEST_HOME}/.codex"
  if [[ -d "${REAL_HOME}/.codex" ]]; then
    ln -s "${REAL_HOME}/.codex" "${TEST_HOME}/.codex"
  fi

  local managed_pi_dir="${TEST_HOME}/.orchestra/runtime/pi/agent"
  local legacy_pi_dir="${TEST_HOME}/.pi/agent"
  local import_legacy_auth="${ORCHESTRA_DESKTOP_E2E_IMPORT_LEGACY_AUTH:-1}"
  local import_legacy_models="${ORCHESTRA_DESKTOP_E2E_IMPORT_LEGACY_MODELS:-1}"
  local import_legacy_settings="${ORCHESTRA_DESKTOP_E2E_IMPORT_LEGACY_SETTINGS:-0}"
  if [[ -d "${legacy_pi_dir}" ]]; then
    mkdir -p "${managed_pi_dir}"
    chmod 700 "${TEST_HOME}/.orchestra" "${TEST_HOME}/.orchestra/runtime" "${TEST_HOME}/.orchestra/runtime/pi" "${managed_pi_dir}" 2>/dev/null || true

    if [[ "${import_legacy_auth}" == "1" ]]; then
      if [[ -f "${legacy_pi_dir}/auth.json" && ! -f "${managed_pi_dir}/auth.json" ]]; then
        install -m 600 "${legacy_pi_dir}/auth.json" "${managed_pi_dir}/auth.json"
        echo "[desktop-e2e-runner] imported host Pi auth.json into managed runtime"
      fi
    elif [[ -f "${legacy_pi_dir}/auth.json" ]]; then
      echo "[desktop-e2e-runner] skipping host Pi auth.json import because ORCHESTRA_DESKTOP_E2E_IMPORT_LEGACY_AUTH=0"
    fi

    if [[ "${import_legacy_settings}" == "1" ]]; then
      if [[ -f "${legacy_pi_dir}/settings.json" && ! -f "${managed_pi_dir}/settings.json" ]]; then
        install -m 600 "${legacy_pi_dir}/settings.json" "${managed_pi_dir}/settings.json"
      fi
    elif [[ -f "${legacy_pi_dir}/settings.json" ]]; then
      echo "[desktop-e2e-runner] skipping legacy settings.json import by default; set ORCHESTRA_DESKTOP_E2E_IMPORT_LEGACY_SETTINGS=1 to opt in"
    fi

    if [[ "${import_legacy_models}" == "1" ]]; then
      if [[ -f "${legacy_pi_dir}/models.json" && ! -f "${managed_pi_dir}/models.json" ]]; then
        install -m 600 "${legacy_pi_dir}/models.json" "${managed_pi_dir}/models.json"
        echo "[desktop-e2e-runner] imported host Pi models.json into managed runtime"
      fi
    elif [[ -f "${legacy_pi_dir}/models.json" ]]; then
      echo "[desktop-e2e-runner] skipping host Pi models.json import because ORCHESTRA_DESKTOP_E2E_IMPORT_LEGACY_MODELS=0"
    fi
  fi

  ensure_binary_matches_preview_url

  if [[ "${REUSE_PREVIEW}" == "1" ]]; then
    for _ in $(seq 1 60); do
      if curl -sf "${PREVIEW_URL}" >/dev/null 2>&1; then
        break
      fi
      sleep 1
    done

    if ! curl -sf "${PREVIEW_URL}" >/dev/null 2>&1; then
      echo "shared vite preview did not become ready at ${PREVIEW_URL}" >&2
      exit 1
    fi
  else
    ensure_port_available "${PREVIEW_PORT}"
    start_detached npx vite preview --host 127.0.0.1 --port "${PREVIEW_PORT}" --strictPort >"${PREVIEW_LOG}" 2>&1
    PREVIEW_PID=$!
    PREVIEW_PGID="${PREVIEW_PID}"

    for _ in $(seq 1 60); do
      if ! kill -0 "${PREVIEW_PID}" 2>/dev/null; then
        echo "vite preview exited unexpectedly" >&2
        cat "${PREVIEW_LOG}" >&2 || true
        exit 1
      fi
      if curl -sf "${PREVIEW_URL}" >/dev/null 2>&1; then
        break
      fi
      sleep 1
    done

    if ! curl -sf "${PREVIEW_URL}" >/dev/null 2>&1; then
      echo "vite preview did not become ready at ${PREVIEW_URL}" >&2
      cat "${PREVIEW_LOG}" >&2 || true
      exit 1
    fi
  fi

  if [[ "${PLATFORM}" == "Darwin" ]]; then
    start_detached tauri-wd --port "${WEBDRIVER_PORT}" --log-level debug >"${DRIVER_LOG}" 2>&1
  else
    start_detached tauri-driver --port "${WEBDRIVER_PORT}" --native-port "${NATIVE_WEBDRIVER_PORT}" --native-driver /usr/bin/WebKitWebDriver >"${DRIVER_LOG}" 2>&1
  fi
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

  if ! ORCHESTRA_DESKTOP_E2E=1 \
    ORCHESTRA_DESKTOP_E2E_PREVIEW_URL="${PREVIEW_URL}" \
    ORCHESTRA_TAURI_BINARY="${BINARY_PATH}" \
    ORCHESTRA_TEST_HOME="${TEST_HOME}" \
    ORCHESTRA_WEBDRIVER_URL="http://127.0.0.1:${WEBDRIVER_PORT}" \
    npx vitest run "${TEST_FILE}"; then
    echo "[desktop-e2e-runner] vitest failed; tauri-driver log follows" >&2
    cat "${DRIVER_LOG}" >&2 || true
    echo "[desktop-e2e-runner] vite preview log follows" >&2
    cat "${PREVIEW_LOG}" >&2 || true
    return 1
  fi
}

run_inner
