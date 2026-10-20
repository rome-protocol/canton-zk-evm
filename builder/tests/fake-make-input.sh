#!/usr/bin/env bash
# Stands in for prover/make-input.sh: <block.json> <witness.json> <genesis.json> <out.bin>
set -euo pipefail
[ $# -eq 4 ] || { echo "usage: $0 block witness genesis out" >&2; exit 2; }
for f in "$1" "$2" "$3"; do [ -s "$f" ] || { echo "missing $f" >&2; exit 1; }; done
echo "make-input $*" >> "${FAKE_LOG:?}"
if [ "${FAKE_INPUT_FAILS_FOR:-}" != "" ] && grep -q "${FAKE_INPUT_FAILS_FOR}" "$1"; then echo "cannot make an input of this block" >&2; exit 1; fi
python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["hash"])' "$1" > "$4"   # the input carries the block hash, for the fake prover
