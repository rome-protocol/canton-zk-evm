#!/usr/bin/env bash
# Tests the gateway contract on a real reth: starts reth through network/reth/launch.sh (peer discovery off), checks it with
# network/reth/check.sh, runs gateway/tests/check.py against it, and stops it. reth is not started any other way.
# Needs Docker, curl, jq, and Python 3 with the packages in demo/requirements.txt (eth-account, eth-abi, websockets).
# The test accounts' keys are made for this run, kept in a throwaway folder (mode 0600) and deleted at the end.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
set -a
# shellcheck disable=SC1091
. "$ROOT/PINS"
set +a
STATE=$(mktemp -d)
export CZE_STATE_DIR=$STATE/reth
export RETH_CONTAINER=${RETH_CONTAINER:-cze-reth-gateway}
export RETH_HTTP_PORT=${RETH_HTTP_PORT:-18845}
export RETH_WS_PORT=${RETH_WS_PORT:-18846}
export RETH_ENGINE_PORT=${RETH_ENGINE_PORT:-18851}
PY=${PYTHON:-python3}

cleanup() {
  local status=$?
  [ "$status" = 0 ] || docker logs --tail 40 "$RETH_CONTAINER" >&2 2>&1 || true
  "$ROOT/network/reth/stop.sh" || true
  rm -rf "$STATE"
  return 0
}
trap cleanup EXIT

rpc() { curl -sf -H 'content-type: application/json' \
  --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":[${2:-}]}" "http://127.0.0.1:$RETH_HTTP_PORT"; }

# The mocks: three badly behaved tokens, compiled with the pinned solc.
docker run --rm -v "$HERE:/src:ro" "$SOLC_IMAGE" --evm-version cancun --optimize --optimize-runs 200 --no-cbor-metadata \
  --combined-json bin /src/Mocks.sol > "$STATE/mocks.json"

"$PY" "$HERE/check.py" genesis "$STATE"
CZE_GENESIS_FILE=$STATE/genesis.json "$ROOT/network/reth/launch.sh"
for _ in $(seq 1 60); do rpc eth_chainId >/dev/null 2>&1 && break; sleep 1; done
rpc eth_chainId >/dev/null || { echo "FAIL: reth does not answer" >&2; exit 1; }
"$ROOT/network/reth/check.sh"
"$PY" "$HERE/check.py" run "$STATE"
