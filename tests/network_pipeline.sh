#!/usr/bin/env bash
# The builder with several blocks in flight, on the local network: the real reth (network/reth/launch.sh, discovery off, no peers, with CZE_PERSIST=1),
# the real Canton with the real Daml package, the real builder, the real sidecar for `legs` and the rehearsal's stand-ins for the proof and for the
# sidecar's proof check (tests/demo_rehearsal.sh says what that leaves out). The prover is tests/pipeline_prove.sh: the rehearsal's stand-in after a delay.
#
# The run, at depth 2 (`builder.py run --max-in-flight 2`), or with PIPELINE_DEPTH=3 at depth 3 with two stand-in provers (two --prover names; the stand-in
# ignores the URL), where the same faults come and two more are added (4 and 5):
#   1. A flood: FLOOD_BLOCKS blocks of 3 plain transfers each, all in reth's pool before the builder starts, cut and committed one after another.
#   2. A refusal at N with N+1 proven: tests/pipeline_prove.sh gives one proof with a byte flipped (demo/prove-tampered.sh); the sidecar says no (at once:
#      the proxy holds the answer back PIPELINE_HOLD_SECONDS, so that the block behind it is proven first); the
#      block after it, already proven, is dropped, its transactions go back to the pool, and the chain goes on from N. Put down again until the journal
#      shows a dropped block that had its proof.
#   3. A lost reply while the command commits: tests/ledger_drop_proxy.py, in front of the JSON Ledger API, sends one Advance on, lets Canton commit it
#      and closes the connection without an answer. The next block must wait until the command is settled as committed.
#   4. (depth 3) The refusal must be of the oldest of three blocks, so that reth goes back three blocks on the persistent node: it is put down again
#      until the journal shows a refusal that took two more blocks with it.
#   5. (depth 3) kill -9 of the builder with three blocks in flight (the builder is stopped, the journal read, and only then killed), then a restart: the blocks
#      it finds in flight are given up, their transactions are back in reth's pool, and the chain goes on.
# Checks (tests/pipeline_check.py): Canton's head is reth's block, and reth's finalized block never above it, once a second for the whole run;
# at the end they are the same block; the journal's committed blocks are the blocks of reth, one commit a height, no gap, no height submitted again while
# its command was in doubt, every committed block seen final; every transaction sent is in a committed block and final; nothing named lost; the proxy saw
# as many submits as the journal's `submitted` lines.
#
# Settings: FLOOD_BLOCKS (300), PIPELINE_PROVE_DELAY (1, seconds a proof takes), PIPELINE_HOLD_SECONDS (4), FLOOD_TIMEOUT (3000, seconds), PIPELINE_OUT (a folder for the journal, the logs
# and the results; it is kept). Needs Docker, Java 21, Rust, Python 3.12, jq, curl and network access. No GPU.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"
DEPTH=${PIPELINE_DEPTH:-2}
case $DEPTH in 2|3) ;; *) echo "FAIL: this scenario runs at depth 2, or at depth 3 with two provers (PIPELINE_DEPTH)" >&2; exit 1;; esac
FLOOD_BLOCKS=${FLOOD_BLOCKS:-300}
TXS_PER_BLOCK=3
case $FLOOD_BLOCKS in ''|*[!0-9]*) echo "FAIL: FLOOD_BLOCKS must be a whole number" >&2; exit 1;; esac
[ "$FLOOD_BLOCKS" -ge 20 ] || { echo "FAIL: FLOOD_BLOCKS must be at least 20, so that the faults fall inside the flood" >&2; exit 1; }
WORK=$(mktemp -d)
OUT=${PIPELINE_OUT:-$WORK/out}
export CZE_STATE_DIR=$WORK/state FAKE_LOG=$WORK/calls
NET=$CZE_STATE_DIR/net
umask 077
mkdir -p "$NET/logs" "$OUT"
: > "$FAKE_LOG"
fail() { echo "FAIL: $*" >&2; exit 1; }
pids=()
cleanup() {
  local status=$?
  if [ "$status" != 0 ]; then
    echo "--- the builder's log (tail)"; tail -n 30 "$NET/logs/builder-2.log" "$NET/logs/builder.log" 2>/dev/null | cut -c1-400 || true
    echo "--- the last journal lines"; tail -q -n 12 "$CZE_STATE_DIR"/builder/journal/*.jsonl 2>/dev/null | cut -c1-400 || true
    echo "--- Canton warnings and errors"; grep -E 'WARN|ERROR' "$NET/logs/canton.log" 2>/dev/null | cut -c1-500 | tail -n 20 || true
    echo "--- reth log (tail)"; docker logs --tail 20 "${RETH_CONTAINER:-cze-reth}" 2>&1 | cut -c1-400 || true
  fi
  touch "$OUT/stop-watch" 2>/dev/null || true
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  [ ! -d "$CZE_STATE_DIR/builder/journal" ] || cp -r "$CZE_STATE_DIR/builder/journal" "$OUT/journal" 2>/dev/null || true
  cp "$NET/logs"/*.log "$OUT/" 2>/dev/null || true
  "$ROOT/network/reth/stop.sh" --wipe-persistent || true
  rm -rf "$WORK/state" "$WORK/out"
  rmdir "$WORK" 2>/dev/null || true
}
trap cleanup EXIT
background() { local name=$1; shift; nohup "$@" > "$NET/logs/$name.log" 2>&1 < /dev/null & pids+=($!); }
rpc() { curl -sf -H 'content-type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":[${2:-}]}" "http://127.0.0.1:${RETH_HTTP_PORT:-8545}"; }

echo "== the demo's packages, keys and funded genesis"
"$ROOT/demo/prepare.sh"
export CZE_GENESIS_FILE=$CZE_STATE_DIR/demo/genesis.json
PY=$CZE_STATE_DIR/venv/bin/python3

echo "== reth, through launch.sh (persistent, discovery off)"
CZE_PERSIST=1 "$ROOT/network/reth/launch.sh"
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
for _ in $(seq 1 30); do curl -sf http://127.0.0.1:9085/api/v1/version >/dev/null && break; sleep 1; done

echo "== Canton"
background canton java -Xmx3g -jar "$CANTON_JAR" daemon -c "$ROOT/network/canton/canton.conf" --bootstrap "$ROOT/network/canton/bootstrap.canton" --no-tty
for _ in $(seq 1 600); do
  grep -q "BOOTSTRAP DONE" "$NET/logs/canton.log" && break
  kill -0 "${pids[-1]}" 2>/dev/null || fail "Canton stopped"
  sleep 1
done
grep -q "BOOTSTRAP DONE" "$NET/logs/canton.log" || fail "the bootstrap did not finish"
python3 "$ROOT/network/canton/propose.py" --genesis-hash "${GENESIS_HASH#0x}" --genesis-state-root "${GENESIS_STATE_ROOT#0x}" --program-vk "$VK" --root-c "$RC" --rules-hash "$(printf '12%.0s' $(seq 32))" > "$NET/chain.json"
# shellcheck disable=SC1091
. "$CZE_STATE_DIR/canton/parties.env"

# The builder's settings, for `once` and `run`, for the checks, and through the proxy for `run`.
PROXY_PORT=7585
export DEMO_PROOF_PROGRAM_VK=$VK DEMO_PROOF_ROOT_C=$RC
export CZE_LEDGER_USER=builder CZE_BUILDER_PARTY=$BUILDER_PARTY CZE_FEE_RECIPIENT=0x0000000000000000000000000000000000000fee
export CZE_MAKE_INPUT_CMD=$ROOT/builder/tests/fake-make-input.sh CZE_PROVE_CMD=$ROOT/tests/pipeline_prove.sh
export CZE_READ_AS="$OPERATOR_PARTY $GATEWAY_PARTY"
export PIPELINE_PROVE_DELAY=${PIPELINE_PROVE_DELAY:-1} PIPELINE_TAMPER_FLAG=$WORK/tamper.flag PIPELINE_HOLD_FILE=$WORK/hold.file PIPELINE_PROVED_LOG=$WORK/proved.log
check() { "$PY" "$ROOT/tests/pipeline_check.py" "$@"; }
export CZE_SOURCE_COMMIT=${CZE_SOURCE_COMMIT:-$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || printf 'a%.0s' $(seq 40))}

echo "== block 1: an empty block, so that the persistent reth never has to go back to the genesis"
first=$(PIPELINE_PROVE_DELAY=0 "$PY" "$ROOT/builder/builder.py" once --read-as "$OPERATOR_PARTY" --read-as "$GATEWAY_PARTY") || fail "block 1 was not made: $first"
jq -e '.committed == true and .number == 1' <<<"$first" >/dev/null || fail "block 1 was not committed: $first"

echo "== the flood: $FLOOD_BLOCKS blocks of $TXS_PER_BLOCK transfers, all in reth's pool"
: > "$OUT/sent.txt"
send() { "$PY" "$ROOT/tests/demo_w1.py" plain "$1" | tee -a "$OUT/sent.txt" | tail -n 1 > /dev/null; }
send "$TXS_PER_BLOCK"
raw=$(rpc eth_getRawTransactionByHash "\"$(head -n 1 "$OUT/sent.txt")\"" | jq -r .result)
raw_bytes=$(( (${#raw} - 2) / 2 ))
[ "$raw_bytes" -gt 50 ] || fail "cannot read the size of a transfer: $raw"
CAP=$(( TXS_PER_BLOCK * raw_bytes + 8 ))   # three transfers fit, a fourth does not
total=$(( FLOOD_BLOCKS * TXS_PER_BLOCK ))
left=$(( total - TXS_PER_BLOCK ))
while [ "$left" -gt 0 ]; do n=$(( left < 100 ? left : 100 )); send "$n"; left=$(( left - n )); done
[ "$(wc -l < "$OUT/sent.txt")" = "$total" ] || fail "reth took $(wc -l < "$OUT/sent.txt") of $total transfers"
echo "$total transfers of $raw_bytes bytes sent; blocks hold $CAP bytes at most"

echo "== the lost-reply proxy, the watch of the two chains, and the builder at depth $DEPTH"
JOURNAL=$CZE_STATE_DIR/builder/journal
: > "$WORK/proxy.log"
background proxy python3 "$ROOT/tests/ledger_drop_proxy.py" "$PROXY_PORT" http://127.0.0.1:7575 "$WORK/drop.flag" "$WORK/proxy.log" "$WORK/hold.file" "${PIPELINE_HOLD_SECONDS:-4}"
for _ in $(seq 1 20); do curl -s -o /dev/null "http://127.0.0.1:$PROXY_PORT/v2/version" && break; sleep 0.5; done
background watch "$PY" "$ROOT/tests/pipeline_check.py" watch "$OUT/watch.txt" "$OUT/stop-watch"
provers=()
[ "$DEPTH" = 2 ] || provers=(--prover stand-in-a=http://127.0.0.1:9101 --prover stand-in-b=http://127.0.0.1:9102)   # two names: the stand-in ignores the URL
start_builder() {   # $1: the name of its log
  background "$1" env CZE_LEDGER_URL="http://127.0.0.1:$PROXY_PORT" "$PY" "$ROOT/builder/builder.py" run \
    --read-as "$OPERATOR_PARTY" --read-as "$GATEWAY_PARTY" --max-in-flight "$DEPTH" ${provers[@]+"${provers[@]}"} --max-block-tx-bytes "$CAP" --idle-ms 500 --test
  builder_pid=${pids[-1]}
}
start_builder builder

jstat() { check stats "$JOURNAL" --proved "$PIPELINE_PROVED_LOG" 2>/dev/null | jq -r ".$1" 2>/dev/null || echo 0; }
last=$(tail -n 1 "$OUT/sent.txt")
mined() { [ "$(rpc eth_getTransactionReceipt "\"$last\"" | jq -r '.result.blockNumber // empty')" != "" ]; }
final_number() { rpc eth_getBlockByNumber '"finalized",false' | jq -r '.result.number'; }
alive() { kill -0 "$builder_pid" 2>/dev/null || fail "the builder stopped"; }
deadline=$(( $(date +%s) + ${FLOOD_TIMEOUT:-3000} ))
overdue() { [ "$(date +%s)" -lt "$deadline" ] || fail "the flood did not finish in ${FLOOD_TIMEOUT:-3000} s: $(check stats "$JOURNAL" --proved "$PIPELINE_PROVED_LOG")"; }

# ---- the refusal, at a tenth of the flood: put the flag down until a dropped block that had its proof shows
at=$(( FLOOD_BLOCKS / 10 > 5 ? FLOOD_BLOCKS / 10 : 5 ))
until [ "$(jstat committed)" -ge "$at" ]; do alive; overdue; sleep 2; done
echo "== a refusal at N with N+1 proven (after $(jstat committed) blocks)"
[ "$DEPTH" = 2 ] || echo "   at depth 3 it must be the oldest of three, so that reth goes back three blocks"
proven=$(jstat cancelledProven); tries=0
while [ "$(jstat cancelledProven)" -le "$proven" ] || [ "$(jstat unwind)" -lt "$DEPTH" ]; do
  alive; overdue
  tries=$(( tries + 1 ))
  [ "$tries" -le 12 ] || fail "after $((tries - 1)) refusals no dropped block had its proof: $(check stats "$JOURNAL" --proved "$PIPELINE_PROVED_LOG")"
  : > "$PIPELINE_TAMPER_FLAG"
  for _ in $(seq 1 90); do
    [ ! -e "$PIPELINE_TAMPER_FLAG" ] && [ "$(jstat refused)" -ge "$tries" ] && break
    sleep 1
  done
  sleep 5   # the dropped block is written when the refusal is
  echo "refusal $tries: $(check stats "$JOURNAL" --proved "$PIPELINE_PROVED_LOG")"
done

# ---- the lost reply, at a third of the flood
at=$(( FLOOD_BLOCKS / 3 > 12 ? FLOOD_BLOCKS / 3 : 12 ))
until [ "$(jstat committed)" -ge "$at" ]; do alive; overdue; sleep 2; done
echo "== a lost reply while the command commits (after $(jstat committed) blocks)"
: > "$WORK/drop.flag"
for _ in $(seq 1 120); do grep -q '^dropped ' "$WORK/proxy.log" && break; alive; sleep 1; done
grep -q '^dropped ' "$WORK/proxy.log" || fail "no Advance was sent while the drop flag was down"
for _ in $(seq 1 180); do [ "$(jstat unknownCommitted)" -ge 1 ] && break; alive; sleep 1; done
[ "$(jstat unknownCommitted)" -ge 1 ] || fail "the command whose reply was lost was not settled as committed: $(check stats "$JOURNAL" --proved "$PIPELINE_PROVED_LOG")"
echo "settled: $(check stats "$JOURNAL" --proved "$PIPELINE_PROVED_LOG")"

# ---- depth 3: kill -9 with three blocks in flight, then a restart, at half the flood
if [ "$DEPTH" = 3 ]; then
  at=$(( FLOOD_BLOCKS / 2 > 20 ? FLOOD_BLOCKS / 2 : 20 ))
  until [ "$(jstat committed)" -ge "$at" ]; do alive; overdue; sleep 2; done
  echo "== kill -9 with three blocks in flight (after $(jstat committed) blocks)"
  for _ in $(seq 1 600); do
    alive; overdue
    if [ "$(jstat inFlight)" -ge 3 ]; then
      kill -STOP "$builder_pid"   # held still, so that what is read is what is killed
      if [ "$(jstat inFlight)" -ge 3 ]; then break; fi
      kill -CONT "$builder_pid"
    fi
    sleep 0.2
  done
  [ "$(jstat inFlight)" -ge 3 ] || fail "three blocks were never in flight together: $(check stats "$JOURNAL" --proved "$PIPELINE_PROVED_LOG")"
  echo "in flight: $(jstat inFlight), committed: $(jstat committed)"
  kill -KILL "$builder_pid"
  for _ in $(seq 1 20); do kill -0 "$builder_pid" 2>/dev/null || break; sleep 0.2; done
  ! kill -0 "$builder_pid" 2>/dev/null || fail "the builder did not die"
  killed_at=$(jstat committed)
  start_builder builder-2
  for _ in $(seq 1 180); do [ "$(jstat restarted)" -ge 1 ] && break; alive; sleep 1; done
  [ "$(jstat restarted)" -ge 1 ] || fail "the restarted builder did not give up the blocks it found in flight: $(check stats "$JOURNAL" --proved "$PIPELINE_PROVED_LOG")"
  for _ in $(seq 1 180); do [ "$(jstat committed)" -gt "$killed_at" ] && break; alive; sleep 1; done
  [ "$(jstat committed)" -gt "$killed_at" ] || fail "the restarted builder committed nothing"
  echo "restarted: $(check stats "$JOURNAL" --proved "$PIPELINE_PROVED_LOG")"
fi

# ---- the rest of the flood
until mined && [ "$(( $(final_number) ))" -ge "$(( $(rpc eth_getTransactionReceipt "\"$last\"" | jq -r '.result.blockNumber') ))" ]; do alive; overdue; sleep 2; done
echo "== all $total transfers are in final blocks; stopping the builder"
kill -TERM "$builder_pid"
for _ in $(seq 1 60); do kill -0 "$builder_pid" 2>/dev/null || break; sleep 1; done
! kill -0 "$builder_pid" 2>/dev/null || fail "the builder did not stop on SIGTERM"
touch "$OUT/stop-watch"; sleep 3

echo "== the checks"
check journal "$JOURNAL" --sent "$OUT/sent.txt" --blocks $(( FLOOD_BLOCKS * 9 / 10 )) || fail "the journal broke a rule (above)"
check chain "$JOURNAL" --sent "$OUT/sent.txt" || fail "reth and the journal disagree (above)"
check settled || fail "Canton's head is not reth's finalized block (above)"
grep -v '^samples' "$OUT/watch.txt" | head -n 5 | grep . && fail "the two chains disagreed during the run (above)"
samples=$(sed -n 's/^samples \([0-9]*\) errors.*/\1/p' "$OUT/watch.txt")
[ "${samples:-0}" -ge 20 ] || fail "the watch of the two chains made ${samples:-0} comparisons"
stats=$(check stats "$JOURNAL" --proved "$PIPELINE_PROVED_LOG"); echo "$stats" | tee "$OUT/stats.json"
jq -e '.refused >= 1 and .cancelledProven >= 1 and .unknown >= 1 and .unknownCommitted >= 1 and .lost == 0' <<<"$stats" >/dev/null || fail "a fault did not show in the journal: $stats"
jq -e --argjson depth "$DEPTH" '.unwind >= $depth' <<<"$stats" >/dev/null || fail "reth never went back $DEPTH blocks at once: $stats"
kills=0
if [ "$DEPTH" = 3 ]; then
  kills=1
  jq -e '.restarted >= 1' <<<"$stats" >/dev/null || fail "no block was found in flight by the restart: $stats"
  jq -e '.provers == 2' <<<"$stats" >/dev/null || fail "not both provers took a proof: $stats"
fi
submits=$(jq .submitted <<<"$stats")
seen=$(grep -cE '^(forwarded|dropped) ' "$WORK/proxy.log")
# a run killed between writing "submitted" and sending the command leaves one line more, and none else can
[ "$seen" -le "$submits" ] && [ "$submits" -le "$(( seen + kills ))" ] || fail "the proxy saw $(grep -cE '^(forwarded|dropped) ' "$WORK/proxy.log") submits, the journal has $submits"
cp "$WORK/proxy.log" "$WORK/proved.log" "$OUT/"
echo "== the pipeline scenario passed at depth $DEPTH: $stats"
