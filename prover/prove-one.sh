#!/usr/bin/env bash
# Proves one block with the running prover and checks the proof.
#
# Usage: prove-one.sh <input.bin> [out-folder]      (default folder: ./state/prover/out)
#
# Sends the input to the coordinator with a PLONK wrap, verifies the proof with cargo-zisk, and
# writes to the folder:
#   proof.bin         the proof as cargo-zisk saves it
#   calldata.json     its four fields: proofBytes, programVK, rootCVadcopFinal, publicValues
#   wrapped-proof.hex the same four, one after the other as hex: 768 + 32 + 32 + 512 = 1,344 bytes
# and prints the proof time. It fails if the prover refuses the input or the proof does not verify.
#
# The guest ELF is the one prover/build-guest.sh made (override with CZE_GUEST_ELF). The
# coordinator is ZISK_COORDINATOR_URL. A proof that takes longer than CZE_PROVE_TIMEOUT seconds
# (default 1800) is given up.
set -euo pipefail
# shellcheck disable=SC1091
. "$(dirname "$0")/common.sh"

INPUT=${1:?usage: prove-one.sh <input.bin> [out-folder]}
OUT=${2:-$STATE/out}
[ -s "$INPUT" ] || fail "no input file: $INPUT"
[ -s "$GUEST_ELF" ] || fail "no guest ELF: $GUEST_ELF (run prover/build-guest.sh)"
mkdir -p "$OUT"

echo "input sha256: $(sha256sum "$INPUT" | cut -d' ' -f1)"

# Registers the program and builds its setup on the prover; quick once it has been done.
cargo-zisk remote setup -e "$GUEST_ELF"

start=$(date +%s.%N)
cargo-zisk remote prove -e "$GUEST_ELF" -i "$INPUT" --plonk --timeout "${CZE_PROVE_TIMEOUT:-1800}" -o "$OUT/proof.bin"
end=$(date +%s.%N)
echo "prove wall time: $(awk -v s="$start" -v e="$end" 'BEGIN { printf "%.2f", e - s }') s"

cargo-zisk verify -p "$OUT/proof.bin"
echo "verified with cargo-zisk"

cargo-zisk-dev export-solidity-calldata -p "$OUT/proof.bin" -o "$OUT/calldata.json"
jq -j '[.proofBytes, .programVK, .rootCVadcopFinal, .publicValues] | map(ltrimstr("0x")) | join("")' \
  "$OUT/calldata.json" > "$OUT/wrapped-proof.hex"
bytes=$(( $(wc -c < "$OUT/wrapped-proof.hex") / 2 ))
[ "$bytes" = 1344 ] || fail "the wrapped proof is $bytes bytes, expected 1344"
echo "wrapped proof: $bytes bytes, in $OUT/wrapped-proof.hex"
