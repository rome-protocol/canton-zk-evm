#!/usr/bin/env bash
# The demo, rehearsed without a GPU: the real reth (through network/reth/launch.sh, discovery off), the real Canton with the real
# Daml package and the real token standard, the real builder, and the real sidecar for `legs` (the gateway's storage proofs), running
# demo/run.sh start to end: the setup block, a deposit, a payment, a withdrawal, the gap that is closed, and the block whose proof has one byte flipped.
# What is not real: the zero-knowledge proof. The prover is a stand-in that writes a fixed proof that carries the block hash (tests/demo_fake_prove.sh) and
# the `verify` call is answered by tests/demo_sidecar.py, which accepts only that proof and otherwise reads the block as the real
# sidecar does. So this checks everything except the proof check itself, which the sidecar's own tests and the GPU session cover.
# The explorer runs beside it, from its image (explorer/run.sh), with its own database and its indexer (run.sh starts both), and is checked against this
# chain: the page of run 1's block once the indexer has written it, the Verify check (which says no, because the proof is a stand-in), the faucet, and the
# calls the explorer and its indexer made to reth and to Canton.
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
# The explorer's database and indexer are made by explorer/run.sh start, in containers of their own name and port, so that this run touches no other.
export CZE_EXPLORER_DB_CONTAINER=cze-rehearsal-explorer-db CZE_EXPLORER_DB_PORT=55434 EXPLORER_INDEXER_CONTAINER=cze-rehearsal-explorer-indexer
pids=()
cleanup() {
  local status=$?
  if [ "$status" != 0 ]; then
    echo "--- Canton warnings and errors"; grep -E 'WARN|ERROR' "$NET/logs/canton.log" 2>/dev/null | cut -c1-700 | tail -n 40 || true
    echo "--- Canton log (tail)"; tail -n 30 "$NET/logs/canton.log" 2>/dev/null || true
    echo "--- reth log (tail)"; docker logs --tail 30 "${RETH_CONTAINER:-cze-reth}" 2>&1 || true
    echo "--- explorer log (tail)"; docker logs --tail 30 "${EXPLORER_CONTAINER:-cze-explorer}" 2>&1 || true
    echo "--- indexer log (tail)"; docker logs --tail 30 "$EXPLORER_INDEXER_CONTAINER" 2>&1 || true
  fi
  "$ROOT/explorer/run.sh" stop || true
  "$ROOT/network/explorer-db.sh" wipe || true
  docker rm -f -v cze-w1-db >/dev/null 2>&1 || true
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

echo "== the sidecars: the real one for legs, the stand-in in front of it for verify"
VK=$(printf 'cd%.0s' $(seq 32)); RC=$(printf 'ef%.0s' $(seq 32)); PROOF=$(printf 'ee%.0s' $(seq 768))$VK$RC
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
# The stand-in proof carries the run's program key and release root, as a real one does: the explorer's indexer checks them against the pins.
export DEMO_PROOF_PROGRAM_VK=$VK DEMO_PROOF_ROOT_C=$RC
export CZE_MAKE_INPUT_CMD=$ROOT/builder/tests/fake-make-input.sh CZE_PROVE_CMD=$ROOT/tests/demo_fake_prove.sh
CZE_SOURCE_COMMIT=$(printf 'a%.0s' $(seq 40)) "$ROOT/demo/run.sh"

echo "== the results are complete and consistent"
"$ROOT/tests/demo_results.sh" "$CZE_DEMO_RESULTS" --stand-in
# Calls: the stand-ins were asked to verify, and the real sidecar's legs answered for the legs.
grep -q ' verify submission$' "$FAKE_LOG" || fail "no verify call"
grep -q '^8086 legs validation$' "$FAKE_LOG" || fail "the confirmer's sidecar was never asked for legs: its participant did not check the legs when it validated"
grep -q ' legs submission$' "$FAKE_LOG" || fail "no legs call: the legs were never checked against the proven state"
# Informational: the first call to a service that has just started can time out once, and Canton recovers (the blocks above committed).
echo "--- Canton's warnings about the external call, if any:"
{ grep -E "WARN|ERROR" "$NET/logs/canton.log" | grep -i 'extension' | cut -c1-300; } || echo "none"

echo "== the explorer and its indexer, beside the chain: the explorer's calls to reth, and both their calls to Canton, go through a log"
# shellcheck disable=SC1091
. "$CZE_STATE_DIR/canton/parties.env"
EXPLORER=http://127.0.0.1:${EXPLORER_PORT:-8088}
: > "$WORK/ledger-calls"; : > "$WORK/reth-calls"
background ledger-calls python3 "$ROOT/tests/demo_call_log.py" 7597 http://127.0.0.1:7577 "$WORK/ledger-calls"
background reth-calls python3 "$ROOT/tests/demo_call_log.py" 8595 "http://127.0.0.1:${RETH_HTTP_PORT:-8545}" "$WORK/reth-calls"
# The indexer asks reth for trace_ methods as well, so it reads reth directly; the explorer's own calls to reth are logged. Both read Canton through the log. The Etherscan door's proxy asks the public RPC, so it is on (PUBLIC_RPC=1).
# The verifier role is on (EXPLORER_VERIFIER=1): it compiles what the Etherscan door's contract module is given, in a sandbox, with a compiler it downloads from the list at SOLC_LIST_URL.
EXPLORER_VERIFIER=1 SOLC_LIST_URL=${SOLC_LIST_URL:-https://binaries.soliditylang.org/linux-amd64/list.json} PUBLIC_RPC=1 LEDGER_URL=http://127.0.0.1:7597 RETH_RPC_URL=http://127.0.0.1:8595 INDEXER_RETH_RPC_URL="http://127.0.0.1:${RETH_HTTP_PORT:-8545}" "$ROOT/explorer/run.sh" start
# Healthy means the indexer has started and its checks are fresh; the blocks follow as it writes them.
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
# The indexer writes the chain from the start; run 1's block is final on the page once it has the block and Canton's record of it.
for _ in $(seq 1 180); do
  api=$(curl -sf "$EXPLORER/api/block/$run1_block" || true)
  [ "$(jq -r .status <<<"${api:-null}" 2>/dev/null)" = final ] && break
  sleep 1
done
api=$(curl -sf "$EXPLORER/api/block/$run1_block") || fail "the explorer has no block $run1_block"
[ "$(jq -r .status <<<"$api")" = final ] || fail "the explorer's block $run1_block is not final after the indexer had time to write it: $(cut -c1-300 <<<"$api"); indexer: $(docker logs --tail 10 "$EXPLORER_INDEXER_CONTAINER" 2>&1 | cut -c1-300)"
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
[ "$(ask)" = 202 ] || fail "the faucet did not take the request: $(cat "$WORK/faucet-body")"
ticket=$(jq -r .ticket "$WORK/faucet-body")
[ "${ticket:-null}" != null ] || fail "the faucet's answer has no ticket: $(cat "$WORK/faucet-body")"
[ "$(jq -r .amount "$WORK/faucet-body")" = 1000000000000000000 ] || fail "the faucet's answer is not 1 coin: $(cat "$WORK/faucet-body")"
[ "$(jq -r .to "$WORK/faucet-body" | tr A-F a-f)" = "$TO" ] || fail "the faucet's answer is not for the address: $(cat "$WORK/faucet-body")"
# The worker sends the queue within a few seconds. Until the block is final on Canton the ticket must say sent, never final.
for _ in $(seq 1 30); do
  curl -sf "$EXPLORER/api/faucet/ticket/$ticket" > "$WORK/ticket" || fail "the ticket cannot be read"
  [ "$(jq -r .status "$WORK/ticket")" = queued ] || break
  sleep 1
done
[ "$(jq -r .status "$WORK/ticket")" = sent ] || fail "the ticket is not sent after the worker ran: $(cat "$WORK/ticket")"
payout=$(jq -r .hash "$WORK/ticket")
[ "$(curl -sf "$EXPLORER/api/tx/$payout" | jq -r .status)" = waiting ] || fail "the payout $payout is not Waiting before the builder has run"
[ "$(ask)" = 429 ] || fail "a second request from the same address was not refused: $(cat "$WORK/faucet-body")"
[ "$(jq -r .reason "$WORK/faucet-body")" = address ] || fail "the second request was refused, but not for the address: $(cat "$WORK/faucet-body")"
grep -qi '^retry-after: [0-9]' "$WORK/faucet-headers" || fail "the refusal does not say how long to wait"
echo "the faucet took the request, sent $payout and refused the same address a second time"

# The coin arrives with the next block: the builder runs once more, as demo/run.sh runs it, and Canton commits the block.
payout_block=$(CZE_LEDGER_USER=builder CZE_BUILDER_PARTY=$BUILDER_PARTY CZE_FEE_RECIPIENT=0x0000000000000000000000000000000000000fee \
  "$CZE_STATE_DIR/venv/bin/python3" "$ROOT/builder/builder.py" once --read-as "$OPERATOR_PARTY" --read-as "$GATEWAY_PARTY" --disclosed "$CZE_STATE_DIR/demo/disclosed.json") || fail "the builder stopped: $payout_block"
echo "$payout_block" | jq -c .
jq -e --arg h "$payout" '.committed == true and (.transactions | index($h) != null)' <<<"$payout_block" >/dev/null || fail "the builder did not commit a block with the payout: $payout_block"
for _ in $(seq 1 90); do [ "$(curl -sf "$EXPLORER/api/tx/$payout" | jq -r .status)" = final ] && break; sleep 1; done
[ "$(curl -sf "$EXPLORER/api/tx/$payout" | jq -r .status)" = final ] || fail "the explorer does not show the payout as Final"
for _ in $(seq 1 90); do [ "$(curl -sf "$EXPLORER/api/faucet/ticket/$ticket" | jq -r .status)" = final ] && break; sleep 1; done
[ "$(curl -sf "$EXPLORER/api/faucet/ticket/$ticket" | jq -r .status)" = final ] || fail "the ticket is not final after the block is final on Canton: $(curl -s "$EXPLORER/api/faucet/ticket/$ticket")"
[ "$(balance)" = 0xde0b6b3a7640000 ] || fail "the address does not hold 1 tROME after the payout: $(balance)"
[ "$(ask)" = 429 ] || fail "the faucet sent to the same address again"

echo "--- the Etherscan door's proxy: ethers' EtherscanProvider and Foundry's cast, against the faucet's final payout"
# The coin is final and the address has no code, so the proxy, the account module and /rpc all have one answer for it. ethers runs in the explorer's image, with its own packages;
# cast is the pinned release, checked against its SHA-256 by the script (it is not in PINS: the chain has no funded test accounts).
chain_id=$(($(rpc eth_chainId | jq -r .result)))
docker run --rm --network host --user "$(id -u):$(id -g)" -e HOME=/tmp -e EXPLORER_URL="$EXPLORER" -e CHAIN_ID="$chain_id" -e ETHERSCAN_ADDRESS="$TO" -e ETHERSCAN_BALANCE=1000000000000000000 -e ETHERSCAN_TX="$payout" \
  -v "$ROOT:/repo:ro" -w /tmp "$EXPLORER_NODE_IMAGE" \
  sh -c "mkdir /tmp/explorer && cd /repo/explorer && tar cf - --exclude=./node_modules . | tar xf - -C /tmp/explorer && cd /tmp/explorer && npm ci --ignore-scripts && npx vitest run e2e/etherscan" || fail "ethers' EtherscanProvider and the Etherscan door disagree"
EXPLORER=$EXPLORER ETHERSCAN_ADDRESS=$TO ETHERSCAN_BALANCE=1000000000000000000 ETHERSCAN_TX=$payout "$ROOT/tests/demo_etherscan_cast.sh" || fail "cast and the Etherscan door's proxy disagree"

echo "--- what the explorer asked reth and Canton for"
# Canton, asked by the explorer (the ledger end, for its status) and by the indexer (the ledger end, the updates and the participant id), and nothing else;
# every update request names the reader party and the block record, and no other party.
[ "$(jq -r '.method + " " + (.path | split("?")[0])' "$WORK/ledger-calls" | sort -u)" = $'GET /v2/parties/participant-id\nGET /v2/state/ledger-end\nPOST /v2/updates' ] \
  || fail "the explorer or its indexer called Canton's Ledger API for something else than the ledger end, the updates and the participant id: $(jq -r '.method + " " + .path' "$WORK/ledger-calls" | sort | uniq -c)"
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
echo "the explorer and its indexer called only the ledger end, the updates and the participant id on Canton, and the explorer only eth_, net_ and web3_ on reth"
echo "== the indexer's real-reth tests: revert data (Error(string), Panic(uint256), a custom error) and W1, the worst-case block"
# The explorer's indexer reads this chain's reth and Canton as it would a deployed one. The proofs here are stand-ins, so the test takes its pins
# from the first proof; everything else is the real thing. The block of three failed transactions and a block that fills the gas cap are made
# here, through the real builder, and the test then indexes the whole chain into a PostgreSQL made for this run (the pinned image, loopback only).
PY=$CZE_STATE_DIR/venv/bin/python3
w1py() { "$PY" "$ROOT/tests/demo_w1.py" "$@"; }
cut_block() {
  local out
  out=$(CZE_LEDGER_USER=builder CZE_BUILDER_PARTY=$BUILDER_PARTY CZE_FEE_RECIPIENT=0x0000000000000000000000000000000000000fee \
    "$PY" "$ROOT/builder/builder.py" once --read-as "$OPERATOR_PARTY" --read-as "$GATEWAY_PARTY" --disclosed "$CZE_STATE_DIR/demo/disclosed.json") || fail "the builder stopped: $out"
  jq -e '.committed == true' <<<"$out" >/dev/null || fail "the builder did not commit the block: $out"
}
receipt_of() { "$PY" "$ROOT/demo/evm.py" receipt "$1"; }
"$ROOT/tests/build_w1_fixtures.sh" "$WORK/w1"
reverts_tx=$(w1py deploy "$WORK/w1/Reverts.bin"); stress_tx=$(w1py deploy "$WORK/w1/Stress.bin")
flood_tx=$(w1py deploy "$WORK/w1/Flood.bin"); multi_tx=$(w1py deploy "$WORK/w1/Multi.bin")
cut_block
REVERTS=$(receipt_of "$reverts_tx" | jq -r .contract); STRESS=$(receipt_of "$stress_tx" | jq -r .contract)
FLOOD=$(receipt_of "$flood_tx" | jq -r .contract); MULTI=$(receipt_of "$multi_tx" | jq -r .contract)
[[ $REVERTS =~ ^0x[0-9a-fA-F]{40}$ && $STRESS =~ ^0x[0-9a-fA-F]{40}$ && $FLOOD =~ ^0x[0-9a-fA-F]{40}$ && $MULTI =~ ^0x[0-9a-fA-F]{40}$ ]] \
  || fail "the fixture contracts were not deployed: $REVERTS $STRESS $FLOOD $MULTI"
first_failed=$(w1py reverts "$REVERTS" | head -n 1)
cut_block
REVERT_BLOCK=$(receipt_of "$first_failed" | jq -r .block)
[ "$(receipt_of "$first_failed" | jq -r .status)" = 0 ] || fail "the first call to Reverts did not fail: $(receipt_of "$first_failed")"
# The ERC-1155 holder of the W1 block: 4,096 ids minted to the Multi contract in a block of their own, so the W1 block's batches send from a holder that already
# holds the ids (two legs for each id).
w1py flood "$MULTI" mint 1 >/dev/null
cut_block
# The W1 block: the log-heavy call chains, and the token traffic as costly as the cap allows: ERC-1155 batches whose ids and values share one array (18 of 4,096 ids,
# 73,728 transfers, 19.6 Mgas of gas limit), one call of ERC-20 transfers to new holders and one of new tokens that need their metadata read (a third of them Burners,
# whose reads spend all their gas, and one a FatReturn whose reads answer 680 KB). The calls' gas limits add up to 27.6 Mgas of the 30 Mgas cap (the builder keeps a margin): 2 Stress calls and the two small Flood
# calls at 2 Mgas, and the batches at 19.6 Mgas.
first_stress=$(w1py stress "$STRESS" 2 | head -n 1)
w1py flood "$FLOOD" transfers 1 >/dev/null
w1py flood "$MULTI" batches 1 >/dev/null
w1py flood "$FLOOD" spawn 1 >/dev/null
cut_block
W1_BLOCK=$(receipt_of "$first_stress" | jq -r .block)
echo "the first Stress call: $(receipt_of "$first_stress" | jq -c .)"
# The contracts of the trace reading (explorer/test/fixtures/Lab.sol): one transaction makes every kind, a second makes a contract and fails, a third
# destroys a contract made by the first. Each goes into a block of its own.
lab_tx=$(w1py deploy "$WORK/w1/Lab.bin" 6000000)
cut_block
LAB=$(receipt_of "$lab_tx" | jq -r .contract)
[[ $LAB =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "Lab was not deployed: $(receipt_of "$lab_tx")"
lab_build=$(w1py lab "$LAB" 'build()')
cut_block
[ "$(receipt_of "$lab_build" | jq -r .status)" = 1 ] || fail "Lab.build() did not succeed: $(receipt_of "$lab_build")"
LAB_BUILD_BLOCK=$(receipt_of "$lab_build" | jq -r .block)
lab_undone=$(w1py lab "$LAB" 'undone()')
cut_block
[ "$(receipt_of "$lab_undone" | jq -r .status)" = 0 ] || fail "Lab.undone() did not fail: $(receipt_of "$lab_undone")"
LAB_UNDONE_BLOCK=$(receipt_of "$lab_undone" | jq -r .block)
lab_kill=$(w1py lab "$LAB" 'kill()')
cut_block
[ "$(receipt_of "$lab_kill" | jq -r .status)" = 1 ] || fail "Lab.kill() did not succeed: $(receipt_of "$lab_kill")"
LAB_KILL_BLOCK=$(receipt_of "$lab_kill" | jq -r .block)
echo "Lab $LAB: build in block $LAB_BUILD_BLOCK, the undone call in $LAB_UNDONE_BLOCK, the self-destruct in $LAB_KILL_BLOCK"
echo "== the Etherscan door's contract module: forge verify-contract (both formats), cast source and cast interface, against Box built and deployed here"
# Box is built twice by the script (the pinned Foundry, checked against its SHA-256; the solc of PINS' image, copied out of it, is the compiler forge runs) and deployed twice with
# the argument 42; the explorer's verifier compiles it again, in its sandbox, with the solc it downloads from the compiler list.
SOLC_COPY=cze-rehearsal-solc-$$
docker create --name "$SOLC_COPY" "$SOLC_IMAGE" > /dev/null
docker cp "$SOLC_COPY:/usr/bin/solc" "$WORK/solc"
docker rm -f -v "$SOLC_COPY" > /dev/null
SOLC=$WORK/solc "$ROOT/tests/demo_etherscan_contract.sh" build "$WORK/box" || fail "the contract script could not build Box"
box_standard_tx=$(w1py deploy "$WORK/box/standard.deploy"); box_flat_tx=$(w1py deploy "$WORK/box/flat.deploy")
cut_block
BOX_STANDARD=$(receipt_of "$box_standard_tx" | jq -r .contract); BOX_FLAT=$(receipt_of "$box_flat_tx" | jq -r .contract)
[[ $BOX_STANDARD =~ ^0x[0-9a-fA-F]{40}$ && $BOX_FLAT =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "Box was not deployed: $BOX_STANDARD $BOX_FLAT"
# The door knows a contract once the indexer has written it.
for box in "$BOX_STANDARD" "$BOX_FLAT"; do
  for _ in $(seq 1 120); do
    [ "$(curl -sf "$EXPLORER/api?module=contract&action=getcontractcreation&contractaddresses=$box" | jq -r .status)" = 1 ] && break
    sleep 1
  done
  [ "$(curl -sf "$EXPLORER/api?module=contract&action=getcontractcreation&contractaddresses=$box" | jq -r .status)" = 1 ] \
    || fail "the explorer does not know $box after the indexer had time to write it; indexer: $(docker logs --tail 10 "$EXPLORER_INDEXER_CONTAINER" 2>&1 | cut -c1-300)"
done
docker ps --format '{{.Names}}' | grep -qx "${EXPLORER_VERIFIER_CONTAINER:-cze-explorer-verifier}" || fail "the verifier is not running"
EXPLORER=$EXPLORER CHAIN_ID=$chain_id BOX_STANDARD=$BOX_STANDARD BOX_FLAT=$BOX_FLAT SOLC=$WORK/solc "$ROOT/tests/demo_etherscan_contract.sh" verify \
  || fail "forge, cast and the Etherscan door's contract module disagree; verifier: $(docker logs --tail 10 "${EXPLORER_VERIFIER_CONTAINER:-cze-explorer-verifier}" 2>&1 | cut -c1-300)"
echo "revert block $REVERT_BLOCK, W1 block $W1_BLOCK: $(rpc eth_getBlockByNumber "\"0x$(printf '%x' "$W1_BLOCK")\",false" | jq -c '{transactions: (.result.transactions | length), gasUsed: .result.gasUsed}')"

PGPW=$(openssl rand -hex 16)
docker run -d --rm --name cze-w1-db --security-opt no-new-privileges -p 127.0.0.1:55433:5432 -e POSTGRES_USER=explorer -e POSTGRES_PASSWORD="$PGPW" -e POSTGRES_DB=explorer "$POSTGRES_IMAGE" >/dev/null
ok=0
for _ in $(seq 1 60); do
  if docker exec cze-w1-db pg_isready -U explorer -q; then ok=$((ok + 1)); [ "$ok" -ge 3 ] && break; else ok=0; fi
  sleep 1
done
[ "$ok" -ge 3 ] || fail "the test database did not start"
docker run --rm --network host --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -e EXPLORER_TEST_RETH_URL="http://127.0.0.1:${RETH_HTTP_PORT:-8545}" -e EXPLORER_TEST_REVERT_BLOCK="$REVERT_BLOCK" -e EXPLORER_TEST_W1_BLOCK="$W1_BLOCK" \
  -e EXPLORER_TEST_LAB="$LAB" -e EXPLORER_TEST_LAB_BUILD_BLOCK="$LAB_BUILD_BLOCK" -e EXPLORER_TEST_LAB_UNDONE_BLOCK="$LAB_UNDONE_BLOCK" -e EXPLORER_TEST_LAB_KILL_BLOCK="$LAB_KILL_BLOCK" \
  -e EXPLORER_TEST_LEDGER_URL=http://127.0.0.1:7577 -e READER_PARTY="$READER_PARTY" -e GATEWAY_ADDRESS="$GATEWAY_ADDRESS" -e CHAIN_ID="$(($(rpc eth_chainId | jq -r .result)))" \
  -e EXPLORER_TEST_REQUIRE_DATABASE=1 -e EXPLORER_TEST_DATABASE_URL="postgres://explorer:$PGPW@127.0.0.1:55433/explorer" \
  -v "$ROOT:/repo:ro" -w /tmp "$EXPLORER_NODE_IMAGE" \
  sh -c "mkdir /tmp/explorer && cd /repo/explorer && tar cf - --exclude=./node_modules . | tar xf - -C /tmp/explorer && cd /tmp/explorer && npm ci --ignore-scripts && npx vitest run server/indexer/real-reth.test.ts --reporter=verbose" \
  | tee "$WORK/w1.log"
grep -q 'W1 inline:' "$WORK/w1.log" || fail "the W1 test did not run"
grep -E '^W1 ' "$WORK/w1.log" || true

echo "demo rehearsal passed"
