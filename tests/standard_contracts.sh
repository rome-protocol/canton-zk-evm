#!/usr/bin/env bash
# network/standard-contracts/deploy.py against a real reth: reth is started only through network/reth/launch.sh (peer discovery off, no peers) on the chain's
# genesis plus a funded account, and checked with network/reth/check.sh. A helper mines a block whenever the pool holds transactions.
#   1. a dry run sends nothing (no block);
#   2. the first run deploys the CREATE2 deployer, Multicall3, CreateX and Permit2, and each one's code hash is the canonical one for this chain;
#      the three presigned transactions (not tied to a chain, 100 gwei) were taken by reth with its launch.sh flags and nothing else;
#   3. the second run sends nothing (no new block);
#   4. on a chain that has other code at Multicall3's address, a run refuses, exits 1 and sends nothing.
# Needs Docker, curl, jq, and Python 3 with the packages in demo/requirements.txt (eth-account, eth-abi, websockets): PYTHON names that Python.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
set -a
# shellcheck disable=SC1091
. "$ROOT/PINS"
set +a
STATE=$(mktemp -d)
export RETH_CONTAINER=${RETH_CONTAINER:-cze-reth-stdc}
export RETH_HTTP_PORT=${RETH_HTTP_PORT:-18745}
export RETH_WS_PORT=${RETH_WS_PORT:-18746}
export RETH_ENGINE_PORT=${RETH_ENGINE_PORT:-18751}
PY=${PYTHON:-python3}
DEPLOY=$ROOT/network/standard-contracts/deploy.py
MINER_PID=

cleanup() {
  local status=$?
  [ -z "$MINER_PID" ] || kill "$MINER_PID" 2>/dev/null || true
  [ "$status" = 0 ] || { docker logs --tail 40 "$RETH_CONTAINER" >&2 2>&1 || true; [ ! -s "$STATE/miner.log" ] || tail -5 "$STATE/miner.log" >&2; }
  CZE_STATE_DIR=$STATE/reth "$ROOT/network/reth/stop.sh" || true
  rm -rf "$STATE"
  return 0
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
rpc() { curl -sf -H 'content-type: application/json' \
  --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":[${2:-}]}" "http://127.0.0.1:$RETH_HTTP_PORT" | jq -r .result; }
block_number() { printf '%d' "$(rpc eth_blockNumber)"; }
wait_for_reth() { for _ in $(seq 1 60); do rpc eth_chainId >/dev/null 2>&1 && return 0; sleep 1; done; fail "reth does not answer"; }
start_reth() {   # $1: state folder, $2...: arguments of the helper's genesis command
  local dir=$1; shift
  "$PY" "$HERE/standard_contracts_chain.py" genesis "$dir" "$@"
  CZE_STATE_DIR=$dir/reth CZE_GENESIS_FILE=$dir/genesis.json "$ROOT/network/reth/launch.sh" >/dev/null
  wait_for_reth
  "$ROOT/network/reth/check.sh" "$RETH_CONTAINER"
}
deploy() { "$PY" "$DEPLOY" --rpc "http://127.0.0.1:$RETH_HTTP_PORT" --funding-key-file "$1/funding.key" --wait-seconds 60 "${@:2}"; }

# What reth 2.5.2 offers: no flag that allows or forbids unprotected (pre-EIP-155) transactions.
help=$(docker run --rm --network none "$RETH_IMAGE" node --help)
! grep -qi 'unprotected' <<<"$help" || fail "the pinned reth has a flag about unprotected transactions: the README's finding has to be revisited"
echo "reth $RETH_VERSION: no flag about unprotected transactions in 'node --help'"

start_reth "$STATE"
[ "$(rpc eth_chainId)" = "$(printf '0x%x' "$CHAIN_ID")" ] || fail "wrong chain id"
"$PY" "$HERE/standard_contracts_chain.py" mine "$STATE" >"$STATE/miner.log" 2>&1 &
MINER_PID=$!

echo "--- 1. dry run"
out=$(deploy "$STATE" --dry-run)
echo "$out"
grep -q 'dry run: nothing was sent' <<<"$out" || fail "the dry run did not say it sent nothing"
sleep 2
[ "$(block_number)" = 0 ] || fail "a dry run made a block"

echo "--- 2. first run"
deploy "$STATE" | tee "$STATE/first.txt"
"$PY" "$HERE/standard_contracts_chain.py" verify "$STATE" | tee "$STATE/verify.txt"
[ "$(grep -c '^ok ' "$STATE/verify.txt")" = 4 ] || fail "not all four contracts have the canonical code"
grep -q 'chainId None' "$STATE/verify.txt" || fail "the presigned transactions are tied to a chain"
[ "$(grep -c 'gasPrice 100000000000, ' "$STATE/verify.txt")" = 3 ] || fail "the presigned transactions are not at 100 gwei"
[ "$(grep -c 'status 0x1' "$STATE/verify.txt")" = 3 ] || fail "a presigned transaction did not succeed"
# Every transaction of the run is in a block: 3 fundings, 3 presigned, and Permit2's deployment.
total=0
for n in $(seq 1 "$(block_number)"); do
  total=$((total + $(rpc eth_getBlockTransactionCountByNumber "\"$(printf '0x%x' "$n")\"" | xargs printf '%d')))
done
[ "$total" = 7 ] || fail "the first run put $total transactions in blocks, expected 7"
head=$(block_number)

echo "--- 3. second run"
out=$(deploy "$STATE")
echo "$out"
grep -q 'nothing to send' <<<"$out" || fail "the second run did not say it has nothing to send"
sleep 2
[ "$(block_number)" = "$head" ] || fail "the second run sent something"

echo "--- 4. other code at an address"
kill "$MINER_PID" 2>/dev/null || true; MINER_PID=
CZE_STATE_DIR=$STATE/reth "$ROOT/network/reth/stop.sh"
mkdir -p "$STATE/two"
start_reth "$STATE/two" --foreign 0xcA11bde05977b3631167028862bE2a173976CA11
"$PY" "$HERE/standard_contracts_chain.py" mine "$STATE/two" >"$STATE/miner.log" 2>&1 &
MINER_PID=$!
set +e
out=$(deploy "$STATE/two" 2>&1)
status=$?
set -e
echo "$out"
[ "$status" = 1 ] || fail "a run on a chain with other code at Multicall3's address exited $status, expected 1"
grep -q 'REFUSED multicall3' <<<"$out" || fail "the refusal does not name Multicall3"
sleep 2
[ "$(block_number)" = 0 ] || fail "a refused run sent something"
echo "ok: standard contracts"
