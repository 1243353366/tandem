#!/usr/bin/env bash
# Start both services for local work. Ctrl-C stops both.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "node is required (>= 22.6). Install it, then re-run." >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required (>= 3.10)." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "node $NODE_MAJOR is too old: the API uses native TypeScript and node:sqlite, both need 22.6+." >&2
  exit 1
fi

mkdir -p data
export TANDEM_DEV="${TANDEM_DEV:-1}"
export TANDEM_DB="${TANDEM_DB:-data/tandem.db}"
export PORT="${PORT:-8080}"
export MATCHER_URL="${MATCHER_URL:-http://127.0.0.1:8081}"
export MATCHER_PORT="${MATCHER_PORT:-8081}"

pids=()
cleanup() {
  for pid in "${pids[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

echo "→ matcher on :$MATCHER_PORT"
( cd services/matcher && exec python3 -m tandem_matcher ) &
pids+=($!)

sleep 0.8

echo "→ api on :$PORT  (dev mode: OTP codes are returned inline)"
( cd services/api && exec node src/main.ts ) &
pids+=($!)

sleep 1.2

echo "→ web on http://127.0.0.1:5173"
if command -v python3 >/dev/null 2>&1; then
  ( cd web && exec python3 -m http.server 5173 --bind 127.0.0.1 >/dev/null 2>&1 ) &
  pids+=($!)
fi

echo
echo "  api     http://127.0.0.1:$PORT/healthz"
echo "  matcher http://127.0.0.1:$MATCHER_PORT/version"
echo "  web     http://127.0.0.1:5173"
echo
echo "  next:    ./cli/tandemctl seed     (load the demo cohort)"
echo "           ./cli/tandemctl match Ada"
echo
echo "Ctrl-C to stop."
wait
