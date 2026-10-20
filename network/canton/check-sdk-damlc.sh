#!/usr/bin/env bash
# Refuses an SDK manifest whose damlc entry is not DAMLC_VERSION. Other components of the SDK (codegen, the script runner)
# can carry the same version number, so it is the damlc entry itself that is read, not any line with that version.
# Usage: check-sdk-damlc.sh <SDK manifest> [damlc version]    (default: DAMLC_VERSION in PINS)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"
fail() { echo "FAIL: $*" >&2; exit 1; }
manifest=${1:?usage: check-sdk-damlc.sh <SDK manifest> [damlc version]}
want=${2:-$DAMLC_VERSION}
[ -f "$manifest" ] || fail "no SDK manifest at $manifest"
# The first "version:" under the "damlc:" key, before the next key at the same or a lower indent.
got=$(awk '
  /^[[:space:]]*damlc:[[:space:]]*$/ { match($0, /^[[:space:]]*/); indent = RLENGTH; inside = 1; next }
  inside {
    match($0, /^[[:space:]]*/)
    if ($0 !~ /^[[:space:]]*$/ && RLENGTH <= indent) exit
    if ($1 == "version:") { gsub(/["\047]/, "", $2); print $2; exit }
  }' "$manifest")
[ "$got" = "$want" ] || fail "the SDK manifest names damlc '${got:-nothing}', not $want"
