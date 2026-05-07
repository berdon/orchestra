#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_NAME="${ORCHESTRA_DESKTOP_E2E_IMAGE:-orchestra-desktop-e2e:latest}"
IMAGE_HASH_LABEL="org.orchestra.desktop-e2e.input-hash"

compute_image_input_hash() {
  sha256sum \
    "${ROOT_DIR}/Containerfile.desktop-e2e" \
    "${ROOT_DIR}/package.json" \
    "${ROOT_DIR}/package-lock.json" \
    "${ROOT_DIR}/mobile/package.json" \
    "${ROOT_DIR}/mobile/package-lock.json" \
    | sha256sum \
    | awk '{print $1}'
}

EXPECTED_HASH="$(compute_image_input_hash)"
EXISTING_HASH=""
if podman image exists "${IMAGE_NAME}"; then
  EXISTING_HASH="$(podman image inspect --format "{{ index .Config.Labels \"${IMAGE_HASH_LABEL}\" }}" "${IMAGE_NAME}" 2>/dev/null || true)"
fi

if [[ "${ORCHESTRA_DESKTOP_E2E_REBUILD:-0}" != "1" ]] && [[ -n "${EXISTING_HASH}" ]] && [[ "${EXISTING_HASH}" == "${EXPECTED_HASH}" ]]; then
  echo "Reusing existing desktop E2E image: ${IMAGE_NAME}"
  exit 0
fi

if [[ -n "${EXISTING_HASH}" ]] && [[ "${EXISTING_HASH}" != "${EXPECTED_HASH}" ]]; then
  echo "Rebuilding desktop E2E image because the image inputs changed."
fi

podman build \
  --label "${IMAGE_HASH_LABEL}=${EXPECTED_HASH}" \
  --tag "${IMAGE_NAME}" \
  --file "${ROOT_DIR}/Containerfile.desktop-e2e" \
  "${ROOT_DIR}"
