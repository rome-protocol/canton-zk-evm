#!/usr/bin/env bash
# The prover command of the pipeline scenario (tests/network_pipeline.sh): <input.bin> <out-folder>. The stand-in prover of the rehearsal
# (tests/demo_fake_prove.sh) after a delay of PIPELINE_PROVE_DELAY seconds, so that a proof takes time as a real one does and the builder has
# blocks in flight. While the file PIPELINE_TAMPER_FLAG exists, the next proof it gives is the tampered one of demo/prove-tampered.sh (one byte flipped,
# which the sidecar refuses) and the flag is taken away: exactly one block is refused for each time the scenario puts the flag down. The file
# PIPELINE_HOLD_FILE then gets the first 16 hex digits of that block's hash, for tests/ledger_drop_proxy.py, which holds back Canton's refusal of it.
set -euo pipefail
[ $# -eq 2 ] || { echo "usage: $0 input out" >&2; exit 2; }
here=$(cd "$(dirname "$0")" && pwd)
sleep "${PIPELINE_PROVE_DELAY:-1}"
# The prover's own log, for tests/pipeline_check.py: when each block's proof was finished (the journal writes that later, while a submit runs).
if [ -n "${PIPELINE_PROVED_LOG:-}" ]; then
  h=$(tr -d '\n' < "$1")
  printf '%s %s done\n' "$(python3 -c 'import datetime as d; print(d.datetime.now(d.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z")')" "${h:2:16}" >> "$PIPELINE_PROVED_LOG"
fi
if [ -n "${PIPELINE_TAMPER_FLAG:-}" ] && mv "$PIPELINE_TAMPER_FLAG" "$PIPELINE_TAMPER_FLAG.used" 2>/dev/null; then
  if [ -n "${PIPELINE_HOLD_FILE:-}" ]; then h=$(tr -d '\n' < "$1"); printf '%s' "${h:2:16}" > "$PIPELINE_HOLD_FILE"; fi
  CZE_TAMPER_REAL_PROVE_CMD="$here/demo_fake_prove.sh" exec "$here/../demo/prove-tampered.sh" "$@"
fi
exec "$here/demo_fake_prove.sh" "$@"
