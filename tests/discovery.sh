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
  [ -z "${STATE2:-}" ] || rm -rf "$STATE2" 2>/dev/null || true
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
# The persistent mode: reth keeps its data in $CZE_STATE_DIR/reth-data, discovery is still off after it is started again on that data
# (CZE_RESUME=1, as network/restart.sh does), the same chain is there, and --wipe-persistent removes the data.
"$ROOT/network/reth/stop.sh"
export CZE_PERSIST=1
wait_for_reth() { for _ in $(seq 1 60); do rpc eth_chainId >/dev/null 2>&1 && return 0; sleep 1; done; echo "FAIL: reth does not answer" >&2; exit 1; }
"$ROOT/network/reth/launch.sh"; wait_for_reth
"$ROOT/network/reth/check.sh" "$RETH_CONTAINER"
genesis=$(rpc eth_getBlockByNumber '"0x0",false' | jq -r .result.hash)
"$ROOT/network/reth/stop.sh" --keep-data
[ -n "$(ls -A "$CZE_STATE_DIR/reth-data")" ] || { echo "FAIL: reth-data is empty after a stop that keeps the data" >&2; exit 1; }
CZE_RESUME=1 "$ROOT/network/reth/launch.sh"; wait_for_reth
"$ROOT/network/reth/check.sh" "$RETH_CONTAINER"
[ "$(rpc eth_getBlockByNumber '"0x0",false' | jq -r .result.hash)" = "$genesis" ] || { echo "FAIL: another chain after the restart" >&2; exit 1; }
[ "$(rpc eth_chainId | jq -r .result)" = "$want" ] || { echo "FAIL: wrong chain id after the restart" >&2; exit 1; }
"$ROOT/network/reth/stop.sh" --wipe-persistent
[ ! -e "$CZE_STATE_DIR/reth-data" ] || { echo "FAIL: --wipe-persistent left reth-data" >&2; exit 1; }
# Real data that root owns in a folder of mode 0700 (the DevNet case: network/up.sh makes the state under umask 077, and an older reth ran as root): launch.sh refuses
# with the one command that hands the data over, that command runs as printed (a throwaway root container needs DAC_READ_SEARCH as well as CHOWN to open a folder
# of mode 0700 that another user owns), and then reth starts on the same chain and passes check.sh.
STATE2=$(mktemp -d)
CZE_STATE_DIR=$STATE2 "$ROOT/network/make-state.sh"
export CZE_STATE_DIR=$STATE2
(umask 077; mkdir "$STATE2/reth-data")
"$ROOT/network/reth/launch.sh"; wait_for_reth
genesis2=$(rpc eth_getBlockByNumber '"0x0",false' | jq -r .result.hash)
"$ROOT/network/reth/stop.sh" --keep-data
docker run --rm --network none --security-opt no-new-privileges --read-only -v "$STATE2/reth-data:/d" "$BUSYBOX_IMAGE" sh -c 'chown -R 0:0 /d && chmod 700 /d'
[ ! -r "$STATE2/reth-data" ] || { echo "FAIL: the test could not make reth-data unreadable to this user" >&2; exit 1; }
if CZE_RESUME=1 "$ROOT/network/reth/launch.sh" >"$STATE2/out" 2>"$STATE2/err"; then echo "FAIL: launch.sh started on root-owned data" >&2; exit 1; fi
grep -q "does not own" "$STATE2/err" || { echo "FAIL: no refusal for root-owned data: $(cat "$STATE2/err")" >&2; exit 1; }
fix=$(sed -n 's/^.*run once: //p' "$STATE2/err")
[[ $fix == *"--cap-add DAC_READ_SEARCH"* ]] || { echo "FAIL: the printed command does not carry DAC_READ_SEARCH: $fix" >&2; exit 1; }
eval "$fix"
CZE_RESUME=1 "$ROOT/network/reth/launch.sh"; wait_for_reth
"$ROOT/network/reth/check.sh" "$RETH_CONTAINER"
[ "$(rpc eth_getBlockByNumber '"0x0",false' | jq -r .result.hash)" = "$genesis2" ] || { echo "FAIL: another chain after the hand-over" >&2; exit 1; }
"$ROOT/network/reth/stop.sh" --wipe-persistent
echo "ok: root-owned data in a 0700 folder is refused, handed over with the printed command, and reth starts on it"
rm -rf "$STATE2"
echo "discovery test passed"
