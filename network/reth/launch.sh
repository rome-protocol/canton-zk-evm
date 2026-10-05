#!/usr/bin/env bash
# The only way reth is started in this project.
#
# Peer discovery is always off: no discovery, no NAT, no outbound or inbound peers, p2p
# bound to localhost, and no p2p port published. It also always passes the flags the block
# builder relies on: --engine.always-process-payload-attributes-on-canonical-head,
# --engine.allow-unwind-canonical-header, --builder.gaslimit set to the chain's gas cap
# (GAS_CAP in PINS, equal to the genesis gas limit), and --rpc.eth-proof-window 1, so that
# eth_getProof can answer for the parent of the newest block. Before Docker is called, this script
# checks its own command line: it refuses to run if a flag above is missing or has a
# different value, or if the command line carries an option that would let peers in or
# find peers (--trusted-peers, --bootnodes, --max-peers, --network host, -P).
#
# Settings come from the environment (all optional):
#   CZE_STATE_DIR      per-run state folder          (default: ./state, ignored by git)
#   RETH_CONTAINER     container name                (default: cze-reth)
#   RETH_HTTP_PORT     host port for HTTP RPC        (default: 8545)
#   RETH_WS_PORT       host port for the builder WS  (default: 8546)
#   RETH_ENGINE_PORT   host port for the Engine API  (default: 8551)
#   LAUNCH_DRY_RUN=1   print the Docker command and stop
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"
STATE=${CZE_STATE_DIR:-$ROOT/state}
NAME=${RETH_CONTAINER:-cze-reth}

RETH_ARGS=(
  node
  --chain /genesis.json
  --datadir /data
  --color never
  --disable-discovery
  --nat none
  --max-outbound-peers 0
  --max-inbound-peers 0
  --addr 127.0.0.1
  --ipcdisable
  --authrpc.addr 0.0.0.0
  --authrpc.port 8551
  --authrpc.jwtsecret /jwt.hex
  --http
  --http.addr 0.0.0.0
  --http.port 8545
  --http.api "eth,net,web3"
  --ws
  --ws.addr 0.0.0.0
  --ws.port 8546
  --ws.api "testing,debug,txpool,eth"
  --engine.always-process-payload-attributes-on-canonical-head
  --engine.allow-unwind-canonical-header
  --builder.gaslimit "$GAS_CAP"
  --rpc.eth-proof-window 1
)

refuse() {
  echo "refusing to start reth: $*" >&2
  exit 1
}

require() {
  local i
  for ((i = 0; i < ${#RETH_ARGS[@]}; i++)); do
    if [ "${RETH_ARGS[i]}" = "$1" ]; then
      [ $# -eq 1 ] && return 0
      [ "${RETH_ARGS[i + 1]:-}" = "$2" ] && return 0
    fi
  done
  refuse "its command line is missing or has the wrong value for: $*"
}
require --disable-discovery
require --nat none
require --max-outbound-peers 0
require --max-inbound-peers 0
require --addr 127.0.0.1
require --ipcdisable
require --engine.always-process-payload-attributes-on-canonical-head
require --engine.allow-unwind-canonical-header
require --builder.gaslimit "$GAS_CAP"
require --rpc.eth-proof-window 1

DOCKER_CMD=(
  docker run -d --name "$NAME" --security-opt no-new-privileges
  -p "127.0.0.1:${RETH_HTTP_PORT:-8545}:8545"
  -p "127.0.0.1:${RETH_WS_PORT:-8546}:8546"
  -p "127.0.0.1:${RETH_ENGINE_PORT:-8551}:8551"
  -v "$STATE/genesis.json:/genesis.json:ro"
  -v "$STATE/jwt.hex:/jwt.hex:ro"
  -v "$NAME-data:/data"
  "$RETH_IMAGE" "${RETH_ARGS[@]}"
)

# Options that would let peers in or find peers.
for a in "${RETH_ARGS[@]}"; do
  case $a in
    --trusted-peers | --trusted-peers=* | --bootnodes | --bootnodes=* | --max-peers | --max-peers=*)
      refuse "its command line must not carry ${a%%=*}" ;;
  esac
done
for ((i = 0; i < ${#DOCKER_CMD[@]}; i++)); do
  case ${DOCKER_CMD[i]} in
    -P | --publish-all) refuse "the Docker command must not carry ${DOCKER_CMD[i]}" ;;
    --network=host | --net=host) refuse "the Docker command must not carry --network host" ;;
    --network | --net)
      [ "${DOCKER_CMD[i + 1]:-}" = host ] && refuse "the Docker command must not carry --network host" ;;
  esac
done

if [ "${LAUNCH_DRY_RUN:-0}" = 1 ]; then
  echo "${DOCKER_CMD[*]}"
  exit 0
fi

CZE_STATE_DIR=$STATE "$ROOT/network/make-state.sh"
"${DOCKER_CMD[@]}"
