#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PINNED_VERSION="${GITLEAKS_VERSION:-8.24.2}"
CACHE_DIR="${ROOT_DIR}/.tmp/tools/gitleaks/${PINNED_VERSION}"
CACHED_BIN="${CACHE_DIR}/gitleaks"

if [[ -n "${GITLEAKS_BIN:-}" ]]; then
  if [[ ! -x "${GITLEAKS_BIN}" ]]; then
    echo "GITLEAKS_BIN is set but not executable: ${GITLEAKS_BIN}" >&2
    exit 1
  fi
  printf '%s\n' "${GITLEAKS_BIN}"
  exit 0
fi

if [[ -x "${CACHED_BIN}" ]]; then
  printf '%s\n' "${CACHED_BIN}"
  exit 0
fi

SYSTEM_BIN="$(command -v gitleaks || true)"
if [[ -n "${SYSTEM_BIN}" ]]; then
  SYSTEM_VERSION="$(${SYSTEM_BIN} version 2>/dev/null || true)"
  if grep -q "${PINNED_VERSION}" <<<"${SYSTEM_VERSION}"; then
    printf '%s\n' "${SYSTEM_BIN}"
    exit 0
  fi
fi

OS_NAME="$(uname -s)"
ARCH_NAME="$(uname -m)"
case "${OS_NAME}" in
  Darwin)
    PLATFORM="darwin"
    ;;
  Linux)
    PLATFORM="linux"
    ;;
  *)
    echo "Unsupported OS for automatic gitleaks bootstrap: ${OS_NAME}" >&2
    if [[ -n "${SYSTEM_BIN}" ]]; then
      echo "Falling back to system gitleaks at ${SYSTEM_BIN}" >&2
      printf '%s\n' "${SYSTEM_BIN}"
      exit 0
    fi
    exit 1
    ;;
esac

case "${ARCH_NAME}" in
  x86_64|amd64)
    ARCHIVE_ARCH="x64"
    ;;
  arm64|aarch64)
    ARCHIVE_ARCH="arm64"
    ;;
  *)
    echo "Unsupported architecture for automatic gitleaks bootstrap: ${ARCH_NAME}" >&2
    if [[ -n "${SYSTEM_BIN}" ]]; then
      echo "Falling back to system gitleaks at ${SYSTEM_BIN}" >&2
      printf '%s\n' "${SYSTEM_BIN}"
      exit 0
    fi
    exit 1
    ;;
esac

ARCHIVE_NAME="gitleaks_${PINNED_VERSION}_${PLATFORM}_${ARCHIVE_ARCH}.tar.gz"
DOWNLOAD_URL="https://github.com/gitleaks/gitleaks/releases/download/v${PINNED_VERSION}/${ARCHIVE_NAME}"
TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

mkdir -p "${CACHE_DIR}"

echo "[guardrails] downloading gitleaks ${PINNED_VERSION} from ${DOWNLOAD_URL}" >&2
if ! curl -fsSL "${DOWNLOAD_URL}" -o "${TMP_DIR}/${ARCHIVE_NAME}"; then
  echo "Failed to download pinned gitleaks ${PINNED_VERSION}." >&2
  if [[ -n "${SYSTEM_BIN}" ]]; then
    echo "Falling back to system gitleaks at ${SYSTEM_BIN}" >&2
    printf '%s\n' "${SYSTEM_BIN}"
    exit 0
  fi
  exit 1
fi

tar -xzf "${TMP_DIR}/${ARCHIVE_NAME}" -C "${TMP_DIR}"
EXTRACTED_BIN="$(find "${TMP_DIR}" -type f -name gitleaks | head -n 1 || true)"
if [[ -z "${EXTRACTED_BIN}" ]]; then
  echo "Downloaded archive did not contain a gitleaks binary." >&2
  exit 1
fi

install -m 0755 "${EXTRACTED_BIN}" "${CACHED_BIN}"
printf '%s\n' "${CACHED_BIN}"
