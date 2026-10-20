#!/usr/bin/env bash
# Stands in for prover/prove-one.sh: <input.bin> <out-folder>
set -euo pipefail
[ $# -eq 2 ] || { echo "usage: $0 input out" >&2; exit 2; }
[ -s "$1" ] || { echo "missing $1" >&2; exit 1; }
echo "prove $*" >> "${FAKE_LOG:?}"
sleep "${FAKE_PROVER_SLEEP:-0}"   # a slow prover, to signal the builder in the middle of a block
if [ "${FAKE_PROVER_FAILS:-}" = 1 ]; then echo "the prover is down" >&2; exit 1; fi
mkdir -p "$2"
if [ "${FAKE_PROVER_WRITES_NOTHING:-}" = 1 ]; then exit 0; fi   # exits 0 and leaves no proof
# 832 bytes of 0xab, then public values in the layout the sidecar accepts: 64 slots of a 4-byte word and four zero bytes; the words are
# 0x20, the 32-byte block hash and zeros. FAKE_PROVER_WRONG_BLOCK=1 commits to another block.
python3 - "$(tr -d '\n' < "$1")" "${FAKE_PROVER_WRONG_BLOCK:-}" > "$2/wrapped-proof.hex" <<'PY'
import sys
block = sys.argv[1][2:] if not sys.argv[2] else "ff" * 32
words = (bytes([0x20]) + bytes.fromhex(block)).ljust(256, b"\0")
public = b"".join(words[i:i + 4] + b"\0" * 4 for i in range(0, 256, 4))
sys.stdout.write((b"\xab" * 832 + public).hex())
PY
