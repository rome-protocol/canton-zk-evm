#!/usr/bin/env bash
# Compiles gateway/Gateway.sol with the solc image in PINS and writes the gateway's runtime code, as hex without 0x, to
# gateway/Gateway.bin-runtime (or to the file named by $1). network/make-state.sh puts that code into each run's genesis.
# With --check it compiles to a temporary file and fails unless gateway/Gateway.bin-runtime is identical.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"
mode="write"
if [ "${1:-}" = --check ]; then mode="check"; shift; fi
OUT=${1:-$ROOT/gateway/Gateway.bin-runtime}
[ "$mode" = write ] || OUT=$(mktemp)
umask 022
# The flags are fixed: the same source and the same compiler give the same bytes. The file also holds the wrapped token,
# whose creation code sits inside the gateway's runtime code, so the output is picked out by the contract's name.
docker run --rm -v "$ROOT/gateway:/src:ro" "$SOLC_IMAGE" --evm-version cancun --optimize --optimize-runs 200 --no-cbor-metadata --bin-runtime /src/Gateway.sol \
  | awk '/^======= .*:Gateway =======$/ { on = 1; next } /^======= / { on = 0 } on && /^Binary of the runtime part:/ { getline; printf "%s", $0 }' > "$OUT"
[[ $(cat "$OUT") =~ ^[0-9a-f]{200,}$ ]] || { echo "FAIL: the compiler did not give runtime code" >&2; exit 1; }
if [ "$mode" = check ]; then
  cmp -s "$OUT" "$ROOT/gateway/Gateway.bin-runtime" || { echo "FAIL: gateway/Gateway.bin-runtime is not what gateway/Gateway.sol compiles to (run gateway/build.sh)" >&2; rm -f "$OUT"; exit 1; }
  rm -f "$OUT"
  echo "gateway/Gateway.bin-runtime is what gateway/Gateway.sol compiles to"
fi
