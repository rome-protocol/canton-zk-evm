#!/usr/bin/env bash
# The demo's fourth run: a prover command that proves the block as usual and then, before the builder submits it, makes U take its
# allocation back. This is demo-only and lives in demo/, never in network/ or builder/: it plays a seller who changes their mind
# in the time between the proof and the commit, which the chain has to survive.
#
# Called as <input.bin> <out-folder>, the way the builder calls its prover command. It runs the real prover command
# ($CZE_WITHDRAW_REAL_PROVE_CMD, the one the other runs use), checks that the proof is there, and then withdraws U's allocation
# with the label $CZE_WITHDRAW_LABEL (demo/canton.py withdraw-allocation). The proof itself is not touched.
set -euo pipefail
real=${CZE_WITHDRAW_REAL_PROVE_CMD:?set CZE_WITHDRAW_REAL_PROVE_CMD to the prover command of the other runs}
label=${CZE_WITHDRAW_LABEL:?set CZE_WITHDRAW_LABEL to the label of the allocation U takes back}
[ $# -eq 2 ] || { echo "usage: $0 <input.bin> <out-folder>" >&2; exit 2; }
here=$(cd "$(dirname "$0")" && pwd)
py=${CZE_DEMO_PYTHON:-${CZE_STATE_DIR:+$CZE_STATE_DIR/venv/bin/python3}}
$real "$@"
[ -f "$2/wrapped-proof.hex" ] || { echo "FAIL: the prover left no wrapped-proof.hex" >&2; exit 1; }
"${py:-python3}" "$here/canton.py" withdraw-allocation "$label" >/dev/null
echo "withdrawn: U's allocation $label, after the proof was made"
