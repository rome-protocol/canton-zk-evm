#!/usr/bin/env bash
# The smoke test: the builder makes ONE EMPTY block, the prover proves it, Advance commits it on Canton, the
# chain's next ZkChain shows head = 1 and reth marks the block final. Run network/up.sh first.
#
# Checks, each of which must hold:
#   - the DAR's main package id (network/canton/dar-id.sh, recorded by up.sh) is in the operator participant's package
#     list (GET /v2/packages), checked before anything runs
#   - the builder exits 0 and says committed, block 1, no transactions
#   - Canton's ZkChain, read by the operator, is at head 1 with the block's hash
#   - the BlockRecord for block 1 is there, read by the reader on the participant that has no sidecar
#   - reth's finalized block is that block
# and writes the facts to demo/results/smoke.txt (or $1): the block hash, the proof time, the time from the proof
# file to the end of the builder's run (Advance, its commit on Canton, and reth marking the block final), the total
# time of the run, the versions, and what was run: the source commit (CZE_SOURCE_COMMIT, 40 hex digits, passed in
# because the checkout on the machine may have no .git), the SHA-256 of the DAR that Canton loaded and its main
# package id. Exits 0 only if every check holds.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"
export CZE_STATE_DIR=${CZE_STATE_DIR:-$ROOT/state}
NET=$CZE_STATE_DIR/net
OUT=${1:-$ROOT/demo/results/smoke.txt}
fail() { echo "FAIL: $*" >&2; exit 1; }
[[ ${CZE_SOURCE_COMMIT:-} =~ ^[0-9a-f]{40}$ ]] || fail "set CZE_SOURCE_COMMIT to the full commit hash of the source that is running (git rev-parse HEAD)"
[ -f "$NET/chain.json" ] || fail "no chain: run network/up.sh first"
[ -f "$NET/dar.txt" ] || fail "no $NET/dar.txt: run network/up.sh first"
# shellcheck disable=SC1091
. "$CZE_STATE_DIR/canton/parties.env"

OPERATOR_API=${CZE_LEDGER_URL:-http://127.0.0.1:7575}
USERS_API=${CZE_USERS_LEDGER_URL:-http://127.0.0.1:7577}
rpc() { curl -sf -H 'content-type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":[${2:-}]}" "http://127.0.0.1:${RETH_HTTP_PORT:-8545}" | jq -r .result; }
# The create arguments of the active contracts of a template that a party sees, as a JSON list.
active() {   # <ledger url> <party> <template>
  local offset
  offset=$(curl -sf "$1/v2/state/ledger-end" | jq -r .offset)
  curl -sf -H 'content-type: application/json' "$1/v2/state/active-contracts" -d "$(jq -n --arg p "$2" --arg t "#canton-zk-evm:Zk.Chain:$3" --argjson o "$offset" \
    '{eventFormat: {filtersByParty: {($p): {cumulative: [{identifierFilter: {TemplateFilter: {value: {templateId: $t, includeCreatedEventBlob: false}}}}]}}, verbose: false}, activeAtOffset: $o}')" \
    | jq -c '[.[] | .contractEntry.JsActiveContract.createdEvent | select(. != null) | .createArgument]'
}
# The package id that is written into the result is the id of a package the operator's participant holds, not only the
# id that is in the DAR file.
"$ROOT/network/canton/check-package.sh" "$(sed -n 's/^package_id=//p' "$NET/dar.txt")" "$OPERATOR_API" || fail "the DAR's main package is not on the operator's participant"
wait_for_head() {   # until the operator's ZkChain is at head 1, up to 60 s
  for _ in $(seq 1 120); do
    [ "$(active "$OPERATOR_API" "$OPERATOR_PARTY" ZkChain | jq -r '.[0].headNumber // empty')" = 1 ] && return 0
    sleep 0.5
  done
  return 1
}

[ "$(active "$OPERATOR_API" "$OPERATOR_PARTY" ZkChain | jq -r '.[0].headNumber')" = 0 ] || fail "the chain is not at head 0: this smoke test is for a fresh network"

export CZE_LEDGER_USER=builder CZE_BUILDER_PARTY=$BUILDER_PARTY CZE_FEE_RECIPIENT=0x0000000000000000000000000000000000000fee
export CZE_PROVE_CMD=$ROOT/network/prove-timed.sh
started=$(date +%s.%N)
set +e
result=$("$CZE_STATE_DIR/venv/bin/python3" "$ROOT/builder/builder.py" once)
status=$?
set -e
finished=$(date +%s.%N)
echo "$result"
[ "$status" = 0 ] || fail "the builder exited $status"
[ "$(jq -r .committed <<<"$result")" = true ] || fail "the builder did not commit the block"
[ "$(jq -r .number <<<"$result")" = 1 ] || fail "the block is not number 1"
[ "$(jq -r '.transactions | length' <<<"$result")" = 0 ] || fail "the block is not empty"
block_hash=$(jq -r .blockHash <<<"$result")

wait_for_head || fail "the ZkChain did not reach head 1"
chain=$(active "$OPERATOR_API" "$OPERATOR_PARTY" ZkChain)
[ "$(jq -r 'length' <<<"$chain")" = 1 ] || fail "there is not exactly one ZkChain"
[ "$(jq -r '.[0].headHash' <<<"$chain")" = "${block_hash#0x}" ] || fail "the ZkChain's head is not the block"

record=
for _ in $(seq 1 60); do
  record=$(active "$USERS_API" "$READER_PARTY" BlockRecord)
  [ "$(jq -r 'length' <<<"$record")" = 1 ] && break
  sleep 0.5
done
[ "$(jq -r '.[0].number // empty' <<<"$record")" = 1 ] || fail "the reader does not see the BlockRecord for block 1"
[ "$(jq -r '.[0].blockHash' <<<"$record")" = "${block_hash#0x}" ] || fail "the BlockRecord is for another block"

[ "$(rpc eth_getBlockByNumber '"finalized",false' | jq -r .hash)" = "$block_hash" ] || fail "reth's finalized block is not the block"

proof_file=$CZE_STATE_DIR/builder/block-1/out/wrapped-proof.hex
proof_seconds=$(sed -n 's/^prove wall time: \([0-9.]*\) s$/\1/p' "$CZE_STATE_DIR/builder/block-1/out/prove.log")
[ -n "$proof_seconds" ] || fail "no proof time in the prover's log"
proof_written=$(stat -c %.9Y "$proof_file")
gas_used=$(rpc eth_getBlockByNumber '"0x1",false' | jq -r '.gasUsed')

mkdir -p "$(dirname "$OUT")"
{
  echo "# The smoke test of the network: one empty block, proven, committed on Canton, final in reth."
  echo "# advance_seconds runs from the moment the proof file was written to the end of the builder's run:"
  echo "# assembling the Daml legs (the builder's Ledger reads, and eth_getProof calls when there are terms to settle), Advance, its commit on every confirmer, and reth marking the block final."
  echo "# proof_seconds is the prover's time for the proof with the prover already running, as in prover/fixtures/session.txt."
  echo "# builder_total_seconds is the whole run, which also holds the witness, the input and, the first time the prover sees"
  echo "# the program, its one-time setup; on a machine that has not built the input tool yet it holds that build too."
  echo "format=2"
  echo "date=$(date -u +%FT%TZ)"
  echo "source_commit=$CZE_SOURCE_COMMIT"
  echo "dar_sha256=$(sed -n 's/^dar_sha256=//p' "$NET/dar.txt")"
  echo "package_id=$(sed -n 's/^package_id=//p' "$NET/dar.txt")"
  echo "chain_id=$CHAIN_ID"
  echo "block=1"
  echo "block_hash=$block_hash"
  echo "transactions=0"
  echo "gas_used=$((gas_used))"
  echo "proof_seconds=$proof_seconds"
  echo "advance_seconds=$(awk -v a="$proof_written" -v b="$finished" 'BEGIN { printf "%.2f", b - a }')"
  echo "builder_total_seconds=$(awk -v a="$started" -v b="$finished" 'BEGIN { printf "%.2f", b - a }')"
  echo "canton_head_number=1"
  echo "canton_head_hash=0x$(jq -r '.[0].headHash' <<<"$chain")"
  echo "block_record_seen_by_reader=yes"
  echo "reth_finalized=yes"
  echo "wrapped_proof_bytes=$(( $(wc -c < "$proof_file") / 2 ))"
  echo "guest_elf_sha256=$(sed -n 's/^elf_sha256=//p' "$NET/guest.txt")"
  echo "programVK=0x$(jq -r '.[0].programVK' <<<"$chain")"
  echo "rootC=0x$(jq -r '.[0].rootC' <<<"$chain")"
  echo "canton=$CANTON_VERSION"
  echo "daml_sdk=$DAML_SDK_VERSION"
  echo "daml_lf_target=$DAML_TARGET"
  echo "zisk=$ZISK_VERSION"
  echo "reth=$RETH_VERSION"
  echo "gpu=$(nvidia-smi --query-gpu=name,driver_version --format=csv,noheader | head -1)"
} > "$OUT"
echo "smoke test passed; facts in $OUT"
