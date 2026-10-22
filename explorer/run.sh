#!/usr/bin/env bash
# Runs the explorer as a container, beside the chain it shows.
#
#   explorer/run.sh setup    make the faucet's key for this run and a genesis that funds it (before the network starts, see below)
#   explorer/run.sh start    build the image if it needs building, make the database ready, and start the indexer and the explorer
#   explorer/run.sh stop     stop both (and, on a network that is not persistent, remove the database `start` made: see below)
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
# And these are passed on when they are set: EXPLORER_HOST, EXPLORER_PORT, RETH_RPC_URL, LEDGER_URL, CHAIN_NAME, NETWORK_NAME, COIN_SYMBOL, RPC_TIMEOUT_MS,
# POLL_MS, FAUCET_AMOUNT, FAUCET_PER_ADDRESS_SECONDS, FAUCET_PER_IP_SECONDS, FAUCET_MAX_PER_HOUR, FAUCET_BATCH, FAUCET_QUEUE_MAX, the human check's CAPTCHA_VERIFY_URL, CAPTCHA_SCRIPT_URL, CAPTCHA_SITE_KEY and CAPTCHA_WIDGET_CLASS (and CAPTCHA_SECRET, which is taken from the environment and never put on the command), and the public RPC's settings: PUBLIC_RPC (1 turns on POST /rpc),
# RPC_RATE_PER_MINUTE, TRUSTED_IP_HEADER, TRACKER_MAX, TRACKER_MAX_BYTES, TRACKER_PER_SENDER, TRACKER_MAX_PENDING_MINUTES. For setup: FAUCET_FUND and CZE_GENESIS_FILE.
# The filesystem is read-only, so the transaction tracker keeps its list in <state>/explorer, which is mounted at /var/lib/explorer, and
# TRACKER_FILE is /var/lib/explorer/tracker.json unless the caller names another path under that folder. The list survives a restart of the container.
# The database: the explorer shows the chain the indexer wrote there, and does not start without one. With none named, `start` takes the one
# network/explorer-db.sh makes (it starts it if it is not running; password in <state>/explorer-db.env, port CZE_EXPLORER_DB_PORT, default 5433).
# To name another: EXPLORER_DB_PASSWORD_FILE and FAUCET_CLIENT_KEY_FILE are mounted read-only like the faucet's key; EXPLORER_DB_HOST, EXPLORER_DB_PORT,
# EXPLORER_DB_USER and EXPLORER_DB_NAME are passed on; EXPLORER_DATABASE_URL is taken from the environment and never put on the command.
# FAUCET_CLIENT_KEY_FILE (the faucet's hash key) is made as <state>/faucet/client-key (mode 0600) when there is a faucet key and none is named.
# `start` applies the migrations (node server/db/cli.ts migrate), then runs the indexer (node server/indexer/cli.ts) as its own container, EXPLORER_INDEXER_CONTAINER
# (default cze-explorer-indexer), beside the explorer. It reads the same chain, and also takes GATEWAY_ADDRESS (from PINS), GENESIS_FILE (default <state>/genesis.json, the genesis reth runs), INDEX_DERIVE, INDEX_POLL_MS,
# INDEX_RETH_BEHIND_MS and INDEX_TRACE_TIMEOUT_MS. It reads the producer's journal and status.json from the builder's work folder (CZE_WORK_DIR, default <state>/builder), mounted read-only when it exists. It reads reth and Canton at INDEXER_RETH_RPC_URL and INDEXER_LEDGER_URL when they are set, else at the
# explorer's (the indexer asks reth for trace_ methods too, so a log of the explorer's own calls is not put in front of it). It never restarts by itself:
# a check that stops it leaves it stopped, and the explorer says so (503) until a person has looked.
# The default database lives and dies with its network. For a persistent network (<state>/persist.env, CZE_PERSIST=1) it is kept across `stop`, and
# the container and port it was made with are read back from persist.env. For a network that is not persistent, `stop` wipes it (network/explorer-db.sh
# wipe), and so does network/down.sh: a new chain made from the same genesis would otherwise meet the old chain's rows and the indexer would stop on them.
# A database the caller named (EXPLORER_DATABASE_URL, EXPLORER_DB_PASSWORD_FILE) is never wiped here.
# The Ledger API token: LEDGER_TOKEN_FILE (or CZE_TOKEN_FILE_READER, for the reader user of an existing participant) names a 0600 file with the reader's bearer token;
# it is mounted read-only at /run/explorer/<its name>, and the explorer and the indexer both get it and read it again on every call, so a refreshed file is picked up. Its value is never on the command.
# TRUSTED_IP_HEADER is for an explorer whose port can be reached only through a proxy that sets the header. Otherwise any client could write it.
# Other settings of the script: EXPLORER_CONTAINER (default cze-explorer), EXPLORER_IMAGE (default cze-explorer),
# EXPLORER_DRY_RUN=1 (print the Docker commands and stop).
# The verifier (contract verification, design section 6.3) is OFF unless EXPLORER_VERIFIER=1: `start` then runs `node server/verifier/cli.ts` as its own container,
# EXPLORER_VERIFIER_CONTAINER (default cze-explorer-verifier), and the API answers 503 to a submission until that role is running. Without the switch `start` stops any verifier
# container left from an earlier run, and starts none. The verifier compiles each contract in a throwaway container with no network, so it needs the Docker program and
# the Docker socket: the program is the pinned static build (PINS' DOCKER_CLI_VERSION and DOCKER_CLI_SHA256), downloaded once into <state>/explorer-verifier/bin and checked,
# and mounted read-only; the socket is mounted with its group added (DOCKER_SOCKET, default /var/run/docker.sock). The compilers are kept in <state>/explorer-verifier/solc, mounted at
# the same path (the Docker daemon must see it there). The sandbox image is PINS' BUSYBOX_IMAGE, which must be on the machine already (docker pull it once). SOLC_LIST_URL (the compiler
# release list; no default) is required, OUTSIDE_USER_AGENT (default "Rome Protocol rome@romeprotocol.com") is what the compiler download says it is, and SOLC_TIMEOUT_MS, SOLC_MEMORY_MB,
# SOLC_MAX_OUTPUT_MB, SOLC_MAX_INPUT_KB and SOLC_CACHE_MAX_MB are passed on when set.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"
STATE=${CZE_STATE_DIR:-$ROOT/state}
case $STATE in /*) ;; *) STATE=$PWD/$STATE ;; esac   # Docker mounts need absolute paths
NAME=${EXPLORER_CONTAINER:-cze-explorer}
INDEXER_NAME=${EXPLORER_INDEXER_CONTAINER:-cze-explorer-indexer}
VERIFIER_NAME=${EXPLORER_VERIFIER_CONTAINER:-cze-explorer-verifier}
IMAGE=${EXPLORER_IMAGE:-cze-explorer}
fail() { echo "explorer/run.sh: $*" >&2; exit 1; }
# A persistent network's database container and port are the ones it was made with, not whatever this shell has set (as down.sh and restart.sh do).
if [ -e "$STATE/persist.env" ]; then
  # shellcheck disable=SC1091
  . "$ROOT/network/persist-settings.sh"
  load_persist_settings "$STATE" || exit 1
fi

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

# Makes the database named: the caller's, or the one network/explorer-db.sh runs for this state folder (started here if it is not up).
database() {
  [ -z "${EXPLORER_DATABASE_URL:-}" ] || return 0
  [ -z "${EXPLORER_DB_PASSWORD_FILE:-}" ] || return 0
  [ "${EXPLORER_DRY_RUN:-0}" = 1 ] || CZE_STATE_DIR=$STATE "$ROOT/network/explorer-db.sh" start
  EXPLORER_DB_PASSWORD_FILE=$STATE/explorer-db.env
  [ -n "${EXPLORER_DB_PORT:-}" ] || [ -z "${CZE_EXPLORER_DB_PORT:-}" ] || EXPLORER_DB_PORT=$CZE_EXPLORER_DB_PORT
}

# The database's settings for the container being built in ARGS.
database_args() {
  [ -z "${EXPLORER_DB_PASSWORD_FILE:-}" ] || mount_file EXPLORER_DB_PASSWORD_FILE "$EXPLORER_DB_PASSWORD_FILE"
  for v in EXPLORER_DB_HOST EXPLORER_DB_PORT EXPLORER_DB_USER EXPLORER_DB_NAME; do
    [ -z "${!v:-}" ] || ARGS+=(-e "$v=${!v}")
  done
  [ -z "${EXPLORER_DATABASE_URL:-}" ] || ARGS+=(-e EXPLORER_DATABASE_URL)   # a URL may hold the password, so it is named without its value, as the captcha's secret is
}

# The reader party and the run's pins, for the container being built in ARGS (the explorer and the indexer read the same chain).
chain_args() {
  local party=${READER_PARTY:-}
  [ -n "$party" ] || party=$(sed -n 's/^READER_PARTY=//p' "$STATE/canton/parties.env" 2>/dev/null || true)
  [ -n "$party" ] || fail "READER_PARTY is not set, and $STATE/canton/parties.env has none: the explorer reads Canton as the reader party only"
  ARGS+=(-e "READER_PARTY=$party")
  local pins=${PINS_FILE:-}
  [ -n "$pins" ] || { [ ! -f "$STATE/net/guest.txt" ] || pins=$STATE/net/guest.txt; }
  [ -z "$pins" ] || mount_file PINS_FILE "$pins"
  # A participant that needs a login: the reader's token file (mode 0600, one token), mounted read-only. LEDGER_TOKEN_FILE names it; on an existing
  # participant (network/README.md, "Running on an existing participant") CZE_TOKEN_FILE_READER, the reader user's file, is used when LEDGER_TOKEN_FILE is not set.
  # Both containers read Canton, so both get it. They read the file on every call and refuse one that others can read. Without either, Canton is read without a token.
  local tokenfile=${LEDGER_TOKEN_FILE:-${CZE_TOKEN_FILE_READER:-}}
  [ -z "$tokenfile" ] || mount_file LEDGER_TOKEN_FILE "$tokenfile"
}

# The explorer's container, in ARGS (without the database's settings: the files named here are checked first, before anything runs).
explorer_args() {
  ARGS=(run -d --name "$NAME" "${HARDEN[@]}" --network host -e "CHAIN_ID=$CHAIN_ID")
  # The one place the explorer may write. The caller owns it, as the container runs as the caller.
  [ "${EXPLORER_DRY_RUN:-0}" = 1 ] || (umask 077; mkdir -p "$STATE/explorer")
  ARGS+=(-v "$STATE/explorer:/var/lib/explorer" -e "TRACKER_FILE=${TRACKER_FILE:-/var/lib/explorer/tracker.json}" -e "FAUCET_STATE_FILE=${FAUCET_STATE_FILE:-/var/lib/explorer/faucet.json}")
  chain_args
  local key=${FAUCET_KEY_FILE:-}
  [ -n "$key" ] || { [ ! -f "$STATE/faucet/key" ] || key=$STATE/faucet/key; }
  [ -z "$key" ] || mount_file FAUCET_KEY_FILE "$key"
  # The faucet's hash key: the caller's, else one made once for this state folder (the faucet keeps its state in the database, with client addresses as keyed hashes).
  local ckey=${FAUCET_CLIENT_KEY_FILE:-}
  if [ -z "$ckey" ] && [ -n "$key" ]; then
    ckey=$STATE/faucet/client-key
    [ -f "$ckey" ] || [ "${EXPLORER_DRY_RUN:-0}" = 1 ] || (umask 077; mkdir -p "$STATE/faucet"; openssl rand -hex 32 > "$ckey")
    [ -f "$ckey" ] || ckey=
  fi
  [ -z "$ckey" ] || mount_file FAUCET_CLIENT_KEY_FILE "$ckey"
  for v in EXPLORER_HOST EXPLORER_PORT RETH_RPC_URL LEDGER_URL CHAIN_NAME NETWORK_NAME COIN_SYMBOL RPC_TIMEOUT_MS POLL_MS FAUCET_AMOUNT FAUCET_PER_ADDRESS_SECONDS FAUCET_PER_IP_SECONDS FAUCET_MAX_PER_HOUR FAUCET_BATCH FAUCET_QUEUE_MAX \
    CAPTCHA_VERIFY_URL CAPTCHA_SCRIPT_URL CAPTCHA_SITE_KEY CAPTCHA_WIDGET_CLASS \
    PUBLIC_RPC RPC_RATE_PER_MINUTE TRUSTED_IP_HEADER TRACKER_MAX TRACKER_MAX_BYTES TRACKER_PER_SENDER TRACKER_MAX_PENDING_MINUTES; do
    [ -z "${!v:-}" ] || ARGS+=(-e "$v=${!v}")
  done
  # The secret is named without a value, so Docker takes it from this shell's environment and it is never in the command line.
  [ -z "${CAPTCHA_SECRET:-}" ] || ARGS+=(-e CAPTCHA_SECRET)
}

# The indexer's container, in ARGS (also without the database's settings).
indexer_args() {
  ARGS=(run -d --name "$INDEXER_NAME" "${HARDEN[@]}" --network host -e "CHAIN_ID=$CHAIN_ID" -e "GATEWAY_ADDRESS=$GATEWAY_ADDRESS")
  chain_args
  # The genesis reth runs (network/make-state.sh's), whose contracts the indexer seeds at its first start; GENESIS_FILE names another.
  local genesis=${GENESIS_FILE:-}
  [ -n "$genesis" ] || genesis=$STATE/genesis.json
  [ -f "$genesis" ] || fail "GENESIS_FILE is not set, and $STATE/genesis.json (the genesis reth runs) is not there: the indexer seeds the chain's contracts from it"
  mount_file GENESIS_FILE "$genesis"
  # The producer's work folder (the builder's CZE_WORK_DIR, default <state>/builder), read-only: the indexer reads its journal/ folder and status.json and never writes
  # there. The folder is mounted, not the status file, because the producer replaces that file by a rename. Without the folder the lifecycle stays blank and the health says so.
  local work=${CZE_WORK_DIR:-$STATE/builder}
  case $work in /*) ;; *) work=$PWD/$work ;; esac
  if [ -d "$work" ]; then
    ARGS+=(-v "$work:/run/explorer/producer:ro" -e JOURNAL_DIR=/run/explorer/producer/journal -e PRODUCER_STATUS_FILE=/run/explorer/producer/status.json)
  else
    echo "run.sh: no producer work folder at $work: the lifecycle stays blank, and the health says so, until the explorer is started again" >&2
  fi
  local reth=${INDEXER_RETH_RPC_URL:-${RETH_RPC_URL:-}} ledger=${INDEXER_LEDGER_URL:-${LEDGER_URL:-}}
  [ -z "$reth" ] || ARGS+=(-e "RETH_RPC_URL=$reth")
  [ -z "$ledger" ] || ARGS+=(-e "LEDGER_URL=$ledger")
  for v in RPC_TIMEOUT_MS INDEX_DERIVE INDEX_POLL_MS INDEX_RETH_BEHIND_MS INDEX_TRACE_TIMEOUT_MS; do
    [ -z "${!v:-}" ] || ARGS+=(-e "$v=${!v}")
  done
}

# The pinned Docker program, in <state>/explorer-verifier/bin/docker: downloaded once, and checked against PINS' SHA-256 before it is used.
verifier_docker_cli() {
  local dir=$STATE/explorer-verifier/bin mark="$DOCKER_CLI_VERSION $DOCKER_CLI_SHA256"
  [ "${EXPLORER_DRY_RUN:-0}" != 1 ] || return 0
  if [ -x "$dir/docker" ] && [ "$(cat "$dir/docker.pin" 2> /dev/null)" = "$mark" ]; then return 0; fi
  (umask 077; mkdir -p "$dir")
  local tgz=$dir/docker.tgz sum
  curl -fsSL -A 'Rome Protocol rome@romeprotocol.com' -o "$tgz" "https://download.docker.com/linux/static/stable/x86_64/docker-$DOCKER_CLI_VERSION.tgz" || { rm -f "$tgz"; fail "the Docker program could not be downloaded"; }
  sum=$( (sha256sum "$tgz" 2> /dev/null || shasum -a 256 "$tgz") | cut -d' ' -f1)
  [ "$sum" = "$DOCKER_CLI_SHA256" ] || { rm -f "$tgz"; fail "the Docker program's SHA-256 is $sum, not the pinned $DOCKER_CLI_SHA256"; }
  tar -xzf "$tgz" -C "$dir" --strip-components=1 docker/docker
  rm -f "$tgz"
  echo "$mark" > "$dir/docker.pin"
}

# The verifier's container, in ARGS (also without the database's settings).
# Trust boundary: this container takes submissions from anyone and is given the Docker socket, which is root on the machine that owns the daemon. The compiler itself
# runs in a container of its own that has no network, a read-only filesystem, no capabilities and no user rights (server/verifier/sandbox.ts); the process that
# starts it is the part that must not be broken into. So the verifier runs only where EXPLORER_VERIFIER=1 is set, and DOCKER_SOCKET should name the socket of a rootless
# Docker daemon (or a socket proxy that allows only create, start, wait and remove) wherever the machine has more than the explorer on it.
verifier_args() {
  [ -n "${SOLC_LIST_URL:-}" ] || fail "EXPLORER_VERIFIER=1 needs SOLC_LIST_URL, the address of the compiler release list"
  local sock=${DOCKER_SOCKET:-/var/run/docker.sock} gid cache=$STATE/explorer-verifier/solc bin=$STATE/explorer-verifier/bin/docker
  if [ "${EXPLORER_DRY_RUN:-0}" = 1 ]; then
    gid=$(stat -c %g "$sock" 2> /dev/null || stat -f %g "$sock" 2> /dev/null || echo 0)
  else
    [ -S "$sock" ] || fail "the Docker socket is not at $sock (DOCKER_SOCKET)"
    gid=$(stat -c %g "$sock" 2> /dev/null || stat -f %g "$sock")
    docker image inspect "$BUSYBOX_IMAGE" > /dev/null 2>&1 || fail "the sandbox image is not on this machine: docker pull $BUSYBOX_IMAGE"
    verifier_docker_cli
    (umask 077; mkdir -p "$cache")
  fi
  ARGS=(run -d --name "$VERIFIER_NAME" "${HARDEN[@]}" --network host -e HOME=/tmp --group-add "$gid"
    -v "$sock:/var/run/docker.sock" -v "$bin:/usr/local/bin/docker:ro" -v "$cache:$cache"
    -e "GATEWAY_ADDRESS=$GATEWAY_ADDRESS" -e "GATEWAY_SOURCE_FILE=/repo/gateway/Gateway.sol" -e "GATEWAY_COMPILER=$SOLC_VERSION"
    -e "SOLC_CACHE_DIR=$cache" -e "SANDBOX_IMAGE=$BUSYBOX_IMAGE" -e "SOLC_LIST_URL=$SOLC_LIST_URL" -e "OUTSIDE_USER_AGENT=${OUTSIDE_USER_AGENT:-Rome Protocol rome@romeprotocol.com}")
  for v in SOLC_TIMEOUT_MS SOLC_MEMORY_MB SOLC_MAX_OUTPUT_MB SOLC_MAX_INPUT_KB SOLC_CACHE_MAX_MB; do
    [ -z "${!v:-}" ] || ARGS+=(-e "$v=${!v}")
  done
}

# Everything that names a file is checked while the three containers' arguments are made, and nothing runs before that is done.
start() {
  explorer_args; local explorer=("${ARGS[@]}")
  indexer_args; local indexer=("${ARGS[@]}")
  local verifier=()
  if [ "${EXPLORER_VERIFIER:-0}" = 1 ]; then verifier_args; verifier=("${ARGS[@]}"); fi
  database   # may start the database, which makes the password file the next lines mount
  ARGS=("${explorer[@]}"); database_args; explorer=("${ARGS[@]}")
  ARGS=("${indexer[@]}"); database_args; indexer=("${ARGS[@]}")
  if [ "${EXPLORER_VERIFIER:-0}" = 1 ]; then ARGS=("${verifier[@]}"); database_args; verifier=("${ARGS[@]}"); fi
  ARGS=(run --rm "${HARDEN[@]}" --network host); database_args; local migrate=("${ARGS[@]}")
  quietly "${migrate[@]}" "$IMAGE" node server/db/cli.ts migrate
  stop_indexer
  quietly "${indexer[@]}" "$IMAGE" node server/indexer/cli.ts
  stop_verifier
  if [ "${EXPLORER_VERIFIER:-0}" = 1 ]; then quietly "${verifier[@]}" "$IMAGE" node server/verifier/cli.ts; fi
  stop_container
  quietly "${explorer[@]}" "$IMAGE"
}

# Stops the container gracefully: SIGTERM, then up to 30 seconds for the explorer to write the tracker's list and let the faucet
# finish the send in hand (server/shutdown.ts). Never docker rm -f, which sends SIGKILL and skips all of that.
stop_container() {
  quietly stop -t 30 "$NAME" 2> /dev/null || true
  quietly rm "$NAME" 2> /dev/null || true
}

# The indexer stops on SIGTERM and lets the write in hand finish.
stop_indexer() {
  quietly stop -t 30 "$INDEXER_NAME" 2> /dev/null || true
  quietly rm "$INDEXER_NAME" 2> /dev/null || true
}

# The verifier stops on SIGTERM after the job in hand: docker waits for as long as a compile may run (SOLC_TIMEOUT_MS, a minute by default) and 30 seconds more.
# A job that is still downloading a compiler is not waited for; its lease runs out and it is taken again.
stop_verifier() {
  quietly stop -t "$(( ${SOLC_TIMEOUT_MS:-60000} / 1000 + 30 ))" "$VERIFIER_NAME" 2> /dev/null || true
  quietly rm "$VERIFIER_NAME" 2> /dev/null || true
}

# The default database follows the network's life: for a network that is not persistent, `stop` removes the database that `start` made, so the next
# chain starts with an empty one. A persistent network keeps it, and a database the caller named is not ours to remove.
forget_database() {
  [ -z "${EXPLORER_DATABASE_URL:-}" ] || return 0
  [ -z "${EXPLORER_DB_PASSWORD_FILE:-}" ] || return 0
  [ ! -e "$STATE/persist.env" ] || return 0
  [ -f "$STATE/explorer-db.env" ] || return 0   # start made none, so there is nothing to remove
  if [ "${EXPLORER_DRY_RUN:-0}" = 1 ]; then echo "network/explorer-db.sh wipe"; return 0; fi
  CZE_STATE_DIR=$STATE "$ROOT/network/explorer-db.sh" wipe || fail "the explorer's database could not be removed (see above): run network/explorer-db.sh wipe again before the next network"
  echo "explorer/run.sh: this network is not persistent, so the explorer's database is removed with it"
}

case ${1:-} in
  build) build ;;
  setup) build; setup ;;
  start) build; start ;;
  stop) stop_container; stop_indexer; stop_verifier; forget_database ;;
  *) echo "usage: explorer/run.sh setup | start | stop | build" >&2; exit 2 ;;
esac
