#!/usr/bin/env bash
# Starts the prover and leaves it running: the coordinator and one GPU worker with the PLONK
# key loaded, so that each proof does not pay for the start-up. Does nothing if both run already.
#
# Logs and pid files go to the prover state folder (see common.sh).
set -euo pipefail
# shellcheck disable=SC1091
. "$(dirname "$0")/common.sh"

mkdir -p "$STATE/logs"
if pgrep -f '^zisk-coordinator' >/dev/null && pgrep -f '^zisk-worker' >/dev/null; then
  echo "the coordinator and the worker are already running"
  exit 0
fi

nohup zisk-coordinator > "$STATE/logs/coordinator.log" 2>&1 < /dev/null &
echo $! > "$STATE/coordinator.pid"
# The worker joins the coordinator on its own port (50051); proofs are requested on ZISK_COORDINATOR_URL.
nohup zisk-worker --coordinator-url http://127.0.0.1:50051 --gpu --plonk --preload-plonk \
  > "$STATE/logs/worker.log" 2>&1 < /dev/null &
echo $! > "$STATE/worker.pid"

# The worker is ready once the coordinator has accepted it, after the keys are loaded.
for _ in $(seq 1 1200); do
  grep -q "Registration accepted" "$STATE/logs/worker.log" 2>/dev/null && { echo "the prover is ready"; exit 0; }
  sleep 0.5
done
tail -n 20 "$STATE/logs/worker.log" >&2
fail "the worker was not accepted by the coordinator within ten minutes"
