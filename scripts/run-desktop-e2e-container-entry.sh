#!/usr/bin/env bash
set -euo pipefail
set -x

TEST_FILE="${1:-}"
if [[ -z "${TEST_FILE}" ]]; then
  echo "container-entry: missing test file argument" >&2
  exit 1
fi

echo "[desktop-e2e] container entry starting"
echo "[desktop-e2e] pwd=$(pwd)"
echo "[desktop-e2e] test_file=${TEST_FILE}"

WORKSPACE_ROOT="/tmp/workspace"
WORKSPACE_DIR="${WORKSPACE_ROOT}/orchestra"

echo "[desktop-e2e] preparing workspace copy"
rm -rf "${WORKSPACE_ROOT}"
mkdir -p "${WORKSPACE_DIR}/src-tauri"
cp -a /src/package.json /src/package-lock.json /src/index.html /src/tsconfig.json /src/vite.config.ts /src/playwright.config.ts /src/README.md /src/.gitignore "${WORKSPACE_DIR}/"
cp -a /src/node_modules "${WORKSPACE_DIR}/node_modules"
cp -a /src/src "${WORKSPACE_DIR}/src"
cp -a /src/tests "${WORKSPACE_DIR}/tests"
cp -a /src/scripts "${WORKSPACE_DIR}/scripts"
cp -a /src/extensions "${WORKSPACE_DIR}/extensions"
cp -a /src/docs "${WORKSPACE_DIR}/docs"
cp -a /src/dist "${WORKSPACE_DIR}/dist"
cp -a /src/src-tauri/Cargo.toml /src/src-tauri/Cargo.lock /src/src-tauri/build.rs /src/src-tauri/tauri.conf.json "${WORKSPACE_DIR}/src-tauri/"
cp -a /src/src-tauri/src "${WORKSPACE_DIR}/src-tauri/src"
cp -a /src/src-tauri/icons "${WORKSPACE_DIR}/src-tauri/icons"
cp -a /src/src-tauri/gen "${WORKSPACE_DIR}/src-tauri/gen"

mkdir -p /root
if [[ -d /seed-home/.pi ]]; then
  echo "[desktop-e2e] wiring writable .pi copy"
  rm -rf /root/.pi
  cp -a /seed-home/.pi /root/.pi
fi
if [[ -d /seed-home/.codex ]]; then
  echo "[desktop-e2e] wiring writable .codex copy"
  rm -rf /root/.codex
  cp -a /seed-home/.codex /root/.codex
fi

mkdir -p "${WORKSPACE_DIR}/.tmp/desktop-e2e"
mkdir -p "${WORKSPACE_DIR}/.tmp/desktop-e2e/shared-home/workspace/workflow-lifecycle-repo/repository"
mkdir -p "${WORKSPACE_DIR}/.tmp/desktop-e2e/shared-home/workspace/dispatch-repo/repository"
cd "${WORKSPACE_DIR}/.tmp/desktop-e2e/shared-home/workspace/workflow-lifecycle-repo/repository"
git init -b main >/dev/null 2>&1
git config user.email desktop-e2e@example.invalid >/dev/null 2>&1
git config user.name "Desktop E2E" >/dev/null 2>&1
if [[ ! -f README.md ]]; then
  echo "workflow lifecycle repo" > README.md
  git add README.md >/dev/null 2>&1
  git commit -m "init" >/dev/null 2>&1 || true
fi
cd "${WORKSPACE_DIR}/.tmp/desktop-e2e/shared-home/workspace/dispatch-repo/repository"
git init -b main >/dev/null 2>&1
git config user.email desktop-e2e@example.invalid >/dev/null 2>&1
git config user.name "Desktop E2E" >/dev/null 2>&1
if [[ ! -f README.md ]]; then
  echo "dispatch repo" > README.md
  git add README.md >/dev/null 2>&1
  git commit -m "init" >/dev/null 2>&1 || true
fi
cd "${WORKSPACE_DIR}"

cd "${WORKSPACE_DIR}"
echo "[desktop-e2e] workspace ready pwd=$(pwd)"
node -v
npm -v
cargo --version
tauri-driver --help >/dev/null
WebKitWebDriver --help >/dev/null

HOST_BUILD_ROOT="/build"
HOST_BINARY_PATH="${HOST_BUILD_ROOT}/src-tauri/target/debug/orchestra"
if [[ ! -x "${HOST_BINARY_PATH}" ]]; then
  echo "[desktop-e2e] expected host-built binary is missing: ${HOST_BINARY_PATH}" >&2
  exit 1
fi
mkdir -p "${WORKSPACE_DIR}/src-tauri/target/debug"
ln -s "${HOST_BINARY_PATH}" "${WORKSPACE_DIR}/src-tauri/target/debug/orchestra"

XVFB_DISPLAY=":99"
XVFB_LOG="/tmp/xvfb.log"

echo "[desktop-e2e] launching Xvfb on ${XVFB_DISPLAY}"
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
  echo "[desktop-e2e] Xvfb failed to start" >&2
  cat "${XVFB_LOG}" >&2 || true
  exit 1
fi

export DISPLAY="${XVFB_DISPLAY}"
export ORCHESTRA_TAURI_BINARY="${HOST_BINARY_PATH}"
export ORCHESTRA_PROJECT_ROOT="${WORKSPACE_DIR}"
export ORCHESTRA_PI_EXECUTABLE="/workspace/orchestra/node_modules/.bin/pi"
echo "[desktop-e2e] launching isolated desktop harness with DISPLAY=${DISPLAY} binary=${ORCHESTRA_TAURI_BINARY} project_root=${ORCHESTRA_PROJECT_ROOT} pi=${ORCHESTRA_PI_EXECUTABLE}"
./scripts/run-desktop-e2e.sh "${TEST_FILE}"
