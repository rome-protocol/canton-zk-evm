#!/usr/bin/env bash
# Stops what network/up.sh (or network/restart.sh) started: Canton, the sidecars, the prover and reth. Safe to run twice.
#   down.sh          a network made without CZE_PERSIST also loses its data, as always. A persistent network keeps everything: its
#                    databases, reth's data and the secrets, so network/restart.sh brings the same chain back.
#   down.sh --wipe   removes a persistent network's data as well: the databases (the explorer's too), reth's data, the passwords and the party list. The chain is gone.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
STATE=${CZE_STATE_DIR:-$ROOT/state}
NET=$STATE/net
PROVER=${CZE_PROVER_STATE:-$STATE/prover}
WIPE=0
case ${1:-} in
  "") ;;
  --wipe) WIPE=1 ;;
  *) echo "usage: down.sh [--wipe]" >&2; exit 2 ;;
esac
PERSISTENT=0
if [ -e "$STATE/persist.env" ]; then
  PERSISTENT=1
  # The containers and ports the chain was made with, not whatever this shell has set (network/persist-settings.sh).
  # shellcheck disable=SC1091
  . "$ROOT/network/persist-settings.sh"
  load_persist_settings "$STATE" || exit 1
fi

stop() {   # a process by its pid file, if that pid is still the process that was started (after a reboot another one may have it)
  local f=$1 pid
  [ -f "$f" ] || return 0
  pid=$(cat "$f")
  if kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o args= 2>/dev/null | grep -qE "$2"; then
    kill "$pid" 2>/dev/null
    for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    kill -9 "$pid" 2>/dev/null
  fi
  rm -f "$f"
}

# Canton first, so that it closes its databases before they stop.
stop "$NET/canton.pid" 'canton'
for f in "$NET"/sidecar-*.pid; do stop "$f" 'zk-sidecar'; done
stop "$PROVER/worker.pid" 'zisk-worker'
stop "$PROVER/coordinator.pid" 'zisk-coordinator'
if [ "$PERSISTENT" = 1 ]; then
  CZE_STATE_DIR=$STATE "$ROOT/network/postgres.sh" stop
  CZE_STATE_DIR=$STATE "$ROOT/network/explorer-db.sh" stop
  if [ "$WIPE" = 1 ]; then
    # persist.env goes last, and only if everything else is gone: it is what tells restart.sh and down.sh that there is a chain to look after.
    left=()
    CZE_STATE_DIR=$STATE "$ROOT/network/reth/stop.sh" --wipe-persistent || left+=("reth's data")
    CZE_STATE_DIR=$STATE "$ROOT/network/postgres.sh" wipe || left+=("the database")
    CZE_STATE_DIR=$STATE "$ROOT/network/explorer-db.sh" wipe || left+=("the explorer's database")
    rm -rf "$NET" "$STATE/canton" "$STATE/jwt.hex" "$STATE/genesis.json"
    if [ ${#left[@]} -gt 0 ]; then
      echo "NOT wiped: ${left[*]} could not be removed and is still there (see above). persist.env is kept: fix the cause and run network/down.sh --wipe again." >&2
      exit 1
    fi
    rm -f "$STATE/persist.env"
    echo "stopped; the persistent chain is wiped, and so is the explorer's database"
  else
    CZE_STATE_DIR=$STATE "$ROOT/network/reth/stop.sh" --keep-data
    echo "stopped; the chain's data is kept (network/restart.sh brings it back, network/down.sh --wipe removes it)"
  fi
else
  [ "$WIPE" = 0 ] || echo "this network is not persistent: its data goes with it"
  "$ROOT/network/reth/stop.sh"
  echo "stopped"
fi
