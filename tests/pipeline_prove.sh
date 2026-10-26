#!/usr/bin/env bash
# The prover command of the pipeline scenario (tests/network_pipeline.sh): <input.bin> <out-folder>. The stand-in prover of the rehearsal
# (tests/demo_fake_prove.sh) after a delay of PIPELINE_PROVE_DELAY seconds, so that a proof takes time as a real one does and the builder has
# blocks in flight. While the file PIPELINE_TAMPER_FLAG exists, the next proof it gives is the tampered one of demo/prove-tampered.sh (one byte flipped,
# which the sidecar refuses) and the flag is taken away: exactly one block is refused for each time the scenario puts the flag down.
set -euo pipefail
[ $# -eq 2 ] || { echo "usage: $0 input out" >&2; exit 2; }
here=$(cd "$(dirname "$0")" && pwd)
sleep "${PIPELINE_PROVE_DELAY:-1}"
if [ -n "${PIPELINE_TAMPER_FLAG:-}" ] && mv "$PIPELINE_TAMPER_FLAG" "$PIPELINE_TAMPER_FLAG.used" 2>/dev/null; then
  CZE_TAMPER_REAL_PROVE_CMD="$here/demo_fake_prove.sh" exec "$here/../demo/prove-tampered.sh" "$@"
fi
exec "$here/demo_fake_prove.sh" "$@"
