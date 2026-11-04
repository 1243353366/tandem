#!/usr/bin/env bash
# Production-shaped launch. Unlike dev.sh this refuses to start without real
# secrets, because a consent platform running on a throwaway pepper is not
# verifying anything.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ "${TANDEM_DEV:-0}" = "1" ]; then
  echo "TANDEM_DEV=1 is set. That returns OTP codes in API responses." >&2
  echo "Unset it for a real deployment, or use scripts/dev.sh for local work." >&2
  exit 1
fi

missing=()
[ -n "${TANDEM_PEPPER:-}" ] || missing+=("TANDEM_PEPPER  (openssl rand -hex 32)")
[ -n "${TANDEM_PUBLIC_URL:-}" ] || missing+=("TANDEM_PUBLIC_URL  (https://your.host)")
if [ ${#missing[@]} -gt 0 ]; then
  printf 'refusing to launch. missing:\n' >&2
  printf '  %s\n' "${missing[@]}" >&2
  exit 1
fi

if [ -z "${TANDEM_SMS_WEBHOOK:-}" ]; then
  echo "warning: TANDEM_SMS_WEBHOOK is not set, so no verification codes will be delivered." >&2
  echo "         point it at any endpoint that accepts {\"to\":\"+1...\",\"body\":\"...\"}." >&2
fi

if [ ! -f "$TANDEM_DB" ] && [ ! -d "$(dirname "$TANDEM_DB")" ]; then
  mkdir -p "$(dirname "$TANDEM_DB")"
fi

echo "→ matcher"
( cd services/matcher && MATCHER_HOST="${MATCHER_HOST:-127.0.0.1}" exec python3 -m tandem_matcher ) &
MATCHER_PID=$!

sleep 1
echo "→ api"
( cd services/api && exec node src/main.ts ) &
API_PID=$!

shutdown() { kill "$MATCHER_PID" "$API_PID" 2>/dev/null || true; }
trap shutdown EXIT INT TERM
wait
