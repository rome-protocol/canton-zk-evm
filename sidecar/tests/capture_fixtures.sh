#!/usr/bin/env bash
# Takes real data from the project's own reth for the sidecar's tests and writes it to a folder:
#   block.json     block 1 of a throwaway copy of the chain: its hash, its header and its transaction
#                  list as they sit in the block's own encoding, and the fields reth reports for it
#   balances.json  a token's account proof and two storage proofs (one holder with a balance, one
#                  without), at block 1
#
# Usage: sidecar/tests/capture_fixtures.sh <folder>
#
# The copy's genesis is the chain's genesis plus one funded test key and one token account that
# holds a balance in the mapping at slot 0. reth is started only through network/reth/launch.sh
# (peer discovery off) and stopped at the end. Needs Docker, curl, and Python 3 with the packages
# prover/make-block.py names (eth-account, websockets).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
OUT=${1:?usage: sidecar/tests/capture_fixtures.sh <folder>}
STATE=$(mktemp -d)
export RETH_CONTAINER=${RETH_CONTAINER:-cze-reth-sidecar}
export RETH_HTTP_PORT=${RETH_HTTP_PORT:-18745}
export RETH_WS_PORT=${RETH_WS_PORT:-18746}
export RETH_ENGINE_PORT=${RETH_ENGINE_PORT:-18751}

cleanup() {
  local status=$?
  [ "$status" = 0 ] || docker logs --tail 40 "$RETH_CONTAINER" >&2 2>&1 || true
  "$ROOT/network/reth/stop.sh" || true
  rm -rf "$STATE"
  return 0
}
trap cleanup EXIT

python3 "$ROOT/prover/make-block.py" fund "$STATE"
python3 "$HERE/capture_fixtures.py" genesis "$STATE"

CZE_STATE_DIR="$STATE/reth" "$STATE/run/network/reth/launch.sh"
for _ in $(seq 1 60); do
  curl -sf -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
    "http://127.0.0.1:$RETH_HTTP_PORT" >/dev/null 2>&1 && break
  sleep 1
done

python3 "$ROOT/prover/make-block.py" build "$STATE" "$STATE/block"
mkdir -p "$OUT"
python3 "$HERE/capture_fixtures.py" capture "$OUT"
