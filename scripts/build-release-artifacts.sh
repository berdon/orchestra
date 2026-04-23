#!/bin/bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

if [[ -f "$HOME/.cargo/env" ]]; then
  # shellcheck disable=SC1090
  source "$HOME/.cargo/env"
fi

canonical_path() {
  python3 - <<'PY' "$1"
import os
import sys
print(os.path.realpath(sys.argv[1]))
PY
}

append_remap() {
  local from="$1"
  local to="$2"
  if [[ -n "$from" && -e "$from" ]]; then
    remap_flags+=("--remap-path-prefix=$(canonical_path "$from")=$to")
  fi
}

regex_escape() {
  python3 - <<'PY' "$1"
import re
import sys
print(re.escape(sys.argv[1]))
PY
}

repo_root="$(canonical_path "$repo_root")"
home_path="${HOME:-}"
cargo_home="${CARGO_HOME:-${HOME:-}/.cargo}"
rustup_home="${RUSTUP_HOME:-${HOME:-}/.rustup}"

remap_flags=()
append_remap "$repo_root" "/workspace/orchestra"
append_remap "$home_path" "/workspace/home"
append_remap "$cargo_home" "/workspace/cargo-home"
append_remap "$rustup_home" "/workspace/rustup-home"

extra_rustflags="${RUSTFLAGS:-}"
for flag in "${remap_flags[@]}"; do
  extra_rustflags+=" ${flag}"
done
extra_rustflags="${extra_rustflags# }"

export RUSTFLAGS="$extra_rustflags"
export CARGO_PROFILE_RELEASE_STRIP="symbols"

cd "$repo_root"

echo "🔨 Building Orchestra release artifacts with path remapping"
echo "   repo root: $repo_root"

echo "🦀 Building packaged Tauri release"
(
  cd src-tauri
  cargo tauri build
)

artifact_path="$repo_root/src-tauri/target/release/bundle/macos/Orchestra.app"

echo "🔎 Scanning packaged artifacts"
"$repo_root/scripts/scan-artifact-leaks.sh" \
  --artifact "$artifact_path" \
  --pattern "$(regex_escape "$repo_root")"

echo "✅ Release artifacts are built and sanitized"
echo "   app bundle: $artifact_path"
