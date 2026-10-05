#!/usr/bin/env bash
# Checks the demo's results files in demo/results/: setup.txt, run1.txt to run5.txt, and the proofs the blocks carry (setup-proof.hex,
# run1-proof.hex to run4-proof.hex). They must say what the setup and the five runs showed, and agree with each other.
# Usage: tests/demo_results.sh [folder] [--stand-in]
# --stand-in is for the rehearsal's output, whose proof is a stand-in: the proof's own keys and block hash are not checked then.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
D=${1:-$ROOT/demo/results}
standin=no; [ "${2:-}" = --stand-in ] && standin=yes
fail() { echo "FAIL: $*" >&2; exit 1; }
v() { sed -n "s/^$2=//p" "$1" | head -1; }   # value of a key in a results file
must() { [ "$(v "$1" "$2")" = "$3" ] || fail "$(basename "$1"): $2 is '$(v "$1" "$2")', expected '$3'"; }
has() { grep -qE "^$2=." "$1" || fail "$(basename "$1") has no $2"; }
same() { [ "$(v "$1" "$2")" = "$(v "$3" "${4:-$2}")" ] || fail "$(basename "$1") and $(basename "$3") disagree on $2"; }   # <file> <key> <other file> [other key]
hex() { [[ $(v "$1" "$2") =~ ^0x[0-9a-f]{$3}$ ]] || fail "$(basename "$1"): $2 is not 0x and $3 hex digits"; }
ST=$D/setup.txt R1=$D/run1.txt R2=$D/run2.txt R3=$D/run3.txt R4=$D/run4.txt R5=$D/run5.txt
for f in "$ST" "$R1" "$R2" "$R3" "$R4" "$R5" "$D"/setup-proof.hex "$D"/run{1,2,3,4}-proof.hex; do [ -f "$f" ] || fail "no $f"; done

for f in "$ST" "$R1" "$R2" "$R3" "$R4" "$R5"; do
  must "$f" format 2
  for k in date source_commit dar_sha256 package_id chain_id guest_elf_sha256 programVK rootC gateway gateway_code_hash canton daml_sdk zisk reth block; do has "$f" $k; done
  [[ $(v "$f" source_commit) =~ ^[0-9a-f]{40}$ ]] || fail "$(basename "$f"): source_commit is not a full commit hash"
  [[ $(v "$f" dar_sha256) =~ ^[0-9a-f]{64}$ ]] || fail "$(basename "$f"): dar_sha256 is not a SHA-256"
  [[ $(v "$f" guest_elf_sha256) =~ ^[0-9a-f]{64}$ ]] || fail "$(basename "$f"): guest_elf_sha256 is not a SHA-256"
  hex "$f" programVK 64; hex "$f" rootC 64; hex "$f" gateway 40; hex "$f" gateway_code_hash 64
  # Generic only: no email address, no IPv4 address.
  ! grep -qE '@|[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}([^0-9.]|$)' "$f" || fail "$(basename "$f") has an email address or an IPv4 address"
  for k in source_commit dar_sha256 package_id chain_id programVK rootC guest_elf_sha256 gateway gateway_code_hash; do same "$ST" $k "$f"; done
done
same "$ST" tka "$R2" token; same "$ST" tka "$R4" token; same "$ST" tka "$R5" token
for f in "$R1" "$R3"; do same "$ST" wtkb "$f"; done
hex "$ST" tka 40; hex "$ST" wtkb 40

# A block's proof file: the four fields one after the other, 1,344 bytes, and its SHA-256 is the one recorded.
proof_ok() {   # <proof file> <results file> <key of the SHA-256> <key of the block hash>
  local proof sum words
  proof=$(tr -d '\n' < "$1")
  { [ "${#proof}" = 2688 ] && [[ $proof =~ ^[0-9a-f]+$ ]]; } || fail "$(basename "$1") is not 1,344 bytes of lowercase hex"
  sum=$(python3 -c 'import hashlib, sys; print(hashlib.sha256(bytes.fromhex(sys.argv[1])).hexdigest())' "$proof")
  [ "$sum" = "$(v "$2" "$3")" ] || fail "$(basename "$1") does not hash to $3"
  if [ "$standin" = no ]; then
    # The proof is the proof (768), programVK (32), rootC (32), public values (512). It carries the recorded keys, and its public values
    # carry the block's hash. This only reads those fields; it does not verify the proof (the sidecar verified it when Canton committed).
    [ "0x${proof:1536:64}" = "$(v "$2" programVK)" ] || fail "$(basename "$1") does not carry the recorded programVK"
    [ "0x${proof:1600:64}" = "$(v "$2" rootC)" ] || fail "$(basename "$1") does not carry the recorded rootC"
    words=$(python3 - "${proof:1664}" <<'PY'
import sys
v = sys.argv[1]
print("".join(v[i:i + 8] for i in range(0, len(v), 16)))   # each 8-byte slot holds a 4-byte word and four zero bytes
PY
)
    local h; h=$(v "$2" "$4")
    grep -q "${h#0x}" <<<"$words" || fail "$(basename "$1") does not carry the block hash in its public values"
  fi
}

# The five committed blocks follow one another: the setup block, then runs 1 to 3, then run 4's next block. Each says where Canton's head was.
b0=$(v "$ST" block); [[ $b0 =~ ^[0-9]+$ ]] || fail "setup.txt: block is not a number"
must "$R1" block $((b0 + 1)); must "$R2" block $((b0 + 2)); must "$R3" block $((b0 + 3)); must "$R4" block $((b0 + 4)); must "$R5" block $((b0 + 5))

# Setup: one block, no legs; wTKB registered on Canton; U accepts withdrawals; U holds 100 TKB.
hex "$ST" block_hash 64; hex "$ST" deploy_tx 64; hex "$ST" register_tx 64
must "$ST" transactions 2; must "$ST" legs 0
must "$ST" canton_head_after "$b0"
must "$ST" wtkb_registered_on_canton yes; must "$ST" u_accepts_withdrawals yes; must "$ST" tkb_u 100
proof_ok "$D/setup-proof.hex" "$ST" proof_sha256 block_hash

# A run that commits one block with one leg: the block is the one after the last, Canton's head and the record are the block's, and the
# block record and the new holding were made by one Canton update.
committed_with_leg() {   # <results file> <proof file> <the file before it> <key: block hash of the one before> <kind> <update key>
  local f=$1
  hex "$f" block_hash 64
  must "$f" transactions "${7:-1}"; must "$f" legs 1; must "$f" leg_kind "$5"
  must "$f" canton_head_before "$(v "$3" block)"
  must "$f" canton_head_after "$(v "$f" block)"
  must "$f" canton_head_hash "$(v "$f" block_hash)"
  [ "$(v "$3" "$4")" != "$(v "$f" block_hash)" ] || fail "$(basename "$f") made the same block as the one before"
  must "$f" block_record_holds_the_proof yes
  [[ $(v "$f" canton_update) =~ ^[0-9a-f]{32,}$ ]] || fail "$(basename "$f"): canton_update is not a Canton update id"
  must "$f" "$6" yes
  must "$f" reth_finalized yes
  proof_ok "$2" "$f" proof_sha256 block_hash
}

# Run 1, a deposit: U's 10 TKB become the gateway's custody, and U's address holds 10 wTKB.
committed_with_leg "$R1" "$D/run1-proof.hex" "$ST" block_hash deposit block_record_and_gateway_holding_in_one_update
[[ $(v "$R1" deposit_id) =~ ^[0-9a-f]{64}$ ]] || fail "run1.txt: deposit_id is not 64 hex digits"
has "$R1" request; has "$R1" allocation; hex "$R1" evm_claim_tx 64
must "$R1" tkb_u_before 90; must "$R1" tkb_u_after 90; must "$R1" custody_before 0; must "$R1" custody_after 10
must "$R1" wtkb_u_before 0.0; must "$R1" wtkb_u_after 10.0; must "$R1" wtkb_supply_before 0.0; must "$R1" wtkb_supply_after 10.0
must "$R1" allocation_active_after no; must "$R1" request_active_after no

# Run 2, a payment: U's 10 TKB go to V; V's 10 TKA go to U; V's plain transfer is in the block and made no leg.
committed_with_leg "$R2" "$D/run2-proof.hex" "$R1" block_hash payment block_record_and_v_holding_in_one_update 3
[[ $(v "$R2" payment_id) =~ ^[0-9a-f]{64}$ ]] || fail "run2.txt: payment_id is not a SHA-256"
has "$R2" terms; has "$R2" allocation
hex "$R2" evm_approve_tx 64; hex "$R2" evm_pay_tx 64; hex "$R2" evm_plain_transfer_tx 64
must "$R2" tkb_u_before 80; must "$R2" tkb_v_before 0; must "$R2" tkb_u_after 80; must "$R2" tkb_v_after 10
must "$R2" allocation_active_after no; must "$R2" terms_active_after no
must "$R2" tka_u_before 0; must "$R2" tka_v_before 1000; must "$R2" tka_u_after 11; must "$R2" tka_v_after 989

# Run 3, a withdrawal: 4 wTKB burned, 4 TKB from the gateway to U.
committed_with_leg "$R3" "$D/run3-proof.hex" "$R2" block_hash withdrawal block_record_and_u_holding_in_one_update
hex "$R3" evm_withdraw_tx 64
must "$R3" tkb_u_before 80; must "$R3" tkb_u_after 84; must "$R3" custody_before 10; must "$R3" custody_after 6
must "$R3" wtkb_u_before 10.0; must "$R3" wtkb_u_after 6.0; must "$R3" wtkb_supply_before 10.0; must "$R3" wtkb_supply_after 6.0

# Run 4, the gap is closed: the block proven with its payment leg, U takes the allocation back, Canton refuses it for that and nothing moves.
for k in block_hash_refused next_run_block_hash; do hex "$R4" $k 64; done
[ "$(v "$R4" block_hash_refused)" != "$(v "$R4" next_run_block_hash)" ] || fail "run4.txt: the next run made the very block that was refused"
for k in evm_approve_tx evm_pay_tx evm_withdraw_to_reader_tx left_out_before_proving; do hex "$R4" $k 64; done
[ "$(v "$R4" payment_id)" != "$(v "$R2" payment_id)" ] || fail "run4.txt: the payment is run 2's"
[[ $(v "$R4" payment_id) =~ ^[0-9a-f]{64}$ ]] || fail "run4.txt: payment_id is not a SHA-256"
has "$R4" terms; has "$R4" allocation
must "$R4" left_out_before_proving "$(v "$R4" evm_withdraw_to_reader_tx)"; must "$R4" left_out_reason "no standing acceptance"
must "$R4" allocation_taken_back_after_the_proof yes
must "$R4" builder_exit 2; must "$R4" committed no; must "$R4" leg_attached yes
must "$R4" refusal "CONTRACT_NOT_FOUND: U's allocation for dvp-2 ($(v "$R4" allocation)), taken back after the proof"
must "$R4" canton_head_before "$(v "$R3" block)"; must "$R4" canton_head_after_refusal "$(v "$R3" block)"; must "$R4" canton_head_hash_after_refusal "$(v "$R3" block_hash)"
must "$R4" block_records_after_refusal "$(v "$R3" block)"
must "$R4" reth_latest_is_parent yes; must "$R4" reth_finalized_is_parent yes
must "$R4" resubmitted_without_the_leg refused; must "$R4" resubmit_refusal "the legs are not the ones the block recorded"
must "$R4" next_run_committed yes; must "$R4" next_run_transactions 1; must "$R4" next_run_legs 0; must "$R4" next_run_left_out 2
must "$R4" canton_head_after "$(v "$R4" block)"; must "$R4" canton_head_hash "$(v "$R4" next_run_block_hash)"
must "$R4" tkb_u_before 74; must "$R4" tkb_v_before 10; must "$R4" tkb_u_after 84; must "$R4" tkb_v_after 10; must "$R4" custody_after 6
must "$R4" allocation_active_after no
must "$R4" tka_u_after 11; must "$R4" tka_v_after 989; must "$R4" wtkb_u_after 6.0; must "$R4" wtkb_supply_after 6.0
must "$R4" reth_finalized yes
proof_ok "$D/run4-proof.hex" "$R4" next_run_proof_sha256 next_run_block_hash

# Run 5, a tampered proof: the same payment, with a new allocation; the sidecar refused the block and nothing moved.
hex "$R5" block_hash_built 64; hex "$R5" evm_pay_tx 64
same "$R5" payment_id "$R4"; same "$R5" evm_pay_tx "$R4"; same "$R5" token "$R4"
[ "$(v "$R5" allocation)" != "$(v "$R4" allocation)" ] || fail "run5.txt: the allocation is run 4's, which was taken back"
has "$R5" terms; has "$R5" allocation; has "$R5" tampered
must "$R5" builder_exit 2; must "$R5" committed no
must "$R5" refusal "the sidecar refused the block: no the proof does not verify"
must "$R5" leg_attached yes
must "$R5" canton_head_before "$(v "$R4" block)"; must "$R5" canton_head_after "$(v "$R4" block)"; must "$R5" canton_head_hash "$(v "$R4" next_run_block_hash)"
[ "$(v "$R5" block_records_before)" = "$(v "$R5" block_records_after)" ] || fail "run5.txt: the number of block records changed"
must "$R5" block_records_before "$(v "$R4" block)"
for k in u v; do [ "$(v "$R5" tkb_${k}_before)" = "$(v "$R5" tkb_${k}_after)" ] || fail "run5.txt: TKB of $k changed"; done
must "$R5" tkb_u_after 74; must "$R5" tkb_v_after 10
must "$R5" allocation_active_after yes
must "$R5" tka_u_after 11; must "$R5" tka_v_after 989
must "$R5" reth_latest_is_parent yes; must "$R5" reth_finalized_is_parent yes
echo "demo results are complete and consistent"
