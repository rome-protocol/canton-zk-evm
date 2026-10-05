#!/usr/bin/env bash
# Takes one real storage proof from the project's reth and writes it to a folder.
#
# Usage: tests/capture_proof.sh <folder>
#
# reth is started only through network/reth/launch.sh (peer discovery off) and stopped at the end.
# The genesis already fills one storage slot of one contract; this asks reth for that contract's
# account proof with two slots: the filled one, and one that was never written.
# Writes <folder>/getproof.json and <folder>/block.json. Needs Docker, curl and jq.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:?usage: tests/capture_proof.sh <folder>}
set -a
# shellcheck disable=SC1091
. "$ROOT/PINS"
set +a
CZE_STATE_DIR=$(mktemp -d)
export CZE_STATE_DIR
export RETH_CONTAINER=${RETH_CONTAINER:-cze-reth-proof}
export RETH_HTTP_PORT=${RETH_HTTP_PORT:-18645}
export RETH_WS_PORT=${RETH_WS_PORT:-18646}
export RETH_ENGINE_PORT=${RETH_ENGINE_PORT:-18651}

cleanup() {
  local status=$?
  # On a failure, show reth's own log so the cause is in the CI output.
  [ "$status" = 0 ] || docker logs --tail 40 "$RETH_CONTAINER" >&2 2>&1 || true
  "$ROOT/network/reth/stop.sh" || true
  rm -rf "$CZE_STATE_DIR"
  return 0
}
trap cleanup EXIT

rpc() { curl -sf -H 'content-type: application/json' \
  --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":[${2:-}]}" "http://127.0.0.1:$RETH_HTTP_PORT"; }

# The first genesis contract with storage, and its first filled slot.
GENESIS="$ROOT/network/genesis.json"
CONTRACT=$(jq -r '.alloc | to_entries | map(select(.value.storage != null))[0].key' "$GENESIS")
FILLED=$(jq -r --arg a "$CONTRACT" '.alloc[$a].storage | keys[0]' "$GENESIS")
EMPTY=0x0000000000000000000000000000000000000000000000000000000000000063
[ "$(jq --arg a "$CONTRACT" --arg s "$EMPTY" '.alloc[$a].storage | has($s)' "$GENESIS")" = false ] \
  || { echo "FAIL: the slot meant to be empty is filled in the genesis" >&2; exit 1; }

"$ROOT/network/reth/launch.sh"
for _ in $(seq 1 60); do rpc eth_chainId >/dev/null 2>&1 && break; sleep 1; done

mkdir -p "$OUT"
rpc eth_getProof "\"$CONTRACT\",[\"$FILLED\",\"$EMPTY\"],\"latest\"" | jq .result > "$OUT/getproof.json"
rpc eth_getBlockByNumber '"latest",false' | jq .result > "$OUT/block.json"
jq -e '.accountProof | length > 0' "$OUT/getproof.json" >/dev/null \
  || { echo "FAIL: reth returned no account proof" >&2; exit 1; }
echo "wrote $OUT/getproof.json and $OUT/block.json"
