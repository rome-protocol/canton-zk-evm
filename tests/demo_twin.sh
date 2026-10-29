#!/usr/bin/env bash
# The Canton twins of ERC-20 tokens (apps/twin, demo/twin.py), run end to end on the local network without a GPU: an ERC-20 is locked in a vault on Ostia and
# its twin is minted on Canton, the twin is sent from one party to another, and it is redeemed for the ERC-20. What is real: reth (network/reth/launch.sh,
# discovery off), Canton with the real Daml package, the twin app's package and the real token standard, the real twin registry service (apps/twin/registry,
# on loopback), the real builder (started with --twin-registry-url) and the real sidecar for `legs`. What is not real: the zero-knowledge proof (a stand-in
# prover and a stand-in for the sidecar's proof check, as in tests/demo_otc.sh).
# Setup, each checked: TKA and a second ERC-20 (TKA2, which gets no twin), the vault (twin.py deploy-vault) and its entry in the chain's registry (the operator
# proposes, the confirmer accepts: network/external/setup.py --contract-step), the TwinRules of TKA (twin.py rules, disclosed) and the pinned twin (--twin-step
# propose and accept), the registry service and the builder.
# (a) U locks 5 TKA for itself and the twin of 5 is minted (the twin's supply is the vault's balance), U sends V 2 twin, V redeems the 2 and the vault pays
# them to V's address, the twin burns (supply and vault balance are 3 again).
# (b) Two payments into the vault that the builder leaves out, each with no twin minted: one of an ERC-20 that has no twin (TKA2, with parts announced), one
# of TKA against an id whose parts were never announced to the registry service.
# Not covered: Canton Coin (its choice context comes from a validator's scan proxy, which the local network does not have).
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
    for log in builder registry; do echo "--- $log log (tail)"; tail -n 30 "$NET/logs/$log.log" 2>/dev/null || true; done
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

step "reth, through launch.sh"
"$ROOT/network/reth/launch.sh"
for _ in $(seq 1 60); do rpc eth_chainId >/dev/null 2>&1 && break; sleep 1; done
rpc eth_chainId >/dev/null || fail "reth does not answer"
"$ROOT/network/reth/check.sh"
GENESIS_HASH=$(rpc eth_getBlockByNumber '"0x0",false' | jq -r .result.hash)
GENESIS_STATE_ROOT=$(rpc eth_getBlockByNumber '"0x0",false' | jq -r .result.stateRoot)

step "Canton tools, the chain's Daml package and the twin app's package"
tools=$("$ROOT/network/canton/fetch.sh")
CANTON_JAR=$(sed -n 's/^CANTON_JAR=//p' <<<"$tools")
CZE_DAR=$("$ROOT/network/canton/build-dar.sh"); export CZE_DAR
"$ROOT/network/canton/dar-id.sh" "$CZE_DAR" > "$NET/dar.txt"
TOOLS=${CZE_TOOLS_DIR:-$CZE_STATE_DIR/tools}
(export DPM_HOME=$TOOLS/dpm DPM_REGISTRY PATH="$TOOLS/bin:$PATH" SDK_VERSION=$DAML_SDK_VERSION TARGET=$DAML_TARGET; "$ROOT/apps/twin/build.sh" >&2)
TWIN_DAR=$ROOT/apps/twin/dist/ostia-twin.dar
[ -s "$TWIN_DAR" ] || fail "the twin app's DAR was not built"

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
REGISTRY_PORT=8090
REGISTRY_URL=http://127.0.0.1:$REGISTRY_PORT
evm() { "$PY" "$ROOT/demo/evm.py" "$@"; }
canton() { "$PY" "$ROOT/demo/canton.py" "$@"; }
twin() { "$PY" "$ROOT/demo/twin.py" "$@"; }
# The builder's arguments, for `run` (a block producer in the background, while twin.py waits for Canton) and for `once` (one block, by hand, which prints its
# JSON line; the exit status is the builder's: 0 committed or skipped, 2 refused).
builder_args=(--read-as "$OPERATOR_PARTY" --read-as "$GATEWAY_PARTY" --disclosed "$DEMO/disclosed.json" --twin-registry-url "$REGISTRY_URL")
builder_env() {
  env CZE_LEDGER_USER=builder CZE_BUILDER_PARTY="$BUILDER_PARTY" CZE_FEE_RECIPIENT=0x0000000000000000000000000000000000000fee "$@"
}
build() { builder_env "$PY" "$ROOT/builder/builder.py" once "${builder_args[@]}"; }
# <what>: one builder run that must commit; its report is left in $OUT.
commit() {
  set +e; OUT=$(build); local status=$?; set -e
  echo "$OUT" | jq -c .
  is "$status" 0 "the builder's exit status for $1 ($OUT)"
  is "$(jq -r .committed <<<"$OUT")" true "$1 committed"
}
# <participant port> <setup.py arguments>: network/external/setup.py on a participant that has no login here
setup_on() {
  local port=$1; shift
  CZE_LEDGER_NO_AUTH=1 python3 "$ROOT/network/external/setup.py" --ledger-url "http://127.0.0.1:$port" "$@" --reth-url "http://127.0.0.1:${RETH_HTTP_PORT:-8545}" 2> "$WORK/setup.err" \
    || { cat "$WORK/setup.err" >&2; return 1; }
}
# <what> <setup.py arguments>: the operator proposes, the confirmer accepts (the proposal reaches the confirmer's participant a moment after the operator's commit)
propose_accept() {
  local what=$1 kind=$2; shift 2
  local r
  r=$(setup_on 7575 "--$kind-step" propose "$@") || fail "the proposal of $what"
  echo "$r" | jq -c .
  jq -e '.submitted == true' <<<"$r" >/dev/null || fail "the proposal of $what: $r"
  r=""
  for _ in $(seq 1 60); do
    if r=$(setup_on 7576 "--$kind-step" accept "$@" ${ACCEPT_EXTRA[@]+"${ACCEPT_EXTRA[@]}"} 2>/dev/null); then break; fi
    r=""; sleep 1
  done
  [ -n "$r" ] || { cat "$WORK/setup.err" >&2; fail "the acceptance of $what"; }
  echo "$r" | jq -c .
  jq -e '.submitted == true' <<<"$r" >/dev/null || fail "the acceptance of $what: $r"
}
# <token>: U's and V's twin of the token, the twin's supply and the vaults' balance (twin.py balances)
twin_of() { twin balances "$1" u v | jq -c .; }
# <balances JSON> <u's twin> <v's twin> <supply> <what>: what twin.py balances shows, and that the supply is what the vaults hold
expect_twin() {
  jq -e --argjson u "$2" --argjson v "$3" --argjson s "$4" \
    '(.holders.u.amount | tonumber) == $u and (.holders.v.amount | tonumber) == $v and (.supply | tonumber) == $s and (.vaultsTotal | tonumber) == $s and .supplyMatches == true' <<<"$1" >/dev/null \
    || fail "$5: the twin is not as expected (U $2, V $3, supply $4, equal to the vaults' balance): $1"
}
tka_of() { evm balance "$1" "$2" finalized | jq -r .tka; }   # <token> <address>
V_ADDR=$(jq -r .v "$DEMO/addresses.json"); U_ADDR=$(jq -r .u "$DEMO/addresses.json")

step "the token rules on Canton, the twin app's package on all three participants, and the twin registry service (loopback, a read token file, a parts state file)"
canton upload-dars
canton setup | jq -c .
for port in 7575 7576 7577; do
  curl -sf -X POST -H 'content-type: application/octet-stream' --data-binary @"$TWIN_DAR" "http://127.0.0.1:$port/v2/packages?vetAllPackages=true&synchronizeVetting=true" >/dev/null \
    || fail "uploading the twin app's package to the participant on port $port"
done
# The local network runs without Ledger API authentication, so its participants take any token; the file is what the service reads its token from.
printf 'local-network-no-auth\n' > "$WORK/read.token"
CHAIN_ID=$(evm chain | jq -r .chainId)
background registry python3 "$ROOT/apps/twin/registry/registry.py" --ledger-url http://127.0.0.1:7575 --admin "$GATEWAY_PARTY" --ostia-rpc "http://127.0.0.1:${RETH_HTTP_PORT:-8545}" \
  --chain-id "$CHAIN_ID" --state-file "$WORK/parts.jsonl" --token-file "$WORK/read.token" --listen "127.0.0.1:$REGISTRY_PORT"
for _ in $(seq 1 30); do curl -sf "$REGISTRY_URL/healthz" >/dev/null && break; kill -0 "${pids[-1]}" 2>/dev/null || fail "the registry service stopped"; sleep 1; done
curl -s "$REGISTRY_URL/healthz" | jq -c .
curl -sf -o /dev/null "$REGISTRY_URL/registry/metadata/v1/info" || fail "the registry service does not answer"

step "the builder, as a block producer in the background (--twin-registry-url)"
background builder env CZE_LEDGER_USER=builder CZE_BUILDER_PARTY="$BUILDER_PARTY" CZE_FEE_RECIPIENT=0x0000000000000000000000000000000000000fee \
  "$PY" "$ROOT/builder/builder.py" run "${builder_args[@]}" --idle-ms 500
BUILDER_PID=${pids[-1]}
alive() { kill -0 "$BUILDER_PID" 2>/dev/null || fail "the builder stopped"; }

step "TKA (1,000 to V) and a second ERC-20 with no twin (TKA2), V sends U 100 TKA; the vault (U) is made on Ostia"
deploy_tx=$(evm deploy | jq -r .tx)
deploy2_tx=$(evm deploy | jq -r .tx)
TOKEN=$(evm wait "$deploy_tx" >/dev/null && evm receipt "$deploy_tx" | jq -r .contract)
TOKEN2=$(evm wait "$deploy2_tx" >/dev/null && evm receipt "$deploy2_tx" | jq -r .contract)
[[ $TOKEN =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "no TKA address: $TOKEN"
[[ $TOKEN2 =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "no TKA2 address: $TOKEN2"
[ "$TOKEN" != "$TOKEN2" ] || fail "the two ERC-20s are one contract"
give_tx=$(evm transfer "$TOKEN" 100 | jq -r .tx)
vault=$(twin deploy-vault); echo "$vault" | jq -c .
VAULT=$(jq -r .address <<<"$vault")
[[ $VAULT =~ ^0x[0-9a-f]{40}$ ]] || fail "no vault address: $vault"
evm wait "$(jq -r .tx <<<"$vault")" >/dev/null
evm wait "$give_tx" >/dev/null
is "$(tka_of "$TOKEN" "$U_ADDR")" 100 "U's TKA"
alive

step "the vault's entry in the chain's registry: the operator proposes, the confirmer accepts"
ACCEPT_EXTRA=()
propose_accept "the vault entry" contract --contract-address "${VAULT#0x}" --contract-kind vault

step "the twin of TKA: its TwinRules, as a disclosed contract, and the pinned twin (propose, accept)"
rules=$(twin rules "$TOKEN"); echo "$rules" | jq -c .
RULES_CID=$(jq -r .contractId <<<"$rules"); RULES_DECIMALS=$(jq -r .decimals <<<"$rules")
is "$(jq -r .instrument <<<"$rules")" "erc20:${TOKEN#0x}" "the twin's instrument"
twin disclosed "$TOKEN" "$WORK/twin-rules.json" | jq -c .
ACCEPT_EXTRA=(--twin-rules-disclosed "$WORK/twin-rules.json")
propose_accept "the twin of TKA" twin --twin-token "${TOKEN#0x}" --twin-decimals "$RULES_DECIMALS" --twin-rules "$RULES_CID"
ACCEPT_EXTRA=()
for _ in $(seq 1 30); do curl -sf "$REGISTRY_URL/healthz" | jq -e '.ok == true and .twins == 1' >/dev/null && break; sleep 1; done
curl -sf "$REGISTRY_URL/healthz" | jq -e '.ok == true and .twins == 1' >/dev/null || fail "the registry service does not show one twin: $(curl -s "$REGISTRY_URL/healthz")"
alive

step "(a) U locks 5 TKA for itself: the twin of 5 is minted to U"
tka_u_before=$(tka_of "$TOKEN" "$U_ADDR"); tka_v_before=$(tka_of "$TOKEN" "$V_ADDR")
locked=$(twin lock u "$TOKEN" 5 u lock-1 --registry-url "$REGISTRY_URL"); echo "$locked" | jq -c .
is "$(jq -r .vault <<<"$locked")" "$VAULT" "the vault the lock went to"
jq -e '(.amount | tonumber) == 5' <<<"$locked" >/dev/null || fail "the amount of the minted holding: $(jq -r .amount <<<"$locked")"
expect_twin "$(twin_of "$TOKEN")" 5 0 5 "after the lock"
is "$(tka_of "$TOKEN" "$U_ADDR")" $((tka_u_before - 5)) "U's TKA after the lock"
is "$(tka_of "$TOKEN" "${VAULT}")" 5 "the vault's TKA after the lock"
alive

step "(a) U sends V 2 twin through the token standard"
sent=$(twin send u v "$TOKEN" 2 --registry-url "$REGISTRY_URL"); echo "$sent" | jq -c .
expect_twin "$(twin_of "$TOKEN")" 3 2 5 "after the send"
alive

step "(a) V redeems 2 twin: the vault pays 2 TKA to V's address, the twin burns"
redeemed=$(twin redeem v "$TOKEN" 2 "$V_ADDR" redeem-1); echo "$redeemed" | jq -c .
is "$(jq -r .requestArchived <<<"$redeemed")" true "the redeem request after the release"
is "$(jq -r .vault <<<"$redeemed")" "$VAULT" "the vault that released"
expect_twin "$(twin_of "$TOKEN")" 3 0 3 "after the redeem"
is "$(tka_of "$TOKEN" "$V_ADDR")" $((tka_v_before + 2)) "V's TKA after the redeem"
is "$(tka_of "$TOKEN" "$VAULT")" 3 "the vault's TKA after the redeem"
alive

step "the block producer stops: the refused cases are cut by hand, one block at a time"
kill "$BUILDER_PID"; wait "$BUILDER_PID" 2>/dev/null || true

step "(b) a lock payment of an ERC-20 that has no twin: V pays 1 TKA2 into the vault against an id whose parts were announced"
ref=no-twin-1
announced=$(curl -sf -X POST -H 'content-type: application/json' --data "$(jq -nc --arg r "$U_PARTY" --arg f "$ref" '{receiver: $r, ref: $f}')" "$REGISTRY_URL/twin/v1/lock-parts")
LOCK2=$(jq -r .lockId <<<"$announced")
is "$LOCK2" "$(printf 'lock,%s,%s' "$U_PARTY" "$ref" | sha256sum | cut -d' ' -f1)" "the lock id of the announced parts"
# The service itself refuses to announce for a token that has no twin; the payer's own command stops there, and nothing is sent.
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' --data "$(jq -nc --arg r "$U_PARTY" --arg f "$ref" --arg t "${TOKEN2#0x}" '{receiver: $r, ref: $f, token: $t}')" "$REGISTRY_URL/twin/v1/lock-parts")
is "$code" 404 "the registry service's answer to an announcement for a token with no twin"
set +e; twin lock v "$TOKEN2" 1 u no-twin-2 --registry-url "$REGISTRY_URL" >/dev/null 2>"$WORK/lock.err"; lock_status=$?; set -e
[ "$lock_status" != 0 ] || fail "twin.py lock locked a token that has no twin"
# Sent by hand, past those checks.
evm approve v "$TOKEN2" gateway 1 | jq -c .
no_twin_tx=$(evm pay v "$LOCK2" "$TOKEN2" "$VAULT" 1 | jq -r .tx)
set +e; OUT=$(build); status=$?; set -e
echo "$OUT" | jq -c .
is "$status" 0 "the builder's exit status after the payment of a token with no twin ($OUT)"
is "$(jq -c '.leftOut | map(.transaction)' <<<"$OUT")" "[\"$no_twin_tx\"]" "the transaction the builder left out (no twin)"
jq -e '.leftOut[0].reason | contains("twin is not pinned")' <<<"$OUT" >/dev/null || fail "the payment was left out for another reason: $(jq -c .leftOut <<<"$OUT")"
is "$(jq -r '.legs // 0' <<<"$OUT")" 0 "the legs of the block after the payment of a token with no twin"
expect_twin "$(twin_of "$TOKEN")" 3 0 3 "after the payment of a token with no twin"
twin balances "$TOKEN2" u v | jq -e '(.supply | tonumber) == 0' >/dev/null || fail "the supply of a twin of TKA2 (there is none)"
is "$(tka_of "$TOKEN2" "$VAULT")" 0 "the vault's TKA2 (the payment was not taken)"
# The left-out payment stays in reth's pool and holds back V's later transactions: V replaces it (same nonce) before anything else.
replaced=$(evm replace v); echo "$replaced" | jq -c .
[ "$(jq '.txs | length' <<<"$replaced")" -ge 1 ] || fail "the payment was not waiting in the pool: nothing was replaced ($replaced)"
commit "the block with the replacement"
is "$(jq -r '.legs // 0' <<<"$OUT")" 0 "the legs of the block with the replacement"

step "(b) a lock payment against an id whose parts were never announced: U pays 1 TKA into the vault"
LOCK3=$(printf 'lock,%s,%s' "$U_PARTY" never-announced | sha256sum | cut -d' ' -f1)
is "$(curl -s -o /dev/null -w '%{http_code}' "$REGISTRY_URL/twin/v1/lock-parts/$LOCK3")" 404 "the registry service's answer for the id that was never announced"
evm approve u "$TOKEN" gateway 1 | jq -c .
unannounced_tx=$(evm pay u "$LOCK3" "$TOKEN" "$VAULT" 1 | jq -r .tx)
set +e; OUT=$(build); status=$?; set -e
echo "$OUT" | jq -c .
is "$status" 0 "the builder's exit status after the payment with no parts ($OUT)"
is "$(jq -c '.leftOut | map(.transaction)' <<<"$OUT")" "[\"$unannounced_tx\"]" "the transaction the builder left out (no parts)"
jq -e '.leftOut[0].reason | contains("has no parts for the lock")' <<<"$OUT" >/dev/null || fail "the payment was left out for another reason: $(jq -c .leftOut <<<"$OUT")"
is "$(jq -r '.legs // 0' <<<"$OUT")" 0 "the legs of the block after the payment with no parts"
expect_twin "$(twin_of "$TOKEN")" 3 0 3 "after the payment with no parts"
is "$(tka_of "$TOKEN" "$VAULT")" 3 "the vault's TKA (the payment was not taken)"
replaced=$(evm replace u); echo "$replaced" | jq -c .
[ "$(jq '.txs | length' <<<"$replaced")" -ge 1 ] || fail "the payment was not waiting in the pool: nothing was replaced ($replaced)"
commit "the block with the replacement"

echo "the twins ran end to end: locked, sent and redeemed, supply equal to the vault's balance throughout, and the payments with no twin or no parts were left out"
