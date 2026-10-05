#!/usr/bin/env bash
# Starts everything the first proof needs, on one machine, and leaves it running (network/down.sh stops it):
#   1. the Canton and Daml tools in PINS, and the real form of the Daml package
#   2. the guest build; its programVK and rootC pin the sidecars and the chain. All three, programVK, rootC and the
#      rules hash, must be the recorded ones (prover/fixtures/session.txt), or this stops before starting anything
#   3. reth, only through network/reth/launch.sh, with peer discovery off and checked
#   4. the two sidecars (operator's on 8085, confirmer's on 8086), pinned to programVK and rootC
#   5. the ZisK prover (prover/start.sh)
#   6. Canton: one synchronizer, three participants (network/canton/), the Daml package uploaded and vetted
#   7. the chain: the operator and the gateway propose it with genesis = reth's block 0, which holds the gateway contract's
#      code at GATEWAY_ADDRESS, and the confirmer accepts
# Needs ZisK installed (prover/install.sh), Docker, a GPU, Rust, Python 3 and jq. State, logs and pid files go to
# $CZE_STATE_DIR (default ./state, ignored by git); the Engine secret and the party ids are created there per run.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"
export CZE_STATE_DIR=${CZE_STATE_DIR:-$ROOT/state}
export CZE_PROVER_STATE=${CZE_PROVER_STATE:-$CZE_STATE_DIR/prover}
NET=$CZE_STATE_DIR/net
umask 077
mkdir -p "$NET/logs"
fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo "== $* ($(date -u +%T))"; }
fixture() { grep -E "^$1=" "$ROOT/prover/fixtures/session.txt" | cut -d= -f2-; }
rpc() { curl -sf -H 'content-type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":[${2:-}]}" "http://127.0.0.1:${RETH_HTTP_PORT:-8545}"; }
# Runs a command in the background, keeps its pid in $NET/<name>.pid and its output in $NET/logs/<name>.log.
background() { local name=$1; shift; nohup "$@" > "$NET/logs/$name.log" 2>&1 < /dev/null & echo $! > "$NET/$name.pid"; }

# shellcheck disable=SC1091
. "$ROOT/prover/common.sh"   # ZisK's paths
command -v cargo-zisk >/dev/null || fail "ZisK is not installed (prover/install.sh)"
[ ! -e "$NET/canton.pid" ] || fail "a network was started here already: run network/down.sh first"

step "tools: Canton $CANTON_VERSION, Daml SDK $DAML_SDK_VERSION"
tools=$("$ROOT/network/canton/fetch.sh")
CANTON_JAR=$(sed -n 's/^CANTON_JAR=//p' <<<"$tools")
DAR=$("$ROOT/network/canton/build-dar.sh")
# The DAR that Canton loads, by content: smoke.sh writes these two into its result.
"$ROOT/network/canton/dar-id.sh" "$DAR" | tee "$NET/dar.txt"

step "the guest build"
"$ROOT/prover/build-guest.sh" | tee "$NET/guest.txt"
guest() { sed -n "s/^$1=//p" "$NET/guest.txt"; }
PROGRAM_VK=$(guest programVK); ROOT_C=$(guest rootC); RULES_HASH=$(guest rulesHash)
[[ $PROGRAM_VK =~ ^0x[0-9a-f]{64}$ && $ROOT_C =~ ^0x[0-9a-f]{64}$ && $RULES_HASH =~ ^[0-9a-f]{64}$ ]] || fail "the guest build did not print its keys"
# ZisK's root key and the chain rules do not depend on where the guest is built, so they must be the recorded ones.
[ "$ROOT_C" = "$(fixture rootC)" ] || fail "the installed ZisK's rootC is not the recorded one ($(fixture rootC))"
[ "$RULES_HASH" = "$(fixture rulesHash)" ] || fail "the guest's rules hash is not the recorded one ($(fixture rulesHash))"
# The program key is that of the ELF this build made. build-guest.sh builds in one fixed folder, so a key that is not the
# recorded one usually means a different ZisK, toolchain or source. It is not the program the recorded proof is for, so stop
# (the message says both keys).
"$ROOT/network/check-program-vk.sh" "$PROGRAM_VK"
PROGRAM_VK=${PROGRAM_VK#0x}; ROOT_C=${ROOT_C#0x}

step "reth, through launch.sh"
"$ROOT/network/reth/launch.sh"
for _ in $(seq 1 60); do rpc eth_chainId >/dev/null 2>&1 && break; sleep 1; done
rpc eth_chainId >/dev/null || fail "reth does not answer"
"$ROOT/network/reth/check.sh"
GENESIS_HASH=$(rpc eth_getBlockByNumber '"0x0",false' | jq -r .result.hash)
[[ $GENESIS_HASH =~ ^0x[0-9a-f]{64}$ ]] || fail "could not read reth's block 0"
GENESIS_STATE_ROOT=$(rpc eth_getBlockByNumber '"0x0",false' | jq -r .result.stateRoot)
[[ $GENESIS_STATE_ROOT =~ ^0x[0-9a-f]{64}$ ]] || fail "could not read the state root of reth's block 0"
# The chain's genesis state root fixes the gateway contract's code, so whoever accepts the chain accepts that code: check that
# block 0 holds exactly the code in gateway/Gateway.bin-runtime at the gateway's address.
GATEWAY_CODE=$(rpc eth_getCode "\"$GATEWAY_ADDRESS\",\"0x0\"" | jq -r .result)
[ "$GATEWAY_CODE" = "0x$(tr -d '[:space:]' < "$ROOT/gateway/Gateway.bin-runtime")" ] || fail "reth's block 0 does not hold the gateway's code at $GATEWAY_ADDRESS"

step "the sidecars"
cargo build --release --locked --manifest-path "$ROOT/sidecar/Cargo.toml"
SIDECAR=$ROOT/sidecar/target/release/zk-sidecar
for port in 8085 8086; do
  background "sidecar-$port" "$SIDECAR" --program-vk "$PROGRAM_VK" --root-c "$ROOT_C" --listen "127.0.0.1:$port"
  for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$port/api/v1/version" >/dev/null && break; sleep 0.5; done
  curl -sf "http://127.0.0.1:$port/api/v1/version" >/dev/null || fail "the sidecar on $port does not answer"
done

step "the prover"
"$ROOT/prover/start.sh"

step "the builder's Python packages"
[ -x "$CZE_STATE_DIR/venv/bin/python3" ] || python3 -m venv "$CZE_STATE_DIR/venv"
"$CZE_STATE_DIR/venv/bin/pip" install --quiet --require-hashes -r "$ROOT/builder/requirements.txt"

step "Canton"
export CZE_DAR=$DAR
background canton java -Xmx"${CZE_CANTON_HEAP:-8g}" -jar "$CANTON_JAR" daemon -c "$ROOT/network/canton/canton.conf" \
  --bootstrap "$ROOT/network/canton/bootstrap.canton" --no-tty
for _ in $(seq 1 600); do
  grep -q "BOOTSTRAP DONE" "$NET/logs/canton.log" && break
  kill -0 "$(cat "$NET/canton.pid")" 2>/dev/null || { tail -n 30 "$NET/logs/canton.log" >&2; fail "Canton stopped"; }
  sleep 1
done
grep -q "BOOTSTRAP DONE" "$NET/logs/canton.log" || fail "Canton did not finish its bootstrap within ten minutes"

step "the chain: genesis $GENESIS_HASH, state root $GENESIS_STATE_ROOT"
python3 "$ROOT/network/canton/propose.py" --genesis-hash "${GENESIS_HASH#0x}" --genesis-state-root "${GENESIS_STATE_ROOT#0x}" --program-vk "$PROGRAM_VK" --root-c "$ROOT_C" \
  --rules-hash "$RULES_HASH" --gateway-address "${GATEWAY_ADDRESS#0x}" | tee "$NET/chain.json"
echo "== up ($(date -u +%T)); smoke test: network/smoke.sh"
