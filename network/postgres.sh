#!/usr/bin/env bash
# The database of the persistent network (CZE_PERSIST=1): one PostgreSQL in Docker, on 127.0.0.1 only, with its data in a named volume.
# Canton keeps the synchronizer, the sequencer, the mediator and the three participants in it, one database each.
#   postgres.sh start   starts it (or starts the stopped one), makes the databases that are missing, and waits until it answers
#   postgres.sh stop    stops it and keeps the data
#   postgres.sh wipe    removes the container and the data
# The password is made once, on this machine, into $CZE_STATE_DIR/postgres.env (mode 0600). It is never printed and never committed:
# Docker reads it from that file, and network/canton/run.sh hands it to Canton through the environment.
# Settings (all optional): CZE_STATE_DIR, CZE_PG_CONTAINER (default cze-postgres), CZE_PG_PORT (default 5432).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"
STATE=${CZE_STATE_DIR:-$ROOT/state}
NAME=${CZE_PG_CONTAINER:-cze-postgres}
PORT=${CZE_PG_PORT:-5432}
ENV_FILE=$STATE/postgres.env
DATABASES="sequencer1 mediator1 operator confirmer users"
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
    # The data lives in the named volume, so it outlives the container. fsync stays on: a crash must not lose a committed block.
    docker run -d --name "$NAME" --security-opt no-new-privileges \
      -p "127.0.0.1:$PORT:5432" \
      --env-file "$ENV_FILE" -e POSTGRES_USER=cze -e POSTGRES_DB=postgres \
      -v "$NAME-data:/var/lib/postgresql/data" \
      "$POSTGRES_IMAGE" -c max_connections=300 >/dev/null
  fi
  # The image's first start runs a temporary server before the real one, so wait for a few consecutive answers.
  local ok=0
  for _ in $(seq 1 120); do
    if docker exec "$NAME" pg_isready -U cze -q 2>/dev/null; then ok=$((ok + 1)); [ "$ok" -ge 3 ] && break; else ok=0; fi
    sleep 1
  done
  [ "$ok" -ge 3 ] || { docker logs --tail 20 "$NAME" >&2; fail "postgres does not answer"; }
  local db
  for db in $DATABASES; do
    docker exec "$NAME" psql -U cze -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$db'" | grep -q 1 \
      || docker exec "$NAME" createdb -U cze "$db"
  done
}

case ${1:-} in
  start) start ;;
  stop) docker stop -t 60 "$NAME" >/dev/null 2>&1 || true ;;
  wipe) docker rm -f "$NAME" >/dev/null 2>&1 || true; docker volume rm -f "$NAME-data" >/dev/null 2>&1 || true; rm -f "$ENV_FILE" ;;
  *) echo "usage: postgres.sh start|stop|wipe" >&2; exit 2 ;;
esac
