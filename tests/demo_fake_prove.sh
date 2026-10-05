#!/usr/bin/env bash
# The rehearsal's prover command (tests/demo_rehearsal.sh): <input.bin> <out-folder>. It writes the one stand-in proof that
# tests/demo_sidecar.py accepts, and the prove.log line network/prove-timed.sh would write. There is no real proof here.
set -euo pipefail
[ $# -eq 2 ] || { echo "usage: $0 input out" >&2; exit 2; }
[ -s "$1" ] || { echo "missing $1" >&2; exit 1; }
mkdir -p "$2"
head -c 1344 /dev/zero | od -An -v -tx1 | tr -d ' \n' | sed 's/00/ee/g' > "$2/wrapped-proof.hex"
echo "prove wall time: 0.01 s" | tee "$2/prove.log"
