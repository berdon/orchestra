#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_NAME="${ORCHESTRA_DESKTOP_E2E_IMAGE:-orchestra-desktop-e2e:latest}"
HOST_PI_DIR="${HOME}/.pi"
HOST_CODEX_DIR="${HOME}/.codex"
TRIM_START="${ORCHESTRA_DEMO_VIDEO_TRIM_START:-8}"
TEST_FILE=""
OUTPUT_NAME=""

usage() {
  cat <<EOF
Usage: $0 [--trim-start SECONDS] <desktop-e2e-test-file> <output-name.webm>

Records a real Orchestra desktop E2E flow inside the Podman runner and writes a
trimmed .webm into .tmp/demo-videos/ in the current worktree.

Example:
  $0 --trim-start 10 tests/desktop-e2e/lane-approval.test.ts lane-approval-session-lifecycle.webm
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --trim-start)
      TRIM_START="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -z "${TEST_FILE}" ]]; then
        TEST_FILE="$1"
      elif [[ -z "${OUTPUT_NAME}" ]]; then
        OUTPUT_NAME="$1"
      else
        echo "Unexpected argument: $1" >&2
        usage >&2
        exit 1
      fi
      shift
      ;;
  esac
done

if [[ -z "${TEST_FILE}" || -z "${OUTPUT_NAME}" ]]; then
  usage >&2
  exit 1
fi

if [[ "${OUTPUT_NAME}" != *.webm ]]; then
  echo "Output name must end in .webm" >&2
  exit 1
fi

if [[ ! -f "${ROOT_DIR}/${TEST_FILE}" ]]; then
  echo "Test file not found: ${TEST_FILE}" >&2
  exit 1
fi

mkdir -p "${ROOT_DIR}/.tmp/demo-videos"
RAW_NAME="raw-${OUTPUT_NAME}"
ENTRY_SCRIPT="$(mktemp /tmp/orchestra-record-e2e-XXXXXX.sh)"
cleanup() {
  rm -f "${ENTRY_SCRIPT}"
}
trap cleanup EXIT

cat >"${ENTRY_SCRIPT}" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
set -x

TEST_FILE="${1:-}"
OUTPUT_FILE="${2:-}"
RAW_FILE="${3:-}"
TRIM_START="${4:-8}"
if [[ -z "${TEST_FILE}" || -z "${OUTPUT_FILE}" || -z "${RAW_FILE}" ]]; then
  echo "usage: $0 <test-file> <output-file> <raw-file> [trim-start]" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update >/dev/null
apt-get install -y --no-install-recommends ffmpeg >/dev/null

WORKSPACE_ROOT="/tmp/workspace"
WORKSPACE_DIR="${WORKSPACE_ROOT}/orchestra"
rm -rf "${WORKSPACE_ROOT}"
mkdir -p "${WORKSPACE_DIR}/src-tauri"
cp -a /src/package.json /src/package-lock.json /src/index.html /src/github.html /src/tsconfig.json /src/vite.config.ts /src/playwright.config.ts /src/README.md /src/.gitignore "${WORKSPACE_DIR}/"
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
  rm -rf /root/.pi
  cp -a /seed-home/.pi /root/.pi
fi
if [[ -d /seed-home/.codex ]]; then
  rm -rf /root/.codex
  cp -a /seed-home/.codex /root/.codex
fi

mkdir -p "${WORKSPACE_DIR}/.tmp/desktop-e2e"
for repo in workflow-lifecycle-repo dispatch-repo lane-approval-repo; do
  mkdir -p "${WORKSPACE_DIR}/.tmp/desktop-e2e/shared-home/workspace/${repo}/repository"
  cd "${WORKSPACE_DIR}/.tmp/desktop-e2e/shared-home/workspace/${repo}/repository"
  git init -b main >/dev/null 2>&1
  git config user.email desktop-e2e@example.invalid >/dev/null 2>&1
  git config user.name "Desktop E2E" >/dev/null 2>&1
  if [[ ! -f README.md ]]; then
    echo "${repo}" > README.md
    git add README.md >/dev/null 2>&1
    git commit -m init >/dev/null 2>&1 || true
  fi
done
cd "${WORKSPACE_DIR}"

HOST_BINARY_PATH="/build/src-tauri/target/debug/orchestra"
if [[ ! -x "${HOST_BINARY_PATH}" ]]; then
  echo "Expected host-built binary is missing: ${HOST_BINARY_PATH}" >&2
  exit 1
fi
mkdir -p "${WORKSPACE_DIR}/src-tauri/target/debug"
ln -s "${HOST_BINARY_PATH}" "${WORKSPACE_DIR}/src-tauri/target/debug/orchestra"

XVFB_DISPLAY=":99"
Xvfb "${XVFB_DISPLAY}" -screen 0 1440x920x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!
for _ in $(seq 1 20); do
  if kill -0 "${XVFB_PID}" 2>/dev/null; then
    break
  fi
  sleep 1
done
kill -0 "${XVFB_PID}" 2>/dev/null

export DISPLAY="${XVFB_DISPLAY}"
export ORCHESTRA_TAURI_BINARY="${HOST_BINARY_PATH}"
export ORCHESTRA_PROJECT_ROOT="${WORKSPACE_DIR}"
export ORCHESTRA_PI_EXECUTABLE="/workspace/orchestra/node_modules/.bin/pi"

mkdir -p /artifacts
ffmpeg -y -video_size 1440x920 -framerate 15 -f x11grab -i "${DISPLAY}" -vf format=yuv420p -pix_fmt yuv420p -codec:v libvpx -crf 10 -b:v 1M -deadline good -cpu-used 4 -auto-alt-ref 0 -an "/artifacts/${RAW_FILE}" >/tmp/ffmpeg-record.log 2>&1 &
FFMPEG_PID=$!
sleep 2

cleanup() {
  if [[ -n "${FFMPEG_PID:-}" ]] && kill -0 "${FFMPEG_PID}" 2>/dev/null; then
    kill -INT "${FFMPEG_PID}" 2>/dev/null || true
    wait "${FFMPEG_PID}" 2>/dev/null || true
  fi
  if [[ -n "${XVFB_PID:-}" ]] && kill -0 "${XVFB_PID}" 2>/dev/null; then
    kill "${XVFB_PID}" 2>/dev/null || true
    wait "${XVFB_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

cd "${WORKSPACE_DIR}"
./scripts/run-desktop-e2e.sh "${TEST_FILE}"
sleep 2

ffmpeg -y -ss "${TRIM_START}" -i "/artifacts/${RAW_FILE}" -vf format=yuv420p -pix_fmt yuv420p -codec:v libvpx -crf 10 -b:v 1M -deadline good -cpu-used 4 -auto-alt-ref 0 -an "/artifacts/${OUTPUT_FILE}" >/tmp/ffmpeg-trim.log 2>&1
rm -f "/artifacts/${RAW_FILE}"
SH
chmod +x "${ENTRY_SCRIPT}"

"${ROOT_DIR}/scripts/build-desktop-e2e-image.sh" >/dev/null
cargo build --manifest-path "${ROOT_DIR}/src-tauri/Cargo.toml" >/dev/null

SEED_MOUNT_ARGS=()
if [[ -d "${HOST_PI_DIR}" ]]; then
  SEED_MOUNT_ARGS+=( -v "${HOST_PI_DIR}:/seed-home/.pi:ro" )
fi
if [[ -d "${HOST_CODEX_DIR}" ]]; then
  SEED_MOUNT_ARGS+=( -v "${HOST_CODEX_DIR}:/seed-home/.codex:ro" )
fi

podman run --rm --security-opt label=disable \
  -v "${ROOT_DIR}:/src:ro" \
  -v "${ROOT_DIR}:/build:ro" \
  -v "${ROOT_DIR}/.tmp/demo-videos:/artifacts" \
  -v "${ENTRY_SCRIPT}:/tmp/orchestra-record-e2e.sh:ro" \
  -v orchestra-desktop-e2e-cargo-registry:/root/.cargo/registry \
  -v orchestra-desktop-e2e-cargo-git:/root/.cargo/git \
  -v orchestra-desktop-e2e-npm-cache:/root/.npm \
  "${SEED_MOUNT_ARGS[@]}" \
  --workdir /workspace \
  "${IMAGE_NAME}" \
  bash /tmp/orchestra-record-e2e.sh "${TEST_FILE}" "${OUTPUT_NAME}" "${RAW_NAME}" "${TRIM_START}"

echo "Recorded demo video: ${ROOT_DIR}/.tmp/demo-videos/${OUTPUT_NAME}"