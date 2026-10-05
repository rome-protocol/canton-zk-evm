#!/usr/bin/env bash
# Stands in for prover/prove-one.sh: <input.bin> <out-folder>
set -euo pipefail
[ $# -eq 2 ] || { echo "usage: $0 input out" >&2; exit 2; }
[ -s "$1" ] || { echo "missing $1" >&2; exit 1; }
echo "prove $*" >> "${FAKE_LOG:?}"
if [ "${FAKE_PROVER_FAILS:-}" = 1 ]; then echo "the prover is down" >&2; exit 1; fi
mkdir -p "$2"
if [ "${FAKE_PROVER_WRITES_NOTHING:-}" = 1 ]; then exit 0; fi   # exits 0 and leaves no proof
head -c 1344 /dev/zero | od -An -v -tx1 | tr -d ' \n' | sed 's/00/ab/g' > "$2/wrapped-proof.hex"
