#!/usr/bin/env bash
# Pi models.json の apiKey: "!…" 用。トークン取得コマンドの stdout を disk にキャッシュする。
# ensemble は Pi の getAuth ごとにこのスクリプトを起動するが、キャッシュ hit 時は内側の
# gcloud 等を実行しない（Codex の refresh_interval_ms と同型の運用）。
set -euo pipefail

DEFAULT_TTL_MS=300000
DEFAULT_CACHE_DIR=".ensemble/pi/cache/auth"
LOCK_NAME=".lock"

usage() {
  cat <<'EOF'
Usage: cached-auth.sh [options] -- <command> [args...]

Options:
  --cache-dir PATH   Cache directory (default: $ENSEMBLE_PI_AUTH_CACHE_DIR or .ensemble/pi/cache/auth)
  --ttl-ms MS        Minimum interval before re-running <command> (default: 300000)
  --cache-key KEY    Cache file basename (default: sha256 of the command line)
  --clear            Delete cache entry for this key and exit
  -h, --help         Show this help

Environment:
  ENSEMBLE_PI_AUTH_CACHE_DIR   Default --cache-dir
  ENSEMBLE_PI_AUTH_CACHE_TTL_MS  Default --ttl-ms

Example (models.json):
  "apiKey": "!/absolute/path/to/agents-ensemble/scripts/pi/cached-auth.sh --ttl-ms 300000 -- gcloud auth print-identity-token --account=you@example.com"
EOF
}

cache_dir="${ENSEMBLE_PI_AUTH_CACHE_DIR:-$DEFAULT_CACHE_DIR}"
ttl_ms="${ENSEMBLE_PI_AUTH_CACHE_TTL_MS:-$DEFAULT_TTL_MS}"
cache_key=""
clear_only=false
command=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cache-dir)
      cache_dir="${2:?}"
      shift 2
      ;;
    --ttl-ms)
      ttl_ms="${2:?}"
      shift 2
      ;;
    --cache-key)
      cache_key="${2:?}"
      shift 2
      ;;
    --clear)
      clear_only=true
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    --)
      shift
      command=("$@")
      break
      ;;
    *)
      echo "cached-auth.sh: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ${#command[@]} -eq 0 ]]; then
  echo "cached-auth.sh: missing command after --" >&2
  usage >&2
  exit 2
fi

if [[ -z "$cache_key" ]]; then
  if command -v shasum >/dev/null 2>&1; then
    cache_key="$(printf '%s\0' "${command[*]}" | shasum -a 256 | awk '{print $1}')"
  else
    cache_key="$(printf '%s\0' "${command[*]}" | sha256sum | awk '{print $1}')"
  fi
fi

mkdir -p "$cache_dir"
chmod 700 "$cache_dir" 2>/dev/null || true

token_path="$cache_dir/$cache_key.token"
meta_path="$cache_dir/$cache_key.meta"
lock_path="$cache_dir/$LOCK_NAME"

if [[ "$clear_only" == true ]]; then
  rm -f "$token_path" "$meta_path"
  exit 0
fi

now_ms() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    python3 -c 'import time; print(int(time.time()*1000))'
  else
    date +%s%3N
  fi
}

jwt_exp_s() {
  local token="$1"
  python3 - "$token" <<'PY' 2>/dev/null || true
import json, sys, base64
token = sys.argv[1].strip()
parts = token.split(".")
if len(parts) < 2:
    raise SystemExit(1)
payload = parts[1]
payload += "=" * (-len(payload) % 4)
data = json.loads(base64.urlsafe_b64decode(payload))
exp = data.get("exp")
if isinstance(exp, int):
    print(exp)
PY
}

cache_valid() {
  [[ -f "$token_path" && -f "$meta_path" ]] || return 1
  local fetched_at_ms
  fetched_at_ms="$(cat "$meta_path")"
  local now
  now="$(now_ms)"
  if [[ "$ttl_ms" -gt 0 && "$((now - fetched_at_ms))" -lt "$ttl_ms" ]]; then
    return 0
  fi
  local token exp now_s skew=300
  token="$(<"$token_path")"
  exp="$(jwt_exp_s "$token")"
  if [[ -n "$exp" ]]; then
    now_s="$(date +%s)"
    if [[ "$exp" -gt "$((now_s + skew))" ]]; then
      return 0
    fi
  fi
  return 1
}

run_locked() {
  local lock_fd=9
  exec {lock_fd}>"$lock_path"
  if ! flock -w 60 "$lock_fd"; then
    echo "cached-auth.sh: could not acquire cache lock" >&2
    exit 1
  fi
  if cache_valid; then
    cat "$token_path"
    return 0
  fi
  local out
  if ! out="$("${command[@]}")"; then
    echo "cached-auth.sh: command failed: ${command[*]}" >&2
    exit 1
  fi
  out="$(printf '%s' "$out" | tr -d '\n\r' | sed -e 's/[[:space:]]*$//')"
  if [[ -z "$out" ]]; then
    echo "cached-auth.sh: command produced empty stdout" >&2
    exit 1
  fi
  umask 077
  printf '%s' "$out" >"$token_path"
  now_ms >"$meta_path"
  chmod 600 "$token_path" "$meta_path" 2>/dev/null || true
  printf '%s' "$out"
}

if cache_valid; then
  cat "$token_path"
  exit 0
fi

if command -v flock >/dev/null 2>&1; then
  run_locked
else
  # macOS without flock: best-effort (parallel getAuth may duplicate refresh)
  if cache_valid; then
    cat "$token_path"
  else
    out="$("${command[@]}")"
    out="$(printf '%s' "$out" | tr -d '\n\r' | sed -e 's/[[:space:]]*$//')"
    umask 077
    printf '%s' "$out" >"$token_path"
    now_ms >"$meta_path"
    chmod 600 "$token_path" "$meta_path" 2>/dev/null || true
    printf '%s' "$out"
  fi
fi
