#!/usr/bin/env bash
# Fails if a container has any UDP socket open. Docker's own resolver (127.0.0.11,
# which is 0B00007F in /proc) is the one allowed exception.
# Usage: check-udp.sh container
set -euo pipefail
NAME=${1:?usage: check-udp.sh container}
udp=$(docker exec "$NAME" cat /proc/net/udp /proc/net/udp6 \
  | awk '$1 ~ /^[0-9]+:$/ && $2 !~ /^0B00007F:/ {print $2}')
if [ -n "$udp" ]; then
  echo "FAIL: UDP sockets are open in $NAME: $udp" >&2
  exit 1
fi
echo "ok: $NAME has no UDP sockets"
