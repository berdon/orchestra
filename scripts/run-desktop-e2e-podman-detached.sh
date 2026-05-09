#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_NAME="${ORCHESTRA_DESKTOP_E2E_IMAGE:-orchestra-desktop-e2e:latest}"
PRESERVE_LOGS="${ORCHESTRA_DESKTOP_E2E_PRESERVE_LOGS:-0}"
TEST_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --preserve-logs)
      PRESERVE_LOGS="1"
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [--preserve-logs] <test-file>" >&2
      exit 0
      ;;
    *)
      TEST_FILE="$1"
      shift
      ;;
  esac
done

if [[ -z "${TEST_FILE}" ]]; then
  echo "Usage: $0 [--preserve-logs] <test-file>" >&2
  exit 1
fi

"${ROOT_DIR}/scripts/build-desktop-e2e-image.sh" >&2

RUN_ID="$(date +%s)-$RANDOM"
CONTAINER_NAME="orchestra-desktop-e2e-${RUN_ID}"
HOST_PI_DIR="${HOME}/.pi"
HOST_CODEX_DIR="${HOME}/.codex"
HOST_ORCHESTRA_PI_AGENT_DIR="${HOME}/.orchestra/runtime/pi/agent"
LOG_DIR="${ROOT_DIR}/.tmp/desktop-e2e/podman-logs"
mkdir -p "${LOG_DIR}"
SEED_MOUNT_ARGS=()
if [[ -d "${HOST_PI_DIR}" ]]; then
  SEED_MOUNT_ARGS+=( -v "${HOST_PI_DIR}:/seed-home/.pi:ro" )
fi
if [[ -d "${HOST_CODEX_DIR}" ]]; then
  SEED_MOUNT_ARGS+=( -v "${HOST_CODEX_DIR}:/seed-home/.codex:ro" )
fi
if [[ -d "${HOST_ORCHESTRA_PI_AGENT_DIR}" ]]; then
  SEED_MOUNT_ARGS+=( -v "${HOST_ORCHESTRA_PI_AGENT_DIR}:/seed-home/.orchestra/runtime/pi/agent:ro" )
fi

CID_FILE="${LOG_DIR}/${CONTAINER_NAME}.cid"
STATUS_FILE="${LOG_DIR}/${CONTAINER_NAME}.status"
LOG_FILE="${LOG_DIR}/${CONTAINER_NAME}.log"
NAME_FILE="${LOG_DIR}/${CONTAINER_NAME}.name"
rm -f "${CID_FILE}" "${STATUS_FILE}" "${LOG_FILE}" "${NAME_FILE}"
printf '%s\n' "${CONTAINER_NAME}" > "${NAME_FILE}"

RUN_ARGS=(
  -d
  --name "${CONTAINER_NAME}"
  --cidfile "${CID_FILE}"
  --security-opt label=disable
  -v "${ROOT_DIR}:/src:ro"
  -v "${ROOT_DIR}:/build:ro"
  -v orchestra-desktop-e2e-cargo-registry:/root/.cargo/registry
  -v orchestra-desktop-e2e-cargo-git:/root/.cargo/git
  -v orchestra-desktop-e2e-npm-cache:/root/.npm
  -v orchestra-desktop-e2e-target:/workspace-target
  "${SEED_MOUNT_ARGS[@]}"
  --workdir /workspace
)

if [[ "${PRESERVE_LOGS}" != "1" ]]; then
  RUN_ARGS+=(--rm)
fi

CID="$(podman run "${RUN_ARGS[@]}" \
  "${IMAGE_NAME}" \
  bash /src/scripts/run-desktop-e2e-container-entry.sh "${TEST_FILE}")"

echo "${CONTAINER_NAME}"
echo "${CID}"
(
  podman logs -f "${CONTAINER_NAME}" >"${LOG_FILE}" 2>&1 || podman logs -f "${CID}" >"${LOG_FILE}" 2>&1 || true
) >/dev/null 2>&1 &
(
  status="1"
  if status="$(podman wait "${CID}" 2>/dev/null | tail -n1)"; then
    :
  else
    status="1"
  fi
  printf '%s\n' "${status}" >"${STATUS_FILE}"
) >/dev/null 2>&1 &
