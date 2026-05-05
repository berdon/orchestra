#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${ROOT_DIR}/dist"
STAMP_FILE="${DIST_DIR}/.desktop-e2e-hosted-web.sha256"

compute_frontend_hash() {
  python3 - "${ROOT_DIR}" <<'PY'
import hashlib
import os
import sys

root = sys.argv[1]
hash_obj = hashlib.sha256()

tracked_files = [
    "index.html",
    "github.html",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "vite.config.ts",
]
tracked_dirs = [
    "src",
]

for relative_path in tracked_files:
    absolute_path = os.path.join(root, relative_path)
    if not os.path.isfile(absolute_path):
        continue
    hash_obj.update(relative_path.encode("utf-8"))
    hash_obj.update(b"\0")
    with open(absolute_path, "rb") as handle:
        hash_obj.update(handle.read())

for relative_dir in tracked_dirs:
    absolute_dir = os.path.join(root, relative_dir)
    if not os.path.isdir(absolute_dir):
        continue
    for current_root, dirnames, filenames in os.walk(absolute_dir):
        dirnames.sort()
        filenames.sort()
        for filename in filenames:
            absolute_path = os.path.join(current_root, filename)
            relative_path = os.path.relpath(absolute_path, root)
            hash_obj.update(relative_path.encode("utf-8"))
            hash_obj.update(b"\0")
            with open(absolute_path, "rb") as handle:
                hash_obj.update(handle.read())

print(hash_obj.hexdigest())
PY
}

ensure_preview_assets() {
  local current_hash
  current_hash="$(compute_frontend_hash)"
  local existing_hash=""
  if [[ -f "${STAMP_FILE}" ]]; then
    existing_hash="$(cat "${STAMP_FILE}")"
  fi

  if [[ -f "${DIST_DIR}/index.html" && "${current_hash}" == "${existing_hash}" ]]; then
    return
  fi

  echo "[desktop-e2e] frontend assets are stale or missing; running npm run build:hosted-web"
  cd "${ROOT_DIR}"
  npm run build:hosted-web
  mkdir -p "${DIST_DIR}"
  printf '%s\n' "${current_hash}" > "${STAMP_FILE}"
}

ensure_preview_assets
