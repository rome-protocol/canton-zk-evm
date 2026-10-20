#!/usr/bin/env bash
# The persistent network's stop and restart scripts, against a Docker that only writes down what it was asked, with no Canton and no real Docker:
#   - network/down.sh and network/restart.sh act on the container names and ports that up.sh recorded in persist.env, not on the defaults,
#     and refuse an environment that names others
#   - network/down.sh --wipe says "wiped" and removes persist.env only if the database and reth's data are really gone
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

mkdir "$WORK/bin"
cat > "$WORK/bin/docker" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_DOCKER_LOG"
# FAKE_DOCKER_FAIL=rm: removing a container or a volume fails, as it does when the daemon refuses
if [ "${FAKE_DOCKER_FAIL:-}" = rm ]; then
  case $1 in rm) exit 1 ;; volume) [ "$2" = rm ] && exit 1 ;; esac
fi
exit 0
FAKE
chmod +x "$WORK/bin/docker"
export FAKE_DOCKER_LOG=$WORK/docker.log

fresh() {   # a copy of the scripts and a state folder of a persistent chain made with a database called mypg and reth called myreth
  rm -rf "$WORK/repo" "$WORK/state"; mkdir -p "$WORK/repo" "$WORK/state"
  cp -R "$ROOT/network" "$ROOT/PINS" "$WORK/repo/"
  printf 'CZE_PERSIST=1\nCANTON_VERSION=x\nCHAIN_ID=1\nCZE_PG_CONTAINER=mypg\nCZE_PG_PORT=5999\nRETH_CONTAINER=myreth\nRETH_HTTP_PORT=18545\nRETH_WS_PORT=18546\nRETH_ENGINE_PORT=18551\n' > "$WORK/state/persist.env"
  : > "$FAKE_DOCKER_LOG"
}
run() { env PATH="$WORK/bin:$PATH" CZE_STATE_DIR="$WORK/state" "$@"; }

# 1. down.sh --wipe acts on the recorded containers, and says "wiped" only after a real wipe.
fresh
out=$(run "$WORK/repo/network/down.sh" --wipe 2>&1) || fail "down.sh --wipe failed: $out"
grep -q "wiped" <<<"$out" || fail "down.sh --wipe did not say it wiped: $out"
grep -q -- "rm -f mypg" "$FAKE_DOCKER_LOG" || fail "the recorded database container was not removed"
grep -q -- "volume rm -f mypg-data" "$FAKE_DOCKER_LOG" || fail "the recorded database volume was not removed"
grep -q "myreth" "$FAKE_DOCKER_LOG" || fail "the recorded reth container was not stopped"
! grep -q "cze-postgres\|cze-reth" "$FAKE_DOCKER_LOG" || fail "down.sh touched a default container: $(cat "$FAKE_DOCKER_LOG")"
[ ! -e "$WORK/state/persist.env" ] || fail "persist.env is still there after a wipe"
echo "ok: down.sh --wipe wipes what persist.env names"

# 2. A wipe that fails says so, exits non-zero, and keeps persist.env so that it can be run again.
fresh
if out=$(run FAKE_DOCKER_FAIL=rm "$WORK/repo/network/down.sh" --wipe 2>&1); then fail "down.sh --wipe succeeded although the database could not be removed"; fi
! grep -q "chain is wiped" <<<"$out" || fail "down.sh says wiped after a failed wipe: $out"
grep -q "NOT wiped" <<<"$out" || fail "down.sh does not say what is left: $out"
[ -e "$WORK/state/persist.env" ] || fail "persist.env was removed after a failed wipe"
echo "ok: a failed wipe is reported and persist.env stays"

# 3. An environment that names another container than the chain's is refused, by down.sh and by restart.sh, before Docker is called.
fresh
if out=$(run CZE_PG_CONTAINER=other "$WORK/repo/network/down.sh" --wipe 2>&1); then fail "down.sh accepted another database container"; fi
grep -q "CZE_PG_CONTAINER is other here, but the chain.*was made with mypg" <<<"$out" || fail "down.sh refusal does not say why: $out"
[ ! -s "$FAKE_DOCKER_LOG" ] || fail "Docker was called after the refusal"
[ -e "$WORK/state/persist.env" ] || fail "persist.env was removed by a refused wipe"
fresh
mkdir -p "$WORK/state/canton" "$WORK/state/net" "$WORK/state/reth-data"
for f in postgres.env jwt.hex genesis.json canton/parties.env net/chain.json net/guest.txt net/dar.txt reth-data/db; do echo x > "$WORK/state/$f"; done
if out=$(run RETH_HTTP_PORT=9999 "$WORK/repo/network/restart.sh" 2>&1); then fail "restart.sh accepted another reth port"; fi
grep -q "RETH_HTTP_PORT is 9999 here, but the chain.*was made with 18545" <<<"$out" || fail "restart.sh refusal does not say why: $out"
[ ! -s "$FAKE_DOCKER_LOG" ] || fail "Docker was called after the refusal"
echo "ok: another container or port than the chain's is refused"

# 4. The variables that are not set take the recorded values (a plain shell, as after a reboot), and the ones that agree are accepted.
# shellcheck disable=SC1091
. "$ROOT/network/persist-settings.sh"
fresh
( unset CZE_PG_CONTAINER CZE_PG_PORT RETH_CONTAINER RETH_HTTP_PORT RETH_WS_PORT RETH_ENGINE_PORT
  load_persist_settings "$WORK/state"
  [ "$CZE_PG_CONTAINER $CZE_PG_PORT $RETH_CONTAINER $RETH_HTTP_PORT $RETH_WS_PORT $RETH_ENGINE_PORT" = "mypg 5999 myreth 18545 18546 18551" ] ) \
  || fail "the recorded settings were not loaded"
( export CZE_PG_PORT=5999; load_persist_settings "$WORK/state" ) || fail "a setting that agrees was refused"
echo "ok: the recorded settings are loaded"

# 5. up.sh records every one of these settings.
for k in CZE_PG_CONTAINER CZE_PG_PORT RETH_CONTAINER RETH_HTTP_PORT RETH_WS_PORT RETH_ENGINE_PORT; do
  grep -q "$k=%s" "$ROOT/network/up.sh" || fail "up.sh does not write $k into persist.env"
  grep -q "$k" "$ROOT/network/persist-settings.sh" || fail "persist-settings.sh does not load $k"
done
echo "persist scripts tests passed"
