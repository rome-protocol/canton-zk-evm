#!/usr/bin/env bash
# The chain continues on a new Canton network (network/canton/propose.py anchor), on the real network: a reset of the Canton network, or a move to another one,
# without the EVM chain starting over. What is real: reth (network/reth/launch.sh, discovery off), Canton with the real Daml package, the real builder and the
# real sidecar for `legs`. What is not real: the zero-knowledge proof (a stand-in prover and a stand-in for the sidecar's proof check, as in
# tests/demo_registered_gateway.sh). Canton runs as a participant that exists before Ostia comes (tests/external_bootstrap.canton and
# network/external/setup.py, as on the Canton Network's DevNet and TestNet): one participant hosts the operator, the confirmer and the gateway, which is what
# the anchor needs. Every port is moved to a block of its own (CZE_ANCHOR_PORT_BASE, default 26000), so the test runs beside other networks on one machine.
# The block spans PB+1 to PB+202 (PB+202 is the mediator's admin port): two copies on one machine need bases at least 203 apart, and each its own reth container
# (RETH_CONTAINER, default cze-anchor-reth), because a container name is one per machine however the ports are moved.
# Steps, each checked:
#   1. network A: the chain proposed at block 0, an EVM contract deployed, EVM transfers, blocks 1 to N committed (reth's finalized block is N);
#      a block that reth imports and Canton never gets (the builder is killed while it waits for the proof) is left on reth, above its finalized block;
#   2. Canton is stopped and wiped (the nodes are in memory): a network B with new parties (none of the old ones), the package vetted again, and no chain;
#   3. refused anchors, each of which changes nothing on B: a head that is not reth's finalized block (the block above it, which reth has but is not final; the block
#      below it; a wrong hash; a number with another block's hash; a wrong state root), another chain id, a gas cap under the head block's gas limit, and the
#      operator's user without the confirmer's right (no --grant); later, a second anchor on a network that has the chain already;
#   4. the anchor at N with --dry-run (nothing is created), then for real (the right to act for the confirmer is given for the submission and taken back), and
#      the chain on B: head N, reth's hash and state root, the same chain id, keys, gas cap and gateway;
#   5. reth is moved back to N (sync_reth.py: the unfinalized block is dropped, its transaction sent again), block N+1 commits and is the child of block N,
#      then N+2; the contract deployed before the wipe and the balances are what they were; the explorer's view of the chain (reth) never went back.
# Needs Docker, Java 21, Rust, Python 3.12, jq, curl and network access. No GPU.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"
WORK=$(mktemp -d)
export CZE_STATE_DIR=$WORK/state CZE_DEMO_RESULTS=$WORK/results FAKE_LOG=$WORK/calls
NET=$CZE_STATE_DIR/net
umask 077
mkdir -p "$NET/logs" "$CZE_DEMO_RESULTS"
: > "$FAKE_LOG"
fail() { echo "FAIL: $*" >&2; exit 1; }

PB=${CZE_ANCHOR_PORT_BASE:-26000}
LEDGER=$((PB + 75)); CONFIRMER_LEDGER=$((PB + 76))
export RETH_HTTP_PORT=$((PB + 45)) RETH_WS_PORT=$((PB + 46)) RETH_ENGINE_PORT=$((PB + 51))
export RETH_CONTAINER=${RETH_CONTAINER:-cze-anchor-reth}
export CZE_LEDGER_URL=http://127.0.0.1:$LEDGER CZE_USER_PREFIX=ostia- CZE_LEDGER_NO_AUTH=1
# Canton's ports, moved: the sequencer, the mediator, each participant's admin, ledger and JSON API, and the two sidecars the participants call.
cat > "$WORK/ports.conf" <<CONF
canton.sequencers.sequencer1.public-api.port = $((PB + 1))
canton.sequencers.sequencer1.admin-api.port = $((PB + 2))
canton.mediators.mediator1.admin-api.port = $((PB + 202))
canton.participants.operator.admin-api.port = $((PB + 12))
canton.participants.operator.ledger-api.port = $((PB + 11))
canton.participants.operator.http-ledger-api.port = $LEDGER
canton.participants.operator.parameters.engine.extensions.canton-zk-evm.port = $((PB + 85))
canton.participants.confirmer.admin-api.port = $((PB + 22))
canton.participants.confirmer.ledger-api.port = $((PB + 21))
canton.participants.confirmer.http-ledger-api.port = $CONFIRMER_LEDGER
canton.participants.confirmer.parameters.engine.extensions.canton-zk-evm.port = $((PB + 86))
canton.participants.users.admin-api.port = $((PB + 32))
canton.participants.users.ledger-api.port = $((PB + 31))
canton.participants.users.http-ledger-api.port = $((PB + 77))
CONF

canton_pid=
pids=()
cleanup() {
  local status=$?
  if [ "$status" != 0 ]; then
    for log in canton-a canton-b; do
      echo "--- $log warnings and errors"; grep -E 'WARN|ERROR' "$NET/logs/$log.log" 2>/dev/null | cut -c1-500 | tail -n 25 || true
    done
    echo "--- reth log (tail)"; docker logs --tail 30 "$RETH_CONTAINER" 2>&1 || true
  fi
  for p in "${pids[@]}" $canton_pid; do kill "$p" 2>/dev/null || true; done
  "$ROOT/network/reth/stop.sh" || true
  rm -rf "$WORK"
}
trap cleanup EXIT
background() { local name=$1; shift; nohup "$@" > "$NET/logs/$name.log" 2>&1 < /dev/null & pids+=($!); }
rpc() { curl -sf -H 'content-type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":[${2:-}]}" "http://127.0.0.1:$RETH_HTTP_PORT"; }
is() { [ "$1" = "$2" ] || fail "$3: got $1, expected $2"; }
step() { echo "== $*"; }

step "the demo's packages, keys and funded genesis"
"$ROOT/demo/prepare.sh"
export CZE_GENESIS_FILE=$CZE_STATE_DIR/demo/genesis.json
PY=$CZE_STATE_DIR/venv/bin/python3
evm() { "$PY" "$ROOT/demo/evm.py" "$@"; }

step "reth, through launch.sh"
"$ROOT/network/reth/launch.sh"
for _ in $(seq 1 60); do rpc eth_chainId >/dev/null 2>&1 && break; sleep 1; done
rpc eth_chainId >/dev/null || fail "reth does not answer"
"$ROOT/network/reth/check.sh"
GENESIS_HASH=$(rpc eth_getBlockByNumber '"0x0",false' | jq -r .result.hash)
GENESIS_STATE_ROOT=$(rpc eth_getBlockByNumber '"0x0",false' | jq -r .result.stateRoot)

step "Canton tools and the chain's Daml package"
tools=$("$ROOT/network/canton/fetch.sh")
CANTON_JAR=$(sed -n 's/^CANTON_JAR=//p' <<<"$tools")
CZE_DAR=$("$ROOT/network/canton/build-dar.sh"); export CZE_DAR
"$ROOT/network/canton/dar-id.sh" "$CZE_DAR" > "$NET/dar.txt"

step "the sidecars: the real one for legs, the stand-in in front of it for verify/verify2"
VK=$(printf 'cd%.0s' $(seq 32)); RC=$(printf 'ef%.0s' $(seq 32)); RULES=$(printf '12%.0s' $(seq 32)); PROOF=$(printf 'ee%.0s' $(seq 768))$VK$RC
cargo build --release --locked --manifest-path "$ROOT/sidecar/Cargo.toml"
background real-sidecar "$ROOT/sidecar/target/release/zk-sidecar" --program-vk "$VK" --root-c "$RC" --zisk-release 1.4.0 --listen 127.0.0.1:$((PB + 95))
for port in $((PB + 85)) $((PB + 86)); do
  background "stand-in-$port" python3 "$ROOT/tests/demo_sidecar.py" "$port" $((PB + 95)) "$VK" "$RC" "$PROOF"
done
for _ in $(seq 1 30); do curl -sf "http://127.0.0.1:$((PB + 95))/api/v1/version" >/dev/null && break; sleep 1; done
sleep 2
export DEMO_PROOF_PROGRAM_VK=$VK DEMO_PROOF_ROOT_C=$RC
export CZE_MAKE_INPUT_CMD=$ROOT/builder/tests/fake-make-input.sh CZE_PROVE_CMD=$ROOT/tests/demo_fake_prove.sh

# A Canton network: the participant of tests/external_bootstrap.canton, then network/external/setup.py. Sets canton_pid.
start_canton() {   # <log name>
  nohup java -Xmx3g -jar "$CANTON_JAR" daemon -c "$ROOT/network/canton/canton.conf" -c "$WORK/ports.conf" --bootstrap "$ROOT/tests/external_bootstrap.canton" --no-tty \
    > "$NET/logs/$1.log" 2>&1 < /dev/null &
  canton_pid=$!
  for _ in $(seq 1 600); do
    grep -q "EXTERNAL PARTICIPANT READY" "$NET/logs/$1.log" && return 0
    kill -0 "$canton_pid" 2>/dev/null || fail "Canton stopped"
    sleep 1
  done
  fail "Canton did not come up"
}
setup() { python3 "$ROOT/network/external/setup.py" --ledger-url "$CZE_LEDGER_URL" --dar "$CZE_DAR" "$@" 2> "$WORK/setup.err" || { cat "$WORK/setup.err" >&2; return 1; }; }
parties() { sed -n "s/^$1=//p" "$CZE_STATE_DIR/canton/parties.env"; }
# The chain contract on the participant, as the builder reads it: one JSON line.
chain() {
  python3 - "$ROOT" "$CZE_STATE_DIR" "$CZE_LEDGER_URL" <<'PY'
import json, os, sys
sys.path.insert(0, sys.argv[1] + "/network/canton")
import propose
parties = propose.read_env_file(__import__("pathlib").Path(sys.argv[2]) / "canton" / "parties.env")
found = propose.operator_ledger(sys.argv[3], parties).active("ZkChain")
print(json.dumps(found[0] if found else None, sort_keys=True))
PY
}
build() {
  CZE_LEDGER_USER=ostia-builder CZE_BUILDER_PARTY=$(parties BUILDER_PARTY) CZE_FEE_RECIPIENT=0x0000000000000000000000000000000000000fee \
    "$PY" "$ROOT/builder/builder.py" once
}
# <what>: one builder run that must commit; its report is left in $OUT.
commit() {
  set +e; OUT=$(build); local status=$?; set -e
  echo "$OUT" | jq -c .
  is "$status" 0 "the builder's exit status for $1 ($OUT)"
  is "$(jq -r .committed <<<"$OUT")" true "$1 committed"
}
block_of() { rpc eth_getBlockByNumber "\"$1\",false" | jq -c .result; }   # <tag or hex number>
anchor() { python3 "$ROOT/network/canton/propose.py" anchor --program-vk "$VK" --root-c "$RC" --rules-hash "$RULES" "$@"; }
# <text the refusal must hold> <anchor arguments>: the anchor must stop, say that, and leave B without a chain.
refused() {
  local text=$1; shift
  set +e; local out; out=$(anchor "$@" 2>&1); local status=$?; set -e
  [ "$status" != 0 ] || fail "the anchor ($*) went through: $out"
  grep -qF -- "$text" <<<"$out" || fail "the anchor ($*) was refused, but not with '$text': $out"
  is "$(chain)" null "the chain on network B after the refused anchor ($*)"
}

step "network A: Canton, the participant's setup, and the chain at block 0"
start_canton canton-a
first=$(setup -- --genesis-hash "${GENESIS_HASH#0x}" --genesis-state-root "${GENESIS_STATE_ROOT#0x}" --program-vk "$VK" --root-c "$RC" --rules-hash "$RULES" --gateway-address "${GATEWAY_ADDRESS#0x}")
echo "$first" | jq -c .
is "$(jq -r '.created' <<<"$first")" true "the chain on network A is new"
A_OPERATOR=$(parties OPERATOR_PARTY)
GATEWAY=${GATEWAY_ADDRESS#0x}

step "blocks 1 to 3 on network A: V deploys TKA, then two transfers to U"
deploy_tx=$(evm deploy | jq -r .tx)
commit "block 1"
TOKEN=$(evm receipt "$deploy_tx" | jq -r .contract)
for i in 2 3; do evm transfer "$TOKEN" "$i" >/dev/null; commit "block $i"; is "$(jq -r .number <<<"$OUT")" "$i" "the number of block $i"; done
U_ADDR=$(jq -r .u "$CZE_STATE_DIR/demo/addresses.json")
is "$(evm balance "$TOKEN" "$U_ADDR" finalized | jq -r .tka)" 5 "U's TKA on network A"
N=3
FINAL=$(block_of finalized); N_HASH=$(jq -r .hash <<<"$FINAL"); N_ROOT=$(jq -r .stateRoot <<<"$FINAL")
is "$(jq -r .number <<<"$FINAL" | xargs printf '%d')" "$N" "reth's finalized block"
echo "head to carry over: block $N $N_HASH"

step "a block that reth imports and Canton never gets: the builder is killed while it waits for the proof, so reth keeps the block above the finalized one"
stuck_tx=$(evm transfer "$TOKEN" 1 | jq -r .tx)
printf '#!/usr/bin/env bash\nsleep 600\n' > "$WORK/hang-prove.sh"; chmod +x "$WORK/hang-prove.sh"
CZE_PROVE_CMD=$WORK/hang-prove.sh CZE_LEDGER_USER=ostia-builder CZE_BUILDER_PARTY=$(parties BUILDER_PARTY) CZE_FEE_RECIPIENT=0x0000000000000000000000000000000000000fee \
  setsid "$PY" "$ROOT/builder/builder.py" once > "$WORK/stuck.out" 2>&1 < /dev/null &
stuck_builder=$!
LATEST_NUMBER=$N
for _ in $(seq 1 120); do
  LATEST_NUMBER=$(rpc eth_blockNumber | jq -r .result | xargs printf '%d')
  [ "$LATEST_NUMBER" -gt "$N" ] && break
  sleep 0.5
done
kill -9 -- "-$stuck_builder" 2>/dev/null || kill -9 "$stuck_builder" 2>/dev/null || true
pkill -f "$WORK/hang-prove.sh" || true
wait "$stuck_builder" 2>/dev/null || true
is "$LATEST_NUMBER" "$((N + 1))" "reth's latest block, imported by the builder that was killed before its proof"
is "$(jq -r .number <<<"$(block_of finalized)" | xargs printf '%d')" "$N" "reth's finalized block after the block that did not commit"
echo "reth's latest block is $LATEST_NUMBER, its finalized block $N"

step "Canton is stopped and wiped: network B, with new parties"
kill "$canton_pid"; wait "$canton_pid" 2>/dev/null || true
for _ in $(seq 1 30); do curl -s -o /dev/null "$CZE_LEDGER_URL/v2/version" || break; sleep 1; done
curl -s -o /dev/null "$CZE_LEDGER_URL/v2/version" && fail "Canton A still answers"
cp "$CZE_STATE_DIR/canton/parties.env" "$WORK/parties-a.env"
start_canton canton-b
setup | jq -c .
B_OPERATOR=$(parties OPERATOR_PARTY)
[ "$B_OPERATOR" != "$A_OPERATOR" ] || fail "network B has the old operator party"
for name in OPERATOR CONFIRMER GATEWAY BUILDER READER; do
  ! grep -qF "$(sed -n "s/^${name}_PARTY=//p" "$WORK/parties-a.env")" "$CZE_STATE_DIR/canton/parties.env" || fail "network B has the old $name party"
done
is "$(chain)" null "the chain on network B before the anchor"

step "refused anchors: each stops before it submits, and leaves network B without a chain"
OTHER=$(block_of "0x$(printf '%x' $((N - 1)))")
ABOVE=$(block_of latest)
refused "is not chain 1" --chain-id 1 --head-number "$N" --head-hash "${N_HASH#0x}" --gas-cap "$GAS_CAP"
refused "above reth's finalized block" --head-number "$LATEST_NUMBER" --head-hash "$(jq -r .hash <<<"$ABOVE" | sed 's/^0x//')" --gas-cap "$GAS_CAP"
refused "below reth's finalized block" --head-number "$((N - 1))" --head-hash "$(jq -r .hash <<<"$OTHER" | sed 's/^0x//')" --gas-cap "$GAS_CAP"
refused "does not have a block with that hash" --head-number "$N" --head-hash "$(printf 'ab%.0s' $(seq 32))" --gas-cap "$GAS_CAP"
refused "not $N" --head-number "$N" --head-hash "$(jq -r .hash <<<"$OTHER" | sed 's/^0x//')" --gas-cap "$GAS_CAP"
refused "state root" --head-number "$N" --head-hash "${N_HASH#0x}" --head-state-root "$(printf '77%.0s' $(seq 32))" --gas-cap "$GAS_CAP"
refused "gas limit" --head-number "$N" --head-hash "${N_HASH#0x}" --gas-cap 1000000
refused "cannot act for" --head-number "$N" --head-hash "${N_HASH#0x}" --gas-cap "$GAS_CAP"
refused "required: --gas-cap" --head-number "$N" --head-hash "${N_HASH#0x}"

step "the anchor at block $N: a dry run first, then for real"
dry=$(anchor --head-number "$N" --head-hash "${N_HASH#0x}" --gas-cap "$GAS_CAP" --dry-run 2> "$WORK/anchor.err")
echo "$dry" | jq -c 'del(.next)'
is "$(jq -r .submitted <<<"$dry")" false "the dry run submitted"
is "$(jq -r .headStateRoot <<<"$dry")" "${N_ROOT#0x}" "the state root the anchor read from reth"
is "$(chain)" null "the chain on network B after the dry run"
done_json=$(anchor --head-number "$N" --head-hash "${N_HASH#0x}" --head-state-root "${N_ROOT#0x}" --gas-cap "$GAS_CAP" --grant 2> "$WORK/anchor.err")
echo "$done_json" | jq -c 'del(.next)'
cat "$WORK/anchor.err"
is "$(jq -r .submitted <<<"$done_json")" true "the anchor submitted"
is "$(jq -r .actingRightsRevoked <<<"$done_json")" true "the anchor's report that the granted right was taken away"
grep -q "Register on this network next" "$WORK/anchor.err" || fail "the anchor did not print what to register next"
# reth's latest block is above the head here (the block that was imported and never committed): the list must say to run sync_reth.py, and that the old builder stays off.
grep -q "network/sync_reth.py" "$WORK/anchor.err" || fail "the list of what to do next does not say to run sync_reth.py before the builder"
grep -q "old network's builder must stay stopped" "$WORK/anchor.err" || fail "the list of what to do next does not say that the old network's builder stays stopped"
for word in token vault twin; do grep -q "$word" "$WORK/anchor.err" || fail "the list of what to register next lacks the $word"; done
is "$(jq -r .rethLatest <<<"$done_json")" "$LATEST_NUMBER" "reth's latest block, as the anchor reports it"
c=$(chain)
is "$(jq -r '[.chainId, .headNumber, .headHash, .headStateRoot, .programVK, .rootC, .rulesHash, .gasCap, .gatewayAddress] | join(" ")' <<<"$c")" \
   "$CHAIN_ID $N ${N_HASH#0x} ${N_ROOT#0x} $VK $RC $RULES $GAS_CAP $GATEWAY" "the chain on network B"
is "$(jq -r '[.operator, .confirmer, .gateway, .builder, .reader] | join(" ")' <<<"$c")" \
   "$B_OPERATOR $(parties CONFIRMER_PARTY) $(parties GATEWAY_PARTY) $(parties BUILDER_PARTY) $(parties READER_PARTY)" "the chain's parties are network B's"
is "$(jq -c '[.changeDelay, .contracts, .twins, .withdrawalQuota]' <<<"$c")" '[null,null,null,null]' "the optional fields of the chain"
# The right to act for the confirmer was given for the one submission and is gone: the same user cannot act for it now.
rights=$(curl -sf "$CZE_LEDGER_URL/v2/users/ostia-operator/rights" | jq -c '[.rights[].kind.CanActAs.value.party] | sort')
is "$rights" "$(jq -cn --arg o "$B_OPERATOR" --arg g "$(parties GATEWAY_PARTY)" '[$o, $g] | sort')" "the rights of the operator's user after the anchor"
set +e; again=$(anchor --head-number "$N" --head-hash "${N_HASH#0x}" --gas-cap "$GAS_CAP" --grant 2>&1); again_status=$?; set -e
[ "$again_status" != 0 ] || fail "a second anchor went through on a network that has the chain: $again"
grep -qF "already exists" <<<"$again" || fail "the second anchor was refused, but not because the chain is there: $again"
is "$(jq -r .headNumber <<<"$(chain)")" "$N" "the chain's head after the second anchor"

step "the builder on network B: reth moves back to block $N, block $((N + 1)) commits as its child, then $((N + 2))"
# The builder moves reth to Canton's head before it builds (network/sync_reth.py does this for a restart); the stuck block's transaction is sent again.
CZE_LEDGER_USER=ostia-builder CZE_BUILDER_PARTY=$(parties BUILDER_PARTY) CZE_FEE_RECIPIENT=0x0000000000000000000000000000000000000fee \
  "$PY" "$ROOT/network/sync_reth.py" | tee "$WORK/sync.out"
is "$(sed -n 's/^canton_head=//p' "$WORK/sync.out")" "$N" "the head sync_reth sees on network B"
is "$(sed -n 's/^reth_latest=//p' "$WORK/sync.out")" "$N" "reth's latest block after the move back"
commit "block $((N + 1))"
is "$(jq -r .number <<<"$OUT")" "$((N + 1))" "the number of the first block on network B"
is "$(jq -c .transactions <<<"$OUT")" "[\"$stuck_tx\"]" "the transaction that was stuck is in the first block on network B"
child=$(block_of "0x$(printf '%x' $((N + 1)))")
is "$(jq -r .parentHash <<<"$child")" "$N_HASH" "block $((N + 1))'s parent"
is "$(jq -r .hash <<<"$(block_of "0x$(printf '%x' $N)")")" "$N_HASH" "block $N after the move"
is "$(jq -c '[.headNumber, .headHash]' <<<"$(chain)")" "[\"$((N + 1))\",\"$(jq -r .hash <<<"$child" | sed 's/^0x//')\"]" "Canton's head"
is "$(jq -r .hash <<<"$(block_of finalized)")" "$(jq -r .hash <<<"$child")" "reth's finalized block"
evm transfer "$TOKEN" 2 >/dev/null
commit "block $((N + 2))"
is "$(jq -r .number <<<"$OUT")" "$((N + 2))" "the number of the second block on network B"
is "$(jq -r .parentHash <<<"$(block_of finalized)")" "$(jq -r .hash <<<"$child")" "block $((N + 2))'s parent"
is "$(evm receipt "$deploy_tx" | jq -r .contract)" "$TOKEN" "the contract deployed on network A"
is "$(evm balance "$TOKEN" "$U_ADDR" finalized | jq -r .tka)" 8 "U's TKA at the end (5 before the wipe, 1 and 2 after)"
is "$(rpc eth_chainId | jq -r .result)" "$(printf '0x%x' "$CHAIN_ID")" "the chain id"

echo "ok: the chain at block $N was anchored on a new network, and blocks $((N + 1)) and $((N + 2)) committed on it"
