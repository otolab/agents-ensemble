#!/usr/bin/env bash
# Deprecated compatibility entrypoint. Keep cached-auth.mjs beside this file.
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "cached-auth.sh: Node.js is required; use cached-auth.mjs" >&2
  exit 127
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$script_dir/cached-auth.mjs" "$@"
