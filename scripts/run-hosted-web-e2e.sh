#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${ORCHESTRA_HOSTED_WEB_E2E_PORT:-4175}"
export ORCHESTRA_HOSTED_WEB_E2E_PORT="$PORT"
export ORCHESTRA_HOSTED_WEB_E2E_ROOT="${ORCHESTRA_HOSTED_WEB_E2E_ROOT:-$ROOT_DIR/dist}"
export ORCHESTRA_STORAGE_ROOT="${ORCHESTRA_STORAGE_ROOT:-$ROOT_DIR/.tmp/hosted-web-e2e-runtime}"

existing_listener_pids="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "$existing_listener_pids" ]]; then
  echo "Stopping stale hosted-web E2E listeners on port $PORT: $existing_listener_pids"
  kill $existing_listener_pids 2>/dev/null || true
  sleep 1
fi

rm -rf "$ORCHESTRA_STORAGE_ROOT"
mkdir -p "$ORCHESTRA_STORAGE_ROOT"

VITE_ORCHESTRA_HOST_MODE=hosted_web npm run build
cargo run --quiet --manifest-path src-tauri/Cargo.toml --bin hosted_web_e2e_server
