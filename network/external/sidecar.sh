#!/usr/bin/env bash
# Runs one sidecar on its own, without a local Canton, the way network/up.sh builds and starts it: the release build of sidecar/, pinned
# to the program key, root key and ZisK release of a record: CZE_SESSION_FILE if set, else prover/fixtures/session.txt, which is a NEW
# chain's record (ZisK 1.3.2). For a chain that already runs, set CZE_SESSION_FILE to a copy of that chain's state/net/guest.txt
# (network/restart.sh does this); with no zisk= line in it the release is 1.3.1.
#   sidecar.sh start [address:port]   builds, starts and waits until it answers; default CZE_SIDECAR_LISTEN, else 127.0.0.1:8085.
#                                     One that runs already with the same keys on the same address is left as it is (success).
#   sidecar.sh stop [address:port]    stops it
# The sidecar has no login: whoever can reach its port can ask it to check a proof. Listen on 127.0.0.1, or on the one address that only the
# participant can reach (the participant's own container network), never on a public one. The pid goes to $CZE_STATE_DIR/net/sidecar-<port>.pid
# (network/down.sh stops it), the log to $CZE_STATE_DIR/net/logs/sidecar-<port>.log.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
export CZE_STATE_DIR=${CZE_STATE_DIR:-$ROOT/state}
NET=$CZE_STATE_DIR/net
fail() { echo "FAIL: $*" >&2; exit 1; }
action=${1:-}
case $action in start | stop) ;; *) echo "usage: sidecar.sh start|stop [address:port]" >&2; exit 2 ;; esac
listen=${2:-${CZE_SIDECAR_LISTEN:-127.0.0.1:8085}}
[[ $listen =~ ^[0-9A-Za-z.:-]+:[0-9]{2,5}$ ]] || fail "not an address:port: '$listen'"
port=${listen##*:}
pidfile=$NET/sidecar-$port.pid
if [ "$action" = stop ]; then
  [ -f "$pidfile" ] || { echo "no sidecar on port $port here"; exit 0; }
  pid=$(cat "$pidfile")
  if kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o args= 2>/dev/null | grep -q 'zk-sidecar'; then kill "$pid"; fi
  rm -f "$pidfile"
  echo "stopped the sidecar on port $port"
  exit 0
fi
rec=${CZE_SESSION_FILE:-$ROOT/prover/fixtures/session.txt}
recorded() { sed -n "s/^$1=0x//p" "$rec" | head -1; }
PROGRAM_VK=$(recorded programVK); ROOT_C=$(recorded rootC)
[[ $PROGRAM_VK =~ ^[0-9a-f]{64}$ && $ROOT_C =~ ^[0-9a-f]{64}$ ]] || fail "no recorded programVK and rootC in $rec"
# The ZisK release the record was made with picks the key the sidecar checks proofs under. A record that names no release is ZisK 1.3.1's;
# any other value goes to the sidecar as it is (without ZisK's "-alpha"), which stops before it listens if it does not know the release.
release=$(sed -n 's/^zisk=//p' "$rec" | head -1); release=${release%-alpha}
release=${release:-1.3.1}
if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
  # One that runs already with these very keys on this very address is what start would make: say so and succeed (up.sh after a manual start). Another is an error.
  # A sidecar started without --zisk-release (before the option existed) checks as ZisK 1.3.1 does.
  args=$(ps -p "$(cat "$pidfile")" -o args= 2>/dev/null || true)
  keys="--program-vk $PROGRAM_VK --root-c $ROOT_C"
  if { [[ $args == *"$keys --zisk-release $release --listen $listen"* ]] || { [ "$release" = 1.3.1 ] && [[ $args == *"$keys --listen $listen"* ]]; }; } \
    && curl -sf "http://${listen/#0.0.0.0:/127.0.0.1:}/api/v1/version" >/dev/null; then
    echo "the sidecar answers on $listen already (pid $(cat "$pidfile"), programVK 0x$PROGRAM_VK)"
    exit 0
  fi
  fail "a sidecar runs on port $port already (pid $(cat "$pidfile")) and is not this one: sidecar.sh stop $listen first"
fi
umask 077
mkdir -p "$NET/logs"
cargo build --release --locked --manifest-path "$ROOT/sidecar/Cargo.toml"
nohup "$ROOT/sidecar/target/release/zk-sidecar" --program-vk "$PROGRAM_VK" --root-c "$ROOT_C" --zisk-release "$release" --listen "$listen" > "$NET/logs/sidecar-$port.log" 2>&1 < /dev/null &
echo $! > "$pidfile"
# The version call goes to the address the sidecar listens on; 0.0.0.0 is reached on loopback.
probe=${listen/#0.0.0.0:/127.0.0.1:}
for _ in $(seq 1 60); do curl -sf "http://$probe/api/v1/version" >/dev/null && break; sleep 0.5; done
curl -sf "http://$probe/api/v1/version" >/dev/null || fail "the sidecar on $listen does not answer (see $NET/logs/sidecar-$port.log)"
echo "the sidecar answers on $listen (programVK 0x$PROGRAM_VK)"
