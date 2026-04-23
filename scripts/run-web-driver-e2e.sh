#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

if [[ "$#" -eq 0 ]]; then
  exec npx playwright test --config playwright.web-driver.config.ts
fi

positional_args=()
option_args=()

for arg in "$@"; do
  if [[ "${arg}" == --* ]]; then
    option_args+=("${arg}")
  else
    positional_args+=("${arg}")
  fi
done

if (( ${#positional_args[@]} > 0 )); then
  all_desktop_tests=1
  for arg in "${positional_args[@]}"; do
    if [[ "${arg}" != tests/desktop-e2e/* ]]; then
      all_desktop_tests=0
      break
    fi
  done

  if (( all_desktop_tests )); then
    if (( ${#option_args[@]} > 0 )); then
      echo "Desktop webdriver routing only supports explicit desktop test file paths. Unsupported options: ${option_args[*]}" >&2
      exit 1
    fi
    exec "${ROOT_DIR}/scripts/run-desktop-e2e-suite.sh" "${positional_args[@]}"
  fi
fi

exec npx playwright test --config playwright.web-driver.config.ts "$@"
