#!/usr/bin/env bash
# Starts reth through launch.sh, runs check.sh against it, then stops it.
# Needs Docker. Uses a throwaway state folder and ports from the environment.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
set -a
# shellcheck disable=SC1091
. "$ROOT/PINS"
set +a
OWN_STATE=0
if [ -z "${CZE_STATE_DIR:-}" ]; then CZE_STATE_DIR=$(mktemp -d); OWN_STATE=1; fi
export CZE_STATE_DIR
export RETH_CONTAINER=${RETH_CONTAINER:-cze-reth-test}
export RETH_HTTP_PORT=${RETH_HTTP_PORT:-18545}
export RETH_WS_PORT=${RETH_WS_PORT:-18546}
export RETH_ENGINE_PORT=${RETH_ENGINE_PORT:-18551}

cleanup() {
  local status=$?
  # On a failure, show reth's own log so the cause is in the CI output.
  [ "$status" = 0 ] || docker logs --tail 40 "$RETH_CONTAINER" >&2 2>&1 || true
  "$ROOT/network/reth/stop.sh" || true
  [ "$OWN_STATE" = 1 ] && rm -rf "$CZE_STATE_DIR"
  return 0
}
trap cleanup EXIT

rpc() { curl -sf -H 'content-type: application/json' \
  --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":[${2:-}]}" "http://127.0.0.1:$RETH_HTTP_PORT"; }

"$ROOT/network/reth/launch.sh"

for _ in $(seq 1 60); do rpc eth_chainId >/dev/null 2>&1 && break; sleep 1; done
want=$(printf '0x%x' "$CHAIN_ID")
[ "$(rpc eth_chainId | jq -r .result)" = "$want" ] || { echo "FAIL: wrong chain id" >&2; exit 1; }

# The running reth is the pinned version.
ver=$(rpc web3_clientVersion | jq -r .result)
[[ $ver == *"$RETH_VERSION"* ]] || { echo "FAIL: web3_clientVersion is '$ver', expected it to contain $RETH_VERSION" >&2; exit 1; }

# Prague is active from genesis: the genesis header carries the requests hash.
[ "$(rpc eth_getBlockByNumber '"0x0",false' | jq -r '.result.requestsHash != null')" = true ] \
  || { echo "FAIL: genesis block is not a Prague block" >&2; exit 1; }

# The Engine API refuses calls without the JWT secret.
code=$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"engine_exchangeCapabilities","params":[[]]}' \
  "http://127.0.0.1:$RETH_ENGINE_PORT")
[ "$code" = 401 ] || { echo "FAIL: Engine API answered $code without a token" >&2; exit 1; }

"$ROOT/network/reth/check.sh" "$RETH_CONTAINER"
echo "discovery test passed"
