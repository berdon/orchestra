#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${ORCHESTRA_HOSTED_WEB_E2E_PORT:-4175}"
export ORCHESTRA_HOSTED_WEB_E2E_PORT="$PORT"
export ORCHESTRA_HOSTED_WEB_E2E_ROOT="${ORCHESTRA_HOSTED_WEB_E2E_ROOT:-$ROOT_DIR/dist}"

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Hosted-web E2E port ${PORT} is already in use. Set ORCHESTRA_HOSTED_WEB_E2E_PORT to an unused port before retrying." >&2
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2 || true
  exit 1
fi

if [[ -z "${ORCHESTRA_STORAGE_ROOT:-}" ]]; then
  RUNTIME_PARENT="$ROOT_DIR/.tmp/hosted-web-e2e"
  mkdir -p "$RUNTIME_PARENT"
  export ORCHESTRA_STORAGE_ROOT="$(mktemp -d "${RUNTIME_PARENT}/runtime-XXXXXX")"
fi

rm -rf "$ORCHESTRA_STORAGE_ROOT"
mkdir -p "$ORCHESTRA_STORAGE_ROOT"

npm run build:hosted-web
cargo run --quiet --manifest-path src-tauri/Cargo.toml --bin hosted_web_e2e_server
