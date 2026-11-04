#!/usr/bin/env bash
# One-command proof that the whole thing works: bring the stack up on throwaway
# ports, seed the demo cohort, ask for matches, tear it all down.
#
# This is the script to run when you clone the repo and want to see it move.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${DEMO_PORT:-8091}"
MATCHER_PORT="${DEMO_MATCHER_PORT:-8092}"
export MATCHER_URL="http://127.0.0.1:$MATCHER_PORT"
TMP_DB="$(mktemp -t tandem-demo-XXXXXX.db)"
TMP_OUT="$(mktemp -d -t tandem-demo-XXXXXX)"

cleanup() {
  kill "${MATCHER_PID:-}" "${API_PID:-}" 2>/dev/null || true
  rm -f "$TMP_DB" "$TMP_DB-shm" "$TMP_DB-wal"
  rm -rf "$TMP_OUT"
}
trap cleanup EXIT

echo "starting matcher on :$MATCHER_PORT"
( cd services/matcher && MATCHER_PORT="$MATCHER_PORT" exec python3 -m tandem_matcher >"$TMP_OUT/matcher.log" 2>&1 ) &
MATCHER_PID=$!
sleep 0.8

echo "starting api on :$PORT"
( cd services/api && TANDEM_DEV=1 TANDEM_DB="$TMP_DB" PORT="$PORT" exec node src/main.ts >"$TMP_OUT/api.log" 2>&1 ) &
API_PID=$!
sleep 1.5

BASE="http://127.0.0.1:$PORT"
for _ in $(seq 1 20); do
  if curl -fsS "$BASE/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.3
done

echo
echo "── seeding ────────────────────────────────────────────────"
TANDEM_BASE_URL="$BASE" ./cli/tandemctl seed

echo
echo "── doctor ─────────────────────────────────────────────────"
TANDEM_BASE_URL="$BASE" ./cli/tandemctl doctor || true

echo
echo "── who should Ada meet? ───────────────────────────────────"
TANDEM_BASE_URL="$BASE" ./cli/tandemctl match Ada --limit 4

echo "── who should Dev meet? (wants a mentor) ──────────────────"
TANDEM_BASE_URL="$BASE" ./cli/tandemctl match Dev --limit 4

echo "── the refusal ────────────────────────────────────────────"
set +e
curl -s -X POST "$BASE/v1/lookup" -H 'Content-Type: application/json' -d '{"phone":"+15550100001"}' \
  | head -c 400
echo
set -e

echo
echo "── scout (recorded data, no network) ──────────────────────"
( cd services/scout && exec python3 -m tandem_scout --replay test/fixtures --out "$TMP_OUT/scout" --topics ai,security ) || true
echo
sed -n '1,40p' "$TMP_OUT/scout/digest.md" 2>/dev/null || true

echo
echo "done. Cleaned up $TMP_DB and $TMP_OUT."
