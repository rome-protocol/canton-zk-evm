#!/usr/bin/env bash
# The rehearsal's prover command (tests/demo_rehearsal.sh): <input.bin> <out-folder>. It writes a stand-in proof that
# tests/demo_sidecar.py accepts, and the prove.log line network/prove-timed.sh would write. There is no real proof here: 832 fixed
# bytes, then public values that commit to the block hash the input holds (builder/tests/fake-make-input.sh puts it there), in the
# layout of a real proof's, so that the builder's check of the proof's block hash is exercised.
set -euo pipefail
[ $# -eq 2 ] || { echo "usage: $0 input out" >&2; exit 2; }
[ -s "$1" ] || { echo "missing $1" >&2; exit 1; }
mkdir -p "$2"
python3 - "$(tr -d '\n' < "$1")" > "$2/wrapped-proof.hex" <<'PY'
import sys
words = (bytes([0x20]) + bytes.fromhex(sys.argv[1][2:])).ljust(256, b"\0")
public = b"".join(words[i:i + 4] + b"\0" * 4 for i in range(0, 256, 4))
sys.stdout.write((b"\xee" * 832 + public).hex())
PY
echo "prove wall time: 0.01 s" | tee "$2/prove.log"
