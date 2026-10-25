#!/usr/bin/env bash
# The persistent network, for real: CZE_PERSIST=1 puts Canton's nodes in PostgreSQL (a pinned image, on 127.0.0.1, password made on the
# machine). The test proposes the chain and commits one Advance (against stand-ins for the sidecars, as tests/canton_network.sh does), then
# crashes Canton (kill -9) and stops the database as a reboot would, starts both again the way network/restart.sh does
# (network/canton/run.sh resume), and checks that
#   - the chain is the same contract at the same head, with the same block hash, and the reader still sees the block's record;
#   - the bootstrap did not run again, the party list is unchanged, and the users' rights are still the right ones;
#   - the Daml package is still on the operator's participant;
#   - Canton still refuses a block the sidecar says no to, and a second Canton on the same databases is refused;
#   - the database password is in one file with mode 0600, and in no log.
# Needs Linux x86-64, Java 21, Docker, Python 3 and network access. No GPU, no reth, no ZisK.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"
WORK=$(mktemp -d)
export CZE_STATE_DIR=$WORK/state FAKE_LOG=$WORK/calls FAKE_ANSWER=$WORK/answer
export CZE_PERSIST=1 CZE_PG_CONTAINER=cze-postgres-test CZE_PG_PORT=${CZE_PG_PORT:-15432} CZE_CANTON_HEAP=3g
fail() { echo "FAIL: $*" >&2; exit 1; }
pids=()
cleanup() {
  local status=$?
  [ "$status" = 0 ] || { echo "--- Canton log (tail)"; tail -n 40 "$CZE_STATE_DIR/net/logs/canton.log" 2>/dev/null || true; }
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  [ ! -f "$CZE_STATE_DIR/net/canton.pid" ] || kill -9 "$(cat "$CZE_STATE_DIR/net/canton.pid")" 2>/dev/null || true
  "$ROOT/network/postgres.sh" wipe || true
  rm -rf "$WORK"
}
trap cleanup EXIT

tools=$("$ROOT/network/canton/fetch.sh")
CANTON_JAR=$(sed -n 's/^CANTON_JAR=//p' <<<"$tools"); export CANTON_JAR
export CZE_TOOLS_DIR=${CZE_TOOLS_DIR:-$CZE_STATE_DIR/tools}
CZE_DAR=$("$ROOT/network/canton/build-dar.sh"); export CZE_DAR

H0=$(printf 'ab%.0s' $(seq 32)); H1=$(printf 'bb%.0s' $(seq 32)); VK=$(printf 'cd%.0s' $(seq 32)); RC=$(printf 'ef%.0s' $(seq 32))
SR=$(printf '55%.0s' $(seq 32)); GW=${GATEWAY_ADDRESS#0x}
for f in verify verify2; do echo "ok $VK $RC $H1 $H0 1 $SR 1700000000 30000000 0 0" > "$FAKE_ANSWER.$f"; done
echo "ok $SR 1 $GW 0" > "$FAKE_ANSWER.legs"
: > "$FAKE_LOG"
for port in 8085 8086; do python3 "$ROOT/tests/fake_sidecar.py" $port & pids+=($!); done
sleep 1
advance() { python3 "$ROOT/tests/canton_advance.py" "$CZE_STATE_DIR" "$@"; }

# First start: a new network in the databases.
CZE_CANTON_WAIT=300 "$ROOT/network/canton/run.sh" bootstrap
grep -q "SYNCHRONIZER PROTOCOL VERSION 36" "$CZE_STATE_DIR/net/logs/canton.log" || fail "the synchronizer is not on protocol version 36"
python3 "$ROOT/network/canton/propose.py" --genesis-hash "$H0" --genesis-state-root "$(printf '44%.0s' $(seq 32))" --program-vk "$VK" --root-c "$RC" \
  --rules-hash "$(printf '12%.0s' $(seq 32))" --gateway-address "$GW" >/dev/null
[ "$(advance accepted)" = 1 ] || fail "a good block did not move the head to 1"
before=$(advance head)
[[ $before =~ ^[0-9a-f]+\ 1\ [0-9a-f]{64}$ ]] || fail "unexpected head before the restart: $before"
parties_before=$(shasum -a 256 "$CZE_STATE_DIR/canton/parties.env")

# The password: one file, mode 0600, and not in a log.
pw_file=$CZE_STATE_DIR/postgres.env
[ "$(stat -c %a "$pw_file" 2>/dev/null || stat -f %Lp "$pw_file")" = 600 ] || fail "$pw_file is not mode 0600"
pw=$(sed -n 's/^POSTGRES_PASSWORD=//p' "$pw_file")
[ "${#pw}" -ge 32 ] || fail "the database password is short or missing"
! grep -rqF "$pw" "$CZE_STATE_DIR/net/logs" || fail "the database password is in a log"
# The database is on 127.0.0.1 only.
docker port "$CZE_PG_CONTAINER" | grep -qE '^5432/tcp -> 127\.0\.0\.1:' || fail "the database is not published on 127.0.0.1"
[ "$(docker port "$CZE_PG_CONTAINER" | grep -vc '127\.0\.0\.1')" = 0 ] || fail "the database is published on another address"

# A second Canton on the same databases is refused while the first one runs.
! "$ROOT/network/canton/run.sh" resume 2>/dev/null || fail "a second Canton was started on a running network"

# What a reboot does: Canton dies without a goodbye, and the database stops.
kill -9 "$(cat "$CZE_STATE_DIR/net/canton.pid")"
sleep 2
"$ROOT/network/postgres.sh" stop
! docker ps --format '{{.Names}}' | grep -qx "$CZE_PG_CONTAINER" || fail "the database is still running"

# The restart: the database and Canton, the way restart.sh does it.
CZE_CANTON_WAIT=300 "$ROOT/network/canton/run.sh" resume
! grep -q "BOOTSTRAP DONE" "$CZE_STATE_DIR/net/logs/canton.log" || fail "the bootstrap ran again"
[ "$(shasum -a 256 "$CZE_STATE_DIR/canton/parties.env")" = "$parties_before" ] || fail "the party list changed"
after=$(advance head)
[ "$after" = "$before" ] || fail "the chain is not the same after the restart: before '$before', after '$after'"
[ "$(advance gateway "$GW")" = ok ] || fail "after the restart the chain's gateway or the users' rights are not what they were"
package_id=$("$ROOT/network/canton/dar-id.sh" "$CZE_DAR" | sed -n 's/^package_id=//p')
"$ROOT/network/canton/check-package.sh" "$package_id" http://127.0.0.1:7575 >/dev/null || fail "the Daml package is not on the operator's participant after the restart"
# Canton still enforces the chain's rules: a block the sidecar refuses changes nothing.
for f in verify verify2; do echo "no the proof does not verify" > "$FAKE_ANSWER.$f"; done
[ "$(advance refused 2>/dev/null)" = 1 ] || fail "after the restart a refused block moved the head"
! grep -qF "$pw" "$CZE_STATE_DIR/net/logs/canton.log" || fail "the database password is in the log"
echo "persistent network test passed"
