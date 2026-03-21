#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "$#" -eq 0 ]]; then
  echo "Usage: $0 <test-file> [<test-file> ...]" >&2
  exit 1
fi

for test_file in "$@"; do
  echo "==> Running desktop E2E in isolated harness: ${test_file}"
  "${ROOT_DIR}/scripts/run-desktop-e2e.sh" "${test_file}"
  sleep 1
done
