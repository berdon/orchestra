#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JOBS="${E2E_JOBS:-1}"
LOG_ROOT="${ROOT_DIR}/.tmp/e2e"
mkdir -p "${LOG_ROOT}"
SUITE_RUN_DIR="$(mktemp -d "${LOG_ROOT}/suite-podman-XXXXXX")"
SCRIPT_LOG="${SUITE_RUN_DIR}/suite.log"

if ! [[ "${JOBS}" =~ ^[0-9]+$ ]] || (( JOBS < 1 )); then
  echo "E2E_JOBS must be a positive integer. Got: ${JOBS}" >&2
  exit 1
fi

desktop_specs=""
browser_specs=""
hosted_web_specs=""
web_driver_specs=""
option_args=()

append_spec() {
  local harness="$1"
  local spec="$2"
  case "${harness}" in
    desktop)
      if [[ -z "${desktop_specs}" ]]; then desktop_specs="${spec}"; else desktop_specs+=$'\n'"${spec}"; fi
      ;;
    browser)
      if [[ -z "${browser_specs}" ]]; then browser_specs="${spec}"; else browser_specs+=$'\n'"${spec}"; fi
      ;;
    hosted-web)
      if [[ -z "${hosted_web_specs}" ]]; then hosted_web_specs="${spec}"; else hosted_web_specs+=$'\n'"${spec}"; fi
      ;;
    web-driver)
      if [[ -z "${web_driver_specs}" ]]; then web_driver_specs="${spec}"; else web_driver_specs+=$'\n'"${spec}"; fi
      ;;
    *)
      echo "Unsupported harness: ${harness}" >&2
      exit 1
      ;;
  esac
}

specs_for_harness() {
  local harness="$1"
  case "${harness}" in
    desktop)
      printf '%s' "${desktop_specs}"
      ;;
    browser)
      printf '%s' "${browser_specs}"
      ;;
    hosted-web)
      printf '%s' "${hosted_web_specs}"
      ;;
    web-driver)
      printf '%s' "${web_driver_specs}"
      ;;
    *)
      echo "Unsupported harness: ${harness}" >&2
      exit 1
      ;;
  esac
}

for arg in "$@"; do
  case "${arg}" in
    tests/desktop-e2e/*)
      append_spec desktop "${arg}"
      ;;
    tests/e2e/*)
      append_spec browser "${arg}"
      ;;
    tests/hosted-web-e2e/*)
      append_spec hosted-web "${arg}"
      ;;
    tests/web-driver-e2e/*)
      append_spec web-driver "${arg}"
      ;;
    *)
      option_args+=("${arg}")
      ;;
  esac
done

selected_harnesses=()
for harness in desktop browser hosted-web web-driver; do
  if [[ -n "$(specs_for_harness "${harness}")" ]]; then
    selected_harnesses+=("${harness}")
  fi
done

if (( ${#selected_harnesses[@]} == 0 )); then
  if (( ${#option_args[@]} > 0 )); then
    echo "[e2e-suite] routing option-only invocation to the browser harness for backwards compatibility; use npm run test:e2e:browser for clarity." | tee -a "${SCRIPT_LOG}" >&2
    exec "${ROOT_DIR}/scripts/run-playwright-e2e-podman.sh" browser "${option_args[@]}"
  fi
  selected_harnesses=(desktop browser hosted-web web-driver)
fi

if (( ${#option_args[@]} > 0 )); then
  for harness in "${selected_harnesses[@]}"; do
    if [[ "${harness}" == "desktop" ]]; then
      echo "The desktop harness does not support forwarded Playwright CLI options through npm run test:e2e. Use npm run test:e2e:desktop with explicit test files instead." >&2
      exit 1
    fi
  done
fi

LAUNCHED_PIDS=()
LAUNCHED_HARNESSES=()
LAUNCHED_LOGS=()
FAILURES=0

cleanup() {
  local pid
  for pid in "${LAUNCHED_PIDS[@]:-}"; do
    if [[ -n "${pid}" ]] && kill -0 "${pid}" >/dev/null 2>&1; then
      kill -TERM "${pid}" >/dev/null 2>&1 || true
    fi
  done

  for pid in "${LAUNCHED_PIDS[@]:-}"; do
    if [[ -n "${pid}" ]]; then
      wait "${pid}" 2>/dev/null || true
    fi
  done
}

trap cleanup EXIT INT TERM

launch_harness() {
  local harness="$1"
  local harness_log="${SUITE_RUN_DIR}/${harness}.log"
  local -a command=()
  local harness_specs="$(specs_for_harness "${harness}")"

  case "${harness}" in
    desktop)
      command=("${ROOT_DIR}/scripts/run-desktop-e2e-suite-podman.sh")
      ;;
    browser|web-driver)
      command=("${ROOT_DIR}/scripts/run-playwright-e2e-podman.sh" "${harness}")
      ;;
    hosted-web)
      command=("${ROOT_DIR}/scripts/run-playwright-e2e-suite-podman.sh" "${harness}")
      ;;
    *)
      echo "Unsupported harness: ${harness}" >&2
      exit 1
      ;;
  esac

  if (( ${#option_args[@]} > 0 )); then
    command+=("${option_args[@]}")
  fi

  if [[ -n "${harness_specs}" ]]; then
    while IFS= read -r spec; do
      [[ -n "${spec}" ]] || continue
      command+=("${spec}")
    done <<< "${harness_specs}"
  fi

  echo "==> Running supported ${harness} E2E via Podman" | tee -a "${SCRIPT_LOG}"
  (
    cd "${ROOT_DIR}"
    "${command[@]}"
  ) >"${harness_log}" 2>&1 &

  LAUNCHED_PIDS+=("$!")
  LAUNCHED_HARNESSES+=("${harness}")
  LAUNCHED_LOGS+=("${harness_log}")
}

rebuild_active_arrays() {
  local keep_pids=()
  local keep_harnesses=()
  local keep_logs=()
  local index
  for index in "${!LAUNCHED_PIDS[@]}"; do
    if [[ -n "${LAUNCHED_PIDS[$index]}" ]]; then
      keep_pids+=("${LAUNCHED_PIDS[$index]}")
      keep_harnesses+=("${LAUNCHED_HARNESSES[$index]}")
      keep_logs+=("${LAUNCHED_LOGS[$index]}")
    fi
  done
  LAUNCHED_PIDS=()
  LAUNCHED_HARNESSES=()
  LAUNCHED_LOGS=()
  if (( ${#keep_pids[@]} > 0 )); then
    LAUNCHED_PIDS=("${keep_pids[@]}")
    LAUNCHED_HARNESSES=("${keep_harnesses[@]}")
    LAUNCHED_LOGS=("${keep_logs[@]}")
  fi
}

wait_for_one_completion() {
  local index
  local pid
  local harness
  local harness_log
  while true; do
    for index in "${!LAUNCHED_PIDS[@]}"; do
      pid="${LAUNCHED_PIDS[$index]}"
      harness="${LAUNCHED_HARNESSES[$index]}"
      harness_log="${LAUNCHED_LOGS[$index]}"
      if kill -0 "${pid}" >/dev/null 2>&1; then
        continue
      fi

      if wait "${pid}"; then
        echo "PASS ${harness}" | tee -a "${SCRIPT_LOG}"
      else
        FAILURES=$((FAILURES + 1))
        echo "FAIL ${harness} (log: ${harness_log})" | tee -a "${SCRIPT_LOG}"
        tail -n 80 "${harness_log}" >&2 || true
      fi

      unset 'LAUNCHED_PIDS[$index]'
      unset 'LAUNCHED_HARNESSES[$index]'
      unset 'LAUNCHED_LOGS[$index]'
      rebuild_active_arrays
      return
    done
    sleep 1
  done
}

for harness in "${selected_harnesses[@]}"; do
  while (( ${#LAUNCHED_PIDS[@]} >= JOBS )); do
    wait_for_one_completion
  done
  launch_harness "${harness}"
done

while (( ${#LAUNCHED_PIDS[@]} > 0 )); do
  wait_for_one_completion
done

if (( FAILURES > 0 )); then
  echo "[e2e-suite-podman] completed with ${FAILURES} failure(s). Logs: ${SUITE_RUN_DIR}" >&2
  exit 1
fi

echo "[e2e-suite-podman] all requested harnesses passed. Logs: ${SUITE_RUN_DIR}" | tee -a "${SCRIPT_LOG}"
