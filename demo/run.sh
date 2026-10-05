#!/usr/bin/env bash
# The first proof, on the network network/up.sh started (and demo/prepare.sh's genesis): two runs, written to demo/results/.
#
#   1. TKA is deployed on the EVM (V gets 1,000), in a block of its own, proven and committed.
#   2. Run 1, the good block: V sends U 10 TKA. On Canton, U allocates 10 TKB to V and U and V sign the terms "if U's TKA balance rose by 10
#      in the proven block, execute that allocation". The builder builds the block, has it proven, attaches the leg and
#      submits one Advance. Canton commits the block and the allocation together.
#   3. Run 2, the tampered proof: V sends U 10 more TKA, a second allocation and terms are made (the same rise of 10), and the
#      builder's prover command flips one byte of the proof (demo/prove-tampered.sh). Advance is refused; nothing moves on
#      Canton, and reth goes back to the parent.
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
# V is funded by the demo's genesis, or it cannot pay for anything.
[ "$(rpc eth_getBalance "\"$V_ADDR\",\"latest\"" | jq -r .)" != 0x0 ] || fail "V has no ether: start the network with CZE_GENESIS_FILE=$DEMO/genesis.json (demo/prepare.sh)"

# One builder run. Prints its JSON line; the exit status is the builder's (0 committed, 2 refused).
build() {   # <prover command>
  CZE_LEDGER_USER=builder CZE_BUILDER_PARTY=$BUILDER_PARTY CZE_FEE_RECIPIENT=0x0000000000000000000000000000000000000fee CZE_PROVE_CMD=$1 \
    "$PY" "$ROOT/builder/builder.py" once --read-as "$OPERATOR_PARTY" --disclosed "$DEMO/disclosed.json"
}
head_number() { canton status | jq -r '.chain[0].headNumber'; }
now() { date +%s.%N; }
secs() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.2f", b - a }'; }
proof_seconds() { sed -n 's/^prove wall time: \([0-9.]*\) s$/\1/p' "$CZE_STATE_DIR/builder/block-$1/out/prove.log" 2>/dev/null | tail -1; }

mkdir -p "$RESULTS"
fixed() {   # the lines every results file starts with
  echo "format=1"
  echo "date=$(date -u +%FT%TZ)"
  echo "source_commit=$CZE_SOURCE_COMMIT"
  echo "dar_sha256=$(sed -n 's/^dar_sha256=//p' "$NET/dar.txt")"
  echo "package_id=$(sed -n 's/^package_id=//p' "$NET/dar.txt")"
  echo "chain_id=$CHAIN_ID"
  echo "guest_elf_sha256=$(sed -n 's/^elf_sha256=//p' "$NET/guest.txt")"
  echo "programVK=0x$(sed -n 's/^programVK=0x//p' "$NET/guest.txt")"
  echo "rootC=$(sed -n 's/^rootC=//p' "$NET/guest.txt")"
  echo "canton=$CANTON_VERSION"
  echo "daml_sdk=$DAML_SDK_VERSION"
  echo "zisk=$ZISK_VERSION"
  echo "reth=$RETH_VERSION"
  echo "gpu=$(nvidia-smi --query-gpu=name,driver_version --format=csv,noheader 2>/dev/null | head -1 || true)"
}

step "the token rules and U's TKB holding on Canton"
canton upload-dars
canton setup | jq -c .
start=$(canton status)
is "$(jq -c .tkb <<<"$start")" '{"u":[100],"v":[]}' "U's and V's TKB holdings at the start"
start_head=$(jq -r '.chain[0].headNumber' <<<"$start")

step "block $((start_head + 1)): V deploys TKA (1,000 TKA to V)"
deploy_tx=$(evm deploy | jq -r .tx)
out=$(build "$GOOD_PROVE") || fail "the builder did not commit the deployment block: $out"
is "$(jq -r .committed <<<"$out")" true "the deployment block committed"
is "$(jq -r .number <<<"$out")" $((start_head + 1)) "the deployment block's number"
is "$(jq -r '.transactions | length' <<<"$out")" 1 "the deployment block's transactions"
receipt=$(evm receipt "$deploy_tx")
TOKEN=$(jq -r .contract <<<"$receipt")
is "$(jq -r .status <<<"$receipt")" 1 "the deployment's status"
is "$(jq -r .block <<<"$receipt")" $((start_head + 1)) "the block TKA was deployed in"
is "$(evm balance "$TOKEN" "$V_ADDR" | jq -r .tka)" 1000 "V's TKA after the deployment"
echo "TKA is at $TOKEN"

# ---------------------------------------------------------------- run 1
step "run 1, the good block: V sends U 10 TKA, and U's 10 TKB go to V"
before1=$(canton status)
is "$(jq -c '.chain[0] | .headNumber' <<<"$before1")" $((start_head + 1)) "Canton's head before run 1"
tka_u_before=$(evm balance "$TOKEN" "$U_ADDR" | jq -r .tka); tka_v_before=$(evm balance "$TOKEN" "$V_ADDR" | jq -r .tka)
transfer1=$(evm transfer "$TOKEN" 10 | jq -r .tx)
dvp1=$(canton dvp dvp-1 "$TOKEN" "$U_ADDR" 10)
echo "$dvp1" | jq -c .
mid1=$(canton status)
is "$(jq -c '.tkb' <<<"$mid1")" '{"u":[90],"v":[]}' "TKB after U's allocation"
is "$(jq -c '.allocations' <<<"$mid1")" '["dvp-1"]' "the active allocations before run 1"
is "$(jq -r .terms <<<"$mid1")" 1 "the active terms before run 1"
n1=$((start_head + 2))
t0=$(now)
set +e; out1=$(build "$GOOD_PROVE"); status1=$?; set -e
t1=$(now)
echo "$out1" | jq -c .
is "$status1" 0 "the builder's exit status in run 1 ($out1)"
is "$(jq -r .committed <<<"$out1")" true "run 1 committed"
is "$(jq -r .number <<<"$out1")" "$n1" "run 1's block number"
is "$(jq -r .legs <<<"$out1")" 1 "run 1's legs"
is "$(jq -c .skippedTerms <<<"$out1")" '[]' "run 1's skipped terms"
is "$(jq -c .transactions <<<"$out1")" "[\"$transfer1\"]" "run 1's transactions"
hash1=$(jq -r .blockHash <<<"$out1")
after1=$(canton status)
is "$(jq -r '.chain[0].headNumber' <<<"$after1")" "$n1" "Canton's head after run 1"
is "0x$(jq -r '.chain[0].headHash' <<<"$after1")" "$hash1" "Canton's head hash after run 1"
record1=$(jq -c --argjson n "$n1" '.blockRecords[] | select(.number == $n)' <<<"$after1")
[ -n "$record1" ] || fail "no BlockRecord for block $n1"
proof_file1=$CZE_STATE_DIR/builder/block-$n1/out/wrapped-proof.hex
is "$(jq -r .proofHex <<<"$record1")" "$(tr -d '\n' < "$proof_file1")" "the proof in the BlockRecord"
is "0x$(jq -r .blockHash <<<"$record1")" "$hash1" "the block hash in the BlockRecord"
is "$(jq -c .tkb <<<"$after1")" '{"u":[90],"v":[10]}' "TKB after run 1 (U's allocation is now V's holding)"
is "$(jq -c .allocations <<<"$after1")" '[]' "the active allocations after run 1"
is "$(jq -r .terms <<<"$after1")" 0 "the active terms after run 1"
is "$(rpc eth_getBlockByNumber '"finalized",false' | jq -r .hash)" "$hash1" "reth's finalized block after run 1"
is "$(evm balance "$TOKEN" "$U_ADDR" | jq -r .tka)" 10 "U's TKA after run 1"
is "$(evm balance "$TOKEN" "$V_ADDR" | jq -r .tka)" 990 "V's TKA after run 1"
# The block and the allocation settled in one Canton transaction: the update that made the BlockRecord is the one that made V's holding,
# both as the users participant reports them.
settled1=$(canton settled "$n1")
update1=$(jq -r .record.updateId <<<"$settled1")
[ -n "$update1" ] || fail "Canton gave no update id for run 1's BlockRecord"
is "$(jq -r .holding.updateId <<<"$settled1")" "$update1" "the update that made V's holding and the one that made the BlockRecord"
is "$(jq -r .holding.offset <<<"$settled1")" "$(jq -r .record.offset <<<"$settled1")" "the offset of V's holding and of the BlockRecord"
gas1=$(rpc eth_getBlockByNumber "\"0x$(printf '%x' "$n1")\",false" | jq -r .gasUsed)
{
  echo "# Run 1, the good block: V sends U 10 TKA on the EVM, and in the same Canton transaction U's allocation of 10 TKB goes to V."
  echo "# The terms U and V signed: if U's TKA balance (TKA's balance mapping, slot 0) rose by 10 in the proven block, execute the allocation."
  echo "# Contract ids are shortened to their first 16 hex digits. after_proof_seconds runs from the moment the proof file was written to the end of the builder's run."
  fixed
  echo "block=$n1"
  echo "block_hash=$hash1"
  echo "token=$TOKEN"
  echo "evm_transfer_tx=$transfer1"
  echo "transactions=1"
  echo "gas_used=$((gas1))"
  echo "legs=1"
  echo "terms=$(short "$(jq -r .terms <<<"$dvp1")")"
  echo "allocation=$(short "$(jq -r .allocation <<<"$dvp1")")"
  echo "proof_seconds=$(proof_seconds "$n1")"
  echo "after_proof_seconds=$(secs "$(stat -c %.9Y "$proof_file1")" "$t1")"
  echo "builder_total_seconds=$(secs "$t0" "$t1")"
  echo "proof_sha256=$(jq -r .proofSha256 <<<"$record1")"
  echo "canton_head_before=$((n1 - 1))"
  echo "canton_head_after=$n1"
  echo "canton_head_hash=$hash1"
  echo "block_record_holds_the_proof=yes"
  echo "canton_update=$update1"
  echo "block_record_and_v_holding_in_one_update=yes"
  echo "tkb_u_before=$(jq -r '.tkb.u | add // 0' <<<"$mid1")"
  echo "tkb_v_before=$(jq -r '.tkb.v | add // 0' <<<"$mid1")"
  echo "tkb_u_after=$(jq -r '.tkb.u | add // 0' <<<"$after1")"
  echo "tkb_v_after=$(jq -r '.tkb.v | add // 0' <<<"$after1")"
  echo "allocation_active_after=no"
  echo "terms_active_after=no"
  echo "tka_u_before=$tka_u_before"
  echo "tka_v_before=$tka_v_before"
  echo "tka_u_after=$(evm balance "$TOKEN" "$U_ADDR" | jq -r .tka)"
  echo "tka_v_after=$(evm balance "$TOKEN" "$V_ADDR" | jq -r .tka)"
  echo "reth_finalized=yes"
} > "$RESULTS/run1.txt"
jq -r .proofHex <<<"$record1" > "$RESULTS/run1-proof.hex"

# ---------------------------------------------------------------- run 2
step "run 2, the tampered proof: V sends U 10 more TKA; one byte of the proof is flipped"
transfer2=$(evm transfer "$TOKEN" 10 | jq -r .tx)
dvp2=$(canton dvp dvp-2 "$TOKEN" "$U_ADDR" 10)
echo "$dvp2" | jq -c .
before2=$(canton status)
is "$(jq -c .tkb <<<"$before2")" '{"u":[80],"v":[10]}' "TKB before run 2"
is "$(jq -c .allocations <<<"$before2")" '["dvp-2"]' "the active allocations before run 2"
n2=$((n1 + 1))
t0=$(now)
set +e; out2=$(CZE_TAMPER_REAL_PROVE_CMD=$GOOD_PROVE build "$ROOT/demo/prove-tampered.sh"); status2=$?; set -e
t1=$(now)
echo "$out2" | jq -c .
is "$status2" 2 "the builder's exit status in run 2 ($out2)"
is "$(jq -r .committed <<<"$out2")" false "run 2 was refused"
reason=$(jq -r .reason <<<"$out2")
# The sidecar's own answer to a proof that does not verify, and nothing else: not another check of the Advance choice.
refusal=$(grep -o 'the sidecar refused the block: [^"\\]*' <<<"$reason" | head -1 | cut -c1-200)
is "$refusal" "the sidecar refused the block: no the proof does not verify" "Canton's refusal of run 2 ($reason)"
# The refused block carried its DvP leg: the builder skipped no terms and kept V's transfer, so only the proof was wrong.
is "$(jq -c .skippedTerms <<<"$out2")" '[]' "run 2's skipped terms"
is "$(jq -c .keptTransactions <<<"$out2")" "[\"$transfer2\"]" "run 2's transactions"
after2=$(canton status)
is "$(jq -c '.chain' <<<"$after2")" "$(jq -c '.chain' <<<"$after1")" "Canton's chain record after run 2"
is "$(jq -c '.blockRecords | map(.number)' <<<"$after2")" "$(jq -c '.blockRecords | map(.number)' <<<"$after1")" "the block records after run 2"
is "$(jq -c .tkb <<<"$after2")" '{"u":[80],"v":[10]}' "TKB after run 2"
is "$(jq -c .allocations <<<"$after2")" '["dvp-2"]' "the active allocations after run 2 (the allocation is still U's, still locked)"
is "$(jq -r .terms <<<"$after2")" 1 "the active terms after run 2"
is "$(rpc eth_getBlockByNumber '"latest",false' | jq -r .hash)" "$hash1" "reth's latest block after run 2"
is "$(rpc eth_getBlockByNumber '"finalized",false' | jq -r .hash)" "$hash1" "reth's finalized block after run 2"
is "$(evm balance "$TOKEN" "$U_ADDR" | jq -r .tka)" 10 "U's TKA after run 2"
is "$(evm balance "$TOKEN" "$V_ADDR" | jq -r .tka)" 990 "V's TKA after run 2"
{
  echo "# Run 2, the tampered proof: V sends U 10 more TKA, and U allocates another 10 TKB to V on the terms \"if U's TKA balance rose by 10 in the proven block\"."
  echo "# The builder's prover command flips one hex digit of the wrapped proof (byte 100) after the real prover made it. Advance is refused."
  echo "# Nothing moves on Canton, and reth goes back to the parent. Contract ids are shortened to their first 16 hex digits."
  fixed
  echo "block=$n2"
  echo "block_hash_built=$(jq -r .blockHash <<<"$out2")"
  echo "token=$TOKEN"
  echo "evm_transfer_tx=$transfer2"
  echo "tampered=byte 100 of the wrapped proof, first hex digit flipped"
  echo "builder_exit=2"
  echo "committed=no"
  echo "refusal=$refusal"
  echo "leg_attached=yes"
  echo "terms=$(short "$(jq -r .terms <<<"$dvp2")")"
  echo "allocation=$(short "$(jq -r .allocation <<<"$dvp2")")"
  echo "proof_seconds=$(proof_seconds "$n2")"
  echo "builder_total_seconds=$(secs "$t0" "$t1")"
  echo "canton_head_before=$n1"
  echo "canton_head_after=$n1"
  echo "canton_head_hash=$hash1"
  echo "block_records_before=$(jq -r '.blockRecords | length' <<<"$after1")"
  echo "block_records_after=$(jq -r '.blockRecords | length' <<<"$after2")"
  echo "tkb_u_before=$(jq -r '.tkb.u | add // 0' <<<"$before2")"
  echo "tkb_v_before=$(jq -r '.tkb.v | add // 0' <<<"$before2")"
  echo "tkb_u_after=$(jq -r '.tkb.u | add // 0' <<<"$after2")"
  echo "tkb_v_after=$(jq -r '.tkb.v | add // 0' <<<"$after2")"
  echo "allocation_active_after=yes"
  echo "terms_active_after=yes"
  echo "tka_u_after=$(evm balance "$TOKEN" "$U_ADDR" | jq -r .tka)"
  echo "tka_v_after=$(evm balance "$TOKEN" "$V_ADDR" | jq -r .tka)"
  echo "reth_latest_is_parent=yes"
  echo "reth_finalized_is_parent=yes"
} > "$RESULTS/run2.txt"
echo "== demo passed; facts in $RESULTS"
