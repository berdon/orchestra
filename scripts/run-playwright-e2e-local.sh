#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

HARNESS="${1:-}"
if [[ -z "${HARNESS}" ]]; then
  echo "Usage: $0 <browser|hosted-web|web-driver> [playwright args...]" >&2
  exit 1
fi
shift || true

case "${HARNESS}" in
  browser)
    CONFIG_PATH="playwright.config.ts"
    ;;
  hosted-web)
    CONFIG_PATH="playwright.hosted-web.config.ts"
    ;;
  web-driver)
    CONFIG_PATH="playwright.web-driver.config.ts"
    ;;
  *)
    echo "Unsupported Playwright E2E harness: ${HARNESS}" >&2
    exit 1
    ;;
esac

positional_args=()
option_args=()
for arg in "$@"; do
  if [[ "${arg}" == tests/* ]]; then
    positional_args+=("${arg}")
  else
    option_args+=("${arg}")
  fi
done

if (( ${#positional_args[@]} == 0 )); then
  AUTO_TEST_FILES=()
  while IFS= read -r test_file; do
    [[ -n "${test_file}" ]] || continue
    AUTO_TEST_FILES+=("${test_file}")
  done < <(node "${ROOT_DIR}/scripts/e2e-suite.mjs" --harness "${HARNESS}")
  if (( ${#AUTO_TEST_FILES[@]} == 0 )); then
    echo "No ${HARNESS} E2E specs were discovered by tests/e2e-suite.json" >&2
    exit 1
  fi
  positional_args=("${AUTO_TEST_FILES[@]}")
fi

exec npx playwright test --config "${CONFIG_PATH}" "${option_args[@]}" "${positional_args[@]}"
