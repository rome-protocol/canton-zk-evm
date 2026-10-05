#!/usr/bin/env bash
# Saves the OpenAPI document of the pinned Canton, as JSON, so that the explorer's tests can check the Ledger API calls against it
# (server/ledger.openapi.test.ts). Canton writes the document itself, so this starts the Canton network's participants (network/canton/canton.conf,
# no bootstrap) with stand-ins for the sidecars that the config asks them to reach, reads /docs/openapi from the users participant, and stops.
# Usage: explorer/check-ledger-api.sh <output file>. Needs Java 21, curl, Python 3, yq and jq. No GPU, no reth.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"
OUT=${1:?usage: explorer/check-ledger-api.sh <output file>}
WORK=$(mktemp -d)
export CZE_STATE_DIR=$WORK/state FAKE_LOG=$WORK/calls FAKE_ANSWER=$WORK/answer
fail() { echo "FAIL: $*" >&2; exit 1; }
pids=()
cleanup() {
  local status=$?
  [ "$status" = 0 ] || { echo "--- Canton log (tail)"; tail -n 40 "$WORK/canton.log" 2>/dev/null || true; }
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

tools=$("$ROOT/network/canton/fetch.sh")
CANTON_JAR=$(sed -n 's/^CANTON_JAR=//p' <<<"$tools")
: > "$FAKE_LOG"; echo "no this stand-in answers nothing" > "$FAKE_ANSWER"
for port in 8085 8086; do
  python3 "$ROOT/tests/fake_sidecar.py" "$port" & pids+=($!)
done
sleep 1
java -Xmx3g -jar "$CANTON_JAR" daemon -c "$ROOT/network/canton/canton.conf" --no-tty > "$WORK/canton.log" 2>&1 &
pids+=($!)
for _ in $(seq 1 300); do
  curl -sf -o "$WORK/openapi.yaml" http://127.0.0.1:7577/docs/openapi && break
  kill -0 "${pids[-1]}" 2>/dev/null || fail "Canton stopped"
  sleep 1
done
[ -s "$WORK/openapi.yaml" ] || fail "Canton did not serve /docs/openapi"
yq -o=json '.' "$WORK/openapi.yaml" > "$OUT"
jq -e '.paths["/v2/updates"].post and .paths["/v2/state/ledger-end"].get' "$OUT" >/dev/null || fail "the document has no /v2/updates or /v2/state/ledger-end"
echo "saved Canton $CANTON_VERSION's OpenAPI document to $OUT ($(jq -r .info.version "$OUT"))"
