#!/usr/bin/env bash
# The only way reth is started in this project.
#
# Peer discovery is always off: no discovery, no NAT, no outbound or inbound peers, p2p
# bound to localhost, and no p2p port published. It also always passes the flags the block
# builder relies on: --engine.always-process-payload-attributes-on-canonical-head,
# --engine.allow-unwind-canonical-header, --testing.skip-invalid-transactions, --builder.gaslimit set to the
# chain's gas cap (GAS_CAP in PINS, equal to the genesis gas limit), and --rpc.eth-proof-window 1, so that
# eth_getProof can answer for the parent of the newest block. Before Docker is called, this script
# checks its own command line: it refuses to run if a flag above is missing or has a
# different value, or if the command line carries an option that would let peers in or
# find peers (--trusted-peers, --bootnodes, --max-peers, --network host, -P).
#
# The container is hardened: it runs as the user that runs this script (never root), with every capability dropped, no new privileges, a read-only root
# filesystem (the data folder is the only writable mount, and /tmp is a tmpfs), and limits on processes and memory. The script refuses to start without them.
# The data folder must belong to that user. A folder written by an older, root-run reth does not: the script then refuses and prints the one command that fixes it.
#
# Settings come from the environment (all optional):
#   CZE_STATE_DIR      per-run state folder          (default: ./state, ignored by git)
#   RETH_CONTAINER     container name                (default: cze-reth)
#   RETH_HTTP_PORT     host port for HTTP RPC        (default: 8545)
#   RETH_WS_PORT       host port for the builder WS  (default: 8546)
#   RETH_ENGINE_PORT   host port for the Engine API  (default: 8551)
#   CZE_RETH_MEMORY    the container's memory limit, swap included (default: 32g)
#   CZE_RETH_PIDS      the container's limit on processes and threads (default: 4096)
#   LAUNCH_DRY_RUN=1   print the Docker command and stop
#   CZE_PERSIST=1      keep reth's data in $CZE_STATE_DIR/reth-data (not in a Docker volume that stop.sh removes), so the chain survives
#                      a restart. Discovery stays off and every check below still runs.
#   CZE_RESUME=1       with CZE_PERSIST=1: start on the genesis, the Engine secret and the data that are there already (network/restart.sh)
#                      and make no new state; refuse if any of them is missing
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"
STATE=${CZE_STATE_DIR:-$ROOT/state}
NAME=${RETH_CONTAINER:-cze-reth}
RUN_UID=$(id -u)
RUN_GID=$(id -g)
RETH_MEMORY=${CZE_RETH_MEMORY:-32g}
RETH_PIDS=${CZE_RETH_PIDS:-4096}

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
  --http.api "eth,net,web3,trace"
  --ws
  --ws.addr 0.0.0.0
  --ws.port 8546
  --ws.api "testing,debug,txpool,eth"
  --engine.always-process-payload-attributes-on-canonical-head
  --engine.allow-unwind-canonical-header
  --builder.gaslimit "$GAS_CAP"
  --testing.skip-invalid-transactions
  --rpc.eth-proof-window 1
  --rpc.gascap "$GAS_CAP"
  --log.file.max-files 0
)

# In the persistent mode every block is written to disk as soon as it is imported. With reth's default (the newest ~7 blocks stay in
# memory) a hard kill, an out-of-memory kill or a power loss would leave reth behind Canton, which has already committed those blocks.
# The builder imports a block about 7 s before Canton commits it, so writing at once costs nothing in the block time.
if [ "${CZE_PERSIST:-0}" = 1 ]; then
  RETH_ARGS+=(
    --engine.persistence-threshold 0
    --engine.memory-block-buffer-target 0
  )
fi

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
# The builder fills a block by the gas its transactions use (the Ethereum rule): it offers more than fits and reth leaves out any transaction it cannot run
# (a gas limit above what the block has left, a wrong nonce, too little balance, a fee under the base fee) and that sender's later ones. The builder's check
# still requires the block to be the offered list in order, less some, under the cap. Without this flag reth refuses such a list and the builder packs by
# gas limits instead.
require --testing.skip-invalid-transactions
require --rpc.eth-proof-window 1
# No eth_call or eth_estimateGas runs past one block's gas, whoever asks (the public RPC, the Etherscan proxy, a token read): reth's default is 50M, above the chain's block limit.
require --rpc.gascap "$GAS_CAP"
# The explorer's indexer reads each final block's traces (trace_replayBlockTransactions) on this port. It listens on the machine only, and the
# public RPC forwards no trace_ or debug_ method. Nothing that can build or change blocks, and no debug, is ever served on it.
require --http.api "eth,net,web3,trace"
# The root filesystem is read-only, and by default reth writes log files under its user's home (there is none). Its log is on standard output: docker logs.
require --log.file.max-files 0

if [ "${CZE_PERSIST:-0}" = 1 ]; then
  require --engine.persistence-threshold 0
  require --engine.memory-block-buffer-target 0
fi

# The data directory: a Docker volume that stop.sh removes, or, in the persistent mode, a folder in the state folder that stays.
if [ "${CZE_PERSIST:-0}" = 1 ]; then
  DATA_MOUNT=$STATE/reth-data
  if [ "${CZE_RESUME:-0}" = 1 ]; then
    have_data=no
    [ -d "$DATA_MOUNT" ] && [ -n "$(ls -A "$DATA_MOUNT" 2>/dev/null)" ] && have_data=yes
    if [ ! -s "$STATE/genesis.json" ] || [ ! -s "$STATE/jwt.hex" ] || [ "$have_data" = no ]; then
      refuse "there is no persistent reth state in $STATE (genesis.json, jwt.hex and reth-data are needed)"
    fi
  else
    [ -z "$(ls -A "$DATA_MOUNT" 2>/dev/null)" ] || refuse "$DATA_MOUNT has data already: use network/restart.sh, or network/down.sh --wipe"
  fi
else
  DATA_MOUNT=$NAME-data
fi

DOCKER_CMD=(
  docker run -d --name "$NAME"
  --security-opt no-new-privileges
  --user "$RUN_UID:$RUN_GID"
  --cap-drop ALL
  --read-only
  --tmpfs /tmp
  --pids-limit "$RETH_PIDS"
  --memory "$RETH_MEMORY"
  --memory-swap "$RETH_MEMORY"
  -p "127.0.0.1:${RETH_HTTP_PORT:-8545}:8545"
  -p "127.0.0.1:${RETH_WS_PORT:-8546}:8546"
  -p "127.0.0.1:${RETH_ENGINE_PORT:-8551}:8551"
  -v "$STATE/genesis.json:/genesis.json:ro"
  -v "$STATE/jwt.hex:/jwt.hex:ro"
  -v "$DATA_MOUNT:/data"
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
    --privileged | --cap-add | --cap-add=*) refuse "the Docker command must not carry ${DOCKER_CMD[i]%%=*}" ;;
    -P | --publish-all) refuse "the Docker command must not carry ${DOCKER_CMD[i]}" ;;
    --network=host | --net=host) refuse "the Docker command must not carry --network host" ;;
    --network | --net)
      [ "${DOCKER_CMD[i + 1]:-}" = host ] && refuse "the Docker command must not carry --network host" ;;
  esac
done

# The container's hardening: not root, no capabilities, no new privileges, a read-only root filesystem with a tmpfs for /tmp, and limits on processes and memory.
# Like reth's flags above, each one is required, so a change to the command above that drops one is refused before Docker is called.
docker_has() {
  local i
  for ((i = 0; i < ${#DOCKER_CMD[@]}; i++)); do
    if [ "${DOCKER_CMD[i]}" = "$1" ]; then
      [ $# -eq 1 ] && return 0
      [ "${DOCKER_CMD[i + 1]:-}" = "$2" ] && return 0
    fi
  done
  refuse "its Docker command is missing or has the wrong value for: $*"
}
[ "$RUN_UID" != 0 ] || refuse "reth must not run as root: run this script as another user"
[[ $RETH_PIDS =~ ^[1-9][0-9]*$ ]] || refuse "CZE_RETH_PIDS must be a positive number, not '$RETH_PIDS'"
[[ $RETH_MEMORY =~ ^[1-9][0-9]*[bkmg]?$ ]] || refuse "CZE_RETH_MEMORY must be a positive size such as 32g, not '$RETH_MEMORY'"
docker_has --security-opt no-new-privileges
docker_has --user "$RUN_UID:$RUN_GID"
docker_has --cap-drop ALL
docker_has --read-only
docker_has --tmpfs /tmp
docker_has --pids-limit "$RETH_PIDS"
docker_has --memory "$RETH_MEMORY"
docker_has --memory-swap "$RETH_MEMORY"

if [ "${LAUNCH_DRY_RUN:-0}" = 1 ]; then
  echo "${DOCKER_CMD[*]}"
  exit 0
fi

# The data belongs to the user the container runs as. A folder this script makes does, and a new Docker volume (root's) is handed over by a throwaway container with
# two capabilities: CHOWN, and DAC_READ_SEARCH to open a data folder that is mode 0700 and owned by another user (network/up.sh runs with umask 077). Data that an older,
# root-run reth wrote is not touched here: the script stops, and says the one command that hands it over (the same container).
CHOWN_DOCKER="docker run --rm --network none --security-opt no-new-privileges --cap-drop ALL --cap-add CHOWN --cap-add DAC_READ_SEARCH --read-only -v"
if [ "${CZE_PERSIST:-0}" = 1 ]; then
  mkdir -p "$DATA_MOUNT"
  foreign=$(find "$DATA_MOUNT" ! -uid "$RUN_UID" 2>/dev/null | head -n 1 || true)
  [ -z "$foreign" ] || refuse "$DATA_MOUNT has files that user $RUN_UID does not own ($foreign), so reth cannot write them as a non-root user. With reth stopped, run once: $CHOWN_DOCKER \"$DATA_MOUNT:/d\" \"$BUSYBOX_IMAGE\" chown -R $RUN_UID:$RUN_GID /d"
else
  $CHOWN_DOCKER "$DATA_MOUNT:/d" "$BUSYBOX_IMAGE" chown -R "$RUN_UID:$RUN_GID" /d >/dev/null
fi
if [ "${CZE_PERSIST:-0}" = 1 ] && [ "${CZE_RESUME:-0}" = 1 ]; then
  : # the genesis and the Engine secret are the ones the chain was made with
else
  CZE_STATE_DIR=$STATE "$ROOT/network/make-state.sh"
fi
"${DOCKER_CMD[@]}"
