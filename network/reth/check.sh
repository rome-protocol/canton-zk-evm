#!/usr/bin/env bash
# Checks that a running reth container really has peer discovery off.
# Usage: check.sh [container]   (default: $RETH_CONTAINER or cze-reth)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"
NAME=${1:-${RETH_CONTAINER:-cze-reth}}
fail() { echo "FAIL: $*" >&2; exit 1; }

# 1. No peers.
http=$(docker port "$NAME" 8545/tcp | head -1)
peers=$(curl -sf -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"net_peerCount","params":[]}' "http://$http" | jq -r .result)
[ "$peers" = 0x0 ] || fail "net_peerCount is $peers, expected 0x0"

# 2. Docker publishes only the RPC, WS and Engine ports, each on 127.0.0.1 only, and
#    nothing for the p2p port (30303).
ports=$(docker port "$NAME")
other=$(grep -vE '^(8545|8546|8551)/tcp -> 127\.0\.0\.1:[0-9]+$' <<<"$ports" || true)
[ -z "$other" ] || fail "unexpected published ports: $other"
for p in 8545 8546 8551; do
  grep -qE "^$p/tcp -> 127\.0\.0\.1:[0-9]+\$" <<<"$ports" || fail "port $p is not published on 127.0.0.1"
done

# 3. The p2p TCP listener (30303, 0x765F in /proc) exists and is bound to loopback only:
#    127.0.0.1 or ::1, never 0.0.0.0 or ::.
listeners=$(docker exec "$NAME" cat /proc/net/tcp /proc/net/tcp6 \
  | awk '$4 == "0A" { split($2, a, ":"); if (a[2] == "765F") print a[1] }')
[ -n "$listeners" ] || fail "no listener on 30303, so its binding cannot be checked"
for l in $listeners; do
  case $l in
    0100007F | 00000000000000000000000001000000) ;;
    *) fail "30303 listens on a non-loopback address: $l" ;;
  esac
done

# 4. No UDP socket in the container.
"$(dirname "$0")/check-udp.sh" "$NAME" >/dev/null

# 5. The running process carries every flag.
cmd=" $(docker exec "$NAME" cat /proc/1/cmdline | tr '\0' ' ')"
for f in --disable-discovery "--nat none" "--max-outbound-peers 0" "--max-inbound-peers 0" "--addr 127.0.0.1" --ipcdisable \
         --engine.always-process-payload-attributes-on-canonical-head --engine.allow-unwind-canonical-header \
         --testing.skip-invalid-transactions "--builder.gaslimit $GAS_CAP" "--rpc.eth-proof-window 1" "--rpc.gascap $GAS_CAP" "--http.api eth,net,web3,trace" "--log.file.max-files 0"; do
  [[ $cmd == *" $f "* ]] || fail "the command line lacks: $f"
done
# 6. The container is hardened: not root (the container's setting and the running process), no capabilities, no new privileges, a read-only root filesystem,
#    and limits on processes and memory.
insp() { docker inspect -f "$1" "$NAME"; }
user=$(insp '{{.Config.User}}')
[ -n "$user" ] && [ "${user%%:*}" != 0 ] && [ "${user%%:*}" != root ] || fail "the container's user is '$user', expected a non-root user"
uid=$(docker exec "$NAME" cat /proc/1/status | awk '$1 == "Uid:" { print $2 }')
[ -n "$uid" ] && [ "$uid" != 0 ] || fail "reth runs as uid '$uid', expected a non-root user"
[ "$(insp '{{range .HostConfig.CapDrop}}{{.}} {{end}}')" = "ALL " ] || fail "the container does not drop every capability"
[ -z "$(insp '{{range .HostConfig.CapAdd}}{{.}} {{end}}')" ] || fail "the container adds capabilities"
[ "$(insp '{{.HostConfig.ReadonlyRootfs}}')" = true ] || fail "the container's root filesystem is not read-only"
[[ $(insp '{{range .HostConfig.SecurityOpt}}{{.}} {{end}}') == *no-new-privileges* ]] || fail "the container allows new privileges"
[ "$(insp '{{.HostConfig.PidsLimit}}')" -gt 0 ] 2>/dev/null || fail "the container has no limit on processes"
[ "$(insp '{{.HostConfig.Memory}}')" -gt 0 ] 2>/dev/null || fail "the container has no memory limit"
echo "ok: $NAME has no peers, no UDP sockets, no p2p port published, and the discovery and builder flags are set; it runs as a non-root user with no capabilities, a read-only filesystem and limits"
