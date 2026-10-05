#!/usr/bin/env bash
# Compiles demo/TKA.sol with the solc image in PINS and writes the creation code, as hex without 0x, to demo/TKA.bin
# (or to the file named by $1). With --check it compiles to a temporary file and fails unless demo/TKA.bin is identical.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"
mode="write"
if [ "${1:-}" = --check ]; then mode="check"; shift; fi
OUT=${1:-$ROOT/demo/TKA.bin}
[ "$mode" = write ] || OUT=$(mktemp)
umask 022
# The flags are fixed: the same source and the same compiler give the same bytes.
docker run --rm -v "$ROOT/demo:/src:ro" "$SOLC_IMAGE" --evm-version cancun --optimize --optimize-runs 200 --no-cbor-metadata --bin /src/TKA.sol \
  | awk '/^Binary:/ { getline; printf "%s", $0 }' > "$OUT"
[[ $(cat "$OUT") =~ ^[0-9a-f]{200,}$ ]] || { echo "FAIL: the compiler did not give creation code" >&2; exit 1; }
if [ "$mode" = check ]; then
  cmp -s "$OUT" "$ROOT/demo/TKA.bin" || { echo "FAIL: demo/TKA.bin is not what demo/TKA.sol compiles to (run demo/build-token.sh)" >&2; rm -f "$OUT"; exit 1; }
  rm -f "$OUT"
  echo "demo/TKA.bin is what demo/TKA.sol compiles to"
fi
