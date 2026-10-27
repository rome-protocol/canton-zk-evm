#!/usr/bin/env bash
# The OTC swap of apps/otc, run end to end on the local network without a GPU: a seller who holds TKB on Canton and a buyer who holds TKA on the
# EVM trade through a venue (demo/otc.py; apps/otc is the app, in its own Daml package). What is real: reth (network/reth/launch.sh, discovery off),
# Canton with the real Daml package and the real token standard, both packages (the chain's and the app's), the real builder (started for the venue's
# party with --venue, so it trusts a venue whose allocation it cannot see), and the real sidecar for `legs`. What is not real: the zero-knowledge
# proof (a stand-in prover and a stand-in for the sidecar's proof check, as in tests/demo_rehearsal.sh).
# Steps, each checked (the script stops at the first claim that does not hold): the setup block (TKA, the wrapped TKB), the offer, the venue's
# acceptance, the seller's allocation, the venue's trade; the buyer's payment, in a block that settles the trade (the seller's TKB goes to the
# gateway, TKA to the seller, and the funded claim appears), the buyer's claim in a later block (the wrapped TKB, the funded claim gone); then the
# refused case: the buyer pays less than the trade names, the builder leaves the payment out and nothing moves.
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

step "reth, through launch.sh"
"$ROOT/network/reth/launch.sh"
for _ in $(seq 1 60); do rpc eth_chainId >/dev/null 2>&1 && break; sleep 1; done
rpc eth_chainId >/dev/null || fail "reth does not answer"
"$ROOT/network/reth/check.sh"
GENESIS_HASH=$(rpc eth_getBlockByNumber '"0x0",false' | jq -r .result.hash)
GENESIS_STATE_ROOT=$(rpc eth_getBlockByNumber '"0x0",false' | jq -r .result.stateRoot)

step "Canton tools, the chain's Daml package and the OTC app's package"
tools=$("$ROOT/network/canton/fetch.sh")
CANTON_JAR=$(sed -n 's/^CANTON_JAR=//p' <<<"$tools")
CZE_DAR=$("$ROOT/network/canton/build-dar.sh"); export CZE_DAR
"$ROOT/network/canton/dar-id.sh" "$CZE_DAR" > "$NET/dar.txt"
TOOLS=${CZE_TOOLS_DIR:-$CZE_STATE_DIR/tools}
(export DPM_HOME=$TOOLS/dpm DPM_REGISTRY PATH="$TOOLS/bin:$PATH" SDK_VERSION=$DAML_SDK_VERSION TARGET=$DAML_TARGET; "$ROOT/apps/otc/build.sh" >&2)
[ -s "$ROOT/apps/otc/dist/otc-venue.dar" ] || fail "the OTC app's DAR was not built"

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
otc() { "$PY" "$ROOT/demo/otc.py" "$@"; }
# One builder run, for the venue's party (--venue): the payment of a trade whose allocation the builder cannot see is settled only because of that.
# Prints its JSON line; the exit status is the builder's (0 committed, 2 refused).
build() {
  CZE_LEDGER_USER=builder CZE_BUILDER_PARTY=$BUILDER_PARTY CZE_FEE_RECIPIENT=0x0000000000000000000000000000000000000fee \
    "$PY" "$ROOT/builder/builder.py" once --read-as "$OPERATOR_PARTY" --read-as "$GATEWAY_PARTY" --venue "$V_PARTY" --disclosed "$DEMO/disclosed.json"
}
# <what>: one builder run that must commit; its report is left in $OUT.
commit() {
  set +e; OUT=$(build); local status=$?; set -e
  echo "$OUT" | jq -c .
  is "$status" 0 "the builder's exit status for $1 ($OUT)"
  is "$(jq -r .committed <<<"$OUT")" true "$1 committed"
}
# <label> <seller's TKB> <gateway's TKB> <seller's TKA> <buyer's TKA> <buyer's wrapped TKB>: what the trade's state shows (whole numbers or decimals).
expect() {
  local s; s=$(otc check "$1"); echo "$s" | jq -c .
  jq -e --argjson tkb "$2" --argjson gw "$3" --argjson sa "$4" --argjson ba "$5" --argjson w "$6" \
    '(.tkb.seller | add // 0) == $tkb and (.tkb.gateway | add // 0) == $gw and (.tka.seller | tonumber) == $sa and (.tka.buyer | tonumber) == $ba and (.wrapped.buyer | tonumber) == $w' <<<"$s" >/dev/null \
    || fail "the balances of $1 are not the expected ones (seller TKB $2, gateway TKB $3, seller TKA $4, buyer TKA $5, buyer wTKB $6)"
  CHECK=$s
}

step "block 1: the buyer (V) deploys TKA (1,000 TKA to V) and the gateway makes wTKB"
canton upload-dars
canton setup | jq -c .
deploy_tx=$(evm deploy | jq -r .tx)
made=$(evm register v "Wrapped TKB" wTKB)
WTKB=$(jq -r .token <<<"$made")
commit "the setup block"
is "$(jq -r .legs <<<"$OUT")" 0 "the setup block's legs"
TOKEN=$(evm receipt "$deploy_tx" | jq -r .contract)
[[ $TOKEN =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "no TKA address: $TOKEN"
canton register-token "$WTKB" | jq -c .
otc upload-dar | jq -c .

step "the offer, the venue's acceptance, the seller's allocation, the venue's trade (2.5 TKB for 2 TKA)"
otc offer swap-1 2.5 "$TOKEN" 2 | jq -c .
otc accept swap-1 | jq -c .
otc allocate swap-1 | jq -c .
published=$(otc publish swap-1); echo "$published" | jq -c .
is "$(jq -r .wrappedToken <<<"$published")" "$WTKB" "the wrapped token of the trade"
expect swap-1 97.5 0 0 1000 0   # the seller's allocation holds 2.5 TKB aside: 100 - 2.5 is not yet the gateway's
is "$(jq -r '.venueTrade' <<<"$CHECK")" true "the venue's trade exists"
is "$(jq -r '.fundedClaim' <<<"$CHECK")" false "no funded claim before the payment"

step "the buyer pays 2 TKA through the gateway, naming the trade: one block settles it"
paid=$(otc pay swap-1); echo "$paid" | jq -c .
pay_tx=$(jq -r .pay <<<"$paid"); approve_tx=$(jq -r .approve <<<"$paid")
commit "the payment's block"
is "$(jq -r .legs <<<"$OUT")" 1 "the payment's legs"
is "$(jq -c .legTransactions <<<"$OUT")" "[\"$pay_tx\"]" "the leg transaction of the payment's block"
is "$(jq -c .leftOut <<<"$OUT")" '[]' "the payment's block left nothing out"
is "$(jq -c '.transactions | sort' <<<"$OUT")" "$(jq -nc --arg a "$approve_tx" --arg b "$pay_tx" '[$a, $b] | sort')" "the transactions of the payment's block"
is "$(evm receipt "$pay_tx" | jq -r .status)" 1 "the payment's status"
# The seller's TKB is the gateway's now, the seller holds the TKA, and the funded claim is there; the buyer has no wrapped TKB yet.
expect swap-1 97.5 2.5 2 998 0
is "$(jq -r .fundedClaim <<<"$CHECK")" true "the funded claim after the payment"
is "$(jq -r .allocation <<<"$CHECK")" false "the seller's allocation after the payment"
is "$(jq -r .venueTrade <<<"$CHECK")" false "the venue's trade after the payment"

step "the buyer claims the wrapped TKB, in a later block"
claimed=$(otc claim swap-1); echo "$claimed" | jq -c .
claim_tx=$(jq -r .claim <<<"$claimed")
commit "the claim's block"
is "$(jq -c .transactions <<<"$OUT")" "[\"$claim_tx\"]" "the transactions of the claim's block"
is "$(jq -c .leftOut <<<"$OUT")" '[]' "the claim's block left nothing out"
is "$(evm receipt "$claim_tx" | jq -r .status)" 1 "the claim's status"
expect swap-1 97.5 2.5 2 998 2.5
is "$(jq -r .fundedClaim <<<"$CHECK")" false "the funded claim after the claim"
is "$(jq -r .wrapped.supply <<<"$CHECK" | jq -R 'tonumber')" 2.5 "the supply of wTKB"

step "the refused case: a second trade (1 TKB for 2 TKA), and the buyer pays 1 TKA"
otc offer swap-2 1 "$TOKEN" 2 | jq -c .
otc accept swap-2 | jq -c .
otc allocate swap-2 | jq -c .
otc publish swap-2 | jq -c .
expect swap-2 96.5 2.5 2 998 2.5
paid2=$(otc pay swap-2 1); echo "$paid2" | jq -c .
short_tx=$(jq -r .pay <<<"$paid2")
set +e; OUT=$(build); status=$?; set -e
echo "$OUT" | jq -c .
is "$status" 0 "the builder's exit status after the short payment ($OUT)"
is "$(jq -c '.leftOut | map(.transaction)' <<<"$OUT")" "[\"$short_tx\"]" "the transaction the builder left out"
grep -q 'another amount' <<<"$(jq -r '.leftOut[0].reason' <<<"$OUT")" || fail "the short payment was left out for another reason: $(jq -c .leftOut <<<"$OUT")"
is "$(jq -r .legs <<<"$OUT")" 0 "the legs of the block after the short payment"
# Nothing moved: the seller's allocation is still there, the trade is not settled, no funded claim, the balances are those of before.
expect swap-2 96.5 2.5 2 998 2.5
is "$(jq -r .fundedClaim <<<"$CHECK")" false "a funded claim after the short payment"
is "$(jq -r .allocation <<<"$CHECK")" true "the seller's allocation after the short payment"
is "$(jq -r .venueTrade <<<"$CHECK")" true "the venue's trade after the short payment"
set +e; otc claim swap-2 >/dev/null 2>&1; claim_status=$?; set -e
[ "$claim_status" != 0 ] || fail "the buyer could claim the wrapped TKB of a trade that was never settled"

echo "the OTC swap ran end to end: settled in one block, claimed in a later one, and the short payment left out"
