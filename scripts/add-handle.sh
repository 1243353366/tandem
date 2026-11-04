#!/usr/bin/env bash
#
# Add, list or remove an account you own.
#
#   ./scripts/add-handle.sh networks
#   ./scripts/add-handle.sh list
#   ./scripts/add-handle.sh add github your-handle
#   ./scripts/add-handle.sh remove hnd_...
#
# Adding a handle is the consent step: it records a consent scoped to
# signal.enrich and lets the nightly scout read what you publish on that account.
# Removing it revokes the consent and deletes the tags derived from it.

set -euo pipefail

API="${TANDEM_API:-http://127.0.0.1:8080}"
TOKEN="${TANDEM_TOKEN:-}"

die() { printf '%s\n' "$1" >&2; exit 1; }

need_token() {
  [ -n "$TOKEN" ] || die "Set TANDEM_TOKEN to the token you got when you created your profile."
}

case "${1:-}" in
  networks)
    curl -fsS "$API/v1/handles/networks" | python3 -c '
import json, sys
for net in json.load(sys.stdin)["networks"]:
    mark = "read" if net["readable"] else "not read"
    print("{network:14} {label:38} {mark}".format(mark=mark, **net))
    if net.get("reason"):
        print("               " + net["reason"])

'
    ;;

  list)
    need_token
    curl -fsS -H "Authorization: Bearer $TOKEN" "$API/v1/me/handles" | python3 -c '
import json, sys
handles = json.load(sys.stdin)["handles"]
if not handles:
    print("no handles yet. add one: ./scripts/add-handle.sh add github your-handle")
for handle in handles:
    print("{network:14} {handle:32} {state:9} {id}".format(
        state="read" if handle["readable"] else "not read", **handle))
' 
    ;;

  add)
    need_token
    network="${2:-}"; handle="${3:-}"
    [ -n "$network" ] && [ -n "$handle" ] || die "usage: $0 add <network> <handle>"
    body=$(python3 -c 'import json,sys; print(json.dumps({"network": sys.argv[1], "handle": sys.argv[2]}))' "$network" "$handle")
    response=$(curl -sS -w '\n%{http_code}' -X POST "$API/v1/handles" \
      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$body")
    code="${response##*$'\n'}"; body="${response%$'\n'*}"
    if [ "$code" != "201" ]; then
      printf '%s\n' "$body" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(f"refused: {d.get(\"message\")}", file=sys.stderr)' 2>/dev/null \
        || printf 'refused (%s): %s\n' "$code" "$body" >&2
      exit 1
    fi
    printf '%s
' "$body" | python3 -c '
import json, sys
h = json.load(sys.stdin)["handle"]
print("added {network} {handle}".format(**h))
print("  consent {0} scoped to signal.enrich".format(h["consent_id"]))
print("  read: yes" if h["readable"] else "  read: no. " + (h.get("why_not_readable") or ""))
print("  the next scout run (or `make members`) will pick it up")
' 
    ;;

  remove)
    need_token
    id="${2:-}"; [ -n "$id" ] || die "usage: $0 remove <handle-id>"
    curl -fsS -X DELETE -H "Authorization: Bearer $TOKEN" "$API/v1/handles/$id" >/dev/null
    echo "removed. the consent is revoked and everything derived from it is deleted."
    ;;

  *)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac
