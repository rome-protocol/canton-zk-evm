#!/usr/bin/env bash
# Starts Canton for the network and waits until it is ready. Used by network/up.sh (bootstrap), network/restart.sh (resume) and the
# persistent-network test.
#   run.sh bootstrap   starts the nodes and runs bootstrap.canton: a new synchronizer, participants, parties, users and the Daml package
#   run.sh resume      CZE_PERSIST=1 only: starts the nodes on the databases they kept and runs resume.canton: nothing is created
# With CZE_PERSIST=1 it first starts the database (network/postgres.sh) and adds canton-persistent.conf, so every node keeps its data in
# PostgreSQL. Without it the nodes are in memory, as canton.conf says, and `resume` is refused.
# Needs CANTON_JAR (network/canton/fetch.sh prints it) and, for bootstrap, CZE_DAR. The pid goes to $CZE_STATE_DIR/net/canton.pid, the
# log to $CZE_STATE_DIR/net/logs/canton.log (the previous log is kept as canton.log.prev).
# Settings (all optional): CZE_STATE_DIR, CZE_CANTON_HEAP (default 8g), CZE_CANTON_WAIT (seconds, default 600), CZE_PG_PORT.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
export CZE_STATE_DIR=${CZE_STATE_DIR:-$ROOT/state}
NET=$CZE_STATE_DIR/net
fail() { echo "FAIL: $*" >&2; exit 1; }
MODE=${1:-}
case $MODE in bootstrap | resume) ;; *) echo "usage: run.sh bootstrap|resume" >&2; exit 2 ;; esac
{ [ -n "${CANTON_JAR:-}" ] && [ -f "$CANTON_JAR" ]; } || fail "set CANTON_JAR to the Canton jar (network/canton/fetch.sh)"
if [ "$MODE" = bootstrap ] && [ -z "${CZE_DAR:-}" ]; then fail "set CZE_DAR to the built DAR"; fi

umask 077
mkdir -p "$NET/logs"
CONF=(-c "$ROOT/network/canton/canton.conf")
if [ "${CZE_PERSIST:-0}" = 1 ]; then
  "$ROOT/network/postgres.sh" start
  CZE_PG_PASSWORD=$(sed -n 's/^POSTGRES_PASSWORD=//p' "$CZE_STATE_DIR/postgres.env")
  [ -n "$CZE_PG_PASSWORD" ] || fail "no password in $CZE_STATE_DIR/postgres.env"
  export CZE_PG_PASSWORD
  CONF+=(-c "$ROOT/network/canton/canton-persistent.conf")
elif [ "$MODE" = resume ]; then
  fail "resume needs CZE_PERSIST=1: an in-memory network keeps nothing to resume"
fi
if [ -f "$NET/canton.pid" ] && kill -0 "$(cat "$NET/canton.pid")" 2>/dev/null; then fail "Canton is running already (pid $(cat "$NET/canton.pid"))"; fi
if [ -f "$NET/logs/canton.log" ]; then mv -f "$NET/logs/canton.log" "$NET/logs/canton.log.prev"; fi

case $MODE in bootstrap) SCRIPT=bootstrap.canton; DONE="BOOTSTRAP DONE" ;; resume) SCRIPT=resume.canton; DONE="RESUME DONE" ;; esac
nohup java -Xmx"${CZE_CANTON_HEAP:-8g}" -jar "$CANTON_JAR" daemon "${CONF[@]}" --bootstrap "$ROOT/network/canton/$SCRIPT" --no-tty \
  > "$NET/logs/canton.log" 2>&1 < /dev/null &
echo $! > "$NET/canton.pid"
for _ in $(seq 1 "${CZE_CANTON_WAIT:-600}"); do
  if grep -q "$DONE" "$NET/logs/canton.log"; then exit 0; fi
  kill -0 "$(cat "$NET/canton.pid")" 2>/dev/null || { tail -n 30 "$NET/logs/canton.log" >&2; fail "Canton stopped"; }
  sleep 1
done
fail "Canton did not print '$DONE' in time"
