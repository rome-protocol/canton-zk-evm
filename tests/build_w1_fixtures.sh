#!/usr/bin/env bash
# Compiles explorer/test/fixtures/Reverts.sol, Stress.sol, Lab.sol and Flood.sol with the solc image in PINS, and writes the creation code of Reverts, Stress,
# Lab, Flood and Multi, as hex without 0x, to <folder>/<name>.bin. Used by tests/demo_rehearsal.sh. The flags are those of demo/build-token.sh.
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: $0 <folder>" >&2; exit 2; }
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"
OUT=$1
mkdir -p "$OUT"
for spec in Reverts:Reverts Stress:Stress Lab:Lab Flood:Flood Flood:Multi; do
  file=${spec%%:*}; name=${spec##*:}
  docker run --rm -v "$ROOT/explorer/test/fixtures:/src:ro" "$SOLC_IMAGE" --evm-version cancun --optimize --optimize-runs 200 --no-cbor-metadata --bin "/src/$file.sol" \
    | awk -v want="$name" '/^=======/ { on = ($0 ~ ("\\.sol:" want " =======")) } on && /^Binary:/ { getline; printf "%s", $0 }' > "$OUT/$name.bin"
  [[ $(cat "$OUT/$name.bin") =~ ^[0-9a-f]{200,}$ ]] || { echo "FAIL: the compiler did not give creation code for $name" >&2; exit 1; }
done
echo "compiled Reverts, Stress, Lab, Flood and Multi into $OUT"
