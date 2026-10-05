#!/usr/bin/env bash
# Checks tests/demo_results.sh itself: made-up results that say what the setup and the five runs must show pass, and each change that makes them say
# something else is refused. The made-up results are not the demo's results and are deleted when this ends.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
hex() { printf "$1%.0s" $(seq "$2"); }   # <hex digits> <times>
PROOF=$(hex ee 1344)
SUM=$(python3 -c 'import hashlib, sys; print(hashlib.sha256(bytes.fromhex(sys.argv[1])).hexdigest())' "$PROOF")
tx() { echo "0x$(hex "$1" 32)"; }   # a transaction hash, made from two hex digits
common() {
  cat <<COMMON
format=2
date=2026-01-01T00:00:00Z
source_commit=$(hex a 40)
dar_sha256=$(hex cd 32)
package_id=$(hex 12 32)
chain_id=770101
guest_elf_sha256=$(hex 34 32)
programVK=0x$(hex 56 32)
rootC=0x$(hex 78 32)
gateway=0x$(hex 31 20)
gateway_code_hash=0x$(hex 32 32)
canton=3.6.0
daml_sdk=3.5.13
zisk=1.3.1
reth=2.5.2
gpu=
COMMON
}
TKA=0x$(hex 9a 20); WTKB=0x$(hex 9b 20)
make() {   # <folder>
  mkdir -p "$1"
  { common; cat <<SETUP
block=1
block_hash=$(tx a1)
tka=$TKA
wtkb=$WTKB
deploy_tx=$(tx 01)
register_tx=$(tx 02)
transactions=2
legs=0
canton_head_after=1
wtkb_registered_on_canton=yes
u_accepts_withdrawals=yes
proof_sha256=$SUM
tkb_u=100
SETUP
  } > "$1/setup.txt"
  { common; cat <<RUN1
block=2
block_hash=$(tx a2)
wtkb=$WTKB
deposit_id=$(hex 4d 32)
evm_claim_tx=$(tx 03)
transactions=1
legs=1
leg_kind=deposit
request=0123456789abcdef
allocation=fedcba9876543210
proof_sha256=$SUM
canton_head_before=1
canton_head_after=2
canton_head_hash=$(tx a2)
block_record_holds_the_proof=yes
canton_update=$(hex 1220 34)
block_record_and_gateway_holding_in_one_update=yes
tkb_u_before=90
tkb_u_after=90
custody_before=0
custody_after=10
wtkb_u_before=0.0
wtkb_u_after=10.0
wtkb_supply_before=0.0
wtkb_supply_after=10.0
allocation_active_after=no
request_active_after=no
reth_finalized=yes
RUN1
  } > "$1/run1.txt"
  { common; cat <<RUN2
block=3
block_hash=$(tx a3)
token=$TKA
payment_id=$(hex 5c 32)
evm_approve_tx=$(tx 04)
evm_pay_tx=$(tx 05)
evm_plain_transfer_tx=$(tx 06)
transactions=3
legs=1
leg_kind=payment
terms=0123456789abcdef
allocation=aaaaaaaabbbbbbbb
proof_sha256=$SUM
canton_head_before=2
canton_head_after=3
canton_head_hash=$(tx a3)
block_record_holds_the_proof=yes
canton_update=$(hex 1220 34)
block_record_and_v_holding_in_one_update=yes
tkb_u_before=80
tkb_v_before=0
tkb_u_after=80
tkb_v_after=10
allocation_active_after=no
terms_active_after=no
tka_u_before=0
tka_v_before=1000
tka_u_after=11
tka_v_after=989
reth_finalized=yes
RUN2
  } > "$1/run2.txt"
  { common; cat <<RUN3
block=4
block_hash=$(tx a4)
wtkb=$WTKB
evm_withdraw_tx=$(tx 07)
transactions=1
legs=1
leg_kind=withdrawal
proof_sha256=$SUM
canton_head_before=3
canton_head_after=4
canton_head_hash=$(tx a4)
block_record_holds_the_proof=yes
canton_update=$(hex 1220 34)
block_record_and_u_holding_in_one_update=yes
tkb_u_before=80
tkb_u_after=84
custody_before=10
custody_after=6
wtkb_u_before=10.0
wtkb_u_after=6.0
wtkb_supply_before=10.0
wtkb_supply_after=6.0
reth_finalized=yes
RUN3
  } > "$1/run3.txt"
  { common; cat <<RUN4
block=5
block_hash_refused=$(tx b5)
token=$TKA
payment_id=$(hex 6d 32)
evm_approve_tx=$(tx 08)
evm_pay_tx=$(tx 09)
evm_withdraw_to_reader_tx=$(tx 0a)
left_out_before_proving=$(tx 0a)
left_out_reason=no standing acceptance
terms=1111111122222222
allocation=3333333344444444
allocation_taken_back_after_the_proof=yes
builder_exit=2
committed=no
refusal=CONTRACT_NOT_FOUND: U's allocation for dvp-2 (3333333344444444), taken back after the proof
leg_attached=yes
canton_head_before=4
canton_head_after_refusal=4
canton_head_hash_after_refusal=$(tx a4)
block_records_after_refusal=4
reth_latest_is_parent=yes
reth_finalized_is_parent=yes
resubmitted_without_the_leg=refused
resubmit_refusal=the legs are not the ones the block recorded
next_run_block_hash=$(tx a5)
next_run_committed=yes
next_run_transactions=1
next_run_legs=0
next_run_left_out=2
next_run_proof_sha256=$SUM
canton_head_after=5
canton_head_hash=$(tx a5)
tkb_u_before=74
tkb_v_before=10
tkb_u_after=84
tkb_v_after=10
custody_after=6
allocation_active_after=no
tka_u_after=11
tka_v_after=989
wtkb_u_after=6.0
wtkb_supply_after=6.0
reth_finalized=yes
RUN4
  } > "$1/run4.txt"
  { common; cat <<RUN5
block=6
block_hash_built=$(tx b6)
token=$TKA
payment_id=$(hex 6d 32)
evm_pay_tx=$(tx 09)
tampered=byte 100 of the wrapped proof, first hex digit flipped
builder_exit=2
committed=no
refusal=the sidecar refused the block: no the proof does not verify
leg_attached=yes
terms=5555555566666666
allocation=7777777788888888
canton_head_before=5
canton_head_after=5
canton_head_hash=$(tx a5)
block_records_before=5
block_records_after=5
tkb_u_before=74
tkb_v_before=10
tkb_u_after=74
tkb_v_after=10
allocation_active_after=yes
tka_u_after=11
tka_v_after=989
reth_latest_is_parent=yes
reth_finalized_is_parent=yes
RUN5
  } > "$1/run5.txt"
  for f in setup run1 run2 run3 run4; do echo "$PROOF" > "$1/$f-proof.hex"; done
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
refused "the old format" run1.txt 's/^format=.*/format=1/'
refused "a gateway the runs do not agree on" run3.txt 's/^gateway=.*/gateway=0x'"$(hex 41 20)"'/'
refused "no code hash of the gateway" run2.txt '/^gateway_code_hash=/d'
refused "a setup that registered nothing on Canton" setup.txt 's/^wtkb_registered_on_canton=.*/wtkb_registered_on_canton=no/'
refused "a setup block that carried a leg" setup.txt 's/^legs=.*/legs=1/'
refused "a setup proof file that is not the recorded proof" setup-proof.hex 's/^ee/ef/'
refused "a wrapped token that run 3 does not agree on" run3.txt 's/^wtkb=.*/wtkb=0x'"$(hex 9c 20)"'/'
refused "no canton_update" run1.txt '/^canton_update=/d'
refused "an empty canton_update" run1.txt 's/^canton_update=.*/canton_update=/'
refused "a canton_update that is not an id" run2.txt 's/^canton_update=.*/canton_update=none/'
refused "the update of the record and of the gateway's holding not the same" run1.txt 's/^block_record_and_gateway_holding_in_one_update=.*/block_record_and_gateway_holding_in_one_update=no/'
refused "the update of the record and of V's holding not the same" run2.txt 's/^block_record_and_v_holding_in_one_update=.*/block_record_and_v_holding_in_one_update=no/'
refused "the update of the record and of U's holding not the same" run3.txt 's/^block_record_and_u_holding_in_one_update=.*/block_record_and_u_holding_in_one_update=no/'
refused "a deposit that left no custody" run1.txt 's/^custody_after=.*/custody_after=0/'
refused "a deposit that made no wrapped token" run1.txt 's/^wtkb_supply_after=.*/wtkb_supply_after=0.0/'
refused "a deposit whose allocation was still active" run1.txt 's/^allocation_active_after=.*/allocation_active_after=yes/'
refused "a payment that kept the 10 TKB from V" run2.txt 's/^tkb_v_after=.*/tkb_v_after=0/'
refused "a payment that moved no TKA" run2.txt 's/^tka_u_after=.*/tka_u_after=0/'
refused "no plain transfer in the payment's block" run2.txt 's/^transactions=3/transactions=2/'
refused "a deposit id that is a label" run1.txt 's/^deposit_id=.*/deposit_id=dep-1/'
refused "a payment id that is not a SHA-256" run2.txt 's/^payment_id=.*/payment_id=dvp-1/'
refused "a withdrawal that did not pay U" run3.txt 's/^tkb_u_after=.*/tkb_u_after=80/'
refused "a withdrawal that left the custody as it was" run3.txt 's/^custody_after=.*/custody_after=10/'
refused "a withdrawal block that is not after run 2's" run3.txt 's/^block=.*/block=9/'
refused "a refusal in run 4 that is not Canton's missing contract" run4.txt 's/^refusal=CONTRACT_NOT_FOUND/refusal=INVALID_ARGUMENT/'
refused "a refusal in run 4 that names another allocation" run4.txt 's/^refusal=\(.*\)(3333333344444444)/refusal=\1(0000000000000000)/'
refused "a refusal in run 4 with more than the fixed line" run4.txt 's/^refusal=.*/&, and more/'
refused "an allocation in run 4 that was not taken back" run4.txt 's/^allocation_taken_back_after_the_proof=.*/allocation_taken_back_after_the_proof=no/'
refused "a withdrawal in run 4 that was left out for another reason" run4.txt 's/^left_out_reason=.*/left_out_reason=gas/'
refused "run 4 that left out another transaction" run4.txt 's/^left_out_before_proving=.*/left_out_before_proving='"$(tx 0b)"'/'
refused "a run 4 that moved Canton's head" run4.txt 's/^canton_head_after_refusal=.*/canton_head_after_refusal=5/'
refused "a run 4 whose block records changed" run4.txt 's/^block_records_after_refusal=.*/block_records_after_refusal=5/'
refused "a block sent again without its leg that was accepted" run4.txt 's/^resubmitted_without_the_leg=.*/resubmitted_without_the_leg=accepted/'
refused "a next run that is the refused block" run4.txt 's/^next_run_block_hash=.*/next_run_block_hash='"$(tx b5)"'/'
refused "a next run with a leg" run4.txt 's/^next_run_legs=.*/next_run_legs=1/'
refused "a next run that left out one" run4.txt 's/^next_run_left_out=.*/next_run_left_out=1/'
refused "a next run proof that is not the recorded one" run4-proof.hex 's/^ee/ef/'
refused "another refusal in run 5" run5.txt 's/^refusal=.*/refusal=the sidecar refused the block: no malformed input/'
refused "a refusal in run 5 from the chain rules, not the sidecar" run5.txt 's/^refusal=.*/refusal=the block is over the gas cap/'
refused "a refusal in run 5 with more than the sidecar said" run5.txt 's/^refusal=.*/&, and more/'
refused "no word that run 5's leg was attached" run5.txt '/^leg_attached=/d'
refused "run 5's leg not attached" run5.txt 's/^leg_attached=.*/leg_attached=no/'
refused "run 5 for another payment" run5.txt 's/^payment_id=.*/payment_id='"$(hex 6e 32)"'/'
refused "run 5 with the allocation of run 4" run5.txt 's/^allocation=.*/allocation=3333333344444444/'
refused "run 5 that committed" run5.txt 's/^committed=.*/committed=yes/'
refused "a run 5 that changed the number of block records" run5.txt 's/^block_records_after=.*/block_records_after=6/'
refused "a run 5 that moved TKA" run5.txt 's/^tka_v_after=.*/tka_v_after=988/'
refused "a run 5 that took U's allocation" run5.txt 's/^allocation_active_after=.*/allocation_active_after=no/'
refused "a run 5 that did not tamper with the proof" run5.txt '/^tampered=/d'

# Without --stand-in the checker also reads each proof file: it carries the recorded programVK and rootC and the block's own hash in its
# public values, and its SHA-256 is the recorded one. A second good folder has proofs laid out that way, one per committed block (the
# setup block, runs 1 to 3, and run 4's next block).
proof() {   # <folder> <proof file> <results file> <key of the SHA-256> <block hash> [programVK first byte] [rootC first byte]
  python3 - "$@" <<'PY'
import hashlib, re, sys
folder, name, results, key, block_hash = sys.argv[1:6]
vk = sys.argv[6] if len(sys.argv) > 6 else "56"
rc = sys.argv[7] if len(sys.argv) > 7 else "78"
h = block_hash[2:] if block_hash.startswith("0x") else block_hash
public = "".join(h[i:i + 8] + "00000000" for i in range(0, len(h), 8))   # 4-byte words, each followed by four zero bytes
proof = "ee" * 768 + vk * 32 + rc * 32 + public.ljust(1024, "0")
assert len(proof) == 2688
open(f"{folder}/{name}", "w").write(proof + "\n")
sha = hashlib.sha256(bytes.fromhex(proof)).hexdigest()
text = open(f"{folder}/{results}").read()
text, n = re.subn(rf"^{key}=.*$", f"{key}={sha}", text, flags=re.M)
assert n == 1
open(f"{folder}/{results}", "w").write(text)
PY
}
full_proofs() {   # <folder>
  proof "$1" setup-proof.hex setup.txt proof_sha256 "$(tx a1)"
  proof "$1" run1-proof.hex run1.txt proof_sha256 "$(tx a2)"
  proof "$1" run2-proof.hex run2.txt proof_sha256 "$(tx a3)"
  proof "$1" run3-proof.hex run3.txt proof_sha256 "$(tx a4)"
  proof "$1" run4-proof.hex run4.txt next_run_proof_sha256 "$(tx a5)"
}
cp -r "$WORK/good" "$WORK/full"; full_proofs "$WORK/full"
"$ROOT/tests/demo_results.sh" "$WORK/full" >/dev/null || fail "the made-up good results with proofs laid out as the real ones were refused"

refused_full() {   # <what changes> <words the refusal must contain> <proof file> <results file> <key of the SHA-256> <block hash> [programVK first byte] [rootC first byte]
  rm -rf "$WORK/bad"; cp -r "$WORK/full" "$WORK/bad"
  proof "$WORK/bad" "$3" "$4" "$5" "$6" "${@:7}"
  cmp -s "$WORK/full/$3" "$WORK/bad/$3" && fail "the change '$1' did not change $3"
  local out
  if out=$("$ROOT/tests/demo_results.sh" "$WORK/bad" 2>&1); then fail "results with $1 were accepted"; fi
  grep -q "$2" <<<"$out" || fail "results with $1 were refused, but not for that: $out"
  return 0
}
refused_full "a proof with another programVK" "does not carry the recorded programVK" run1-proof.hex run1.txt proof_sha256 "$(tx a2)" 57
refused_full "a proof with another block's hash" "does not carry the block hash" run2-proof.hex run2.txt proof_sha256 "$(tx a2)"
refused_full "a proof with another rootC" "does not carry the recorded rootC" run3-proof.hex run3.txt proof_sha256 "$(tx a4)" 56 79
refused_full "run 4's proof carrying the refused block's hash" "does not carry the block hash" run4-proof.hex run4.txt next_run_proof_sha256 "$(tx b5)"
echo "demo results checks passed"
