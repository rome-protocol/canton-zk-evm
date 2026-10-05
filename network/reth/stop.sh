#!/usr/bin/env bash
# Stops and removes the reth container and its data volume.
set -uo pipefail
NAME=${RETH_CONTAINER:-cze-reth}
docker rm -f "$NAME" >/dev/null 2>&1
docker volume rm -f "$NAME-data" >/dev/null 2>&1
exit 0
