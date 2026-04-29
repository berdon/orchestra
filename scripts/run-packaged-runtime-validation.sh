#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${ORCHESTRA_PACKAGED_RUNTIME_PROFILE:-release}"
APP_INPUT="${ORCHESTRA_PACKAGED_RUNTIME_APP_PATH:-${ROOT_DIR}/src-tauri/target/${PROFILE}/bundle/macos/Orchestra.app}"
TEST_FILE="${ORCHESTRA_PACKAGED_RUNTIME_TEST_FILE:-tests/desktop-e2e/packaged-runtime-smoke.test.ts}"
SANITIZED_PATH="${ORCHESTRA_PACKAGED_RUNTIME_SANITIZED_PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
FIXTURE_DIR="${ORCHESTRA_PACKAGED_RUNTIME_AGENT_FIXTURE_DIR:-}"
BUILD_IF_MISSING="${ORCHESTRA_PACKAGED_RUNTIME_BUILD_IF_MISSING:-0}"
REQUIRE_PROMPT_FIXTURE="${ORCHESTRA_PACKAGED_RUNTIME_REQUIRE_PROMPT_FIXTURE:-1}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Packaged runtime validation currently targets macOS packaged builds only." >&2
  exit 1
fi

resolve_app_binary() {
  local input_path="$1"
  if [[ "${input_path}" == *.app ]]; then
    printf '%s\n' "${input_path}/Contents/MacOS/Orchestra"
  else
    printf '%s\n' "${input_path}"
  fi
}

APP_BINARY="$(resolve_app_binary "${APP_INPUT}")"
if [[ ! -x "${APP_BINARY}" && "${BUILD_IF_MISSING}" == "1" ]]; then
  echo "[packaged-runtime-validation] missing packaged app at ${APP_BINARY}; building it first"
  npm run prepare:bundled-pi-runtime
  ORCHESTRA_BUILD_PROFILE="${PROFILE}" ./scripts/build-adhoc.sh
fi

if [[ ! -x "${APP_BINARY}" ]]; then
  echo "Packaged app binary is missing or not executable: ${APP_BINARY}" >&2
  exit 1
fi

RUN_ROOT="${ROOT_DIR}/.tmp/packaged-runtime-validation"
mkdir -p "${RUN_ROOT}"
RUN_DIR="$(mktemp -d "${RUN_ROOT}/run-XXXXXX")"
TEST_HOME="${RUN_DIR}/home"
AGENT_DIR="${TEST_HOME}/.orchestra/runtime/pi/agent"
TRAP_BIN_DIR="${RUN_DIR}/trap-bin"
PATH_TRAP_LOG="${RUN_DIR}/path-tool-trap.log"
mkdir -p "${AGENT_DIR}" "${TRAP_BIN_DIR}"
rm -rf "${TEST_HOME}/.pi"

for tool in pi node npm bun; do
  if env PATH="${SANITIZED_PATH}" /bin/sh -lc "command -v ${tool}" >/dev/null 2>&1; then
    echo "[packaged-runtime-validation] base sanitized PATH still resolves ${tool}; shadowing it with a failing trap binary so packaged validation can still prove the app did not use PATH-discovered ${tool}."
  fi
  cat > "${TRAP_BIN_DIR}/${tool}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf '%s\t%s\n' "${tool}" "\$*" >> "${PATH_TRAP_LOG}"
echo "Packaged runtime validation trap: unexpected PATH lookup for ${tool}" >&2
exit 97
EOF
  chmod +x "${TRAP_BIN_DIR}/${tool}"
done

EXPECT_PROMPT_SUCCESS=0
if [[ -n "${FIXTURE_DIR}" ]]; then
  if [[ ! -f "${FIXTURE_DIR}/auth.json" || ! -f "${FIXTURE_DIR}/models.json" ]]; then
    echo "Packaged runtime validation fixture directory must contain auth.json and models.json: ${FIXTURE_DIR}" >&2
    exit 1
  fi
  install -m 600 "${FIXTURE_DIR}/auth.json" "${AGENT_DIR}/auth.json"
  install -m 600 "${FIXTURE_DIR}/models.json" "${AGENT_DIR}/models.json"
  if [[ -f "${FIXTURE_DIR}/settings.json" ]]; then
    install -m 600 "${FIXTURE_DIR}/settings.json" "${AGENT_DIR}/settings.json"
  fi
  EXPECT_PROMPT_SUCCESS=1
elif [[ "${REQUIRE_PROMPT_FIXTURE}" == "1" ]]; then
  echo "Set ORCHESTRA_PACKAGED_RUNTIME_AGENT_FIXTURE_DIR to a directory containing Orchestra-managed auth.json and models.json so packaged validation can execute a real prompt." >&2
  exit 1
fi

choose_unused_port() {
  python3 - "$1" <<'PY'
import random
import socket
import sys

base = int(sys.argv[1])
for _ in range(200):
    candidate = base + random.randint(0, 10000)
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind(("127.0.0.1", candidate))
        except OSError:
            continue
        print(candidate)
        raise SystemExit(0)
raise SystemExit("unable to allocate port")
PY
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

WEBDRIVER_PORT="$(choose_unused_port 45000)"
DRIVER_LOG="${RUN_DIR}/tauri-wd.log"
WRAPPER_PATH="${RUN_DIR}/launch-packaged-orchestra.sh"
cat > "${WRAPPER_PATH}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export HOME="${TEST_HOME}"
export XDG_CONFIG_HOME="${TEST_HOME}/.config"
export XDG_CACHE_HOME="${TEST_HOME}/.cache"
export XDG_DATA_HOME="${TEST_HOME}/.local/share"
export ORCHESTRA_PACKAGED_RUNTIME_PATH_TRAP_LOG="${PATH_TRAP_LOG}"
export ORCHESTRA_DESKTOP_E2E=1
export ORCHESTRA_ENABLE_WEBDRIVER_AUTOMATION=1
export PATH="${TRAP_BIN_DIR}:${SANITIZED_PATH}"
unset ORCHESTRA_PI_EXECUTABLE
exec "${APP_BINARY}"
EOF
chmod +x "${WRAPPER_PATH}"
mkdir -p "${TEST_HOME}/.config" "${TEST_HOME}/.cache" "${TEST_HOME}/.local/share"

cleanup() {
  if [[ -n "${DRIVER_PGID:-}" ]]; then
    kill -TERM -- "-${DRIVER_PGID}" 2>/dev/null || true
    wait "${DRIVER_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

cd "${ROOT_DIR}"
echo "[packaged-runtime-validation] app=${APP_BINARY}"
echo "[packaged-runtime-validation] wrapper=${WRAPPER_PATH}"
echo "[packaged-runtime-validation] test_home=${TEST_HOME}"
echo "[packaged-runtime-validation] webdriver_port=${WEBDRIVER_PORT}"
echo "[packaged-runtime-validation] sanitized_path=${SANITIZED_PATH}"
echo "[packaged-runtime-validation] trap_bin_dir=${TRAP_BIN_DIR}"
echo "[packaged-runtime-validation] path_trap_log=${PATH_TRAP_LOG}"

start_detached tauri-wd --port "${WEBDRIVER_PORT}" --log-level debug >"${DRIVER_LOG}" 2>&1
DRIVER_PID=$!
DRIVER_PGID="${DRIVER_PID}"

for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${WEBDRIVER_PORT}/status" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "${DRIVER_PID}" 2>/dev/null; then
    echo "tauri-wd exited unexpectedly" >&2
    cat "${DRIVER_LOG}" >&2 || true
    exit 1
  fi
  sleep 1
done

if ! curl -sf "http://127.0.0.1:${WEBDRIVER_PORT}/status" >/dev/null 2>&1; then
  echo "tauri-wd did not become ready" >&2
  cat "${DRIVER_LOG}" >&2 || true
  exit 1
fi

ORCHESTRA_DESKTOP_E2E=1 \
ORCHESTRA_DESKTOP_E2E_PACKAGED_VALIDATION=1 \
ORCHESTRA_PACKAGED_RUNTIME_EXPECT_PROMPT_SUCCESS="${EXPECT_PROMPT_SUCCESS}" \
ORCHESTRA_TAURI_BINARY="${WRAPPER_PATH}" \
ORCHESTRA_TEST_HOME="${TEST_HOME}" \
ORCHESTRA_WEBDRIVER_URL="http://127.0.0.1:${WEBDRIVER_PORT}" \
ORCHESTRA_PACKAGED_RUNTIME_APP_BINARY="${APP_BINARY}" \
npx vitest run "${TEST_FILE}"

if [[ -s "${PATH_TRAP_LOG}" ]]; then
  echo "Packaged app attempted to invoke PATH-discovered pi/node/npm/bun during validation:" >&2
  cat "${PATH_TRAP_LOG}" >&2
  exit 1
fi

echo "[packaged-runtime-validation] validation passed" >&2
