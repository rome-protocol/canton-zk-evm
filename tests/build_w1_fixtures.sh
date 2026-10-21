#!/usr/bin/env bash
# Compiles explorer/test/fixtures/Reverts.sol and Stress.sol with the solc image in PINS, and writes the creation code of Reverts and Stress,
# as hex without 0x, to <folder>/Reverts.bin and <folder>/Stress.bin. Used by tests/demo_rehearsal.sh. The flags are those of demo/build-token.sh.
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: $0 <folder>" >&2; exit 2; }
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"
OUT=$1
mkdir -p "$OUT"
for name in Reverts Stress; do
  docker run --rm -v "$ROOT/explorer/test/fixtures:/src:ro" "$SOLC_IMAGE" --evm-version cancun --optimize --optimize-runs 200 --no-cbor-metadata --bin "/src/$name.sol" \
    | awk -v want="$name" '/^=======/ { on = ($0 ~ ("\\.sol:" want " =======")) } on && /^Binary:/ { getline; printf "%s", $0 }' > "$OUT/$name.bin"
  [[ $(cat "$OUT/$name.bin") =~ ^[0-9a-f]{200,}$ ]] || { echo "FAIL: the compiler did not give creation code for $name" >&2; exit 1; }
done
echo "compiled Reverts and Stress into $OUT"
