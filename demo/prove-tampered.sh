#!/usr/bin/env bash
# The demo's second run: a prover command that gives the builder a proof with one byte flipped. This is demo-only and lives
# in demo/, never in network/ or builder/: nothing in the chain can be told to accept it.
#
# Called as <input.bin> <out-folder>, the way the builder calls its prover command. It runs the real prover command
# ($CZE_TAMPER_REAL_PROVE_CMD, the same one the good run uses), so the proof is a real one, and then changes ONE hex digit
# of <out-folder>/wrapped-proof.hex: the first digit of byte 100, inside the 768-byte PLONK proof. The rest is untouched.
set -euo pipefail
real=${CZE_TAMPER_REAL_PROVE_CMD:?set CZE_TAMPER_REAL_PROVE_CMD to the prover command of the good run}
[ $# -eq 2 ] || { echo "usage: $0 <input.bin> <out-folder>" >&2; exit 2; }
$real "$@"
f=$2/wrapped-proof.hex
[ -f "$f" ] || { echo "FAIL: the prover left no wrapped-proof.hex" >&2; exit 1; }
proof=$(tr -d '\n' < "$f")
{ [ "${#proof}" = 2688 ] && [[ $proof =~ ^[0-9a-f]+$ ]]; } || { echo "FAIL: wrapped-proof.hex is not 1,344 bytes of lowercase hex" >&2; exit 1; }
at=200   # the first hex digit of byte 100
digit=${proof:$at:1}
flipped=$(printf '%x' $((16#$digit ^ 1)))
printf '%s%s%s' "${proof:0:$at}" "$flipped" "${proof:$((at + 1))}" > "$f"
echo "tampered: byte 100 of the wrapped proof, first digit $digit -> $flipped"
