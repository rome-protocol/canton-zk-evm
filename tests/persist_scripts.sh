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
# FAKE_DOCKER_FAIL_ONLY=<name>: only a removal that names it fails (the other database is removed)
if [ "${FAKE_DOCKER_FAIL:-}" = rm ] && { [ -z "${FAKE_DOCKER_FAIL_ONLY:-}" ] || [[ "$*" == *"$FAKE_DOCKER_FAIL_ONLY"* ]]; }; then
  case $1 in rm) exit 1 ;; volume) [ "$2" = rm ] && exit 1 ;; esac
fi
exit 0
FAKE
chmod +x "$WORK/bin/docker"
export FAKE_DOCKER_LOG=$WORK/docker.log

fresh() {   # a copy of the scripts and a state folder of a persistent chain made with a database called mypg and reth called myreth
  rm -rf "$WORK/repo" "$WORK/state"; mkdir -p "$WORK/repo" "$WORK/state"
  cp -R "$ROOT/network" "$ROOT/PINS" "$WORK/repo/"
  printf 'CZE_PERSIST=1\nCANTON_VERSION=x\nCANTON_PROTOCOL_VERSION=x\nCHAIN_ID=1\nCZE_PG_CONTAINER=mypg\nCZE_PG_PORT=5999\nCZE_EXPLORER_DB_CONTAINER=myexp\nCZE_EXPLORER_DB_PORT=5998\nRETH_CONTAINER=myreth\nRETH_HTTP_PORT=18545\nRETH_WS_PORT=18546\nRETH_ENGINE_PORT=18551\n' > "$WORK/state/persist.env"
  : > "$FAKE_DOCKER_LOG"
}
record() {   # the builder's in-doubt command and kept transactions, and a file of the builder's that is not theirs
  mkdir -p "$WORK/state/builder"; echo '{}' > "$WORK/state/builder/unresolved.json"; echo '[]' > "$WORK/state/builder/kept-transactions.json"; echo '{}' > "$WORK/state/builder/status.json"
}
run() { env PATH="$WORK/bin:$PATH" CZE_STATE_DIR="$WORK/state" "$@"; }

# 1. down.sh --wipe acts on the recorded containers, and says "wiped" only after a real wipe.
fresh; record
out=$(run "$WORK/repo/network/down.sh" --wipe 2>&1) || fail "down.sh --wipe failed: $out"
grep -q "wiped" <<<"$out" || fail "down.sh --wipe did not say it wiped: $out"
grep -q -- "rm -f mypg" "$FAKE_DOCKER_LOG" || fail "the recorded database container was not removed"
grep -q -- "volume rm -f mypg-data" "$FAKE_DOCKER_LOG" || fail "the recorded database volume was not removed"
grep -q "myreth" "$FAKE_DOCKER_LOG" || fail "the recorded reth container was not stopped"
grep -q -- "rm -f myexp" "$FAKE_DOCKER_LOG" || fail "the recorded explorer database container was not removed"
grep -q -- "volume rm -f myexp-data" "$FAKE_DOCKER_LOG" || fail "the recorded explorer database volume was not removed"
grep -q "the explorer's database" <<<"$out" || fail "down.sh --wipe does not say that the explorer's database is wiped: $out"
! grep -q "cze-postgres\|cze-explorer-db\|cze-reth" "$FAKE_DOCKER_LOG" || fail "down.sh touched a default container: $(cat "$FAKE_DOCKER_LOG")"
[ ! -e "$WORK/state/persist.env" ] || fail "persist.env is still there after a wipe"
echo "ok: down.sh --wipe wipes what persist.env names"
[ ! -e "$WORK/state/builder/unresolved.json" ] || fail "the builder's record of the wiped chain is still there"
[ ! -e "$WORK/state/builder/kept-transactions.json" ] || fail "the builder's record of the wiped chain is still there"
[ -e "$WORK/state/builder/status.json" ] || fail "down.sh --wipe removed a file of the builder's that is not its record"
echo "ok: down.sh --wipe removes the builder's in-doubt record and kept transactions, and only them"
# The builder keeps them in CZE_WORK_DIR when that is set: down.sh --wipe removes those two files there, and the folder at the default place stays as it is.
fresh; record
mkdir "$WORK/custom"; echo '{}' > "$WORK/custom/unresolved.json"; echo '[]' > "$WORK/custom/kept-transactions.json"; echo '{}' > "$WORK/custom/status.json"
run env CZE_WORK_DIR="$WORK/custom" "$WORK/repo/network/down.sh" --wipe > /dev/null 2>&1 || fail "down.sh --wipe with CZE_WORK_DIR failed"
[ ! -e "$WORK/custom/unresolved.json" ] || fail "the record in CZE_WORK_DIR is still there after a wipe"
[ ! -e "$WORK/custom/kept-transactions.json" ] || fail "the kept transactions in CZE_WORK_DIR are still there after a wipe"
[ -e "$WORK/custom/status.json" ] || fail "down.sh --wipe removed a file of CZE_WORK_DIR that is not the record"
[ -e "$WORK/state/builder/unresolved.json" ] || fail "down.sh --wipe removed the default folder's record when CZE_WORK_DIR names another"
[ -e "$WORK/state/builder/kept-transactions.json" ] || fail "down.sh --wipe removed the default folder's kept transactions when CZE_WORK_DIR names another"
rm -rf "$WORK/custom"
echo "ok: down.sh --wipe removes the record where CZE_WORK_DIR says the builder keeps it"
# A persistent chain that is only stopped keeps them.
fresh; record
run "$WORK/repo/network/down.sh" > /dev/null 2>&1 || fail "down.sh of a persistent chain failed"
[ -e "$WORK/state/builder/unresolved.json" ] || fail "down.sh without --wipe removed the builder's record of a chain that is kept"
[ -e "$WORK/state/builder/kept-transactions.json" ] || fail "down.sh without --wipe removed the builder's record of a chain that is kept"
echo "ok: a persistent chain that is stopped keeps the builder's record"

# 2. A wipe that fails says so, exits non-zero, and keeps persist.env so that it can be run again.
fresh; record
if out=$(run FAKE_DOCKER_FAIL=rm "$WORK/repo/network/down.sh" --wipe 2>&1); then fail "down.sh --wipe succeeded although the database could not be removed"; fi
[ -e "$WORK/state/builder/unresolved.json" ] || fail "the builder's record was removed although the chain is still there"
! grep -q "chain is wiped" <<<"$out" || fail "down.sh says wiped after a failed wipe: $out"
grep -q "NOT wiped" <<<"$out" || fail "down.sh does not say what is left: $out"
[ -e "$WORK/state/persist.env" ] || fail "persist.env was removed after a failed wipe"
echo "ok: a failed wipe is reported and persist.env stays"
# The explorer's database failing alone is reported by name, and the rest is still wiped.
fresh
if out=$(run FAKE_DOCKER_FAIL=rm FAKE_DOCKER_FAIL_ONLY=myexp "$WORK/repo/network/down.sh" --wipe 2>&1); then fail "down.sh --wipe succeeded although the explorer's database could not be removed"; fi
grep -q "NOT wiped: the explorer's database " <<<"$out" || fail "down.sh does not name the explorer's database as what is left: $out"
grep -q -- "volume rm -f mypg-data" "$FAKE_DOCKER_LOG" || fail "the chain's database was not wiped after the explorer's failed"
[ -e "$WORK/state/persist.env" ] || fail "persist.env was removed after the explorer's database could not be wiped"
echo "ok: a failed wipe of the explorer's database is reported by name"

# 3. An environment that names another container than the chain's is refused, by down.sh and by restart.sh, before Docker is called.
fresh
if out=$(run CZE_PG_CONTAINER=other "$WORK/repo/network/down.sh" --wipe 2>&1); then fail "down.sh accepted another database container"; fi
grep -q "CZE_PG_CONTAINER is other here, but the chain.*was made with mypg" <<<"$out" || fail "down.sh refusal does not say why: $out"
if out=$(run CZE_EXPLORER_DB_CONTAINER=other "$WORK/repo/network/down.sh" --wipe 2>&1); then fail "down.sh accepted another explorer database container"; fi
grep -q "CZE_EXPLORER_DB_CONTAINER is other here, but the chain.*was made with myexp" <<<"$out" || fail "down.sh refusal does not name the explorer's database: $out"
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
# 6. The chain does not depend on the explorer's database: when it cannot start, restart.sh warns and goes on to reth (the next step).
fresh
sed -i.bak "s/^CHAIN_ID=.*/CHAIN_ID=$(sed -n 's/^CHAIN_ID=//p' "$ROOT/PINS")/; s/^CANTON_VERSION=.*/CANTON_VERSION=$(sed -n 's/^CANTON_VERSION=//p' "$ROOT/PINS")/; s/^CANTON_PROTOCOL_VERSION=.*/CANTON_PROTOCOL_VERSION=$(sed -n 's/^export CANTON_PROTOCOL_VERSION=//p' "$ROOT/PINS")/" "$WORK/state/persist.env"
for f in postgres.env jwt.hex genesis.json; do echo x > "$WORK/state/$f"; done
mkdir -p "$WORK/state/canton" "$WORK/state/net" "$WORK/state/reth-data" "$WORK/repo/prover"
echo x > "$WORK/state/canton/parties.env"; echo x > "$WORK/state/net/chain.json"; echo x > "$WORK/state/net/guest.txt"; echo x > "$WORK/state/net/dar.txt"; echo x > "$WORK/state/reth-data/f"
: > "$WORK/repo/prover/common.sh"
printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/bin/cargo-zisk"; chmod +x "$WORK/bin/cargo-zisk"
printf '#!/usr/bin/env bash\necho "port is already allocated" >&2; exit 125\n' > "$WORK/repo/network/explorer-db.sh"
printf '#!/usr/bin/env bash\ntouch "%s/reth-launched"; exit 1\n' "$WORK" > "$WORK/repo/network/reth/launch.sh"
chmod +x "$WORK/repo/network/explorer-db.sh" "$WORK/repo/network/reth/launch.sh"
run "$WORK/repo/network/restart.sh" > "$WORK/restart.out" 2>&1 || true
grep -q "WARN: the explorer's database did not start" "$WORK/restart.out" || fail "restart.sh did not warn that the explorer's database failed: $(tail -5 "$WORK/restart.out")"
[ -e "$WORK/reth-launched" ] || fail "restart.sh stopped at the explorer's database and never started reth: $(tail -5 "$WORK/restart.out")"
# up.sh has the same guard on the same step (it cannot be run here: it needs Canton).
grep -q 'explorer-db.sh" start ||' "$ROOT/network/up.sh" || fail "up.sh lets a failing explorer database stop the chain"
echo "ok: a failing explorer database does not stop the chain"
# 7. External mode keeps its chain on the shared participant, so up.sh refuses it without CZE_PERSIST=1 (before it starts or writes anything), and says why.
fresh
rm -f "$WORK/state/persist.env"; mkdir -p "$WORK/repo/prover"; : > "$WORK/repo/prover/common.sh"
printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/bin/cargo-zisk"; chmod +x "$WORK/bin/cargo-zisk"
if out=$(run CZE_CANTON=external CZE_LEDGER_URL=https://ledger.example CZE_LEDGER_NO_AUTH=1 "$WORK/repo/network/up.sh" 2>&1); then fail "up.sh started an external chain without CZE_PERSIST=1"; fi
grep -q "CZE_CANTON=external needs CZE_PERSIST=1" <<<"$out" || fail "up.sh's refusal does not say that external mode needs CZE_PERSIST=1: $out"
[ ! -e "$WORK/state/persist.env" ] || fail "up.sh wrote persist.env before it refused"
[ ! -s "$FAKE_DOCKER_LOG" ] || fail "Docker was called before up.sh refused"
# With CZE_PERSIST=1 it goes past that guard (and stops at the next one, here the missing URL).
if out=$(run CZE_CANTON=external CZE_PERSIST=1 "$WORK/repo/network/up.sh" 2>&1); then fail "up.sh accepted an external setting without a URL"; fi
grep -q "needs CZE_LEDGER_URL" <<<"$out" || fail "up.sh with CZE_PERSIST=1 did not reach the settings check: $out"
echo "ok: external mode refuses to start without CZE_PERSIST=1"

# 7b. prover/common.sh sets STATE to the prover's folder (CZE_PROVER_STATE). restart.sh sets it back to the chain's state folder before it
# uses it again: with the prover's state elsewhere, it read <prover state>/canton/parties.env and made a venv there (found by a reboot test).
awk '/^\. "\$ROOT\/prover\/common\.sh"/ {seen=1; next} seen && /^STATE=\$CZE_STATE_DIR/ {ok=1} seen && !ok && /\$\{?STATE\}?([\/"]|$)/ && !/^ *#/ {bad=1} END {exit !(seen && ok && !bad)}' \
  "$ROOT/network/restart.sh" || fail "restart.sh uses STATE after sourcing prover/common.sh without setting it back to CZE_STATE_DIR"
echo "ok: restart.sh uses the chain's state folder after loading the prover's paths"

# 8. The Ledger API users' prefix: up.sh records it, restart.sh uses it (a shell without it does not fall back to ostia-), and a different one is refused.
grep -q 'CZE_USER_PREFIX=%s' "$ROOT/network/up.sh" || fail "up.sh does not record CZE_USER_PREFIX in persist.env"
grep -q 'load_user_prefix' "$ROOT/network/restart.sh" || fail "restart.sh does not load the recorded prefix"
# shellcheck disable=SC2016
! grep -q 'CZE_USER_PREFIX=${CZE_USER_PREFIX-ostia-}' "$ROOT/network/restart.sh" || fail "restart.sh still defaults the prefix to ostia- before it reads the recorded one"
prefix_of() { ( unset CZE_USER_PREFIX; [ "$1" = unset ] || export CZE_USER_PREFIX=$1; load_user_prefix "$WORK/state" 2>&1 && printf '[%s]' "$CZE_USER_PREFIX" ); }
fresh; printf 'CZE_CANTON=external\nCZE_USER_PREFIX=team-\n' >> "$WORK/state/persist.env"
[ "$(prefix_of unset)" = "[team-]" ] || fail "a restart without CZE_USER_PREFIX did not take the recorded team-: $(prefix_of unset)"
[ "$(prefix_of team-)" = "[team-]" ] || fail "a restart with the same prefix was refused: $(prefix_of team-)"
out=$(prefix_of ostia-) && fail "a restart with another prefix was accepted: $out"
grep -q "CZE_USER_PREFIX is 'ostia-' here, but the chain.*was made with 'team-'" <<<"$out" || fail "the refusal does not say why: $out"
out=$(prefix_of "") && fail "an empty prefix was accepted for a chain made with team-: $out"
# A chain made with an empty prefix keeps it empty; one that predates the record keeps the default.
fresh; printf 'CZE_CANTON=external\nCZE_USER_PREFIX=\n' >> "$WORK/state/persist.env"
[ "$(prefix_of unset)" = "[]" ] || fail "an empty recorded prefix was replaced: $(prefix_of unset)"
fresh; printf 'CZE_CANTON=external\n' >> "$WORK/state/persist.env"
[ "$(prefix_of unset)" = "[ostia-]" ] || fail "a persist.env without a prefix did not keep the default: $(prefix_of unset)"
# restart.sh itself refuses a different prefix before it calls Docker.
fresh; printf 'CZE_CANTON=external\nCZE_LEDGER_URL=https://ledger.example\nCZE_SIDECAR_LISTEN=\nCZE_USER_PREFIX=team-\n' >> "$WORK/state/persist.env"
sed -i.bak "s/^CHAIN_ID=.*/CHAIN_ID=$(sed -n 's/^CHAIN_ID=//p' "$ROOT/PINS")/" "$WORK/state/persist.env"
mkdir -p "$WORK/state/canton" "$WORK/state/net" "$WORK/state/reth-data"
for f in jwt.hex genesis.json canton/parties.env net/chain.json net/guest.txt net/dar.txt reth-data/db; do echo x > "$WORK/state/$f"; done
if out=$(run CZE_LEDGER_NO_AUTH=1 CZE_USER_PREFIX=ostia- "$WORK/repo/network/restart.sh" 2>&1); then fail "restart.sh accepted another prefix than the chain's"; fi
grep -q "CZE_USER_PREFIX is 'ostia-' here, but the chain.*was made with 'team-'" <<<"$out" || fail "restart.sh refusal does not say why: $out"
[ ! -s "$FAKE_DOCKER_LOG" ] || fail "Docker was called after the prefix refusal"
echo "ok: the Ledger API users' prefix is recorded, used, and not overridden"
# 5. A network that is not persistent takes the explorer's default database with it: down.sh removes the container and the volume (explorer/run.sh
# stop does the same, see tests/demo_explorer_static.sh), so a new chain from the same genesis does not meet the old chain's rows. A failed removal is reported.
fresh; record; rm -f "$WORK/state/persist.env"; echo 'POSTGRES_PASSWORD=x' > "$WORK/state/explorer-db.env"
out=$(run "$WORK/repo/network/down.sh" 2>&1) || fail "down.sh of a network that is not persistent failed: $out"
[ ! -e "$WORK/state/builder/unresolved.json" ] || fail "down.sh of a network that is not persistent did not remove the builder's record (and only it)"
[ ! -e "$WORK/state/builder/kept-transactions.json" ] || fail "down.sh of a network that is not persistent did not remove the builder's record (and only it)"
[ -e "$WORK/state/builder/status.json" ] || fail "down.sh of a network that is not persistent did not remove the builder's record (and only it)"
grep -q -- "rm -f cze-explorer-db" "$FAKE_DOCKER_LOG" || fail "down.sh left the explorer's container of a network that is not persistent: $(cat "$FAKE_DOCKER_LOG")"
grep -q -- "volume rm -f cze-explorer-db-data" "$FAKE_DOCKER_LOG" || fail "down.sh left the explorer's database volume of a network that is not persistent"
grep -q "explorer's database is removed" <<<"$out" || fail "down.sh does not say that the explorer's database is removed: $out"
[ ! -e "$WORK/state/explorer-db.env" ] || fail "the explorer's password file is still there"
fresh; rm -f "$WORK/state/persist.env"; echo 'POSTGRES_PASSWORD=x' > "$WORK/state/explorer-db.env"
if out=$(run FAKE_DOCKER_FAIL=rm "$WORK/repo/network/down.sh" 2>&1); then fail "down.sh succeeded although the explorer's database could not be removed"; fi
grep -q "NOT wiped: the explorer's database" <<<"$out" || fail "down.sh does not say that the explorer's database is left: $out"
fresh; rm -f "$WORK/state/persist.env"
run "$WORK/repo/network/down.sh" > /dev/null 2>&1 || fail "down.sh failed with no explorer database"
! grep -q "cze-explorer-db" "$FAKE_DOCKER_LOG" || fail "down.sh touched an explorer database that was never made"
echo "ok: a network that is not persistent removes the explorer's database with it"
# 9. CZE_LOCAL_PROVER=0: the proofs are made on other machines, so restart.sh and up.sh start no prover, and restart.sh and down.sh leave the local prover's pid files alone.
# The ZisK client check stays. 1 (the default) is the old behaviour. Anything else is refused.
prep_restart() {   # a persistent chain whose restart goes as far as reth (launch.sh is a stub that says it ran and fails), with a stub prover/start.sh
  fresh
  sed -i.bak "s/^CHAIN_ID=.*/CHAIN_ID=$(sed -n 's/^CHAIN_ID=//p' "$ROOT/PINS")/; s/^CANTON_VERSION=.*/CANTON_VERSION=$(sed -n 's/^CANTON_VERSION=//p' "$ROOT/PINS")/; s/^CANTON_PROTOCOL_VERSION=.*/CANTON_PROTOCOL_VERSION=$(sed -n 's/^export CANTON_PROTOCOL_VERSION=//p' "$ROOT/PINS")/" "$WORK/state/persist.env"
  for f in postgres.env jwt.hex genesis.json; do echo x > "$WORK/state/$f"; done
  mkdir -p "$WORK/state/canton" "$WORK/state/net" "$WORK/state/reth-data" "$WORK/state/prover" "$WORK/repo/prover"
  echo x > "$WORK/state/canton/parties.env"; echo x > "$WORK/state/net/chain.json"; echo x > "$WORK/state/net/guest.txt"; echo x > "$WORK/state/net/dar.txt"; echo x > "$WORK/state/reth-data/f"
  : > "$WORK/repo/prover/common.sh"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/bin/cargo-zisk"; chmod +x "$WORK/bin/cargo-zisk"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/repo/network/explorer-db.sh"; chmod +x "$WORK/repo/network/explorer-db.sh"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/repo/network/postgres.sh"; chmod +x "$WORK/repo/network/postgres.sh"
  printf '#!/usr/bin/env bash\ntouch "%s/reth-launched"; exit 1\n' "$WORK" > "$WORK/repo/network/reth/launch.sh"; chmod +x "$WORK/repo/network/reth/launch.sh"
  printf '#!/usr/bin/env bash\ntouch "%s/prover-started"; exit 0\n' "$WORK" > "$WORK/repo/prover/start.sh"; chmod +x "$WORK/repo/prover/start.sh"
  rm -f "$WORK/reth-launched" "$WORK/prover-started"
}
fake_prover_process() {   # a process whose command line names zisk-worker, with its pid file in the prover's state folder
  printf '#!/usr/bin/env bash\nsleep 60\n' > "$WORK/zisk-worker"; chmod +x "$WORK/zisk-worker"
  "$WORK/zisk-worker" & FAKE_PID=$!; echo "$FAKE_PID" > "$WORK/state/prover/worker.pid"
  sleep 0.3
}
# 9a. restart.sh, default: a running local prover is refused (the old behaviour).
prep_restart; fake_prover_process
if run "$WORK/repo/network/restart.sh" > "$WORK/restart.out" 2>&1; then fail "restart.sh went on with a prover running"; fi
grep -q "is a running process" "$WORK/restart.out" || fail "restart.sh did not refuse a running local prover: $(tail -5 "$WORK/restart.out")"
kill "$FAKE_PID" 2> /dev/null || true
echo "ok: restart.sh refuses a running local prover by default"
# 9b. restart.sh with CZE_LOCAL_PROVER=0 ignores its pid file and goes on to reth.
prep_restart; fake_prover_process
run CZE_LOCAL_PROVER=0 "$WORK/repo/network/restart.sh" > "$WORK/restart.out" 2>&1 || true
kill "$FAKE_PID" 2> /dev/null || true
[ -e "$WORK/reth-launched" ] || fail "restart.sh with CZE_LOCAL_PROVER=0 stopped on the local prover's pid file: $(tail -5 "$WORK/restart.out")"
[ -e "$WORK/state/prover/worker.pid" ] || fail "restart.sh with CZE_LOCAL_PROVER=0 removed the local prover's pid file"
echo "ok: restart.sh with CZE_LOCAL_PROVER=0 ignores the local prover's pid files"
# 9c. Every call of prover/start.sh in up.sh and restart.sh is behind CZE_LOCAL_PROVER, and the line says so when it is skipped.
grep -q 'CZE_LOCAL_PROVER=0: no prover is started here' "$ROOT/network/restart.sh" || fail "restart.sh does not say that it starts no prover"
grep -q 'CZE_LOCAL_PROVER=0: no prover is started here' "$ROOT/network/up.sh" || fail "up.sh does not say that it starts no prover"
awk '/prover\/start\.sh/ && !/^ *#/ && !/LOCAL_PROVER/ {bad=1} END {exit bad}' "$ROOT/network/up.sh" "$ROOT/network/restart.sh" || fail "a call of prover/start.sh in up.sh or restart.sh is not behind CZE_LOCAL_PROVER"
# 9d. The ZisK client check stays with CZE_LOCAL_PROVER=0.
prep_restart; rm -f "$WORK/bin/cargo-zisk"
if out=$(run CZE_LOCAL_PROVER=0 "$WORK/repo/network/restart.sh" 2>&1); then fail "restart.sh with CZE_LOCAL_PROVER=0 went on without the ZisK client"; fi
grep -q "ZisK is not installed" <<<"$out" || fail "restart.sh with CZE_LOCAL_PROVER=0 did not check the ZisK client: $out"
[ ! -e "$WORK/reth-launched" ] || fail "reth was started without the ZisK client"
echo "ok: the ZisK client check stays with CZE_LOCAL_PROVER=0"
# 9e. A value other than 0 or 1 is refused by all three scripts, before anything is called.
for sc in up restart down; do
  fresh
  if out=$(run CZE_LOCAL_PROVER=2 "$WORK/repo/network/$sc.sh" 2>&1); then fail "$sc.sh accepted CZE_LOCAL_PROVER=2"; fi
  grep -q "CZE_LOCAL_PROVER is 0 or 1, not '2'" <<<"$out" || fail "$sc.sh refusal does not say why: $out"
  [ ! -s "$FAKE_DOCKER_LOG" ] || fail "Docker was called after $sc.sh refused CZE_LOCAL_PROVER=2"
done
echo "ok: another value of CZE_LOCAL_PROVER is refused"
# 9f. down.sh: by default it stops the local prover, with CZE_LOCAL_PROVER=0 it does not touch it.
fresh; record; mkdir -p "$WORK/state/prover"; fake_prover_process
run "$WORK/repo/network/down.sh" > /dev/null 2>&1 || fail "down.sh failed"
if kill -0 "$FAKE_PID" 2> /dev/null; then kill "$FAKE_PID"; fail "down.sh did not stop the local prover by default"; fi
fresh; record; mkdir -p "$WORK/state/prover"; fake_prover_process
run CZE_LOCAL_PROVER=0 "$WORK/repo/network/down.sh" > /dev/null 2>&1 || fail "down.sh with CZE_LOCAL_PROVER=0 failed"
kill -0 "$FAKE_PID" 2> /dev/null || fail "down.sh with CZE_LOCAL_PROVER=0 stopped a local prover"
[ -e "$WORK/state/prover/worker.pid" ] || fail "down.sh with CZE_LOCAL_PROVER=0 removed the local prover's pid file"
kill "$FAKE_PID" 2> /dev/null || true
echo "ok: down.sh stops the local prover by default and leaves it alone with CZE_LOCAL_PROVER=0"
echo "persist scripts tests passed"
