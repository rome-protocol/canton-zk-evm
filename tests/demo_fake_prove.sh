#!/usr/bin/env bash
# The rehearsal's prover command (tests/demo_rehearsal.sh): <input.bin> <out-folder>. It writes a stand-in proof that
# tests/demo_sidecar.py accepts, and the prove.log line network/prove-timed.sh would write. There is no real proof here: 832 fixed
# bytes, then public values that commit to the block hash the input holds (builder/tests/fake-make-input.sh puts it there), in the
# layout of a real proof's, so that the builder's check of the proof's block hash is exercised.
set -euo pipefail
[ $# -eq 2 ] || { echo "usage: $0 input out" >&2; exit 2; }
[ -s "$1" ] || { echo "missing $1" >&2; exit 1; }
mkdir -p "$2"
# The 832 fixed bytes are 768 of 0xee, then the program key and the release root: DEMO_PROOF_PROGRAM_VK and DEMO_PROOF_ROOT_C (64 hex digits each, as the
# rehearsal pins them; 0xee bytes when unset), because the explorer's indexer reads them from the proof and checks them against its pins (C7).
python3 - "$(tr -d '\n' < "$1")" "${DEMO_PROOF_PROGRAM_VK:-$(printf 'ee%.0s' $(seq 32))}" "${DEMO_PROOF_ROOT_C:-$(printf 'ee%.0s' $(seq 32))}" > "$2/wrapped-proof.hex" <<'PY'
import sys
vk, root = bytes.fromhex(sys.argv[2]), bytes.fromhex(sys.argv[3])
assert len(vk) == 32 and len(root) == 32
words = (bytes([0x20]) + bytes.fromhex(sys.argv[1][2:])).ljust(256, b"\0")
public = b"".join(words[i:i + 4] + b"\0" * 4 for i in range(0, 256, 4))
sys.stdout.write((b"\xee" * 768 + vk + root + public).hex())
PY
echo "prove wall time: 0.01 s" | tee "$2/prove.log"
