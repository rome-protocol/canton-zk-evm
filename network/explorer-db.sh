#!/usr/bin/env bash
# The explorer's own database (CZE_PERSIST=1): a second PostgreSQL in Docker, apart from the one Canton uses, so that a heavy query
# on the explorer's data can never slow Canton's commits. 127.0.0.1 only, its data in a named volume, one database (explorer) and one user.
#   explorer-db.sh start   starts it (or starts the stopped one), waits until it answers, and makes the database if it is missing
#   explorer-db.sh stop    stops it and keeps the data
#   explorer-db.sh wipe    removes the container and the data
# The password is made once, on this machine, into $CZE_STATE_DIR/explorer-db.env (mode 0600) as a line POSTGRES_PASSWORD=...
# It is never printed and never committed. Docker reads it from that file, and the explorer reads it through EXPLORER_DB_PASSWORD_FILE.
# The schema is not made here: the explorer applies its migrations itself (node server/db/cli.ts migrate).
# Settings (all optional): CZE_STATE_DIR, CZE_EXPLORER_DB_CONTAINER (default cze-explorer-db), CZE_EXPLORER_DB_PORT (default 5433).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"
STATE=${CZE_STATE_DIR:-$ROOT/state}
NAME=${CZE_EXPLORER_DB_CONTAINER:-cze-explorer-db}
PORT=${CZE_EXPLORER_DB_PORT:-5433}
ENV_FILE=$STATE/explorer-db.env
fail() { echo "FAIL: $*" >&2; exit 1; }
exists() { docker inspect "$NAME" >/dev/null 2>&1; }
running() { [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" = true ]; }

start() {
  umask 077
  mkdir -p "$STATE"
  [ -s "$ENV_FILE" ] || { echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" > "$ENV_FILE"; chmod 600 "$ENV_FILE"; }
  if running; then :
  elif exists; then docker start "$NAME" >/dev/null
  else
    # fsync stays on: a crash must not lose a committed block. The volume outlives the container.
    docker run -d --name "$NAME" --security-opt no-new-privileges \
      -p "127.0.0.1:$PORT:5432" \
      --env-file "$ENV_FILE" -e POSTGRES_USER=explorer -e POSTGRES_DB=explorer \
      -v "$NAME-data:/var/lib/postgresql/data" \
      "$POSTGRES_IMAGE" -c max_connections=100 >/dev/null
  fi
  # The image's first start runs a temporary server before the real one, so wait for a few consecutive answers.
  local ok=0
  for _ in $(seq 1 120); do
    if docker exec "$NAME" pg_isready -U explorer -d explorer -q 2>/dev/null; then ok=$((ok + 1)); [ "$ok" -ge 3 ] && break; else ok=0; fi
    sleep 1
  done
  [ "$ok" -ge 3 ] || { docker logs --tail 20 "$NAME" >&2; fail "the explorer's database does not answer"; }
}

case ${1:-} in
  start) start ;;
  stop) docker stop -t 60 "$NAME" >/dev/null 2>&1 || true ;;
  wipe)
    # Says so, and fails, if the container or the volume is still there afterwards: down.sh --wipe must not claim a wipe that did not happen.
    docker info >/dev/null 2>&1 || fail "docker does not answer, so nothing was wiped"
    if exists; then docker rm -f "$NAME" >/dev/null || fail "could not remove the container $NAME"; fi
    if docker volume inspect "$NAME-data" >/dev/null 2>&1; then docker volume rm -f "$NAME-data" >/dev/null || fail "could not remove the volume $NAME-data"; fi
    rm -f "$ENV_FILE" ;;
  *) echo "usage: explorer-db.sh start|stop|wipe" >&2; exit 2 ;;
esac
