#!/usr/bin/env bash
# A second gateway, registered in the chain's registry (Daml 0.5.0, `ZkChain.contracts`), on the real network: the builder sends its proofs in
# `extraGateways` and Canton accepts them. What is real: reth (network/reth/launch.sh, discovery off), Canton with the real Daml package, the real builder
# and the real sidecar for `legs`. What is not real: the zero-knowledge proof (a stand-in prover and a stand-in for the sidecar's proof check, as in
# tests/demo_otc.sh). The second gateway is the reviewed runtime code (gateway/Gateway.bin-runtime) in reth's genesis at a second address, so the real
# account proof of its `legs[number]` slot ends in its real code hash.
# Steps, each checked: a block under a registry with no entry (the Advance leaves `extraGateways` out); the operator proposes the Gateway entry and the
# confirmer accepts it (network/external/setup.py --contract-step; both read the code at the address from reth); a block with no leg under the entry (the
# Advance carries the second gateway's proofs and no leg); a payment through the second gateway (V pays U 10 TKA through it, and U's 10 TKB go to V),
# which commits with the leg settled on Canton.
# Needs Docker, Java 21, Rust, Python 3, jq, curl and network access. No GPU.
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
pids=()
cleanup() {
  local status=$?
  if [ "$status" != 0 ]; then
    echo "--- Canton warnings and errors"; grep -E 'WARN|ERROR' "$NET/logs/canton.log" 2>/dev/null | cut -c1-700 | tail -n 40 || true
    echo "--- Canton log (tail)"; tail -n 30 "$NET/logs/canton.log" 2>/dev/null || true
    echo "--- reth log (tail)"; docker logs --tail 30 "${RETH_CONTAINER:-cze-reth}" 2>&1 || true
  fi
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  "$ROOT/network/reth/stop.sh" || true
  rm -rf "$WORK"
}
trap cleanup EXIT
background() { local name=$1; shift; nohup "$@" > "$NET/logs/$name.log" 2>&1 < /dev/null & pids+=($!); }
rpc() { curl -sf -H 'content-type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":[${2:-}]}" "http://127.0.0.1:${RETH_HTTP_PORT:-8545}"; }
is() { [ "$1" = "$2" ] || fail "$3: got $1, expected $2"; }
step() { echo "== $*"; }

step "the demo's packages, keys and funded genesis"
"$ROOT/demo/prepare.sh"
export CZE_GENESIS_FILE=$CZE_STATE_DIR/demo/genesis.json
# The second gateway: the same runtime code as the first, at another address, in the genesis (nonce 1, no balance, no storage).
G2=b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8
export CZE_DEMO_GATEWAY_ADDRESS=0x$G2   # demo/evm.py sends register, claim, withdraw, approve-to-gateway and pay here
G2_CODE=0x$(tr -d '[:space:]' < "$ROOT/gateway/Gateway.bin-runtime")
jq --arg a "0x$G2" --arg c "$G2_CODE" '.alloc[$a] = {balance: "0x0", nonce: "0x1", code: $c}' "$CZE_GENESIS_FILE" > "$WORK/genesis2.json"
cat "$WORK/genesis2.json" > "$CZE_GENESIS_FILE"

step "reth, through launch.sh"
"$ROOT/network/reth/launch.sh"
for _ in $(seq 1 60); do rpc eth_chainId >/dev/null 2>&1 && break; sleep 1; done
rpc eth_chainId >/dev/null || fail "reth does not answer"
"$ROOT/network/reth/check.sh"
GENESIS_HASH=$(rpc eth_getBlockByNumber '"0x0",false' | jq -r .result.hash)
GENESIS_STATE_ROOT=$(rpc eth_getBlockByNumber '"0x0",false' | jq -r .result.stateRoot)
is "$(rpc eth_getCode "\"0x$G2\",\"0x0\"" | jq -r .result)" "$G2_CODE" "the code at the second gateway's address in block 0"

step "Canton tools and the chain's Daml package"
tools=$("$ROOT/network/canton/fetch.sh")
CANTON_JAR=$(sed -n 's/^CANTON_JAR=//p' <<<"$tools")
CZE_DAR=$("$ROOT/network/canton/build-dar.sh"); export CZE_DAR
"$ROOT/network/canton/dar-id.sh" "$CZE_DAR" > "$NET/dar.txt"

step "the sidecars: the real one for legs, the stand-in in front of it for verify/verify2"
VK=$(printf 'cd%.0s' $(seq 32)); RC=$(printf 'ef%.0s' $(seq 32)); PROOF=$(printf 'ee%.0s' $(seq 768))$VK$RC
cargo build --release --locked --manifest-path "$ROOT/sidecar/Cargo.toml"
background real-sidecar "$ROOT/sidecar/target/release/zk-sidecar" --program-vk "$VK" --root-c "$RC" --listen 127.0.0.1:9085
for port in 8085 8086; do
  background "stand-in-$port" python3 "$ROOT/tests/demo_sidecar.py" "$port" 9085 "$VK" "$RC" "$PROOF"
done
sleep 2
for _ in $(seq 1 30); do curl -sf http://127.0.0.1:9085/api/v1/version >/dev/null && break; sleep 1; done

step "Canton"
background canton java -Xmx3g -jar "$CANTON_JAR" daemon -c "$ROOT/network/canton/canton.conf" --bootstrap "$ROOT/network/canton/bootstrap.canton" --no-tty
for _ in $(seq 1 600); do
  grep -q "BOOTSTRAP DONE" "$NET/logs/canton.log" && break
  kill -0 "${pids[-1]}" 2>/dev/null || fail "Canton stopped"
  sleep 1
done
grep -q "BOOTSTRAP DONE" "$NET/logs/canton.log" || fail "the bootstrap did not finish"
python3 "$ROOT/network/canton/propose.py" --genesis-hash "${GENESIS_HASH#0x}" --genesis-state-root "${GENESIS_STATE_ROOT#0x}" --program-vk "$VK" --root-c "$RC" --rules-hash "$(printf '12%.0s' $(seq 32))" | tee "$NET/chain.json"
printf 'elf_sha256=%s\nprogramVK=0x%s\nrootC=0x%s\nrulesHash=%s\n' "$(printf '00%.0s' $(seq 32))" "$VK" "$RC" "$(printf '12%.0s' $(seq 32))" > "$NET/guest.txt"

# shellcheck disable=SC1091
. "$CZE_STATE_DIR/canton/parties.env"
PY=$CZE_STATE_DIR/venv/bin/python3
DEMO=$CZE_STATE_DIR/demo
export DEMO_PROOF_PROGRAM_VK=$VK DEMO_PROOF_ROOT_C=$RC
export CZE_MAKE_INPUT_CMD=$ROOT/builder/tests/fake-make-input.sh CZE_PROVE_CMD=$ROOT/tests/demo_fake_prove.sh
evm() { "$PY" "$ROOT/demo/evm.py" "$@"; }
canton() { "$PY" "$ROOT/demo/canton.py" "$@"; }
# One builder run. Prints its JSON line; the exit status is the builder's (0 committed, 2 refused).
build() {
  CZE_LEDGER_USER=builder CZE_BUILDER_PARTY=$BUILDER_PARTY CZE_FEE_RECIPIENT=0x0000000000000000000000000000000000000fee \
    "$PY" "$ROOT/builder/builder.py" once --read-as "$OPERATOR_PARTY" --read-as "$GATEWAY_PARTY" --disclosed "$DEMO/disclosed.json"
}
# <what>: one builder run that must commit; its report is left in $OUT.
commit() {
  set +e; OUT=$(build); local status=$?; set -e
  echo "$OUT" | jq -c .
  is "$status" 0 "the builder's exit status for $1 ($OUT)"
  is "$(jq -r .committed <<<"$OUT")" true "$1 committed"
}
advance_of() { cat "$CZE_STATE_DIR/builder/block-$1/advance.json"; }   # <block number>: the argument as it was sent
totals() { jq -c '{u: (.tkb.u | add // 0), v: (.tkb.v | add // 0), gateway: (.custody | add // 0)}' <<<"$1"; }
tka() { evm balance "$TOKEN" "$1" finalized | jq -r .tka; }
head_of() { canton status | jq -r '.chain[0].headNumber'; }
# <participant port> <setup.py arguments>: network/external/setup.py on a participant that has no login here
setup_on() {
  local port=$1; shift
  CZE_LEDGER_NO_AUTH=1 python3 "$ROOT/network/external/setup.py" --ledger-url "http://127.0.0.1:$port" "$@" --reth-url "http://127.0.0.1:${RETH_HTTP_PORT:-8545}" 2> "$WORK/setup.err" \
    || { cat "$WORK/setup.err" >&2; return 1; }
}
V_ADDR=$(jq -r .v "$DEMO/addresses.json"); U_ADDR=$(jq -r .u "$DEMO/addresses.json")

step "the token rules and U's TKB on Canton"
canton upload-dars
canton setup | jq -c .
is "$(totals "$(canton status)")" '{"u":100,"v":0,"gateway":0}' "what Canton holds at the start"

step "a block under a registry with no entry: V deploys TKA; the Advance has no extraGateways (a package before 0.5.0 takes it)"
n1=$(( $(head_of) + 1 ))
deploy_tx=$(evm deploy | jq -r .tx)
commit "the first block"
is "$(jq -r .number <<<"$OUT")" "$n1" "the first block's number"
is "$(jq -r .legs <<<"$OUT")" 0 "the first block's legs"
is "$(advance_of "$n1" | jq 'has("extraGateways")')" false "extraGateways in the Advance of the first block"
TOKEN=$(evm receipt "$deploy_tx" | jq -r .contract)
is "$(evm receipt "$deploy_tx" | jq -r .status)" 1 "the deployment's status"

step "the Gateway entry for the second gateway: the operator proposes, the confirmer accepts (both read its code from reth)"
r=$(setup_on 7575 --contract-step propose --contract-address "$G2" --contract-kind gateway --dry-run); jq -e '.submitted == false' <<<"$r" >/dev/null || fail "the dry run of the proposal: $r"
r=$(setup_on 7575 --contract-step propose --contract-address "$G2" --contract-kind gateway); echo "$r" | jq -c .
jq -e '.submitted == true' <<<"$r" >/dev/null || fail "the proposal: $r"
r=""
for _ in $(seq 1 60); do   # the proposal reaches the confirmer's participant a moment after the operator's commit
  if r=$(setup_on 7576 --contract-step accept --contract-address "$G2" --contract-kind gateway 2>/dev/null); then break; fi
  r=""; sleep 1
done
[ -n "$r" ] || { cat "$WORK/setup.err" >&2; fail "the acceptance of the Gateway entry"; }
echo "$r" | jq -c .
jq -e '.submitted == true' <<<"$r" >/dev/null || fail "the acceptance: $r"

step "a block with no leg under the entry: V sends U 1 TKA; the Advance carries the second gateway's proofs and no leg"
n2=$(( $(head_of) + 1 ))
plain_tx=$(evm transfer "$TOKEN" 1 | jq -r .tx)
commit "the block under the entry"
is "$(jq -r .number <<<"$OUT")" "$n2" "the block's number"
is "$(jq -r .legs <<<"$OUT")" 0 "the block's legs"
is "$(jq -c .transactions <<<"$OUT")" "[\"$plain_tx\"]" "the block's transactions"
is "$(advance_of "$n2" | jq -c '[.extraGateways[] | {address, legs: (.legs | length), nodes: ((.accountNodes | length) > 0 and (.storageNodes | length) > 0)}]')" "[{\"address\":\"$G2\",\"legs\":0,\"nodes\":true}]" "the second gateway's entry in the Advance"
is "$(head_of)" "$n2" "Canton's head"

step "a payment through the second gateway: V pays U 10 TKA, and U's 10 TKB go to V"
tka_u_before=$(tka "$U_ADDR"); tka_v_before=$(tka "$V_ADDR")
dvp=$(canton dvp dvp-1 "$TOKEN" "$U_ADDR" 10)
echo "$dvp" | jq -c .
payment=$(jq -r .id <<<"$dvp")
approve_tx=$(evm approve v "$TOKEN" gateway 10 | jq -r .tx)
pay_tx=$(evm pay v "$payment" "$TOKEN" "$U_ADDR" 10 | jq -r .tx)
n3=$(( $(head_of) + 1 ))
is "$(totals "$(canton status)")" '{"u":90,"v":0,"gateway":0}' "TKB after U's allocation to V"
commit "the payment's block"
is "$(jq -r .number <<<"$OUT")" "$n3" "the payment's block number"
is "$(jq -r .legs <<<"$OUT")" 1 "the payment's block's legs"
is "$(jq -c .legTransactions <<<"$OUT")" "[\"$pay_tx\"]" "the leg transactions"
is "$(jq -c .leftOut <<<"$OUT")" '[]' "the left-out transactions"
is "$(advance_of "$n3" | jq -c '[.extraGateways[] | {address, legs: (.legs | length)}]')" "[{\"address\":\"$G2\",\"legs\":1}]" "the leg is the second gateway's"
is "$(advance_of "$n3" | jq '.legs | length')" 0 "the first gateway's legs"
is "$(head_of)" "$n3" "Canton's head after the payment"
is "$(totals "$(canton status)")" '{"u":90,"v":10,"gateway":0}' "TKB after the payment (U's allocation is now V's holding)"
is "$(tka "$U_ADDR")" $((tka_u_before + 10)) "U's TKA after the payment"
is "$(tka "$V_ADDR")" $((tka_v_before - 10)) "V's TKA after the payment"
for tx in "$approve_tx" "$pay_tx"; do is "$(evm receipt "$tx" | jq -r .status)" 1 "the status of $tx"; done

echo "ok: the second gateway was registered, and blocks with and without its legs committed"
