#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_NAME="${ORCHESTRA_DESKTOP_E2E_IMAGE:-orchestra-desktop-e2e:latest}"
TEST_FILE="${1:-}"

if [[ -z "${TEST_FILE}" ]]; then
  echo "Usage: $0 <test-file>" >&2
  exit 1
fi

"${ROOT_DIR}/scripts/build-desktop-e2e-image.sh"

RUN_ID="$(date +%s)-$RANDOM"
CONTAINER_NAME="orchestra-desktop-e2e-${RUN_ID}"
HOST_PI_DIR="${HOME}/.pi"
PI_MOUNT_ARGS=()
if [[ -d "${HOST_PI_DIR}" ]]; then
  PI_MOUNT_ARGS=(-v "${HOST_PI_DIR}:/seed-home/.pi:ro")
fi

podman run --rm \
  --name "${CONTAINER_NAME}" \
  --security-opt label=disable \
  -v "${ROOT_DIR}:/src:ro" \
  -v "${ROOT_DIR}:/build:ro" \
  -v orchestra-desktop-e2e-cargo-registry:/root/.cargo/registry \
  -v orchestra-desktop-e2e-cargo-git:/root/.cargo/git \
  -v orchestra-desktop-e2e-npm-cache:/root/.npm \
  "${PI_MOUNT_ARGS[@]}" \
  --workdir /workspace \
  "${IMAGE_NAME}" \
  bash /src/scripts/run-desktop-e2e-container-entry.sh "${TEST_FILE}"
