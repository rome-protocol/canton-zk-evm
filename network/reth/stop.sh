#!/usr/bin/env bash
# Stops and removes the reth container. Its data goes too, unless the data is kept: with --keep-data the container goes and the data
# stays (the persistent network: network/down.sh). With --wipe-persistent the folder $CZE_STATE_DIR/reth-data is emptied as well.
# That folder is written by reth as root, so a throwaway container removes it.
set -uo pipefail
status=0
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
NAME=${RETH_CONTAINER:-cze-reth}
STATE=${CZE_STATE_DIR:-$ROOT/state}
IMAGE_OF_RETH=$(docker inspect -f '{{.Image}}' "$NAME" 2>/dev/null || true)   # the image the container runs, read before it is removed
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
        # The image of reth's own container first, when there was one: it is on the machine already (it wrote these files), so a wipe needs
        # no download, and a registry's pull limit cannot stop it. The small pinned image is the fallback.
        wipe='rm -rf /d/* /d/.[!.]*'
        { [ -n "$IMAGE_OF_RETH" ] && docker run --rm --security-opt no-new-privileges --entrypoint sh -v "$STATE/reth-data:/d" "$IMAGE_OF_RETH" -c "$wipe" >&2 2>/dev/null; } \
          || docker run --rm --security-opt no-new-privileges -v "$STATE/reth-data:/d" "$BUSYBOX_IMAGE" sh -c "$wipe" >&2 || status=1
        rmdir "$STATE/reth-data" || status=1
      fi
    fi ;;
  *) docker volume rm -f "$NAME-data" >/dev/null 2>&1 ;;
esac
exit $status
