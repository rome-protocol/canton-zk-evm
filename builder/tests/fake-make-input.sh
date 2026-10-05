#!/usr/bin/env bash
# Stands in for prover/make-input.sh: <block.json> <witness.json> <genesis.json> <out.bin>
set -euo pipefail
[ $# -eq 4 ] || { echo "usage: $0 block witness genesis out" >&2; exit 2; }
for f in "$1" "$2" "$3"; do [ -s "$f" ] || { echo "missing $f" >&2; exit 1; }; done
echo "make-input $*" >> "${FAKE_LOG:?}"
printf 'prover input' > "$4"
