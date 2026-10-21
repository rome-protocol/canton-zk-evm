#!/usr/bin/env bash
# Checks on how the explorer is run, which need no Docker: its images are pinned by digest (and the Rust one is the toolchain the repository
# pins), the Dockerfile takes every base image from PINS, and explorer/run.sh gives the container only what it needs: the reader party,
# the pins file and the faucet's key, the last two read-only, and no more rights than that.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

[[ ${EXPLORER_NODE_IMAGE:-} =~ @sha256:[0-9a-f]{64}$ ]] || fail "EXPLORER_NODE_IMAGE is not pinned by digest"
[[ ${EXPLORER_RUST_IMAGE:-} =~ @sha256:[0-9a-f]{64}$ ]] || fail "EXPLORER_RUST_IMAGE is not pinned by digest"
channel=$(sed -n 's/^channel = "\(.*\)"$/\1/p' "$ROOT/rust-toolchain.toml")
[[ $EXPLORER_RUST_IMAGE == */rust:"$channel"-*@sha256:* ]] || fail "EXPLORER_RUST_IMAGE is not Rust $channel, the toolchain rust-toolchain.toml pins"

# The Dockerfile names no image of its own: each stage starts from an image PINS pins, so there is one place to change them.
froms=$(grep -E '^FROM ' "$ROOT/explorer/Dockerfile")
[ -n "$froms" ] || fail "explorer/Dockerfile has no FROM"
while read -r line; do
  [[ $line =~ ^FROM\ \$\{EXPLORER_(NODE|RUST)_IMAGE\}\ AS\ [a-z]+$ ]] || fail "a FROM in explorer/Dockerfile does not take its image from PINS: $line"
done <<<"$froms"
for arg in EXPLORER_NODE_IMAGE EXPLORER_RUST_IMAGE; do
  grep -q "^ARG $arg\$" "$ROOT/explorer/Dockerfile" || fail "the Dockerfile does not declare $arg, with no default"
done

# run.sh, without calling Docker: what it would start.
S=$WORK/state
mkdir -p "$S/canton" "$S/net" "$S/faucet"
printf 'OPERATOR_PARTY=operator::1220aa\nREADER_PARTY=reader::1220bb\n' > "$S/canton/parties.env"
printf 'programVK=0x%s\nrootC=0x%s\n' "$(printf 'cd%.0s' $(seq 32))" "$(printf 'ef%.0s' $(seq 32))" > "$S/net/guest.txt"
printf 'SECRET-KEY-TEXT\n' > "$S/faucet/key"
printf 'POSTGRES_PASSWORD=statepw\n' > "$S/explorer-db.env"   # what network/explorer-db.sh makes: the default database of a run
dry() { EXPLORER_DRY_RUN=1 CZE_STATE_DIR="$S" "$ROOT/explorer/run.sh" "$@"; }
has() { grep -qF -- "$2" <<<"$1" || fail "$3: no \"$2\" in: $1"; }
lacks() { ! grep -qF -- "$2" <<<"$1" || fail "$3: \"$2\" is in: $1"; }

start=$(dry start)
# The public RPC's and the tracker's settings reach the container when they are set.
rpc=$(PUBLIC_RPC=1 RPC_RATE_PER_MINUTE=120 TRACKER_MAX=500 dry start)
has "$rpc" " -e PUBLIC_RPC=1" "the public RPC switch is passed on"
has "$rpc" " -e RPC_RATE_PER_MINUTE=120" "the rate limit is passed on"
has "$rpc" " -e TRACKER_MAX=500" "the tracker's size is passed on"
has "$start" "docker build" "start builds the image"
has "$start" "--build-arg EXPLORER_NODE_IMAGE=$EXPLORER_NODE_IMAGE" "the build takes the Node image from PINS"
has "$start" "--build-arg EXPLORER_RUST_IMAGE=$EXPLORER_RUST_IMAGE" "the build takes the Rust image from PINS"
has "$start" "docker run" "start runs the image"
has "$start" "-e READER_PARTY=reader::1220bb" "the reader party comes from the run's parties file"
lacks "$start" "operator::1220aa" "the other parties"
has "$start" "-e PINS_FILE=/run/explorer/guest.txt" "the run's own pins"
has "$start" "-v $S/net/guest.txt:/run/explorer/guest.txt:ro" "the pins file is mounted read-only"
has "$start" "-e FAUCET_KEY_FILE=/run/explorer/key" "the faucet's key"
has "$start" "-v $S/faucet/key:/run/explorer/key:ro" "the key is mounted read-only"
lacks "$start" "SECRET-KEY-TEXT" "the key's contents"
has "$start" "--read-only" "the container's own files"
has "$start" "--cap-drop ALL" "the container's capabilities"
has "$start" "--security-opt no-new-privileges" "the container's privileges"
has "$start" "--user $(id -u):$(id -g)" "the container runs as the caller, who owns the key"
has "$start" "--network host" "the explorer reads the chain's local ports"
lacks "$start" "--privileged" "the container"
lacks "$start" "docker.sock" "the container"
lacks "$start" " -p " "a published port"

# Without a key the faucet is off: nothing about it is passed. Settings given by the caller win over the run's files.
rm "$S/faucet/key"
nokey=$(dry start); lacks "$nokey" "FAUCET_KEY_FILE" "a run with no key"
printf 'programVK=0x00\n' > "$WORK/other-pins.txt"
over=$(READER_PARTY=reader::other PINS_FILE=$WORK/other-pins.txt dry start)
has "$over" "-e READER_PARTY=reader::other" "READER_PARTY given by the caller"
has "$over" "-e PINS_FILE=/run/explorer/other-pins.txt" "PINS_FILE given by the caller"
has "$over" "-v $WORK/other-pins.txt:/run/explorer/other-pins.txt:ro" "the caller's pins file"

# A file the caller names must exist and be a regular file, and is mounted by its absolute path: a path that is missing would be made into a
# directory by Docker, a bare name would become a named volume, and a directory is not a file to read.
mkdir "$WORK/adir"; printf 'k\n' > "$WORK/relkey"
for bad in "PINS_FILE=$WORK/no-such-pins" "PINS_FILE=$WORK/adir" "PINS_FILE=no-such-pins" "FAUCET_KEY_FILE=$WORK/no-such-key" "FAUCET_KEY_FILE=$WORK/adir"; do
  if out=$(env "$bad" EXPLORER_DRY_RUN=1 CZE_STATE_DIR="$S" "$ROOT/explorer/run.sh" start 2>&1); then fail "start ran with $bad"; fi
  has "$out" "${bad%%=*}" "the refusal for $bad"
  lacks "$out" "docker run" "a start with $bad"
done
if out=$(CZE_GENESIS_FILE=$WORK/no-such-genesis EXPLORER_DRY_RUN=1 CZE_STATE_DIR="$S" "$ROOT/explorer/run.sh" setup 2>&1); then fail "setup ran with a genesis that is not there"; fi
has "$out" "CZE_GENESIS_FILE" "the refusal for the genesis"
if out=$(CZE_GENESIS_FILE=$WORK/adir EXPLORER_DRY_RUN=1 CZE_STATE_DIR="$S" "$ROOT/explorer/run.sh" setup 2>&1); then fail "setup ran with a genesis that is a directory"; fi
rel=$(cd "$WORK" && FAUCET_KEY_FILE=relkey EXPLORER_DRY_RUN=1 CZE_STATE_DIR="$S" "$ROOT/explorer/run.sh" start)
has "$rel" "-v $WORK/relkey:/run/explorer/relkey:ro" "a relative file is mounted by its absolute path"
rm -rf "$WORK/adir"

# The faucet keeps its limits and waiting requests in the one folder the explorer may write, and a secret stays off the command line.
sec=$(openssl rand -hex 8)   # made for this run, so no secret-like string is in the repository
queue=$(FAUCET_BATCH=50 FAUCET_QUEUE_MAX=900 CAPTCHA_VERIFY_URL=https://check.example/verify CAPTCHA_SECRET="$sec" dry start)
has "$queue" "-e FAUCET_STATE_FILE=/var/lib/explorer/faucet.json" "the faucet's state is kept in the explorer's folder"
has "$queue" "-e FAUCET_BATCH=50" "the batch size is passed on"
has "$queue" "-e FAUCET_QUEUE_MAX=900" "the queue cap is passed on"
has "$queue" "-e CAPTCHA_VERIFY_URL=https://check.example/verify" "the human check's address is passed on"
has "$queue" "-e CAPTCHA_SECRET" "the human check's secret is named"
lacks "$queue" "$sec" "the secret's value is never on the command"

# The database: its password file and the faucet's hash key are mounted read-only, the parts are passed on, and a URL (it may hold the password) is named without its value.
printf 'POSTGRES_PASSWORD=x\n' > "$WORK/db.env"; printf 'k\n' > "$WORK/client.key"
dbsec=$(openssl rand -hex 8)
dbrun=$(EXPLORER_DB_PASSWORD_FILE="$WORK/db.env" FAUCET_CLIENT_KEY_FILE="$WORK/client.key" EXPLORER_DB_HOST=10.0.0.5 EXPLORER_DB_PORT=5433 EXPLORER_DB_USER=explorer EXPLORER_DB_NAME=explorer dry start)
has "$dbrun" "-v $WORK/db.env:/run/explorer/db.env:ro" "the database's password file is mounted read-only"
has "$dbrun" "-e EXPLORER_DB_PASSWORD_FILE=/run/explorer/db.env" "the container reads the password file from the mount"
has "$dbrun" "-v $WORK/client.key:/run/explorer/client.key:ro" "the faucet's hash key is mounted read-only"
has "$dbrun" "-e FAUCET_CLIENT_KEY_FILE=/run/explorer/client.key" "the container reads the hash key from the mount"
has "$dbrun" "-e EXPLORER_DB_HOST=10.0.0.5" "the database's host is passed on"
has "$dbrun" "-e EXPLORER_DB_NAME=explorer" "the database's name is passed on"
urlrun=$(EXPLORER_DATABASE_URL="postgres://explorer:$dbsec@127.0.0.1:5433/explorer" dry start)
has "$urlrun" "-e EXPLORER_DATABASE_URL" "the database's URL is named"
lacks "$urlrun" "$dbsec" "the URL's password is never on the command"

# With no database named, start takes the run's own (network/explorer-db.sh's): its password file from the state folder and its port from CZE_EXPLORER_DB_PORT.
def=$(CZE_EXPLORER_DB_PORT=5999 dry start)
has "$def" "-v $S/explorer-db.env:/run/explorer/explorer-db.env:ro" "the run's own database password file is mounted"
has "$def" "-e EXPLORER_DB_PASSWORD_FILE=/run/explorer/explorer-db.env" "the container reads the run's own database password"
has "$def" "-e EXPLORER_DB_PORT=5999" "the run's own database port"
lacks "$def" "statepw" "the password's value"
# The faucet's hash key is made once per state folder when there is a faucet key: here it exists, so it is mounted read-only.
printf 'SECRET-KEY-TEXT\n' > "$S/faucet/key"
printf '%s\n' "$(printf 'ab%.0s' $(seq 32))" > "$S/faucet/client-key"
withck=$(dry start)
has "$withck" "-v $S/faucet/client-key:/run/explorer/client-key:ro" "the faucet's hash key of this state folder is mounted read-only"
has "$withck" "-e FAUCET_CLIENT_KEY_FILE=/run/explorer/client-key" "the container reads it from the mount"
# No database at all (no file of the run's, none named): start stops before any container runs, and names the setting.
mv "$S/explorer-db.env" "$WORK/explorer-db.env.kept"
if out=$(dry start 2>&1); then fail "start ran with no database"; fi
has "$out" "EXPLORER_DB_PASSWORD_FILE" "the refusal names the database setting"
lacks "$out" "docker run" "a start with no database"
mv "$WORK/explorer-db.env.kept" "$S/explorer-db.env"

# start makes the database ready, then runs the indexer beside the explorer: three Docker runs, in that order, each its own container.
[ "$(grep -c '^docker run' <<<"$withck")" = 3 ] || fail "start does not run migrate, the indexer and the explorer: $withck"
migrate=$(grep -- 'node server/db/cli.ts migrate' <<<"$withck")
indexer=$(grep -- 'node server/indexer/cli.ts' <<<"$withck")
{ [ -n "$migrate" ] && [ -n "$indexer" ]; } || fail "start has no migrate or no indexer step: $withck"
[ "$(grep -n -- 'node server/db/cli.ts migrate' <<<"$withck" | cut -d: -f1)" -lt "$(grep -n -- 'node server/indexer/cli.ts' <<<"$withck" | cut -d: -f1)" ] || fail "the indexer starts before the migrations"
has "$migrate" "--rm" "the migration container is removed when done"
has "$migrate" "-e EXPLORER_DB_PASSWORD_FILE=/run/explorer/explorer-db.env" "the migration reads the run's database"
has "$indexer" "--name cze-explorer-indexer" "the indexer is its own container"
has "$indexer" "-e GATEWAY_ADDRESS=$GATEWAY_ADDRESS" "the indexer is told the gateway's address (from PINS)"
has "$indexer" "-e CHAIN_ID=$CHAIN_ID" "the indexer is told the chain id"
has "$indexer" "-e READER_PARTY=reader::1220bb" "the indexer reads Canton as the reader party"
has "$indexer" "-e PINS_FILE=/run/explorer/guest.txt" "the indexer reads the run's own pins"
has "$indexer" "-e EXPLORER_DB_PASSWORD_FILE=/run/explorer/explorer-db.env" "the indexer reads the run's database"
has "$indexer" "--read-only" "the indexer's filesystem"
has "$indexer" "--cap-drop ALL" "the indexer's capabilities"
has "$indexer" "--network host" "the indexer reads the chain's local ports"
lacks "$indexer" "FAUCET_KEY_FILE" "the indexer has no faucet key"
lacks "$indexer" "FAUCET_CLIENT_KEY_FILE" "the indexer has no hash key"
lacks "$indexer" "--restart" "a check that stops the indexer must leave it stopped"
# The indexer reads reth and Canton where INDEXER_* say, else where the explorer does; its own settings are passed on.
same=$(RETH_RPC_URL=http://127.0.0.1:8595 LEDGER_URL=http://127.0.0.1:7597 dry start | grep -- 'node server/indexer/cli.ts')
has "$same" "-e RETH_RPC_URL=http://127.0.0.1:8595" "the indexer follows the explorer's reth by default"
split=$(RETH_RPC_URL=http://127.0.0.1:8595 LEDGER_URL=http://127.0.0.1:7597 INDEXER_RETH_RPC_URL=http://127.0.0.1:8545 INDEXER_LEDGER_URL=http://127.0.0.1:7577 INDEX_DERIVE=behind INDEX_POLL_MS=500 dry start)
split_indexer=$(grep -- 'node server/indexer/cli.ts' <<<"$split")
has "$split_indexer" "-e RETH_RPC_URL=http://127.0.0.1:8545" "the indexer's own reth address wins"
has "$split_indexer" "-e LEDGER_URL=http://127.0.0.1:7577" "the indexer's own Canton address wins"
lacks "$split_indexer" "8595" "the explorer's logged address is not the indexer's"
has "$split_indexer" "-e INDEX_DERIVE=behind" "INDEX_DERIVE is passed on"
has "$split_indexer" "-e INDEX_POLL_MS=500" "INDEX_POLL_MS is passed on"
explorer_run=$(grep -- '--name cze-explorer ' <<<"$split")
has "$explorer_run" "-e RETH_RPC_URL=http://127.0.0.1:8595" "the explorer keeps its own reth address"
lacks "$explorer_run" "GATEWAY_ADDRESS" "the explorer is not given the indexer's settings"
# stop stops both.
stopped=$(dry stop)
grep -qx 'docker stop -t 30 cze-explorer' <<<"$stopped" || fail "stop does not stop the explorer: $stopped"
grep -qx 'docker stop -t 30 cze-explorer-indexer' <<<"$stopped" || fail "stop does not stop the indexer: $stopped"

# No reader party anywhere: it stops, and says which setting.
rm "$S/canton/parties.env"
if out=$(dry start 2>&1); then fail "start ran without a reader party"; fi
has "$out" "READER_PARTY" "the refusal"

# setup lets the container write the faucet's folder and nothing else of the state.
setup=$(dry setup)
has "$setup" "node server/faucet-setup.ts" "setup runs the faucet's script"
has "$setup" "-v $S/faucet:$S/faucet" "setup may write the faucet's folder"
lacks "$setup" "-v $S:$S" "setup may write the whole state"
has "$setup" "-e CZE_GENESIS_FILE=$ROOT/network/genesis.json" "the genesis it copies, when none is named"
has "$setup" "-v $ROOT/network/genesis.json:$ROOT/network/genesis.json:ro" "the genesis is read-only"
lacks "$setup" "--network host" "setup needs no network"
printf '{}\n' > "$WORK/g.json"
named=$(CZE_GENESIS_FILE=$WORK/g.json dry setup)
has "$named" "-e CZE_GENESIS_FILE=$WORK/g.json" "the genesis the caller names"

# stop, and what it is not given.
# Never docker rm -f: SIGKILL would skip the explorer's shutdown, which writes the tracker's list and lets the faucet finish its send.
stopped=$(dry stop)
has "$stopped" "docker stop -t 30 cze-explorer" "stop is graceful"
has "$stopped" "docker rm cze-explorer" "stop removes the container after it has stopped"
lacks "$stopped" " -f" "stop never kills"
lacks "$start" "rm -f" "start never kills the old container"
order=$(grep -n "^docker stop -t 30 \|^docker run -d" <<<"$start" | cut -d: -f2 | cut -d' ' -f1-2 | tr '\n' ',')
[ "$order" = "docker stop,docker run,docker stop,docker run," ] || fail "start must stop each old container (the indexer, then the explorer) before it runs the new one: $order"
if dry nonsense >/dev/null 2>&1; then fail "run.sh accepted a command it does not have"; fi
echo "explorer run checks passed"
