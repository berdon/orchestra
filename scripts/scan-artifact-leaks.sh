#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[guardrails] scripts/scan-artifact-leaks.sh is deprecated; delegating to scripts/scan-release-artifacts.sh release" >&2
exec "${SCRIPT_DIR}/scan-release-artifacts.sh" release
