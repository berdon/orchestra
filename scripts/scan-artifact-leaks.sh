#!/bin/bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

default_artifact="$repo_root/src-tauri/target/release/bundle/macos/Orchestra.app"

artifacts=()
patterns=(
  '/Users/[A-Za-z0-9._-]+/'
  '/home/[^/]+/(work|workspace|projects|\.orchestra|\.cargo|\.rustup)/'
  '\.orchestra/projects/'
  '\.orchestra/projects/.+/task-workspaces/'
  'auhanson'
  'openclaw'
  '192\.168\.1\.10:49500'
)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --artifact)
      artifacts+=("$2")
      shift 2
      ;;
    --pattern)
      patterns+=("$2")
      shift 2
      ;;
    --help|-h)
      cat <<'EOF'
Usage: scripts/scan-artifact-leaks.sh [--artifact PATH]... [--pattern REGEX]...

Scans packaged Orchestra artifacts for machine-specific or user-specific leak markers.
The default patterns intentionally target real checkout/home/workspace leak shapes rather than
benign generic runtime paths such as `/home/web_user` inside vendored tooling.
Defaults to scanning src-tauri/target/release/bundle/macos/Orchestra.app.
EOF
      exit 0
      ;;
    *)
      artifacts+=("$1")
      shift
      ;;
  esac
done

if [[ ${#artifacts[@]} -eq 0 ]]; then
  artifacts=("$default_artifact")
fi

missing=0
for artifact in "${artifacts[@]}"; do
  if [[ ! -e "$artifact" ]]; then
    echo "Missing artifact: $artifact" >&2
    missing=1
  fi
done
if [[ $missing -ne 0 ]]; then
  exit 1
fi

found=0
for artifact in "${artifacts[@]}"; do
  echo "🔎 Scanning $artifact"
  for pattern in "${patterns[@]}"; do
    if [[ -d "$artifact" ]]; then
      if rg -a -n --hidden --glob '!*.map' --glob '!*.dSYM/**' --glob '!target/**' "$pattern" "$artifact" >/tmp/orchestra-artifact-scan-match.txt 2>/dev/null; then
        echo "Leak pattern matched in bundle (pattern: $pattern):" >&2
        cat /tmp/orchestra-artifact-scan-match.txt >&2
        found=1
      fi
      if [[ -d "$artifact/Contents/MacOS" ]]; then
        while IFS= read -r binary_path; do
          if strings "$binary_path" | rg -n "$pattern" >/tmp/orchestra-artifact-strings-match.txt 2>/dev/null; then
            echo "Leak pattern matched in binary strings (pattern: $pattern, file: $binary_path):" >&2
            cat /tmp/orchestra-artifact-strings-match.txt >&2
            found=1
          fi
        done < <(find "$artifact/Contents/MacOS" -type f)
      fi
    else
      if rg -a -n --hidden "$pattern" "$artifact" >/tmp/orchestra-artifact-scan-match.txt 2>/dev/null; then
        echo "Leak pattern matched (pattern: $pattern):" >&2
        cat /tmp/orchestra-artifact-scan-match.txt >&2
        found=1
      fi
    fi
  done
done

rm -f /tmp/orchestra-artifact-scan-match.txt /tmp/orchestra-artifact-strings-match.txt

if [[ $found -ne 0 ]]; then
  echo "❌ Artifact leak scan failed." >&2
  exit 1
fi

echo "✅ Artifact leak scan passed."
