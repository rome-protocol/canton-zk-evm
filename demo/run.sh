#!/usr/bin/env bash
# The demo, on the network network/up.sh started (with the genesis demo/prepare.sh made): a setup block and five runs, written to
# demo/results/.
#
#   Setup. In one block, V deploys TKA (an EVM test token) and the gateway makes wTKB, the wrapped form of TKB (a Canton test token).
#          On Canton: the token's rules, 100 TKB for U, wTKB registered as the EVM form of TKB, and U's standing acceptance.
#   Run 1, a deposit. U allocates 10 TKB to the gateway and signs a deposit request; U's EVM address claims 10 wTKB. The block and the
#          gateway's 10 TKB are made by one Canton update.
#   Run 2, a payment. U allocates 10 TKB to V, and U and V sign terms for one payment. V pays U 10 TKA through the gateway, and in the
#          same block sends U 1 TKA by a plain transfer. The block and V's 10 TKB are made by one Canton update; the plain transfer
#          settles nothing and is no obstacle.
#   Run 3, a withdrawal. U's address withdraws 4 wTKB to U's party. The block and U's new 4 TKB are made by one Canton update.
#   Run 4, the gap is closed. V pays U 10 TKA for a second payment. U also asks to withdraw 1 wTKB to a party that has no acceptance:
#          the builder leaves that out before proving. After the proof is made, U takes its allocation for the payment back. Canton
#          refuses the block, nothing moves, and reth goes back to the last block. The same proven block, sent again without its
#          leg, is refused too. The next builder run leaves the payment out and commits.
#   Run 5, a tampered proof. U allocates again for the payment that is still waiting, and one byte of the proof is flipped.
#          The sidecar refuses the proof; nothing moves.
#
# Every claim is checked, and the script stops at the first one that does not hold. Needs CZE_SOURCE_COMMIT (the full commit
# hash of the source that runs, as for network/smoke.sh). Prover command: $CZE_PROVE_CMD, default network/prove-timed.sh.
# Results go to $CZE_DEMO_RESULTS (default demo/results).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"
export CZE_STATE_DIR=${CZE_STATE_DIR:-$ROOT/state}
NET=$CZE_STATE_DIR/net
DEMO=$CZE_STATE_DIR/demo
RESULTS=${CZE_DEMO_RESULTS:-$ROOT/demo/results}
PY=$CZE_STATE_DIR/venv/bin/python3
fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo "== $* ($(date -u +%T))"; }
[[ ${CZE_SOURCE_COMMIT:-} =~ ^[0-9a-f]{40}$ ]] || fail "set CZE_SOURCE_COMMIT to the full commit hash of the source that is running"
for f in "$NET/chain.json" "$NET/dar.txt" "$NET/guest.txt" "$DEMO/addresses.json" "$CZE_STATE_DIR/canton/parties.env"; do [ -f "$f" ] || fail "no $f: run demo/prepare.sh, then network/up.sh"; done
# shellcheck disable=SC1091
. "$CZE_STATE_DIR/canton/parties.env"

GOOD_PROVE=${CZE_PROVE_CMD:-$ROOT/network/prove-timed.sh}
evm() { "$PY" "$ROOT/demo/evm.py" "$@"; }
canton() { "$PY" "$ROOT/demo/canton.py" "$@"; }
rpc() { curl -sf -H 'content-type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":[${2:-}]}" "http://127.0.0.1:${RETH_HTTP_PORT:-8545}" | jq -c .result; }
is() { [ "$1" = "$2" ] || fail "$3: got $1, expected $2"; }
short() { printf '%s' "${1:0:16}"; }
V_ADDR=$(jq -r .v "$DEMO/addresses.json"); U_ADDR=$(jq -r .u "$DEMO/addresses.json")
# V and U are funded by the demo's genesis, or they cannot pay for anything.
for who in "$V_ADDR" "$U_ADDR"; do
  [ "$(rpc eth_getBalance "\"$who\",\"latest\"" | jq -r .)" != 0x0 ] || fail "$who has no ether: start the network with CZE_GENESIS_FILE=$DEMO/genesis.json (demo/prepare.sh)"
done

# One builder run. Prints its JSON line; the exit status is the builder's (0 committed, 2 refused).
build() {   # <prover command>
  CZE_LEDGER_USER=builder CZE_BUILDER_PARTY=$BUILDER_PARTY CZE_FEE_RECIPIENT=0x0000000000000000000000000000000000000fee CZE_PROVE_CMD=$1 \
    "$PY" "$ROOT/builder/builder.py" once --read-as "$OPERATOR_PARTY" --read-as "$GATEWAY_PARTY" --disclosed "$DEMO/disclosed.json"
}
now() { date +%s.%N; }
secs() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.2f", b - a }'; }
proof_seconds() { sed -n 's/^prove wall time: \([0-9.]*\) s$/\1/p' "$CZE_STATE_DIR/builder/block-$1/out/prove.log" 2>/dev/null | tail -1; }
# What Canton holds of TKB, in whole tokens: U's, V's and the gateway's custody.
totals() { jq -c '{u: (.tkb.u | add // 0), v: (.tkb.v | add // 0), gateway: (.custody | add // 0)}' <<<"$1"; }
total() { jq -r ".$2" <<<"$(totals "$1")"; }
wrapped() { evm wrapped "$WTKB" "$1" "${2:-finalized}"; }   # <holder address> [latest|finalized]: {"balance", "supply"}
tka() { evm balance "$TOKEN" "$1" "${2:-finalized}" | jq -r .tka; }
latest_hash() { rpc eth_getBlockByNumber '"latest",false' | jq -r .hash; }
finalized_hash() { rpc eth_getBlockByNumber '"finalized",false' | jq -r .hash; }
record_of() { jq -c --argjson n "$2" '.blockRecords[] | select(.number == $n)' <<<"$1"; }
proof_file() { echo "$CZE_STATE_DIR/builder/block-$1/out/wrapped-proof.hex"; }

# <report> <block number> <legs> <transactions as a JSON list> <what>: a committed block's report.
committed() {
  is "$(jq -r .committed <<<"$1")" true "$5 committed ($1)"
  is "$(jq -r .number <<<"$1")" "$2" "$5's block number"
  is "$(jq -r .legs <<<"$1")" "$3" "$5's legs"
  is "$(jq -c .transactions <<<"$1")" "$4" "$5's transactions"
}
# <status> <block number> <block hash> <what>: Canton's head is that block, and its record holds the proof the prover made.
at_head() {
  is "$(jq -r '.chain[0].headNumber' <<<"$1")" "$2" "Canton's head after $4"
  is "0x$(jq -r '.chain[0].headHash' <<<"$1")" "$3" "Canton's head hash after $4"
  local record; record=$(record_of "$1" "$2")
  [ -n "$record" ] || fail "no BlockRecord for block $2"
  is "$(jq -r .proofHex <<<"$record")" "$(tr -d '\n' < "$(proof_file "$2")")" "the proof in the BlockRecord of $4"
  is "0x$(jq -r .blockHash <<<"$record")" "$3" "the block hash in the BlockRecord of $4"
  is "$(finalized_hash)" "$3" "reth's finalized block after $4"
}
# <block number> <u|v|gateway>: the BlockRecord and that party's newest TKB holding were made by one Canton update. Prints the update id.
one_update() {
  local found update
  found=$(canton settled "$1" "$2")
  update=$(jq -r .record.updateId <<<"$found")
  [ -n "$update" ] || fail "Canton gave no update id for block $1's BlockRecord"
  is "$(jq -r .holding.updateId <<<"$found")" "$update" "the update that made $2's holding and the one that made block $1's BlockRecord"
  is "$(jq -r .holding.offset <<<"$found")" "$(jq -r .record.offset <<<"$found")" "the offset of $2's holding and of block $1's BlockRecord"
  echo "$update"
}
# <report> <what>: the builder was refused by Canton and moved reth back, so its report says so.
refused() {
  is "$(jq -r .committed <<<"$1")" false "$2 was refused"
}

mkdir -p "$RESULTS"
fixed() {   # the lines every results file starts with
  echo "format=2"
  echo "date=$(date -u +%FT%TZ)"
  echo "source_commit=$CZE_SOURCE_COMMIT"
  echo "dar_sha256=$(sed -n 's/^dar_sha256=//p' "$NET/dar.txt")"
  echo "package_id=$(sed -n 's/^package_id=//p' "$NET/dar.txt")"
  echo "chain_id=$CHAIN_ID"
  echo "guest_elf_sha256=$(sed -n 's/^elf_sha256=//p' "$NET/guest.txt")"
  echo "programVK=0x$(sed -n 's/^programVK=0x//p' "$NET/guest.txt")"
  echo "rootC=$(sed -n 's/^rootC=//p' "$NET/guest.txt")"
  echo "gateway=$GATEWAY_ADDRESS"
  echo "gateway_code_hash=$GATEWAY_CODE_HASH"
  echo "canton=$CANTON_VERSION"
  echo "daml_sdk=$DAML_SDK_VERSION"
  echo "zisk=$ZISK_VERSION"
  echo "reth=$RETH_VERSION"
  echo "gpu=$(nvidia-smi --query-gpu=name,driver_version --format=csv,noheader 2>/dev/null | head -1 || true)"
}
GATEWAY_CODE_HASH=$(rpc eth_getProof "\"$GATEWAY_ADDRESS\",[],\"latest\"" | jq -r .codeHash)
[[ $GATEWAY_CODE_HASH =~ ^0x[0-9a-f]{64}$ ]] || fail "reth gave no code hash for the gateway at $GATEWAY_ADDRESS: $GATEWAY_CODE_HASH"

# ---------------------------------------------------------------- setup
step "the token rules and U's TKB on Canton"
canton upload-dars
canton setup | jq -c .
start=$(canton status)
is "$(jq -c '[.tkb, .custody, .allocations, .terms, .deposits, .acceptances]' <<<"$start")" '[{"u":[100],"v":[]},[],[],0,0,0]' "what Canton holds at the start"
start_head=$(jq -r '.chain[0].headNumber' <<<"$start")

n_setup=$((start_head + 1))
step "block $n_setup: V deploys TKA (1,000 TKA to V) and the gateway makes wTKB"
deploy_tx=$(evm deploy | jq -r .tx)
made=$(evm register v "Wrapped TKB" wTKB)
register_tx=$(jq -r .tx <<<"$made"); WTKB=$(jq -r .token <<<"$made")
t0=$(now)
set +e; out_setup=$(build "$GOOD_PROVE"); status_setup=$?; set -e
t1=$(now)
echo "$out_setup" | jq -c .
is "$status_setup" 0 "the builder's exit status for the setup block ($out_setup)"
committed "$out_setup" "$n_setup" 0 "[\"$deploy_tx\",\"$register_tx\"]" "the setup block"
is "$(jq -c .legTransactions <<<"$out_setup")" '[]' "the setup block's leg transactions"
is "$(jq -c .leftOut <<<"$out_setup")" '[]' "the setup block's left-out transactions"
hash_setup=$(jq -r .blockHash <<<"$out_setup")
receipt=$(evm receipt "$deploy_tx")
TOKEN=$(jq -r .contract <<<"$receipt")
is "$(jq -r .status <<<"$receipt")" 1 "the deployment's status"
is "$(jq -r .block <<<"$receipt")" "$n_setup" "the block TKA was deployed in"
receipt=$(evm receipt "$register_tx")
is "$(jq -r .status <<<"$receipt")" 1 "the registration's status"
is "$(jq -r .block <<<"$receipt")" "$n_setup" "the block wTKB was made in"
is "$(tka "$V_ADDR")" 1000 "V's TKA after the deployment"
is "$(wrapped "$U_ADDR" | jq -c .)" '{"balance":"0.0","supply":"0.0"}' "wTKB at the start (this also shows that the contract exists at $WTKB)"
echo "TKA is at $TOKEN, wTKB at $WTKB"

step "wTKB is registered on Canton as the EVM form of TKB, and U accepts withdrawals"
registered=$(canton register-token "$WTKB")
is "$(jq -r .evmToken <<<"$registered")" "${WTKB#0x}" "the registered token"
canton accept u | jq -c .
after_setup=$(canton status)
at_head "$after_setup" "$n_setup" "$hash_setup" "the setup block"
is "$(jq -r .acceptances <<<"$after_setup")" 1 "the standing acceptances after the setup"
{
  echo "# Setup: V deploys TKA and the gateway makes wTKB, in one block with no legs. Then wTKB is registered on Canton as the EVM form of TKB, and U accepts withdrawals."
  fixed
  echo "block=$n_setup"
  echo "block_hash=$hash_setup"
  echo "tka=$TOKEN"
  echo "wtkb=$WTKB"
  echo "deploy_tx=$deploy_tx"
  echo "register_tx=$register_tx"
  echo "transactions=2"
  echo "legs=0"
  echo "proof_seconds=$(proof_seconds "$n_setup")"
  echo "builder_total_seconds=$(secs "$t0" "$t1")"
  echo "canton_head_after=$n_setup"
  echo "wtkb_registered_on_canton=yes"
  echo "u_accepts_withdrawals=yes"
  echo "proof_sha256=$(jq -r .proofSha256 <<<"$(record_of "$after_setup" "$n_setup")")"
  echo "tkb_u=$(total "$after_setup" u)"
} > "$RESULTS/setup.txt"
jq -r .proofHex <<<"$(record_of "$after_setup" "$n_setup")" > "$RESULTS/setup-proof.hex"

# ---------------------------------------------------------------- run 1
n1=$((n_setup + 1))
step "run 1, a deposit: U puts 10 TKB with the gateway and claims 10 wTKB"
deposit=$(canton deposit dep-1 "$U_ADDR" 10)
echo "$deposit" | jq -c .
deposit_id=$(jq -r .depositId <<<"$deposit")
claim_tx=$(evm claim u "$deposit_id" "$WTKB" 10 | jq -r .tx)
mid1=$(canton status)
is "$(totals "$mid1")" '{"u":90,"v":0,"gateway":0}' "TKB after U's allocation"
is "$(jq -c '[.allocations, .deposits]' <<<"$mid1")" '[["dep-1"],1]' "the allocations and deposit requests before run 1"
t0=$(now)
set +e; out1=$(build "$GOOD_PROVE"); status1=$?; set -e
t1=$(now)
echo "$out1" | jq -c .
is "$status1" 0 "the builder's exit status in run 1 ($out1)"
committed "$out1" "$n1" 1 "[\"$claim_tx\"]" "run 1"
is "$(jq -c .legTransactions <<<"$out1")" "[\"$claim_tx\"]" "run 1's leg transactions"
is "$(jq -c .leftOut <<<"$out1")" '[]' "run 1's left-out transactions"
hash1=$(jq -r .blockHash <<<"$out1")
after1=$(canton status)
at_head "$after1" "$n1" "$hash1" "run 1"
is "$(totals "$after1")" '{"u":90,"v":0,"gateway":10}' "TKB after run 1 (U's allocation is now the gateway's custody)"
is "$(jq -c '[.allocations, .deposits]' <<<"$after1")" '[[],0]' "the allocations and deposit requests after run 1"
is "$(wrapped "$U_ADDR" | jq -c .)" '{"balance":"10.0","supply":"10.0"}' "U's wTKB and the supply at the finalized block after run 1"
is "$(evm receipt "$claim_tx" | jq -r .status)" 1 "the claim's status"
update1=$(one_update "$n1" gateway)
gas1=$(rpc eth_getBlockByNumber "\"0x$(printf '%x' "$n1")\",false" | jq -r .gasUsed)
{
  echo "# Run 1, a deposit: U's allocation of 10 TKB to the gateway is executed, and in the same Canton transaction the block is recorded; U's address holds 10 wTKB."
  echo "# Contract ids are shortened to their first 16 hex digits. after_proof_seconds runs from the moment the proof file was written to the end of the builder's run."
  fixed
  echo "block=$n1"
  echo "block_hash=$hash1"
  echo "wtkb=$WTKB"
  echo "deposit_id=$deposit_id"
  echo "evm_claim_tx=$claim_tx"
  echo "transactions=1"
  echo "gas_used=$((gas1))"
  echo "legs=1"
  echo "leg_kind=deposit"
  echo "request=$(short "$(jq -r .request <<<"$deposit")")"
  echo "allocation=$(short "$(jq -r .allocation <<<"$deposit")")"
  echo "proof_seconds=$(proof_seconds "$n1")"
  echo "after_proof_seconds=$(secs "$(stat -c %.9Y "$(proof_file "$n1")")" "$t1")"
  echo "builder_total_seconds=$(secs "$t0" "$t1")"
  echo "proof_sha256=$(jq -r .proofSha256 <<<"$(record_of "$after1" "$n1")")"
  echo "canton_head_before=$n_setup"
  echo "canton_head_after=$n1"
  echo "canton_head_hash=$hash1"
  echo "block_record_holds_the_proof=yes"
  echo "canton_update=$update1"
  echo "block_record_and_gateway_holding_in_one_update=yes"
  echo "tkb_u_before=$(total "$mid1" u)"
  echo "tkb_u_after=$(total "$after1" u)"
  echo "custody_before=$(total "$mid1" gateway)"
  echo "custody_after=$(total "$after1" gateway)"
  echo "wtkb_u_before=0.0"
  echo "wtkb_u_after=$(wrapped "$U_ADDR" | jq -r .balance)"
  echo "wtkb_supply_before=0.0"
  echo "wtkb_supply_after=$(wrapped "$U_ADDR" | jq -r .supply)"
  echo "allocation_active_after=no"
  echo "request_active_after=no"
  echo "reth_finalized=yes"
} > "$RESULTS/run1.txt"
jq -r .proofHex <<<"$(record_of "$after1" "$n1")" > "$RESULTS/run1-proof.hex"

# ---------------------------------------------------------------- run 2
n2=$((n1 + 1))
step "run 2, a payment: V pays U 10 TKA through the gateway, and U's 10 TKB go to V"
tka_u_before=$(tka "$U_ADDR"); tka_v_before=$(tka "$V_ADDR")
dvp1=$(canton dvp dvp-1 "$TOKEN" "$U_ADDR" 10)
echo "$dvp1" | jq -c .
payment1=$(jq -r .id <<<"$dvp1")
is "$payment1" "$(canton payment-id dvp-1 | jq -r .id)" "the payment id of dvp-1"
approve1_tx=$(evm approve v "$TOKEN" gateway 10 | jq -r .tx)
pay1_tx=$(evm pay v "$payment1" "$TOKEN" "$U_ADDR" 10 | jq -r .tx)
plain1_tx=$(evm transfer "$TOKEN" 1 | jq -r .tx)   # V sends U 1 TKA with no Canton side: it is not this payment
mid2=$(canton status)
is "$(totals "$mid2")" '{"u":80,"v":0,"gateway":10}' "TKB after U's allocation to V"
is "$(jq -c '[.allocations, .terms]' <<<"$mid2")" '[["dvp-1"],1]' "the allocations and terms before run 2"
t0=$(now)
set +e; out2=$(build "$GOOD_PROVE"); status2=$?; set -e
t1=$(now)
echo "$out2" | jq -c .
is "$status2" 0 "the builder's exit status in run 2 ($out2)"
committed "$out2" "$n2" 1 "[\"$approve1_tx\",\"$pay1_tx\",\"$plain1_tx\"]" "run 2"
is "$(jq -c .legTransactions <<<"$out2")" "[\"$pay1_tx\"]" "run 2's leg transactions (the plain transfer made none)"
is "$(jq -c .leftOut <<<"$out2")" '[]' "run 2's left-out transactions"
hash2=$(jq -r .blockHash <<<"$out2")
after2=$(canton status)
at_head "$after2" "$n2" "$hash2" "run 2"
is "$(totals "$after2")" '{"u":80,"v":10,"gateway":10}' "TKB after run 2 (U's allocation is now V's holding)"
is "$(jq -c '[.allocations, .terms]' <<<"$after2")" '[[],0]' "the allocations and terms after run 2"
is "$(tka "$U_ADDR")" $((tka_u_before + 11)) "U's TKA after run 2 (10 paid and 1 sent)"
is "$(tka "$V_ADDR")" $((tka_v_before - 11)) "V's TKA after run 2"
for tx in "$approve1_tx" "$pay1_tx" "$plain1_tx"; do is "$(evm receipt "$tx" | jq -r .status)" 1 "the status of $tx"; done
update2=$(one_update "$n2" v)
gas2=$(rpc eth_getBlockByNumber "\"0x$(printf '%x' "$n2")\",false" | jq -r .gasUsed)
{
  echo "# Run 2, a payment: V pays U 10 TKA through the gateway with the payment id of U, V and \"dvp-1\"; in the same Canton transaction U's allocation of 10 TKB to V is executed."
  echo "# In the same block V also sends U 1 TKA by a plain transfer. It is not this payment, so it settles nothing, and it does not get in the way."
  echo "# Contract ids are shortened to their first 16 hex digits. after_proof_seconds runs from the moment the proof file was written to the end of the builder's run."
  fixed
  echo "block=$n2"
  echo "block_hash=$hash2"
  echo "token=$TOKEN"
  echo "payment_id=$payment1"
  echo "evm_approve_tx=$approve1_tx"
  echo "evm_pay_tx=$pay1_tx"
  echo "evm_plain_transfer_tx=$plain1_tx"
  echo "transactions=3"
  echo "gas_used=$((gas2))"
  echo "legs=1"
  echo "leg_kind=payment"
  echo "terms=$(short "$(jq -r .terms <<<"$dvp1")")"
  echo "allocation=$(short "$(jq -r .allocation <<<"$dvp1")")"
  echo "proof_seconds=$(proof_seconds "$n2")"
  echo "after_proof_seconds=$(secs "$(stat -c %.9Y "$(proof_file "$n2")")" "$t1")"
  echo "builder_total_seconds=$(secs "$t0" "$t1")"
  echo "proof_sha256=$(jq -r .proofSha256 <<<"$(record_of "$after2" "$n2")")"
  echo "canton_head_before=$n1"
  echo "canton_head_after=$n2"
  echo "canton_head_hash=$hash2"
  echo "block_record_holds_the_proof=yes"
  echo "canton_update=$update2"
  echo "block_record_and_v_holding_in_one_update=yes"
  echo "tkb_u_before=$(total "$mid2" u)"
  echo "tkb_v_before=$(total "$mid2" v)"
  echo "tkb_u_after=$(total "$after2" u)"
  echo "tkb_v_after=$(total "$after2" v)"
  echo "allocation_active_after=no"
  echo "terms_active_after=no"
  echo "tka_u_before=$tka_u_before"
  echo "tka_v_before=$tka_v_before"
  echo "tka_u_after=$(tka "$U_ADDR")"
  echo "tka_v_after=$(tka "$V_ADDR")"
  echo "reth_finalized=yes"
} > "$RESULTS/run2.txt"
jq -r .proofHex <<<"$(record_of "$after2" "$n2")" > "$RESULTS/run2-proof.hex"

# ---------------------------------------------------------------- run 3
n3=$((n2 + 1))
step "run 3, a withdrawal: U's address burns 4 wTKB, and 4 TKB go from the gateway to U"
withdraw_tx=$(evm withdraw u "$WTKB" 4 "$U_PARTY" | jq -r .tx)
t0=$(now)
set +e; out3=$(build "$GOOD_PROVE"); status3=$?; set -e
t1=$(now)
echo "$out3" | jq -c .
is "$status3" 0 "the builder's exit status in run 3 ($out3)"
committed "$out3" "$n3" 1 "[\"$withdraw_tx\"]" "run 3"
is "$(jq -c .legTransactions <<<"$out3")" "[\"$withdraw_tx\"]" "run 3's leg transactions"
is "$(jq -c .leftOut <<<"$out3")" '[]' "run 3's left-out transactions"
hash3=$(jq -r .blockHash <<<"$out3")
after3=$(canton status)
at_head "$after3" "$n3" "$hash3" "run 3"
is "$(totals "$after3")" '{"u":84,"v":10,"gateway":6}' "TKB after run 3 (4 TKB from the gateway to U)"
is "$(wrapped "$U_ADDR" | jq -c .)" '{"balance":"6.0","supply":"6.0"}' "U's wTKB and the supply at the finalized block after run 3"
is "$(evm receipt "$withdraw_tx" | jq -r .status)" 1 "the withdrawal's status"
update3=$(one_update "$n3" u)
gas3=$(rpc eth_getBlockByNumber "\"0x$(printf '%x' "$n3")\",false" | jq -r .gasUsed)
{
  echo "# Run 3, a withdrawal: U's address burns 4 wTKB; in the same Canton transaction the gateway pays 4 TKB to U, who had accepted withdrawals."
  echo "# after_proof_seconds runs from the moment the proof file was written to the end of the builder's run."
  fixed
  echo "block=$n3"
  echo "block_hash=$hash3"
  echo "wtkb=$WTKB"
  echo "evm_withdraw_tx=$withdraw_tx"
  echo "transactions=1"
  echo "gas_used=$((gas3))"
  echo "legs=1"
  echo "leg_kind=withdrawal"
  echo "proof_seconds=$(proof_seconds "$n3")"
  echo "after_proof_seconds=$(secs "$(stat -c %.9Y "$(proof_file "$n3")")" "$t1")"
  echo "builder_total_seconds=$(secs "$t0" "$t1")"
  echo "proof_sha256=$(jq -r .proofSha256 <<<"$(record_of "$after3" "$n3")")"
  echo "canton_head_before=$n2"
  echo "canton_head_after=$n3"
  echo "canton_head_hash=$hash3"
  echo "block_record_holds_the_proof=yes"
  echo "canton_update=$update3"
  echo "block_record_and_u_holding_in_one_update=yes"
  echo "tkb_u_before=$(total "$after2" u)"
  echo "tkb_u_after=$(total "$after3" u)"
  echo "custody_before=$(total "$after2" gateway)"
  echo "custody_after=$(total "$after3" gateway)"
  echo "wtkb_u_before=10.0"
  echo "wtkb_u_after=$(wrapped "$U_ADDR" | jq -r .balance)"
  echo "wtkb_supply_before=10.0"
  echo "wtkb_supply_after=$(wrapped "$U_ADDR" | jq -r .supply)"
  echo "reth_finalized=yes"
} > "$RESULTS/run3.txt"
jq -r .proofHex <<<"$(record_of "$after3" "$n3")" > "$RESULTS/run3-proof.hex"

# ---------------------------------------------------------------- run 4
n4=$((n3 + 1))
step "run 4, the gap is closed: the block is proven, then U takes its allocation back"
tka_u_before=$(tka "$U_ADDR"); tka_v_before=$(tka "$V_ADDR")
dvp2=$(canton dvp dvp-2 "$TOKEN" "$U_ADDR" 10)
echo "$dvp2" | jq -c .
payment2=$(jq -r .id <<<"$dvp2")
approve2_tx=$(evm approve v "$TOKEN" gateway 10 | jq -r .tx)
pay2_tx=$(evm pay v "$payment2" "$TOKEN" "$U_ADDR" 10 | jq -r .tx)
# U's party is not the reader's: the reader has made no acceptance, so this withdrawal has no Canton side.
nowhere_tx=$(evm withdraw u "$WTKB" 1 "$READER_PARTY" | jq -r .tx)
before4=$(canton status)
is "$(totals "$before4")" '{"u":74,"v":10,"gateway":6}' "TKB after U's allocation for dvp-2"
is "$(jq -c '[.allocations, .terms]' <<<"$before4")" '[["dvp-2"],1]' "the allocations and terms before run 4"
t0=$(now)
set +e; out4=$(CZE_WITHDRAW_REAL_PROVE_CMD=$GOOD_PROVE CZE_WITHDRAW_LABEL=dvp-2 build "$ROOT/demo/prove-then-withdraw.sh"); status4=$?; set -e
t1=$(now)
echo "$out4" | jq -c .
is "$status4" 2 "the builder's exit status for the block U took its allocation back from ($out4)"
refused "$out4" "the block U took its allocation back from"
alloc4=$(jq -r .allocation <<<"$dvp2")
reason4=$(jq -r .reason <<<"$out4")
grep -q '"code":"CONTRACT_NOT_FOUND"' <<<"$reason4" || fail "Canton refused the block, but not because U's allocation for dvp-2 was gone: $out4"
grep -qF "$alloc4" <<<"$reason4" || fail "Canton's refusal does not name U's allocation for dvp-2: $out4"
is "$(jq -c .leftOut <<<"$out4" | jq -c 'map(.transaction)')" "[\"$nowhere_tx\"]" "the transactions left out before proving"
grep -q 'no standing acceptance' <<<"$(jq -r '.leftOut[0].reason' <<<"$out4")" || fail "the withdrawal to the reader was left out for another reason: $(jq -c .leftOut <<<"$out4")"
is "$(jq -c .keptTransactions <<<"$out4")" "[\"$approve2_tx\",\"$pay2_tx\"]" "the transactions of the refused block"
is "$(jq -c .legTransactions <<<"$out4")" "[\"$pay2_tx\"]" "the refused block's leg transactions"
hash4_refused=$(jq -r .blockHash <<<"$out4")
seconds4=$(proof_seconds "$n4")
advance4=$CZE_STATE_DIR/builder/block-$n4/advance.json
[ -f "$advance4" ] || fail "the builder did not save the Advance it sent ($advance4)"
is "$(jq -r '.legs | length' "$advance4")" 1 "the legs in the saved Advance"
refused_state=$(canton status)
is "$(jq -c '[.chain, .blockRecords]' <<<"$refused_state")" "$(jq -c '[.chain, .blockRecords]' <<<"$after3")" "Canton's chain record and block records after the refusal"
is "$(totals "$refused_state")" '{"u":84,"v":10,"gateway":6}' "TKB after the refusal (U has its allocation back as a holding; the gateway paid nothing)"
is "$(jq -c '[.allocations, .terms]' <<<"$refused_state")" '[[],1]' "the allocations and terms after the refusal"
is "$(latest_hash)" "$hash3" "reth's latest block after the refusal"
is "$(finalized_hash)" "$hash3" "reth's finalized block after the refusal"
is "$(tka "$U_ADDR" latest)" "$tka_u_before" "U's TKA after the refusal"
is "$(tka "$V_ADDR" latest)" "$tka_v_before" "V's TKA after the refusal"
is "$(wrapped "$U_ADDR" latest | jq -c .)" '{"balance":"6.0","supply":"6.0"}' "U's wTKB and the supply after the refusal"

step "the same proven block, sent again without its leg"
set +e; again=$(canton resubmit "$advance4"); status_again=$?; set -e
echo "$again" | jq -c .
is "$status_again" 2 "the exit status of the block sent again without its leg ($again)"
is "$(jq -r .committed <<<"$again")" false "the block sent again without its leg was refused"
grep -q 'the legs are not the ones the block recorded' <<<"$(jq -r .reason <<<"$again")" || fail "Canton refused the block sent again, but not for its legs: $again"
is "$(canton status | jq -c '[.chain, .blockRecords]')" "$(jq -c '[.chain, .blockRecords]' <<<"$after3")" "Canton's chain record and block records after the block was sent again"

step "the next builder run leaves the payment out and commits"
t2=$(now)
set +e; out4b=$(build "$GOOD_PROVE"); status4b=$?; set -e
t3=$(now)
echo "$out4b" | jq -c .
is "$status4b" 0 "the builder's exit status in the next run ($out4b)"
committed "$out4b" "$n4" 0 "[\"$approve2_tx\"]" "the next run"
is "$(jq -c '.leftOut | map(.transaction) | sort' <<<"$out4b")" "$(jq -nc --arg a "$pay2_tx" --arg b "$nowhere_tx" '[$a, $b] | sort')" "the transactions the next run left out"
grep -q 'payment leg has no Canton side' <<<"$(jq -r --arg t "$pay2_tx" '.leftOut[] | select(.transaction == $t) | .reason' <<<"$out4b")" || fail "the payment was left out for another reason: $(jq -c .leftOut <<<"$out4b")"
hash4=$(jq -r .blockHash <<<"$out4b")
[ "$hash4" != "$hash4_refused" ] || fail "the next run made the very block that was refused"
after4=$(canton status)
at_head "$after4" "$n4" "$hash4" "the next run"
is "$(totals "$after4")" '{"u":84,"v":10,"gateway":6}' "TKB after the next run (as after run 3)"
is "$(jq -c '[.allocations, .terms]' <<<"$after4")" '[[],1]' "the allocations and terms after the next run"
is "$(tka "$U_ADDR")" "$tka_u_before" "U's TKA after the next run (as after run 3)"
is "$(tka "$V_ADDR")" "$tka_v_before" "V's TKA after the next run (as after run 3)"
is "$(wrapped "$U_ADDR" | jq -c .)" '{"balance":"6.0","supply":"6.0"}' "U's wTKB and the supply after the next run (as after run 3)"
{
  echo "# Run 4, the gap is closed: V pays U 10 TKA for the payment \"dvp-2\" and U's allocation for it is there when the builder looks. U also asks to withdraw 1 wTKB to the reader party,"
  echo "# which has not accepted withdrawals: the builder leaves that out before it proves anything. After the proof is made, U takes its allocation back (demo/prove-then-withdraw.sh)."
  echo "# Canton refuses the block and nothing moves; reth goes back to the last block. The same proven block sent again without its leg is refused too."
  echo "# The next builder run leaves the payment out and commits what is left. Contract ids are shortened to their first 16 hex digits."
  fixed
  echo "block=$n4"
  echo "block_hash_refused=$hash4_refused"
  echo "token=$TOKEN"
  echo "payment_id=$payment2"
  echo "evm_approve_tx=$approve2_tx"
  echo "evm_pay_tx=$pay2_tx"
  echo "evm_withdraw_to_reader_tx=$nowhere_tx"
  echo "left_out_before_proving=$nowhere_tx"
  echo "left_out_reason=no standing acceptance"
  echo "terms=$(short "$(jq -r .terms <<<"$dvp2")")"
  echo "allocation=$(short "$(jq -r .allocation <<<"$dvp2")")"
  echo "allocation_taken_back_after_the_proof=yes"
  echo "builder_exit=2"
  echo "committed=no"
  echo "refusal=CONTRACT_NOT_FOUND: U's allocation for dvp-2 ($(short "$alloc4")), taken back after the proof"
  echo "leg_attached=yes"
  echo "proof_seconds=$seconds4"
  echo "builder_total_seconds=$(secs "$t0" "$t1")"
  echo "canton_head_before=$n3"
  echo "canton_head_after_refusal=$n3"
  echo "canton_head_hash_after_refusal=$hash3"
  echo "block_records_after_refusal=$(jq -r '.blockRecords | length' <<<"$refused_state")"
  echo "reth_latest_is_parent=yes"
  echo "reth_finalized_is_parent=yes"
  echo "resubmitted_without_the_leg=refused"
  echo "resubmit_refusal=the legs are not the ones the block recorded"
  echo "next_run_block_hash=$hash4"
  echo "next_run_committed=yes"
  echo "next_run_transactions=1"
  echo "next_run_legs=0"
  echo "next_run_left_out=2"
  echo "next_run_proof_sha256=$(jq -r .proofSha256 <<<"$(record_of "$after4" "$n4")")"
  echo "next_run_builder_total_seconds=$(secs "$t2" "$t3")"
  echo "canton_head_after=$n4"
  echo "canton_head_hash=$hash4"
  echo "tkb_u_before=$(total "$before4" u)"
  echo "tkb_v_before=$(total "$before4" v)"
  echo "tkb_u_after=$(total "$after4" u)"
  echo "tkb_v_after=$(total "$after4" v)"
  echo "custody_after=$(total "$after4" gateway)"
  echo "allocation_active_after=no"
  echo "tka_u_after=$(tka "$U_ADDR")"
  echo "tka_v_after=$(tka "$V_ADDR")"
  echo "wtkb_u_after=$(wrapped "$U_ADDR" | jq -r .balance)"
  echo "wtkb_supply_after=$(wrapped "$U_ADDR" | jq -r .supply)"
  echo "reth_finalized=yes"
} > "$RESULTS/run4.txt"
jq -r .proofHex <<<"$(record_of "$after4" "$n4")" > "$RESULTS/run4-proof.hex"

# ---------------------------------------------------------------- run 5
n5=$((n4 + 1))
step "run 5, the tampered proof: U allocates again for dvp-2, whose payment is still waiting; one byte of the proof is flipped"
# V's payment for dvp-2 is still in reth's pool (it had no Canton side, so it was left out). U makes a new allocation and new terms
# for the same payment id: the old terms are still there, but their allocation is gone, so the builder takes the new ones.
dvp2b=$(canton dvp dvp-2 "$TOKEN" "$U_ADDR" 10)
echo "$dvp2b" | jq -c .
is "$(jq -r .id <<<"$dvp2b")" "$payment2" "the payment id of the new terms"
before5=$(canton status)
is "$(totals "$before5")" '{"u":74,"v":10,"gateway":6}' "TKB before run 5"
is "$(jq -c '[.allocations, .terms]' <<<"$before5")" '[["dvp-2"],2]' "the allocations and terms before run 5"
t0=$(now)
set +e; out5=$(CZE_TAMPER_REAL_PROVE_CMD=$GOOD_PROVE build "$ROOT/demo/prove-tampered.sh"); status5=$?; set -e
t1=$(now)
echo "$out5" | jq -c .
is "$status5" 2 "the builder's exit status in run 5 ($out5)"
refused "$out5" "run 5"
reason5=$(jq -r .reason <<<"$out5")
# The sidecar's own answer to a proof that does not verify, and nothing else: not another check of the Advance choice.
refusal5=$(grep -o 'the sidecar refused the block: [^"\\]*' <<<"$reason5" | head -1 | cut -c1-200)
is "$refusal5" "the sidecar refused the block: no the proof does not verify" "Canton's refusal of run 5 ($reason5)"
# The refused block carried its payment leg: only the proof was wrong.
is "$(jq -c .keptTransactions <<<"$out5")" "[\"$pay2_tx\"]" "run 5's transactions"
is "$(jq -c .legTransactions <<<"$out5")" "[\"$pay2_tx\"]" "run 5's leg transactions"
is "$(jq -c '.leftOut | map(.transaction)' <<<"$out5")" "[\"$nowhere_tx\"]" "run 5's left-out transactions"
after5=$(canton status)
is "$(jq -c '[.chain, (.blockRecords | map(.number))]' <<<"$after5")" "$(jq -c '[.chain, (.blockRecords | map(.number))]' <<<"$after4")" "Canton's chain record and block records after run 5"
is "$(totals "$after5")" '{"u":74,"v":10,"gateway":6}' "TKB after run 5"
is "$(jq -c '[.allocations, .terms]' <<<"$after5")" '[["dvp-2"],2]' "the allocations and terms after run 5 (the allocation is still U's, still locked)"
is "$(latest_hash)" "$hash4" "reth's latest block after run 5"
is "$(finalized_hash)" "$hash4" "reth's finalized block after run 5"
is "$(tka "$U_ADDR")" "$tka_u_before" "U's TKA after run 5"
is "$(tka "$V_ADDR")" "$tka_v_before" "V's TKA after run 5"
is "$(wrapped "$U_ADDR" | jq -c .)" '{"balance":"6.0","supply":"6.0"}' "U's wTKB and the supply after run 5"
{
  echo "# Run 5, the tampered proof: U allocates again for the payment \"dvp-2\", which V's transaction is still waiting to make, and the builder's prover command flips one hex digit of the wrapped proof"
  echo "# (byte 100) after the real prover made it. Advance is refused. Nothing moves on Canton, and reth goes back to the parent. Contract ids are shortened to their first 16 hex digits."
  fixed
  echo "block=$n5"
  echo "block_hash_built=$(jq -r .blockHash <<<"$out5")"
  echo "token=$TOKEN"
  echo "payment_id=$payment2"
  echo "evm_pay_tx=$pay2_tx"
  echo "tampered=byte 100 of the wrapped proof, first hex digit flipped"
  echo "builder_exit=2"
  echo "committed=no"
  echo "refusal=$refusal5"
  echo "leg_attached=yes"
  echo "terms=$(short "$(jq -r .terms <<<"$dvp2b")")"
  echo "allocation=$(short "$(jq -r .allocation <<<"$dvp2b")")"
  echo "proof_seconds=$(proof_seconds "$n5")"
  echo "builder_total_seconds=$(secs "$t0" "$t1")"
  echo "canton_head_before=$n4"
  echo "canton_head_after=$n4"
  echo "canton_head_hash=$hash4"
  echo "block_records_before=$(jq -r '.blockRecords | length' <<<"$after4")"
  echo "block_records_after=$(jq -r '.blockRecords | length' <<<"$after5")"
  echo "tkb_u_before=$(total "$before5" u)"
  echo "tkb_v_before=$(total "$before5" v)"
  echo "tkb_u_after=$(total "$after5" u)"
  echo "tkb_v_after=$(total "$after5" v)"
  echo "allocation_active_after=yes"
  echo "tka_u_after=$(tka "$U_ADDR")"
  echo "tka_v_after=$(tka "$V_ADDR")"
  echo "reth_latest_is_parent=yes"
  echo "reth_finalized_is_parent=yes"
} > "$RESULTS/run5.txt"
echo "== demo passed; facts in $RESULTS"
