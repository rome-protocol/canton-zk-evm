#!/usr/bin/env bash
# Checks tests/demo_results.sh itself: made-up results that say what the runs must show pass, and each change that makes them say
# something else is refused. The made-up results are not the demo's results and are deleted when this ends.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
hex() { printf "$1%.0s" $(seq "$2"); }   # <hex digits> <times>
H=0x$(hex ab 32); PROOF=$(hex ee 1344)
SUM=$(python3 -c 'import hashlib, sys; print(hashlib.sha256(bytes.fromhex(sys.argv[1])).hexdigest())' "$PROOF")
common() {
  cat <<COMMON
format=1
date=2026-01-01T00:00:00Z
source_commit=$(hex a 40)
dar_sha256=$(hex cd 32)
package_id=$(hex 12 32)
chain_id=770101
guest_elf_sha256=$(hex 34 32)
programVK=0x$(hex 56 32)
rootC=0x$(hex 78 32)
canton=3.6.0
daml_sdk=3.5.13
zisk=1.3.1
reth=2.5.2
token=0x$(hex 9a 20)
evm_transfer_tx=0x$(hex 01 32)
terms=0123456789abcdef
allocation=fedcba9876543210
COMMON
}
make() {   # <folder>
  mkdir -p "$1"
  { common; cat <<RUN1
block=2
block_hash=$H
transactions=1
legs=1
canton_head_before=1
canton_head_after=2
canton_head_hash=$H
block_record_holds_the_proof=yes
canton_update=$(hex 1220 34)
block_record_and_v_holding_in_one_update=yes
reth_finalized=yes
allocation_active_after=no
terms_active_after=no
tkb_u_before=90
tkb_v_before=0
tkb_u_after=90
tkb_v_after=10
tka_u_before=0
tka_v_before=1000
tka_u_after=10
tka_v_after=990
proof_sha256=$SUM
RUN1
  } > "$1/run1.txt"
  echo "$PROOF" > "$1/run1-proof.hex"
  { common; cat <<RUN2
block=3
builder_exit=2
committed=no
refusal=the sidecar refused the block: no the proof does not verify
leg_attached=yes
canton_head_before=2
canton_head_after=2
canton_head_hash=$H
block_records_before=2
block_records_after=2
tkb_u_before=80
tkb_v_before=10
tkb_u_after=80
tkb_v_after=10
allocation_active_after=yes
terms_active_after=yes
tka_u_after=10
tka_v_after=990
reth_latest_is_parent=yes
reth_finalized_is_parent=yes
RUN2
  } > "$1/run2.txt"
}
make "$WORK/good"
"$ROOT/tests/demo_results.sh" "$WORK/good" --stand-in >/dev/null || fail "the made-up good results were refused"

refused() {   # <what changes> <file> <sed expression>
  rm -rf "$WORK/bad"; cp -r "$WORK/good" "$WORK/bad"
  sed -i.bak "$3" "$WORK/bad/$2"
  cmp -s "$WORK/good/$2" "$WORK/bad/$2" && fail "the change '$1' did not change $2"
  "$ROOT/tests/demo_results.sh" "$WORK/bad" --stand-in >/dev/null 2>&1 && fail "results with $1 were accepted"
  return 0
}
refused "no canton_update" run1.txt '/^canton_update=/d'
refused "an empty canton_update" run1.txt 's/^canton_update=.*/canton_update=/'
refused "a canton_update that is not an id" run1.txt 's/^canton_update=.*/canton_update=none/'
refused "the update of the record and of V's holding not the same" run1.txt 's/^block_record_and_v_holding_in_one_update=.*/block_record_and_v_holding_in_one_update=no/'
refused "another refusal" run2.txt 's/^refusal=.*/refusal=the sidecar refused the block: no malformed input/'
refused "a refusal from the chain rules, not the sidecar" run2.txt 's/^refusal=.*/refusal=the block is over the gas cap/'
refused "a refusal with more than the sidecar said" run2.txt 's/^refusal=.*/&, and more/'
refused "no word that the leg was attached" run2.txt '/^leg_attached=/d'
refused "the leg not attached" run2.txt 's/^leg_attached=.*/leg_attached=no/'
echo "demo results checks passed"
