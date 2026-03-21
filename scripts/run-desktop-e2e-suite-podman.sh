#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JOBS="${DESKTOP_E2E_JOBS:-$(nproc)}"

if [[ "$#" -eq 0 ]]; then
  echo "Usage: $0 <test-file> [<test-file> ...]" >&2
  exit 1
fi

"${ROOT_DIR}/scripts/build-desktop-e2e-image.sh"

running=0
pids=()

run_one() {
  local test_file="$1"
  echo "==> Running desktop E2E in isolated container: ${test_file}"
  "${ROOT_DIR}/scripts/run-desktop-e2e-podman.sh" "${test_file}"
}

for test_file in "$@"; do
  run_one "${test_file}" &
  pids+=("$!")
  running=$((running + 1))

  if (( running >= JOBS )); then
    wait -n
    running=$((running - 1))
  fi
done

wait
