#!/usr/bin/env bash
# Brings a persistent chain (network/up.sh with CZE_PERSIST=1) back after a restart of the machine or of its processes: the database,
# reth on its data, both sidecars, the prover and Canton, in that order. It makes nothing new: no new chain is proposed, no per-run secret is
# made, no guest is built, and Canton's bootstrap is not run again (resume.canton starts the nodes on what they kept). Then it checks that
# Canton's ZkChain head and reth agree, moving reth to Canton's head the way the builder does (network/sync_reth.py), and prints the head.
# It refuses to run without persistent state, or if any of the services is still running (network/down.sh stops them).
# State comes from $CZE_STATE_DIR (default ./state), as for up.sh.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"
export CZE_STATE_DIR=${CZE_STATE_DIR:-$ROOT/state}
export CZE_PROVER_STATE=${CZE_PROVER_STATE:-$CZE_STATE_DIR/prover}
export CZE_PERSIST=1 CZE_RESUME=1
STATE=$CZE_STATE_DIR
NET=$STATE/net
fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo "== $* ($(date -u +%T))"; }
background() { local name=$1; shift; nohup "$@" > "$NET/logs/$name.log" 2>&1 < /dev/null & echo $! > "$NET/$name.pid"; }
rpc() { curl -sf -H 'content-type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":[${2:-}]}" "http://127.0.0.1:${RETH_HTTP_PORT:-8545}"; }

# 1. There must be a persistent chain here.
missing=()
for f in persist.env postgres.env jwt.hex genesis.json canton/parties.env net/chain.json net/guest.txt net/dar.txt; do
  [ -s "$STATE/$f" ] || missing+=("$f")
done
{ [ -d "$STATE/reth-data" ] && [ -n "$(ls -A "$STATE/reth-data" 2>/dev/null)" ]; } || missing+=("reth-data")
if [ ${#missing[@]} -gt 0 ]; then
  echo "FAIL: there is no persistent chain in $STATE (missing: ${missing[*]})." >&2
  echo "Start one with: CZE_PERSIST=1 network/up.sh   (a plain network/up.sh makes a chain that does not survive a restart)" >&2
  exit 1
fi
# The database container, reth's container and their ports are the ones up.sh used (network/persist-settings.sh).
# shellcheck disable=SC1091
. "$ROOT/network/persist-settings.sh"
load_persist_settings "$STATE" || exit 1
[ "$(sed -n 's/^CHAIN_ID=//p' "$STATE/persist.env")" = "$CHAIN_ID" ] || fail "this state is for chain $(sed -n 's/^CHAIN_ID=//p' "$STATE/persist.env"), not $CHAIN_ID"
# The databases were made by one Canton version, and only that one reads them: a newer jar needs its own upgrade, not a silent start.
[ "$(sed -n 's/^CANTON_VERSION=//p' "$STATE/persist.env")" = "$CANTON_VERSION" ] \
  || fail "the databases were made by Canton $(sed -n 's/^CANTON_VERSION=//p' "$STATE/persist.env"), and PINS now says $CANTON_VERSION"
umask 077
mkdir -p "$NET/logs"
# Nothing of this chain may be running: a pid file left by a reboot is stale, one that points at a live process is an error.
shopt -s nullglob
for f in "$NET"/canton.pid "$NET"/sidecar-*.pid "$CZE_PROVER_STATE"/worker.pid "$CZE_PROVER_STATE"/coordinator.pid; do
  [ -f "$f" ] || continue
  if kill -0 "$(cat "$f")" 2>/dev/null && ps -p "$(cat "$f")" -o args= 2>/dev/null | grep -qE 'canton|zk-sidecar|zisk-'; then
    fail "$f is a running process: network/down.sh first"
  fi
  rm -f "$f"
done
shopt -u nullglob
# shellcheck disable=SC1091
. "$ROOT/prover/common.sh"   # ZisK's paths
command -v cargo-zisk >/dev/null || fail "ZisK is not installed (prover/install.sh)"

step "the database"
"$ROOT/network/postgres.sh" start

step "reth, on its data"
# The container is gone after a reboot; the data is in $STATE/reth-data. One that still runs is stopped gently, so that reth writes its last blocks.
docker stop -t 60 "${RETH_CONTAINER:-cze-reth}" >/dev/null 2>&1 || true
docker rm -f "${RETH_CONTAINER:-cze-reth}" >/dev/null 2>&1 || true
"$ROOT/network/reth/launch.sh"
for _ in $(seq 1 60); do rpc eth_chainId >/dev/null 2>&1 && break; sleep 1; done
rpc eth_chainId >/dev/null || fail "reth does not answer"
"$ROOT/network/reth/check.sh"
[ "$(rpc eth_chainId | jq -r .result)" = "$(printf '0x%x' "$CHAIN_ID")" ] || fail "reth answers with another chain id"

step "the sidecars"
guest() { sed -n "s/^$1=//p" "$NET/guest.txt"; }
PROGRAM_VK=$(guest programVK); ROOT_C=$(guest rootC)
[[ $PROGRAM_VK =~ ^0x[0-9a-f]{64}$ && $ROOT_C =~ ^0x[0-9a-f]{64}$ ]] || fail "$NET/guest.txt does not hold the guest's keys"
PROGRAM_VK=${PROGRAM_VK#0x}; ROOT_C=${ROOT_C#0x}
SIDECAR=$ROOT/sidecar/target/release/zk-sidecar
[ -x "$SIDECAR" ] || cargo build --release --locked --manifest-path "$ROOT/sidecar/Cargo.toml"
for port in 8085 8086; do
  background "sidecar-$port" "$SIDECAR" --program-vk "$PROGRAM_VK" --root-c "$ROOT_C" --listen "127.0.0.1:$port"
  for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$port/api/v1/version" >/dev/null && break; sleep 0.5; done
  curl -sf "http://127.0.0.1:$port/api/v1/version" >/dev/null || fail "the sidecar on $port does not answer"
done

step "the prover"
"$ROOT/prover/start.sh"

step "Canton $CANTON_VERSION, on its databases"
tools=$("$ROOT/network/canton/fetch.sh")
CANTON_JAR=$(sed -n 's/^CANTON_JAR=//p' <<<"$tools") "$ROOT/network/canton/run.sh" resume
# The Daml package the chain runs is still on the operator's participant.
"$ROOT/network/canton/check-package.sh" "$(sed -n 's/^package_id=//p' "$NET/dar.txt")" "${CZE_LEDGER_URL:-http://127.0.0.1:7575}" \
  || fail "the DAR's main package is not on the operator's participant"

step "Canton's head and reth"
[ -x "$STATE/venv/bin/python3" ] || python3 -m venv "$STATE/venv"
"$STATE/venv/bin/pip" install --quiet --require-hashes -r "$ROOT/builder/requirements.txt"
# shellcheck disable=SC1091
. "$STATE/canton/parties.env"
head=$(CZE_LEDGER_USER=builder CZE_BUILDER_PARTY=$BUILDER_PARTY CZE_FEE_RECIPIENT=0x0000000000000000000000000000000000000fee \
  "$STATE/venv/bin/python3" "$ROOT/network/sync_reth.py") || fail "Canton and reth do not agree (see above)"
echo "$head"
echo "== back ($(date -u +%T)): the chain is at block $(sed -n 's/^canton_head=//p' <<<"$head") ($(sed -n 's/^canton_hash=//p' <<<"$head"))"
