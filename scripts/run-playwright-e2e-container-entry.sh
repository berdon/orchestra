#!/usr/bin/env bash
set -euo pipefail
set -x

HARNESS="${1:-}"
if [[ -z "${HARNESS}" ]]; then
  echo "container-entry: missing harness argument" >&2
  exit 1
fi
shift || true

WORKSPACE_ROOT="/tmp/workspace"
WORKSPACE_DIR="${WORKSPACE_ROOT}/orchestra"
TARGET_DIR="${ORCHESTRA_DESKTOP_E2E_TARGET_DIR:-/workspace-target}"
RUN_HOME="${WORKSPACE_ROOT}/home"

rm -rf "${WORKSPACE_ROOT}"
mkdir -p "${WORKSPACE_DIR}" "${RUN_HOME}"

rsync -a --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude .tmp \
  /src/ "${WORKSPACE_DIR}/"
cp -a /workspace/orchestra/node_modules "${WORKSPACE_DIR}/node_modules"
if [[ -d /workspace/orchestra/mobile/node_modules ]]; then
  mkdir -p "${WORKSPACE_DIR}/mobile"
  cp -a /workspace/orchestra/mobile/node_modules "${WORKSPACE_DIR}/mobile/node_modules"
fi
rm -rf "${WORKSPACE_DIR}/node_modules/.vite" "${WORKSPACE_DIR}/node_modules/.cache/vite" "${WORKSPACE_DIR}/node_modules/.cache/vitest" "${WORKSPACE_DIR}/.vitest"

if [[ -d /seed-home/.pi ]]; then
  rm -rf "${RUN_HOME}/.pi"
  cp -a /seed-home/.pi "${RUN_HOME}/.pi"
fi
if [[ -d /seed-home/.codex ]]; then
  rm -rf "${RUN_HOME}/.codex"
  cp -a /seed-home/.codex "${RUN_HOME}/.codex"
fi

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

cd "${WORKSPACE_DIR}"
export HOME="${RUN_HOME}"
export XDG_CONFIG_HOME="${RUN_HOME}/.config"
export XDG_CACHE_HOME="${RUN_HOME}/.cache"
export XDG_DATA_HOME="${RUN_HOME}/.local/share"
export NPM_CONFIG_CACHE="${RUN_HOME}/.npm"
export RUSTUP_HOME="/root/.rustup"
export CARGO_HOME="/root/.cargo"
export CARGO_TARGET_DIR="${TARGET_DIR}"
export CARGO_INCREMENTAL=0
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/ms-playwright}"
mkdir -p "${XDG_CONFIG_HOME}" "${XDG_CACHE_HOME}" "${XDG_DATA_HOME}" "${NPM_CONFIG_CACHE}" "${TARGET_DIR}"

XVFB_DISPLAY=":99"
XVFB_LOG="${WORKSPACE_DIR}/.tmp/playwright-e2e-xvfb.log"
mkdir -p "${WORKSPACE_DIR}/.tmp"
Xvfb "${XVFB_DISPLAY}" -screen 0 1440x920x24 -nolisten tcp >"${XVFB_LOG}" 2>&1 &
XVFB_PID=$!
cleanup() {
  if [[ -n "${XVFB_PID:-}" ]] && kill -0 "${XVFB_PID}" 2>/dev/null; then
    kill "${XVFB_PID}" 2>/dev/null || true
    wait "${XVFB_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT
for _ in $(seq 1 20); do
  if kill -0 "${XVFB_PID}" 2>/dev/null; then
    break
  fi
  sleep 1
done
if ! kill -0 "${XVFB_PID}" 2>/dev/null; then
  echo "playwright-e2e: Xvfb failed to start" >&2
  cat "${XVFB_LOG}" >&2 || true
  exit 1
fi
export DISPLAY="${XVFB_DISPLAY}"

case "${HARNESS}" in
  browser)
    export ORCHESTRA_BROWSER_E2E_PORT="$(choose_unused_port 41000)"
    export ORCHESTRA_BROWSER_E2E_BASE_URL="http://127.0.0.1:${ORCHESTRA_BROWSER_E2E_PORT}"
    ;;
  hosted-web)
    export ORCHESTRA_HOSTED_WEB_E2E_PORT="$(choose_unused_port 42000)"
    export ORCHESTRA_HOSTED_WEB_E2E_BASE_URL="http://127.0.0.1:${ORCHESTRA_HOSTED_WEB_E2E_PORT}"
    export ORCHESTRA_STORAGE_ROOT="${WORKSPACE_DIR}/.tmp/hosted-web-storage-${ORCHESTRA_HOSTED_WEB_E2E_PORT}"
    mkdir -p "${ORCHESTRA_STORAGE_ROOT}"
    ;;
  web-driver)
    export ORCHESTRA_WEB_DRIVER_E2E_PORT="$(choose_unused_port 43000)"
    export ORCHESTRA_WEB_DRIVER_E2E_BASE_URL="http://127.0.0.1:${ORCHESTRA_WEB_DRIVER_E2E_PORT}"
    ;;
  *)
    echo "Unsupported Playwright E2E harness: ${HARNESS}" >&2
    exit 1
    ;;
esac

./scripts/run-playwright-e2e-local.sh "${HARNESS}" "$@"
