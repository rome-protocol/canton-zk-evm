#!/usr/bin/env bash
# Several checks look for text that holds a $ (shell variables written in the scripts), so single quotes are meant.
# shellcheck disable=SC2015,SC2016
# Checks on the network files that need neither Docker nor Canton:
#   - reth is started only by network/reth/launch.sh, and network/up.sh checks discovery after starting it
#   - canton.conf: every node in memory and on localhost, the extension on the operator's and the confirmer's
#     participants only, each pointing at its own sidecar port, and the sidecar ports are the ones up.sh starts
#   - no key, token or password is written in any network file
#   - the recorded smoke result is complete and consistent and in format 2 (what network/smoke.sh writes), and the same
#     checks are run on a fixture, which they must accept, and on copies with one fault each, which they must refuse
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
fail() { echo "FAIL: $*" >&2; exit 1; }
CONF=$ROOT/network/canton/canton.conf

# reth: nothing but launch.sh names its image or runs it.
others=$(grep -rIlE --include='*.sh' --include='*.py' --include='*.rs' 'RETH_IMAGE|paradigmxyz|reth node' "$ROOT/network" "$ROOT/builder" "$ROOT/prover" "$ROOT/sidecar/src" 2>/dev/null | grep -v '^'"$ROOT"'/network/reth/launch.sh$' || true)
[ -z "$others" ] || fail "something other than network/reth/launch.sh starts or names reth's image: $others"
# Nothing else runs a container, except the databases (postgres.sh and explorer-db.sh, the pinned postgres image) and the wipe of reth's folder (reth/stop.sh,
# the pinned busybox image); neither names another image.
runners=$(grep -rIlE --include='*.sh' --include='*.py' --include='*.rs' 'docker run' "$ROOT/network" "$ROOT/builder" "$ROOT/prover" "$ROOT/sidecar/src" 2>/dev/null \
  | grep -v '^'"$ROOT"'/network/reth/launch.sh$' | grep -v '^'"$ROOT"'/network/postgres.sh$' | grep -v '^'"$ROOT"'/network/explorer-db.sh$' | grep -v '^'"$ROOT"'/network/reth/stop.sh$' || true)
[ -z "$runners" ] || fail "something other than launch.sh, postgres.sh, explorer-db.sh and reth/stop.sh runs a container: $runners"
[ "$(grep -c 'docker run' "$ROOT/network/postgres.sh")" = 1 ] && grep -A8 'docker run' "$ROOT/network/postgres.sh" | grep -q '"\$POSTGRES_IMAGE"' || fail "postgres.sh does not run the pinned POSTGRES_IMAGE"
[ "$(grep -c 'docker run' "$ROOT/network/explorer-db.sh")" = 1 ] && grep -A8 'docker run' "$ROOT/network/explorer-db.sh" | grep -q '"\$POSTGRES_IMAGE"' || fail "explorer-db.sh does not run the pinned POSTGRES_IMAGE"
grep 'docker run' "$ROOT/network/reth/stop.sh" | grep -q '"\$BUSYBOX_IMAGE"' || fail "reth/stop.sh does not run the pinned BUSYBOX_IMAGE"
grep -q 'network/reth/launch.sh' "$ROOT/network/up.sh" || fail "up.sh does not start reth through launch.sh"
grep -q 'network/reth/check.sh' "$ROOT/network/up.sh" || fail "up.sh does not check that discovery is off"
grep -q 'network/reth/stop.sh' "$ROOT/network/down.sh" || fail "down.sh does not stop reth through stop.sh"

# canton.conf
[ "$(grep -c 'storage.type = memory' "$CONF")" = 5 ] || fail "not every node (1 sequencer, 1 mediator, 3 participants) is in memory"
bad=$(grep -E 'address *=' "$CONF" | grep -v '"127.0.0.1"' || true)
[ -z "$bad" ] || fail "an address other than 127.0.0.1: $bad"
[ "$(grep -c 'extensions.canton-zk-evm' "$CONF")" = 2 ] || fail "the extension is not on exactly two participants"
users=$(sed -n '/^    users {/,$p' "$CONF")
! grep -q 'extensions' <<<"$users" || fail "the users participant has an extension"
for who in operator:8085 confirmer:8086; do
  block=$(sed -n "/^    ${who%%:*} {/,/^    }/p" "$CONF")
  grep -q "port = ${who##*:}" <<<"$block" || fail "the ${who%%:*} participant's extension is not on ${who##*:}"
done
for port in 8085 8086; do grep -q "$port" "$ROOT/network/up.sh" || fail "up.sh does not start a sidecar on $port"; done
# The Ledger API port the builder defaults to is the operator's.
grep -A8 '^    operator {' "$CONF" | grep -q 'http-ledger-api.*port = 7575' || fail "the operator's JSON Ledger API is not on 7575"

# The persistent mode (CZE_PERSIST=1): canton.conf stays in memory (the default), canton-persistent.conf puts every node in PostgreSQL,
# on 127.0.0.1, with the password from the environment; the database is a pinned image, published on localhost only, with the password in
# a 0600 file made on the machine.
PCONF=$ROOT/network/canton/canton-persistent.conf
[ "$(grep -cE '^  (sequencers|mediators|participants)\.[a-z0-9]+\.storage = \$\{_pg\}' "$PCONF")" = 5 ] || fail "canton-persistent.conf does not move all five nodes (1 sequencer, 1 mediator, 3 participants) to PostgreSQL"
for db in sequencer1 mediator1 operator confirmer users; do
  grep -q "storage.config.properties.databaseName = \"$db\"" "$PCONF" || fail "canton-persistent.conf has no database for $db"
  grep -q "$db" "$ROOT/network/postgres.sh" || fail "postgres.sh does not make the database $db"
done
grep -q 'type = postgres' "$PCONF" || fail "canton-persistent.conf is not PostgreSQL"
grep -q 'serverName = "127.0.0.1"' "$PCONF" || fail "canton-persistent.conf does not use the database on 127.0.0.1"
grep -q 'password = ${CZE_PG_PASSWORD}' "$PCONF" || fail "the database password does not come from the environment"
! grep -qE 'password *= *"' "$PCONF" || fail "a password is written in canton-persistent.conf"
! grep -q 'storage.type = memory' "$PCONF" || fail "canton-persistent.conf keeps a node in memory"
grep -qE '^POSTGRES_IMAGE=.+@sha256:[0-9a-f]{64}$' "$ROOT/PINS" || fail "PINS does not pin POSTGRES_IMAGE by digest"
PG=$ROOT/network/postgres.sh
grep -q -- '-p "127.0.0.1:\$PORT:5432"' "$PG" || fail "postgres.sh does not publish the database on 127.0.0.1 only"
! grep -qE -- '(^|[ "])(-P|--publish-all|--network[= ]host|--net[= ]host)( |"|$)' "$PG" || fail "postgres.sh publishes the database beyond localhost"
! grep -qE -- '-p "?[0-9]+:' "$PG" || fail "postgres.sh publishes a port without 127.0.0.1"
grep -q 'openssl rand' "$PG" && grep -q 'chmod 600' "$PG" || fail "postgres.sh does not make the password per machine into a 0600 file"
grep -q -- '--env-file' "$PG" || fail "postgres.sh does not read the password from its file"
! grep -qE 'POSTGRES_PASSWORD=[A-Za-z0-9]' "$PG" "$ROOT/network/canton/run.sh" "$ROOT/network/up.sh" "$ROOT/network/restart.sh" || fail "a database password is written down"
! grep -qE 'echo .*(CZE_PG_PASSWORD|POSTGRES_PASSWORD)' "$ROOT/network/canton/run.sh" "$ROOT/network/up.sh" "$ROOT/network/restart.sh" || fail "a script prints the database password"
grep -q 'network/canton/run.sh' "$ROOT/network/up.sh" || fail "up.sh does not start Canton through run.sh"
grep -q 'canton-persistent.conf' "$ROOT/network/canton/run.sh" || fail "run.sh does not use canton-persistent.conf with CZE_PERSIST=1"
grep -q 'network/postgres.sh' "$ROOT/network/canton/run.sh" || fail "run.sh does not start the database with CZE_PERSIST=1"
# The explorer's own database: a container and a volume of its own (never Canton's), on 127.0.0.1 only, with a per-machine 0600 password.
EDB=$ROOT/network/explorer-db.sh
grep -q -- '-p "127.0.0.1:\$PORT:5432"' "$EDB" || fail "explorer-db.sh does not publish the database on 127.0.0.1 only"
! grep -qE -- '(^|[ "])(-P|--publish-all|--network[= ]host|--net[= ]host)( |"|$)' "$EDB" || fail "explorer-db.sh publishes the database beyond localhost"
! grep -qE -- '-p "?[0-9]+:' "$EDB" || fail "explorer-db.sh publishes a port without 127.0.0.1"
grep -q 'openssl rand' "$EDB" && grep -q 'chmod 600' "$EDB" || fail "explorer-db.sh does not make the password per machine into a 0600 file"
grep -q -- '--env-file' "$EDB" || fail "explorer-db.sh does not read the password from its file"
! grep -qE 'POSTGRES_PASSWORD=[A-Za-z0-9]' "$EDB" "$ROOT/network/down.sh" || fail "the explorer database's password is written down"
! grep -E 'echo .*POSTGRES_PASSWORD' "$EDB" | grep -qv '> "\$ENV_FILE"' || fail "explorer-db.sh prints the database password"
[ "$(sed -n 's/^NAME=//p' "$EDB")" != "$(sed -n 's/^NAME=//p' "$PG")" ] || fail "the explorer's database shares Canton's container"
grep -q 'cze-explorer-db' "$EDB" && ! grep -q 'cze-postgres' "$EDB" || fail "explorer-db.sh does not name its own container"
[ "$(sed -n 's/^PORT=${CZE_EXPLORER_DB_PORT:-\(.*\)}$/\1/p' "$EDB")" != "$(sed -n 's/^PORT=${CZE_PG_PORT:-\(.*\)}$/\1/p' "$PG")" ] || fail "the explorer's database shares Canton's port"
for f in up.sh restart.sh; do grep -q 'network/explorer-db.sh" start' "$ROOT/network/$f" || fail "$f does not start the explorer's database"; done
grep -q 'explorer-db.sh" stop' "$ROOT/network/down.sh" && grep -q 'explorer-db.sh" wipe' "$ROOT/network/down.sh" || fail "down.sh does not stop and wipe the explorer's database"
grep -q 'CZE_EXPLORER_DB_CONTAINER' "$ROOT/network/persist-settings.sh" || fail "persist-settings.sh does not record the explorer database's container"
# restart.sh: no new chain, no new secrets, no new guest, no bootstrap; the order that Canton needs (the sidecars before it); the check at the end.
R=$ROOT/network/restart.sh
! grep -v '^ *#' "$R" | grep -qE 'propose\.py|make-state\.sh|build-guest\.sh|build-dar\.sh|bootstrap' || fail "restart.sh makes something new: a chain, a secret, a guest or a bootstrap"
grep -q 'run.sh" resume' "$R" || fail "restart.sh does not resume Canton"
grep -q 'CZE_RESUME=1' "$R" || fail "restart.sh does not tell reth's launch.sh to resume"
grep -q 'network/sync_reth.py' "$R" || fail "restart.sh does not check Canton's head against reth"
[ "$(grep -n 'sidecar-\$port\|run.sh" resume' "$R" | head -1 | grep -c sidecar)" = 1 ] || fail "restart.sh starts Canton before the sidecars"
# It refuses to run without a persistent chain, and says how to make one.
EMPTY=$(mktemp -d)
refusal=$(CZE_STATE_DIR=$EMPTY "$R" 2>&1) && fail "restart.sh ran without a persistent chain"
grep -q 'there is no persistent chain' <<<"$refusal" || fail "restart.sh's refusal is unclear: $refusal"
grep -q 'CZE_PERSIST=1 network/up.sh' <<<"$refusal" || fail "restart.sh does not say how to start a persistent chain: $refusal"
# ... run.sh resume is refused for an in-memory network, and down.sh knows --wipe and nothing else.
refusal=$(CZE_STATE_DIR=$EMPTY CANTON_JAR=$R "$ROOT/network/canton/run.sh" resume 2>&1) && fail "run.sh resumed an in-memory network"
grep -q 'resume needs CZE_PERSIST=1' <<<"$refusal" || fail "run.sh's refusal is unclear: $refusal"
"$ROOT/network/down.sh" --nonsense >/dev/null 2>&1 && fail "down.sh accepted an unknown option"
rm -rf "$EMPTY"
# down.sh keeps a persistent chain's data unless it is told to wipe it; up.sh does not replace a chain that is there.
grep -q -- '--keep-data' "$ROOT/network/down.sh" || fail "down.sh does not keep reth's data for a persistent chain"
grep -q -- '--wipe)' "$ROOT/network/down.sh" || fail "down.sh has no --wipe"
grep -q 'persist.env' "$ROOT/network/up.sh" || fail "up.sh does not guard a persistent chain that is here"
grep -q 'CZE_PERSIST' "$ROOT/network/up.sh" || fail "up.sh does not know CZE_PERSIST"
# A new persistent chain commits an empty block 1 right after it is proposed (reth cannot move back to genesis in that mode), and stops if it fails;
# restart.sh does not build anything.
propose_line=$(grep -n 'network/canton/propose.py' "$ROOT/network/up.sh" | head -1 | cut -d: -f1)
first_line=$(grep -n 'builder/builder.py" once' "$ROOT/network/up.sh" | head -1 | cut -d: -f1)
[ -n "$propose_line" ] && [ -n "$first_line" ] && [ "$first_line" -gt "$propose_line" ] || fail "up.sh does not run the builder once after it proposes the chain"
sed -n "$((first_line - 8)),$((first_line - 1))p" "$ROOT/network/up.sh" | grep -q 'CZE_PERSIST:-0}" = 1' || fail "up.sh's first block is not only for a persistent chain"
sed -n "$((first_line)),\$p" "$ROOT/network/up.sh" | grep -q 'block 1 was not committed' || fail "up.sh does not stop when block 1 is not committed"
! grep -q 'builder/builder.py' "$ROOT/network/restart.sh" || fail "restart.sh builds a block"
grep -q 'never rests at head 0' "$ROOT/network/README.md" || fail "network/README.md does not state the first-block rule"

# No secret is written down: keys, tokens and passwords are made per run (see network/make-state.sh).
! grep -rInE '(secret|password|passwd|token|private[-_ ]?key) *[=:] *["'"'"']?[A-Za-z0-9+/]{16,}' "$ROOT/network" || fail "something that looks like a secret in network/"
# What a smoke result must hold. check_smoke <result file> <file with the recorded programVK>: prints what is wrong and
# returns 1, so that the same checks run on the recorded result and, in the tests below, on a fixture.
check_smoke() {
  local R=$1 S=$2
  bad() { echo "$*"; return 1; }
  for k in block_hash proof_seconds advance_seconds canton_head_number canton_head_hash block_record_seen_by_reader reth_finalized canton daml_sdk zisk; do
    grep -qE "^$k=." "$R" || { bad "smoke result has no $k"; return 1; }
  done
  [ "$(sed -n 's/^block_hash=//p' "$R")" = "$(sed -n 's/^canton_head_hash=//p' "$R")" ] || { bad "Canton's head is not the block"; return 1; }
  [ "$(sed -n 's/^canton_head_number=//p' "$R")" = 1 ] || { bad "Canton's head is not 1"; return 1; }
  [ "$(sed -n 's/^reth_finalized=//p' "$R")" = yes ] || { bad "reth did not finalize the block"; return 1; }
  # Generic only: no email address and no IPv4 address.
  ! grep -qE '@|[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}([^0-9.]|$)' "$R" || { bad "an email address or an IPv4 address"; return 1; }
  # Format 2 (what network/smoke.sh writes): the result also names the source commit it ran, the DAR and the package id,
  # and its programVK is the recorded one. These checks always run; a result without a format line is refused.
  [ "$(sed -n 's/^format=//p' "$R")" = 2 ] || { bad "not format 2 (missing or unknown format line)"; return 1; }
  for k in source_commit dar_sha256 package_id; do grep -qE "^$k=." "$R" || { bad "no $k"; return 1; }; done
  [[ $(sed -n 's/^source_commit=//p' "$R") =~ ^[0-9a-f]{40}$ ]] || { bad "source_commit is not a full commit hash"; return 1; }
  [[ $(sed -n 's/^dar_sha256=//p' "$R") =~ ^[0-9a-f]{64}$ ]] || { bad "dar_sha256 is not a SHA-256"; return 1; }
  [[ $(sed -n 's/^package_id=//p' "$R") =~ ^[0-9a-f]{64}$ ]] || { bad "package_id is not 64 hex digits"; return 1; }
  # A result recorded before Osaka started at genesis ran the guest that stopped at Prague: its key is previous_programVK in session.txt.
  rvk=$(sed -n 's/^programVK=//p' "$R")
  [ "$rvk" = "$(sed -n 's/^programVK=//p' "$S")" ] || [ "$rvk" = "$(sed -n 's/^previous_programVK=//p' "$S")" ] || { bad "programVK is not the recorded one"; return 1; }
}
# The recorded smoke result is complete and consistent.
out=$(check_smoke "$ROOT/demo/results/smoke.txt" "$ROOT/prover/fixtures/session.txt") || fail "demo/results/smoke.txt: $out"

# The same checks, exercised on a fixture with made-up values: the fixture passes, and each fault that the checks are
# there to catch is caught.
F=$ROOT/tests/data/smoke-format2.txt
grep -q '^format=2$' "$F" || fail "the fixture is not format 2"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
printf 'programVK=%s\n' "$(sed -n 's/^programVK=//p' "$F")" > "$WORK/recorded.txt"
out=$(check_smoke "$F" "$WORK/recorded.txt") || fail "the format 2 fixture is refused: $out"
must_refuse() {   # <what is wrong> <sed expression applied to the fixture>
  sed -e "$2" "$F" > "$WORK/bad.txt"
  ! check_smoke "$WORK/bad.txt" "$WORK/recorded.txt" >/dev/null || fail "the format 2 checks accept a result with $1"
}
must_refuse "no format line" '/^format=/d'
must_refuse "an unknown format" 's/^format=2$/format=3/'
must_refuse "no source_commit" '/^source_commit=/d'
must_refuse "a short source_commit" 's/^source_commit=.*/source_commit=0123abc/'
must_refuse "no dar_sha256" '/^dar_sha256=/d'
must_refuse "a dar_sha256 that is not 64 hex digits" 's/^dar_sha256=.*/dar_sha256=zz/'
must_refuse "no package_id" '/^package_id=/d'
must_refuse "a package_id that is not 64 hex digits" 's/^package_id=.*/package_id=abc/'
must_refuse "a programVK that is not the recorded one" 's/^programVK=0x4/programVK=0x5/'
must_refuse "a Canton head that is not the block" 's/^canton_head_hash=.*/canton_head_hash=0xbb/'
must_refuse "a Canton head that is not 1" 's/^canton_head_number=1$/canton_head_number=2/'
must_refuse "a block that reth did not finalize" 's/^reth_finalized=yes$/reth_finalized=no/'
must_refuse "an IPv4 address" 's/^gpu=fixture$/gpu=10.1.2.3/'

# up.sh stops on a program key that is not the recorded one, and records the DAR it loads; smoke.sh needs the commit it ran.
grep -q 'network/check-program-vk.sh' "$ROOT/network/up.sh" || fail "up.sh does not stop on a programVK that is not the recorded one"
grep -q 'network/canton/dar-id.sh' "$ROOT/network/up.sh" || fail "up.sh does not record the DAR's SHA-256 and package id"
grep -q 'network/canton/check-package.sh' "$ROOT/network/smoke.sh" || fail "smoke.sh does not check the package id against the participant's package list"
grep -q 'network/canton/check-package.sh' "$ROOT/tests/canton_network.sh" || fail "the canton job does not check the DAR's package id against the participant's package list"
grep -q 'CZE_SOURCE_COMMIT' "$ROOT/network/smoke.sh" || fail "smoke.sh does not take the source commit"
for k in format source_commit dar_sha256 package_id; do grep -q "echo \"$k=" "$ROOT/network/smoke.sh" || fail "smoke.sh does not write $k"; done
# The Daml-LF target is described as what it is: the released Daml 3.6 line.
grep -q 'Daml 3.6 release' "$ROOT/daml/build.sh" || fail "daml/build.sh does not say LF 2.4 is from the Daml 3.6 release"
! grep -qi 'snapshot' "$ROOT/daml/build.sh" || fail "daml/build.sh still says snapshot"

# The gateway party (the chain's custody holder): hosted on the operator's participant, the operator's user may act as it, the
# builder may read as it, and its id goes to the parties file. up.sh gives the chain the gateway contract's address from PINS and
# stops unless the genesis reth runs holds the gateway's code.
B=$ROOT/network/canton/bootstrap.canton
grep -q 'val gatewayParty = operator.parties.enable("gateway")' "$B" || fail "bootstrap.canton does not create the gateway party on the operator's participant"
grep -qE 'users.create\("operator", actAs = Set\(operatorParty, gatewayParty\)' "$B" || fail "the operator's user cannot act as the gateway party"
grep -qE 'users.create\("builder", .*readAs = Set\(operatorParty, gatewayParty\)' "$B" || fail "the builder cannot read as the gateway party"
grep -q 'GATEWAY_PARTY=' "$B" || fail "bootstrap.canton does not write GATEWAY_PARTY to parties.env"
[ "$(grep -cE 'actAs = Set\([^)]*gatewayParty' "$B")" = 1 ] || fail "a user other than the operator's can act as the gateway party"
# shellcheck disable=SC2016
grep -q -- '--gateway-address "${GATEWAY_ADDRESS#0x}"' "$ROOT/network/up.sh" || fail "up.sh does not give the chain the gateway address from PINS"
grep -q 'eth_getCode' "$ROOT/network/up.sh" || fail "up.sh does not read the gateway's code from reth's genesis"
grep -q 'gateway/Gateway.bin-runtime' "$ROOT/network/up.sh" || fail "up.sh does not compare it with gateway/Gateway.bin-runtime"
# Running on an existing participant (network/external/, CZE_CANTON=external): the scripts, what they refuse, and that local mode is as it was.
X=$ROOT/network/external
for f in setup.py sidecar.sh participant-config.sh check-env.sh; do [ -x "$X/$f" ] || fail "network/external/$f is missing or not executable"; done
# The settings check: a good set passes and prints no token; each fault is refused.
XW=$(mktemp -d); trap 'rm -rf "$XW"' EXIT
for role in ADMIN OPERATOR CONFIRMER BUILDER; do echo "secret-token-$role" > "$XW/$role"; chmod 600 "$XW/$role"; done
xenv() { env -i PATH="$PATH" CZE_LEDGER_URL="${URL-https://ledger.example}" CZE_TOKEN_FILE_ADMIN="$XW/ADMIN" CZE_TOKEN_FILE_OPERATOR="$XW/OPERATOR" \
  CZE_TOKEN_FILE_CONFIRMER="$XW/CONFIRMER" CZE_TOKEN_FILE_BUILDER="$XW/BUILDER" "$X/check-env.sh"; }
out=$(xenv 2>&1) || fail "check-env.sh refused a complete setting: $out"
! grep -q 'secret-token' <<<"$out" || fail "check-env.sh prints a token"
URL=http://127.0.0.1:7575 xenv >/dev/null 2>&1 || fail "check-env.sh refused http on this machine"
URL=http://10.1.2.3:7575 xenv >/dev/null 2>&1 && fail "check-env.sh accepted a token over plain http to another machine"
URL='' xenv >/dev/null 2>&1 && fail "check-env.sh accepted no Ledger API URL"
chmod 644 "$XW/OPERATOR"; out=$(xenv 2>&1) && fail "check-env.sh accepted a token file that others can read"
! grep -q 'secret-token' <<<"$out" || fail "check-env.sh prints a token when it refuses"
chmod 600 "$XW/OPERATOR"
: > "$XW/BUILDER"; xenv >/dev/null 2>&1 && fail "check-env.sh accepted an empty token file"
echo x > "$XW/BUILDER"; chmod 600 "$XW/BUILDER"
env -i PATH="$PATH" CZE_LEDGER_URL=https://ledger.example "$X/check-env.sh" >/dev/null 2>&1 && fail "check-env.sh accepted a login-less setting without CZE_LEDGER_NO_AUTH"
env -i PATH="$PATH" CZE_LEDGER_URL=https://ledger.example CZE_LEDGER_NO_AUTH=1 "$X/check-env.sh" >/dev/null 2>&1 || fail "check-env.sh refused CZE_LEDGER_NO_AUTH=1"
# A restart needs no admin token (the validator's most powerful one); an up does.
xenv_no_admin() { env -i PATH="$PATH" CZE_LEDGER_URL=https://ledger.example CZE_TOKEN_FILE_OPERATOR="$XW/OPERATOR" CZE_TOKEN_FILE_CONFIRMER="$XW/CONFIRMER" \
  CZE_TOKEN_FILE_BUILDER="$XW/BUILDER" "$X/check-env.sh" "$1"; }
xenv_no_admin restart >/dev/null 2>&1 || fail "check-env.sh restart wants the admin token"
# A restart needs the builder's token and no other: not the operator's, not the confirmer's (they are for up.sh and setup.py).
xenv_builder_only() { env -i PATH="$PATH" CZE_LEDGER_URL=https://ledger.example CZE_TOKEN_FILE_BUILDER="$XW/BUILDER" "$X/check-env.sh" "$1"; }
xenv_builder_only restart >/dev/null 2>&1 || fail "check-env.sh restart wants a token other than the builder's"
xenv_builder_only up >/dev/null 2>&1 && fail "check-env.sh up accepted a setting with the builder's token only"
env -i PATH="$PATH" CZE_LEDGER_URL=https://ledger.example CZE_TOKEN_FILE_OPERATOR="$XW/OPERATOR" CZE_TOKEN_FILE_CONFIRMER="$XW/CONFIRMER" "$X/check-env.sh" restart >/dev/null 2>&1 \
  && fail "check-env.sh restart accepted a setting without the builder's token"
chmod 644 "$XW/BUILDER"; xenv_builder_only restart >/dev/null 2>&1 && fail "check-env.sh restart accepted a builder token file that others can read"
chmod 600 "$XW/BUILDER"
xenv_no_admin up >/dev/null 2>&1 && fail "check-env.sh up accepted a setting without the admin token"
xenv_no_admin sideways >/dev/null 2>&1 && fail "check-env.sh took a phase that is neither up nor restart"
grep -q 'check-env.sh" restart' "$ROOT/network/restart.sh" || fail "restart.sh does not check the settings for a restart (no admin token)"
grep -q 'CZE_PACKAGE_TOKEN_FILE=${CZE_TOKEN_FILE_BUILDER' "$ROOT/network/restart.sh" || fail "restart.sh lists the package with a token other than the builder's"
! grep -q 'CZE_TOKEN_FILE_ADMIN' "$ROOT/network/restart.sh" "$ROOT/network/sync_reth.py" || ! grep -v 'CZE_PACKAGE_TOKEN_FILE=' "$ROOT/network/restart.sh" | grep -q 'CZE_TOKEN_FILE_ADMIN' || fail "restart.sh uses the admin token"
# An external chain has no local databases: a Canton pin move does not stop its restart.
grep -q '\[ "\$CANTON_MODE" = external \] || \[ "\$(sed -n' "$ROOT/network/restart.sh" || fail "restart.sh checks the local databases' Canton version in external mode"
# A sidecar that runs already with the same keys on the same address is not an error (up.sh after a manual start).
grep -q 'answers on \$listen already' "$X/sidecar.sh" || fail "sidecar.sh start fails when the same sidecar runs already"
# The participant's line: the extension's key, the given address and port, and validate-on-startup off.
line=$("$X/participant-config.sh" 172.17.0.1 8085)
[ "$line" = 'ADDITIONAL_CONFIG_ZK_EVM=canton.participants.participant.parameters.engine.extensions.canton-zk-evm { address = "172.17.0.1", port = 8085, validate-on-startup = false }' ] || fail "participant-config.sh printed: $line"
"$X/participant-config.sh" 'x"y' 8085 >/dev/null 2>&1 && fail "participant-config.sh took an address with a quote"
"$X/participant-config.sh" 127.0.0.1 99999999 >/dev/null 2>&1 && fail "participant-config.sh took a port that is not one"
# The lone sidecar: the recorded keys, loopback by default, a pid file down.sh finds, no reth, no container.
grep -q 'session.txt' "$X/sidecar.sh" && grep -q -- '--program-vk "$PROGRAM_VK" --root-c "$ROOT_C"' "$X/sidecar.sh" || fail "sidecar.sh does not pin the recorded program key and root key"
grep -q 'CZE_SIDECAR_LISTEN:-127.0.0.1:8085' "$X/sidecar.sh" || fail "sidecar.sh does not listen on 127.0.0.1 by default"
grep -q 'sidecar-\$port.pid' "$X/sidecar.sh" || fail "sidecar.sh does not keep its pid where down.sh looks"
! grep -qE 'docker|reth' "$X/sidecar.sh" || fail "sidecar.sh starts something other than the sidecar"
grep -q -- '--manifest-path "$ROOT/sidecar/Cargo.toml"' "$X/sidecar.sh" || fail "sidecar.sh does not build the sidecar as up.sh does"
# up.sh, restart.sh and down.sh know the mode. In external mode up.sh runs setup.py, not Canton; in local mode it runs Canton as before.
for f in up.sh restart.sh; do grep -q 'network/external/check-env.sh' "$ROOT/network/$f" || fail "$f does not check the external settings"; done
grep -q 'CZE_CANTON=external' "$ROOT/network/down.sh" || fail "down.sh does not know the external mode"
awk '/CANTON_MODE" = external \]; then/ {in_ext=1} /^else/ {in_ext=0} in_ext && /canton\/run.sh/ {bad=1} END {exit bad}' "$ROOT/network/up.sh" || fail "up.sh starts Canton in external mode"
grep -q 'network/external/setup.py' "$ROOT/network/up.sh" || fail "up.sh does not run setup.py in external mode"
grep -q 'canton/run.sh" bootstrap' "$ROOT/network/up.sh" || fail "up.sh no longer bootstraps the local Canton"
! grep -qE 'echo .*\$\(.*(TOKEN_FILE|\$file)' "$X"/*.sh "$ROOT/network/up.sh" "$ROOT/network/restart.sh" "$ROOT/network/canton/check-package.sh" || fail "a script prints a token"
! grep -qE 'CZE_TOKEN_FILE_[A-Z]+=' "$ROOT/network/up.sh" "$ROOT/network/restart.sh" "$ROOT/network/down.sh" || fail "a token file's path is written in a script"
# persist.env records the mode, the participant and the sidecar's address, and no token.
grep -q 'CZE_CANTON=external' "$ROOT/network/up.sh" && ! grep 'CZE_CANTON=external' "$ROOT/network/up.sh" | grep -qi token || fail "up.sh writes a token into persist.env"
echo "network static checks passed"
