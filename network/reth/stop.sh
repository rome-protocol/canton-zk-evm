#!/usr/bin/env bash
# Stops and removes the reth container. Its data goes too, unless the data is kept: with --keep-data the container goes and the data
# stays (the persistent network: network/down.sh). With --wipe-persistent the folder $CZE_STATE_DIR/reth-data is emptied as well.
# That folder is written by reth as root, so a throwaway container removes it.
set -uo pipefail
status=0
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
NAME=${RETH_CONTAINER:-cze-reth}
STATE=${CZE_STATE_DIR:-$ROOT/state}
# A gentle stop first: reth writes its newest blocks to disk when it is told to stop, and the persistent network keeps that data.
docker stop -t 60 "$NAME" >/dev/null 2>&1
docker rm -f "$NAME" >/dev/null 2>&1
case ${1:-} in
  --keep-data) ;;
  --wipe-persistent)
    docker volume rm -f "$NAME-data" >/dev/null 2>&1
    if [ -d "$STATE/reth-data" ]; then
      rm -rf "$STATE/reth-data" 2>/dev/null   # works when the files are ours; reth writes them as root, so usually a container does it
      if [ -d "$STATE/reth-data" ]; then
        # shellcheck disable=SC1091
        . "$ROOT/PINS"
        docker run --rm --security-opt no-new-privileges -v "$STATE/reth-data:/d" "$BUSYBOX_IMAGE" sh -c 'rm -rf /d/* /d/.[!.]*' >&2 || status=1
        rmdir "$STATE/reth-data" || status=1
      fi
    fi ;;
  *) docker volume rm -f "$NAME-data" >/dev/null 2>&1 ;;
esac
exit $status
