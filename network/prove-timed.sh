#!/usr/bin/env bash
# The prover command the smoke test gives the builder: prover/prove-one.sh, with its output also kept in
# <out-folder>/prove.log so that the proof time can be read afterwards. Called as <input.bin> <out-folder>.
set -euo pipefail
mkdir -p "$2"
"$(dirname "$0")/../prover/prove-one.sh" "$@" 2>&1 | tee "$2/prove.log"
