#!/usr/bin/env bash
# Runs the explorer as a container, beside the chain it shows.
#
#   explorer/run.sh setup    make the faucet's key for this run and a genesis that funds it (before the network starts, see below)
#   explorer/run.sh start    build the image if it needs building, and start the explorer
#   explorer/run.sh stop     stop it
#   explorer/run.sh build    only build the image
#
# The faucet's key and funded genesis come first, because reth starts from the genesis:
#   explorer/run.sh setup
#   CZE_GENESIS_FILE=<state>/faucet/genesis.json network/up.sh
#   explorer/run.sh start        # then open http://127.0.0.1:8088
#
# The explorer reads the chain's reth and the reader party's view of Canton, on this machine's own ports, so the container runs on the host's
# network and listens on 127.0.0.1 only. It gets what it needs and no more: the reader party, the run's own pins file and the faucet's key (both
# read-only), and no rights beyond those of the user who runs this script, who owns the key. The image is built from PINS' pinned base images.
#
# It takes these from the run's state folder ($CZE_STATE_DIR, default ./state) unless the caller gives them:
#   READER_PARTY      the reader party's id, from <state>/canton/parties.env
#   PINS_FILE         the pins to expect, from <state>/net/guest.txt (else the recorded session's, which the image carries)
#   FAUCET_KEY_FILE   the faucet's key, from <state>/faucet/key (else the faucet is off)
# And these are passed on when they are set: EXPLORER_HOST, EXPLORER_PORT, RETH_RPC_URL, LEDGER_URL, CHAIN_NAME, COIN_SYMBOL, RPC_TIMEOUT_MS,
# POLL_MS, FAUCET_AMOUNT, FAUCET_PER_ADDRESS_SECONDS, FAUCET_MIN_INTERVAL_MS and, for setup, FAUCET_FUND and CZE_GENESIS_FILE.
# Other settings of the script: EXPLORER_CONTAINER (default cze-explorer), EXPLORER_IMAGE (default cze-explorer),
# EXPLORER_DRY_RUN=1 (print the Docker commands and stop).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"
STATE=${CZE_STATE_DIR:-$ROOT/state}
case $STATE in /*) ;; *) STATE=$PWD/$STATE ;; esac   # Docker mounts need absolute paths
NAME=${EXPLORER_CONTAINER:-cze-explorer}
IMAGE=${EXPLORER_IMAGE:-cze-explorer}
fail() { echo "explorer/run.sh: $*" >&2; exit 1; }

# Runs Docker, or prints the command when EXPLORER_DRY_RUN=1.
docker_() { if [ "${EXPLORER_DRY_RUN:-0}" = 1 ]; then echo "docker $*"; else docker "$@"; fi; }
# The same, without the output of a build, a start or a removal (an image id, a container id, a name).
quietly() { if [ "${EXPLORER_DRY_RUN:-0}" = 1 ]; then echo "docker $*"; else docker "$@" > /dev/null; fi; }

build() {
  quietly build --quiet -f "$ROOT/explorer/Dockerfile" -t "$IMAGE" \
    --build-arg "EXPLORER_NODE_IMAGE=$EXPLORER_NODE_IMAGE" --build-arg "EXPLORER_RUST_IMAGE=$EXPLORER_RUST_IMAGE" "$ROOT"
}

# What every container here is given: no rights beyond the caller's, a read-only filesystem.
HARDEN=(--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges --user "$(id -u):$(id -g)")

# The absolute path of a file the caller named. Docker would make a directory of a path that is missing, and a named volume of a bare name, so
# anything that is not an existing regular file stops here.
file_path() {   # <what it is> <path>
  [ -f "$2" ] || fail "$1 is not an existing file: $2"
  case $2 in /*) echo "$2" ;; *) echo "$PWD/$2" ;; esac
}

# A file of the caller's, mounted read-only at /run/explorer under its own name; sets the variable that names it to the path inside.
mount_file() {   # <variable> <file>
  local path name; path=$(file_path "$1" "$2"); name=$(basename "$path")
  ARGS+=(-v "$path:/run/explorer/$name:ro" -e "$1=/run/explorer/$name")
}

setup() {
  local genesis; genesis=$(file_path CZE_GENESIS_FILE "${CZE_GENESIS_FILE:-$ROOT/network/genesis.json}")
  (umask 077; mkdir -p "$STATE/faucet")
  local args=(run --rm "${HARDEN[@]}" -v "$STATE/faucet:$STATE/faucet" -v "$genesis:$genesis:ro" -e "CZE_STATE_DIR=$STATE" -e "CZE_GENESIS_FILE=$genesis")
  for v in FAUCET_FUND COIN_SYMBOL; do [ -z "${!v:-}" ] || args+=(-e "$v=${!v}"); done
  docker_ "${args[@]}" "$IMAGE" node server/faucet-setup.ts
}

start() {
  ARGS=(run -d --name "$NAME" "${HARDEN[@]}" --network host -e "CHAIN_ID=$CHAIN_ID")
  local party=${READER_PARTY:-}
  [ -n "$party" ] || party=$(sed -n 's/^READER_PARTY=//p' "$STATE/canton/parties.env" 2>/dev/null || true)
  [ -n "$party" ] || fail "READER_PARTY is not set, and $STATE/canton/parties.env has none: the explorer reads Canton as the reader party only"
  ARGS+=(-e "READER_PARTY=$party")
  local pins=${PINS_FILE:-}
  [ -n "$pins" ] || { [ ! -f "$STATE/net/guest.txt" ] || pins=$STATE/net/guest.txt; }
  [ -z "$pins" ] || mount_file PINS_FILE "$pins"
  local key=${FAUCET_KEY_FILE:-}
  [ -n "$key" ] || { [ ! -f "$STATE/faucet/key" ] || key=$STATE/faucet/key; }
  [ -z "$key" ] || mount_file FAUCET_KEY_FILE "$key"
  for v in EXPLORER_HOST EXPLORER_PORT RETH_RPC_URL LEDGER_URL CHAIN_NAME COIN_SYMBOL RPC_TIMEOUT_MS POLL_MS FAUCET_AMOUNT FAUCET_PER_ADDRESS_SECONDS FAUCET_MIN_INTERVAL_MS; do
    [ -z "${!v:-}" ] || ARGS+=(-e "$v=${!v}")
  done
  quietly rm -f "$NAME" 2> /dev/null || true
  quietly "${ARGS[@]}" "$IMAGE"
}

case ${1:-} in
  build) build ;;
  setup) build; setup ;;
  start) build; start ;;
  stop) quietly rm -f "$NAME" 2> /dev/null || true ;;
  *) echo "usage: explorer/run.sh setup | start | stop | build" >&2; exit 2 ;;
esac
