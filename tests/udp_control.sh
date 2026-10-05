#!/usr/bin/env bash
# A control for the UDP check in check-udp.sh, with no reth involved: the check must
# fail on a container that has a UDP listener and pass on one that has none. Without
# this, a check that always passes would look the same as a check that works.
# Needs Docker.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"
fail() { echo "FAIL: $*" >&2; exit 1; }

QUIET=cze-udp-control-quiet-$$
LISTENING=cze-udp-control-listening-$$
trap 'docker rm -f "$QUIET" "$LISTENING" >/dev/null 2>&1 || true' EXIT

docker run -d --name "$QUIET" "$BUSYBOX_IMAGE" sleep 300 >/dev/null
# udpsvd keeps a UDP socket open on port 9999 (0x270F).
docker run -d --name "$LISTENING" "$BUSYBOX_IMAGE" udpsvd 0.0.0.0 9999 cat >/dev/null
for _ in $(seq 1 20); do
  docker exec "$LISTENING" grep -q ':270F ' /proc/net/udp && break
  sleep 0.5
done
docker exec "$LISTENING" grep -q ':270F ' /proc/net/udp || fail "the control's UDP listener did not start"

"$ROOT/network/reth/check-udp.sh" "$QUIET" >/dev/null \
  || fail "check-udp.sh failed on a container with no UDP socket"
if err=$("$ROOT/network/reth/check-udp.sh" "$LISTENING" 2>&1); then
  fail "check-udp.sh passed on a container with a UDP listener"
fi
grep -q '270F' <<<"$err" || fail "check-udp.sh did not name the open socket: $err"
echo "udp control passed"
