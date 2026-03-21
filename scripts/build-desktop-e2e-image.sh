#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_NAME="${ORCHESTRA_DESKTOP_E2E_IMAGE:-orchestra-desktop-e2e:latest}"

if [[ "${ORCHESTRA_DESKTOP_E2E_REBUILD:-0}" != "1" ]] && podman image exists "${IMAGE_NAME}"; then
  echo "Reusing existing desktop E2E image: ${IMAGE_NAME}"
  exit 0
fi

podman build \
  --tag "${IMAGE_NAME}" \
  --file "${ROOT_DIR}/Containerfile.desktop-e2e" \
  "${ROOT_DIR}"
