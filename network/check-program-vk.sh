#!/usr/bin/env bash
# Stops unless the programVK of the guest that was just built is the recorded one (programVK in
# prover/fixtures/session.txt, or the file named by CZE_SESSION_FILE). The sidecars and the chain are pinned to the key
# of the guest that runs, and the recorded proof is for the recorded key; a build with another key is not the program
# the record is about, so nothing is started with it.
# Usage: check-program-vk.sh <programVK as 0x + 64 hex>
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
fail() { echo "FAIL: $*" >&2; exit 1; }
built=${1:-}
rec_file=${CZE_SESSION_FILE:-$ROOT/prover/fixtures/session.txt}
recorded=$(sed -n 's/^programVK=//p' "$rec_file" | head -1)
[[ $recorded =~ ^0x[0-9a-f]{64}$ ]] || fail "no recorded programVK in $rec_file"
[[ $built =~ ^0x[0-9a-f]{64}$ ]] || fail "the guest build gave no programVK"
if [ "$built" != "$recorded" ]; then
  fail "the guest built here has programVK $built, not the recorded $recorded. The key is that of the ELF; build-guest.sh builds in one fixed folder, so a different key usually means a different ZisK, toolchain or source. Nothing is started with a key that is not the recorded one."
fi
echo "programVK $built is the recorded one"
