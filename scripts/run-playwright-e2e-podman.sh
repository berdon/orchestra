#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_NAME="${ORCHESTRA_DESKTOP_E2E_IMAGE:-orchestra-desktop-e2e:latest}"
HARNESS="${1:-}"
TARGET_VOLUME_NAME=""

if [[ -z "${HARNESS}" ]]; then
  echo "Usage: $0 <browser|hosted-web|web-driver> [playwright args...]" >&2
  exit 1
fi
shift || true

case "${HARNESS}" in
  browser|hosted-web|web-driver)
    TARGET_VOLUME_NAME="orchestra-${HARNESS}-e2e-target"
    ;;
  *)
    echo "Unsupported Playwright E2E harness: ${HARNESS}" >&2
    exit 1
    ;;
esac

"${ROOT_DIR}/scripts/build-desktop-e2e-image.sh"

RUN_ID="$(date +%s)-$RANDOM"
CONTAINER_NAME="orchestra-${HARNESS}-e2e-${RUN_ID}"
HOST_PI_DIR="${HOME}/.pi"
HOST_CODEX_DIR="${HOME}/.codex"
SEED_MOUNT_ARGS=()
if [[ -d "${HOST_PI_DIR}" ]]; then
  SEED_MOUNT_ARGS+=( -v "${HOST_PI_DIR}:/seed-home/.pi:ro" )
fi
if [[ -d "${HOST_CODEX_DIR}" ]]; then
  SEED_MOUNT_ARGS+=( -v "${HOST_CODEX_DIR}:/seed-home/.codex:ro" )
fi

podman run --rm \
  --name "${CONTAINER_NAME}" \
  --security-opt label=disable \
  -v "${ROOT_DIR}:/src:ro" \
  -v orchestra-desktop-e2e-cargo-registry:/root/.cargo/registry \
  -v orchestra-desktop-e2e-cargo-git:/root/.cargo/git \
  -v orchestra-desktop-e2e-npm-cache:/root/.npm \
  -v "${TARGET_VOLUME_NAME}:/workspace-target" \
  "${SEED_MOUNT_ARGS[@]}" \
  --workdir /workspace \
  "${IMAGE_NAME}" \
  bash /src/scripts/run-playwright-e2e-container-entry.sh "${HARNESS}" "$@"
