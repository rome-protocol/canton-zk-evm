#!/usr/bin/env bash
# Stops what network/up.sh started: Canton, the sidecars, the prover and reth (with its data). Safe to run twice.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
STATE=${CZE_STATE_DIR:-$ROOT/state}
NET=$STATE/net
PROVER=${CZE_PROVER_STATE:-$STATE/prover}

stop() {   # a process by its pid file
  local f=$1 pid
  [ -f "$f" ] || return 0
  pid=$(cat "$f")
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null
    for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    kill -9 "$pid" 2>/dev/null
  fi
  rm -f "$f"
}

for f in "$NET"/canton.pid "$NET"/sidecar-*.pid "$PROVER"/worker.pid "$PROVER"/coordinator.pid; do stop "$f"; done
"$ROOT/network/reth/stop.sh"
echo "stopped"
