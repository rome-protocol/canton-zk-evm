#!/usr/bin/env bash
# The demo, rehearsed without a GPU: the real reth (through network/reth/launch.sh, discovery off), the real Canton with the real
# Daml package and the real token standard, the real builder, and the real sidecar for `fact` (the storage proofs), running
# demo/run.sh start to end: deploy TKA, the good block with its DvP leg, and the block whose proof has one byte flipped.
# What is not real: the zero-knowledge proof. The prover is a stand-in that writes one fixed proof (tests/demo_fake_prove.sh) and
# the `verify` call is answered by tests/demo_sidecar.py, which accepts only that proof and otherwise reads the block as the real
# sidecar does. So this checks everything except the proof check itself, which the sidecar's own tests and the GPU session cover.
# The explorer runs beside it, from its image (explorer/run.sh), and is checked against this chain: the page of run 1's block, the Verify check
# (which says no, because the proof is a stand-in), the faucet, and the calls the explorer made to reth and to Canton.
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
    echo "--- explorer log (tail)"; docker logs --tail 30 "${EXPLORER_CONTAINER:-cze-explorer}" 2>&1 || true
  fi
  "$ROOT/explorer/run.sh" stop || true
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  "$ROOT/network/reth/stop.sh" || true
  rm -rf "$WORK"
}
trap cleanup EXIT
background() { local name=$1; shift; nohup "$@" > "$NET/logs/$name.log" 2>&1 < /dev/null & pids+=($!); }
rpc() { curl -sf -H 'content-type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":[${2:-}]}" "http://127.0.0.1:${RETH_HTTP_PORT:-8545}"; }

echo "== the demo's packages, keys and funded genesis"
"$ROOT/demo/prepare.sh"
export CZE_GENESIS_FILE=$CZE_STATE_DIR/demo/genesis.json

echo "== the explorer's image, and the faucet's key and genesis on top of the demo's"
"$ROOT/explorer/run.sh" setup
export CZE_GENESIS_FILE=$CZE_STATE_DIR/faucet/genesis.json

echo "== reth, through launch.sh"
"$ROOT/network/reth/launch.sh"
for _ in $(seq 1 60); do rpc eth_chainId >/dev/null 2>&1 && break; sleep 1; done
rpc eth_chainId >/dev/null || fail "reth does not answer"
"$ROOT/network/reth/check.sh"
GENESIS_HASH=$(rpc eth_getBlockByNumber '"0x0",false' | jq -r .result.hash)
GENESIS_STATE_ROOT=$(rpc eth_getBlockByNumber '"0x0",false' | jq -r .result.stateRoot)

echo "== Canton tools and the real Daml package"
tools=$("$ROOT/network/canton/fetch.sh")
CANTON_JAR=$(sed -n 's/^CANTON_JAR=//p' <<<"$tools")
CZE_DAR=$("$ROOT/network/canton/build-dar.sh"); export CZE_DAR
"$ROOT/network/canton/dar-id.sh" "$CZE_DAR" > "$NET/dar.txt"

echo "== the sidecars: the real one for fact, the stand-in in front of it for verify"
VK=$(printf 'cd%.0s' $(seq 32)); RC=$(printf 'ef%.0s' $(seq 32)); PROOF=$(printf 'ee%.0s' $(seq 1344))
cargo build --release --locked --manifest-path "$ROOT/sidecar/Cargo.toml"
background real-sidecar "$ROOT/sidecar/target/release/zk-sidecar" --program-vk "$VK" --root-c "$RC" --listen 127.0.0.1:9085
for port in 8085 8086; do
  background "stand-in-$port" python3 "$ROOT/tests/demo_sidecar.py" "$port" 9085 "$VK" "$RC" "$PROOF"
done
sleep 2
for _ in $(seq 1 30); do curl -sf http://127.0.0.1:9085/api/v1/version >/dev/null && break; sleep 1; done

echo "== Canton"
background canton java -Xmx3g -jar "$CANTON_JAR" daemon -c "$ROOT/network/canton/canton.conf" --bootstrap "$ROOT/network/canton/bootstrap.canton" --no-tty
for _ in $(seq 1 600); do
  grep -q "BOOTSTRAP DONE" "$NET/logs/canton.log" && break
  kill -0 "${pids[-1]}" 2>/dev/null || fail "Canton stopped"
  sleep 1
done
grep -q "BOOTSTRAP DONE" "$NET/logs/canton.log" || fail "the bootstrap did not finish"
python3 "$ROOT/network/canton/propose.py" --genesis-hash "${GENESIS_HASH#0x}" --genesis-state-root "${GENESIS_STATE_ROOT#0x}" --program-vk "$VK" --root-c "$RC" --rules-hash "$(printf '12%.0s' $(seq 32))" | tee "$NET/chain.json"
printf 'elf_sha256=%s\nprogramVK=0x%s\nrootC=0x%s\nrulesHash=%s\n' "$(printf '00%.0s' $(seq 32))" "$VK" "$RC" "$(printf '12%.0s' $(seq 32))" > "$NET/guest.txt"

echo "== the demo"
export CZE_MAKE_INPUT_CMD=$ROOT/builder/tests/fake-make-input.sh CZE_PROVE_CMD=$ROOT/tests/demo_fake_prove.sh
CZE_SOURCE_COMMIT=$(printf 'a%.0s' $(seq 40)) "$ROOT/demo/run.sh"

echo "== the results are complete and consistent"
"$ROOT/tests/demo_results.sh" "$CZE_DEMO_RESULTS" --stand-in
# Calls: the stand-ins were asked to verify, and the real sidecar's fact answered the leg.
grep -q ' verify submission$' "$FAKE_LOG" || fail "no verify call"
grep -q '^8086 fact validation$' "$FAKE_LOG" || fail "the confirmer's sidecar was never asked for fact: its participant did not check the leg when it validated"
grep -q ' fact submission$' "$FAKE_LOG" || fail "no fact call: the leg was never checked against the proven state"
# Informational: the first call to a service that has just started can time out once, and Canton recovers (the blocks above committed).
echo "--- Canton's warnings about the external call, if any:"
{ grep -E "WARN|ERROR" "$NET/logs/canton.log" | grep -i 'extension' | cut -c1-300; } || echo "none"

echo "== the explorer, beside the chain: its calls to reth and to Canton go through a log"
# shellcheck disable=SC1091
. "$CZE_STATE_DIR/canton/parties.env"
EXPLORER=http://127.0.0.1:${EXPLORER_PORT:-8088}
: > "$WORK/ledger-calls"; : > "$WORK/reth-calls"
background ledger-calls python3 "$ROOT/tests/demo_call_log.py" 7597 http://127.0.0.1:7577 "$WORK/ledger-calls"
background reth-calls python3 "$ROOT/tests/demo_call_log.py" 8595 "http://127.0.0.1:${RETH_HTTP_PORT:-8545}" "$WORK/reth-calls"
LEDGER_URL=http://127.0.0.1:7597 RETH_RPC_URL=http://127.0.0.1:8595 "$ROOT/explorer/run.sh" start
for _ in $(seq 1 120); do curl -sf "$EXPLORER/healthz" >/dev/null 2>&1 && break; sleep 1; done
curl -sf "$EXPLORER/healthz" >/dev/null || fail "the explorer is not healthy: $(curl -s "$EXPLORER/healthz" | cut -c1-600)"

# The explorer took its pins from this run's own guest.txt, not from the recorded session's that the image carries.
status=$(curl -sf "$EXPLORER/api/status")
[ "$(jq -r .pins.file <<<"$status")" = guest.txt ] || fail "the explorer's pins did not come from the run's guest.txt: $(jq -c .pins <<<"$status")"
[ "$(jq -r '.pins.programVK | ascii_downcase | sub("^0x"; "")' <<<"$status")" = "$VK" ] || fail "the explorer's program key is not the run's: $(jq -c .pins <<<"$status")"
[ "$(jq -r '.pins.rootC | ascii_downcase | sub("^0x"; "")' <<<"$status")" = "$RC" ] || fail "the explorer's ZisK release is not the run's: $(jq -c .pins <<<"$status")"

# Run 1's block, from the demo's own results: nothing here names a block number or a hash.
run1=$CZE_DEMO_RESULTS/run1.txt
run1_block=$(sed -n 's/^block=//p' "$run1"); run1_hash=$(sed -n 's/^block_hash=//p' "$run1"); run1_update=$(sed -n 's/^canton_update=//p' "$run1")
[ -n "$run1_block" ] || fail "run1.txt names no block"
[ -n "$run1_hash" ] || fail "run1.txt names no block hash"
[ -n "$run1_update" ] || fail "run1.txt names no Canton update"
api=$(curl -sf "$EXPLORER/api/block/$run1_block")
[ "$(jq -r .status <<<"$api")" = final ] || fail "the explorer's block $run1_block is not final: $(cut -c1-300 <<<"$api")"
[ "$(jq -r .hash <<<"$api")" = "$run1_hash" ] || fail "the explorer's block $run1_block is not the block run 1 made: $(cut -c1-300 <<<"$api")"
[ "$(jq -r .canton.updateId <<<"$api")" = "$run1_update" ] || fail "the explorer's Canton update for block $run1_block is not the one run 1 recorded"
echo "--- the pages and the Verify check, on run 1's block (block $run1_block)"
# The repository is mounted read-only, and the page tests run in a copy of explorer/ inside the container: npm installs this image's own (musl)
# builds of the packages there, not in the checkout's node_modules.
docker run --rm --network host --user "$(id -u):$(id -g)" -e HOME=/tmp -e EXPLORER_URL="$EXPLORER" -e RUN1_FILE=/results/run1.txt \
  -v "$CZE_DEMO_RESULTS:/results:ro" -v "$ROOT:/repo:ro" -w /tmp "$EXPLORER_NODE_IMAGE" \
  sh -c "mkdir /tmp/explorer && cd /repo/explorer && tar cf - --exclude=./node_modules . | tar xf - -C /tmp/explorer && cd /tmp/explorer && npm ci --ignore-scripts && npx vitest run e2e"

echo "--- the faucet: 1 tROME, once"
TO=0x5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e
ask() { curl -s -D "$WORK/faucet-headers" -o "$WORK/faucet-body" -w '%{http_code}' -X POST -H 'content-type: application/json' --data "{\"address\":\"$TO\"}" "$EXPLORER/api/faucet"; }
balance() { rpc eth_getBalance "\"$TO\",\"latest\"" | jq -r .result; }
[ "$(curl -sf "$EXPLORER/api/faucet" | jq -r .on)" = true ] || fail "the faucet is off"
[ "$(balance)" = 0x0 ] || fail "the faucet's address already holds coins"
[ "$(ask)" = 200 ] || fail "the faucet did not send: $(cat "$WORK/faucet-body")"
[ "$(jq -r .amount "$WORK/faucet-body")" = 1000000000000000000 ] || fail "the faucet's answer is not 1 coin: $(cat "$WORK/faucet-body")"
[ "$(jq -r .to "$WORK/faucet-body" | tr A-F a-f)" = "$TO" ] || fail "the faucet's answer is not for the address: $(cat "$WORK/faucet-body")"
payout=$(jq -r .hash "$WORK/faucet-body")
[ "$(curl -sf "$EXPLORER/api/tx/$payout" | jq -r .status)" = waiting ] || fail "the payout $payout is not Waiting before the builder has run"
sleep 3   # past the faucet's pause between sends, so that a refusal below is for the address
[ "$(ask)" = 429 ] || fail "a second request from the same address was not refused: $(cat "$WORK/faucet-body")"
[ "$(jq -r .reason "$WORK/faucet-body")" = address ] || fail "the second request was refused, but not for the address: $(cat "$WORK/faucet-body")"
grep -qi '^retry-after: [0-9]' "$WORK/faucet-headers" || fail "the refusal does not say how long to wait"
echo "the faucet sent $payout and refused the same address a second time"

# The coin arrives with the next block: the builder runs once more, as demo/run.sh runs it, and Canton commits the block.
payout_block=$(CZE_LEDGER_USER=builder CZE_BUILDER_PARTY=$BUILDER_PARTY CZE_FEE_RECIPIENT=0x0000000000000000000000000000000000000fee \
  "$CZE_STATE_DIR/venv/bin/python3" "$ROOT/builder/builder.py" once --read-as "$OPERATOR_PARTY" --disclosed "$CZE_STATE_DIR/demo/disclosed.json") || fail "the builder stopped: $payout_block"
echo "$payout_block" | jq -c .
jq -e --arg h "$payout" '.committed == true and (.transactions | index($h) != null)' <<<"$payout_block" >/dev/null || fail "the builder did not commit a block with the payout: $payout_block"
for _ in $(seq 1 60); do [ "$(curl -sf "$EXPLORER/api/tx/$payout" | jq -r .status)" = final ] && break; sleep 1; done
[ "$(curl -sf "$EXPLORER/api/tx/$payout" | jq -r .status)" = final ] || fail "the explorer does not show the payout as Final"
[ "$(balance)" = 0xde0b6b3a7640000 ] || fail "the address does not hold 1 tROME after the payout: $(balance)"
[ "$(ask)" = 429 ] || fail "the faucet sent to the same address again"

echo "--- what the explorer asked reth and Canton for"
# Canton: the ledger end and the updates, and nothing else; every update request names the reader party and the block record, and no other party.
[ "$(jq -r '.method + " " + (.path | split("?")[0])' "$WORK/ledger-calls" | sort -u)" = $'GET /v2/state/ledger-end\nPOST /v2/updates' ] \
  || fail "the explorer called Canton's Ledger API for something else than the ledger end and the updates: $(jq -r '.method + " " + .path' "$WORK/ledger-calls" | sort | uniq -c)"
# Every update request is, in structure: filtersByParty has the reader party as its only key, there is no filtersForAnyParty, and every template is the block record.
jq -s -e --arg r "$READER_PARTY" '
  [.[] | select(.method == "POST") | .body | fromjson] as $bodies
  | ($bodies | length) > 0
  and ($bodies | all(
      (.updateFormat.includeTransactions.eventFormat | (.filtersByParty | keys) == [$r])
      and ([.. | objects | select(has("filtersForAnyParty"))] | length == 0)
      and ([.. | objects | select(has("templateId")) | .templateId] | (length > 0 and all(endswith(":Zk.Chain:BlockRecord"))))
  ))' "$WORK/ledger-calls" >/dev/null \
  || fail "an update request was not for the reader party alone and the block record alone: $(jq -r 'select(.method == "POST") | .body' "$WORK/ledger-calls" | head -n 3 | cut -c1-600)"
for party in "$OPERATOR_PARTY" "$BUILDER_PARTY" "$CONFIRMER_PARTY" "$U_PARTY" "$V_PARTY" "$REGISTRY_PARTY"; do
  ! jq -r 'select(.method == "POST") | .body' "$WORK/ledger-calls" | grep -qF "$party" || fail "an update request named a party other than the reader: $party"
done
# reth: only eth_, net_ and web3_ methods.
[ -s "$WORK/reth-calls" ] || fail "the explorer made no call to reth"
jq -e -s 'all(.[] | .body | fromjson | if type == "array" then .[] else . end | .method; test("^(eth|net|web3)_"))' "$WORK/reth-calls" >/dev/null || fail "the explorer called a method of reth that is not eth_, net_ or web3_"
echo "the explorer called only the ledger end and the updates on Canton, and only eth_, net_ and web3_ on reth"
echo "demo rehearsal passed"
