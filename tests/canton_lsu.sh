#!/usr/bin/env bash
# A logical synchronizer upgrade (LSU) under a running chain, on the local network: the synchronizer starts on protocol version LSU_FROM_PV (36)
# and is upgraded to LSU_TO_PV (37), serial + 1, while the builder keeps making blocks and transfers keep coming. It runs what
# tests/network_pipeline.sh runs: the real reth (network/reth/launch.sh, discovery off, no peers, persistent), the real Canton with the real Daml
# package, the real builder, the real sidecar for `legs`, and the rehearsal's stand-ins for the proof and for the sidecar's proof check
# (tests/demo_rehearsal.sh says what that leaves out). Canton gets a second sequencer and mediator for the successor (network/canton/lsu.conf), and
# a console that reaches the nodes over their admin APIs runs the upgrade (network/canton/lsu.canton): the announcement, the topology freeze, the
# move of the synchronizer nodes' ids, keys and topology state to the successor, and the participants' switch (LSU_SWITCH=auto: they move by
# themselves once the successor sequencer is announced; manual: each is moved by perform_manual_lsu).
#
# The run:
#   1. the chain, block 1, then the builder (`builder.py run`, depth LSU_DEPTH, an empty block every LSU_HEARTBEAT seconds) and a sender
#      (one plain transfer every LSU_SEND_EVERY seconds)
#   2. after LSU_BEFORE_SECONDS and at least 5 committed blocks: the upgrade, with its upgrade time LSU_LEAD_SECONDS after the announcement
#   3. once every participant is on the successor: LSU_AFTER_BLOCKS more committed blocks, then the sender stops, every transfer it sent
#      must be in a final block, and the builder stops
# Checks: the console's steps all ran (the freeze refused a new party; every participant on the successor; a new party allocated after it); the
# journal's rules and reth against the journal (tests/pipeline_check.py, as the pipeline scenario checks them); Canton's head is reth's finalized
# block, and reth's finalized block was never above Canton's head during the run; LSU_AFTER_BLOCKS blocks committed after the upgrade; the gap
# between the last commit before the upgrade time and the first after it is under LSU_MAX_GAP seconds (300); no transaction named lost.
# The record (tests/lsu_record.py) says what happened to the blocks in flight at the upgrade time.
#
# Settings: LSU_FROM_PV (36), LSU_TO_PV (37), LSU_SWITCH (auto), LSU_LEAD_SECONDS (60), LSU_BEFORE_SECONDS (60), LSU_AFTER_BLOCKS (10),
# LSU_DEPTH (2), LSU_HEARTBEAT (15), LSU_SEND_EVERY (2), LSU_MAX_GAP (300), PIPELINE_PROVE_DELAY (1, seconds a proof takes), LSU_TIMEOUT (1800,
# seconds for the whole run after the chain is up), LSU_SIDECAR_PORTS ("8085 8086": the operator's and the confirmer's stand-in sidecars; other
# ports are given to Canton in a third config file), LSU_OUT (a folder for the record, the journal and the logs; kept only when it is set,
# otherwise everything is deleted at the end). The files the upgrade exports (the synchronizer nodes' keys) stay in the run's own folder and are
# deleted with it. LSU_HOLD_SECONDS (0: off): the stand-in sidecars hold every call Canton makes while it validates a block for that many seconds,
# from LSU_HOLD_WINDOW (6) seconds before the upgrade time to one second after it, so that an Advance sent just before the upgrade time is still
# being confirmed when it passes (tests/demo_sidecar.py, DEMO_SIDECAR_HOLD_FILE). Needs Docker, Java 21, Rust, Python 3.12, jq, curl and network
# access. No GPU.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"
FROM_PV=${LSU_FROM_PV:-36}; TO_PV=${LSU_TO_PV:-37}; SWITCH=${LSU_SWITCH:-auto}
DEPTH=${LSU_DEPTH:-2}; AFTER_BLOCKS=${LSU_AFTER_BLOCKS:-10}; MAX_GAP=${LSU_MAX_GAP:-300}; HOLD=${LSU_HOLD_SECONDS:-0}; WINDOW=${LSU_HOLD_WINDOW:-6}
read -r OP_PORT CONF_PORT <<<"${LSU_SIDECAR_PORTS:-8085 8086}"
for v in "$FROM_PV" "$TO_PV" "$DEPTH" "$AFTER_BLOCKS" "$MAX_GAP" "$OP_PORT" "$CONF_PORT" "${LSU_LEAD_SECONDS:-60}" "${LSU_BEFORE_SECONDS:-60}" "$HOLD" "$WINDOW"; do
  case $v in ''|*[!0-9]*) echo "FAIL: a setting is not a whole number: '$v'" >&2; exit 1;; esac
done
case $SWITCH in auto|manual) ;; *) echo "FAIL: LSU_SWITCH is auto or manual" >&2; exit 1;; esac
WORK=$(mktemp -d)
OUT=${LSU_OUT:-$WORK/out}
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
    echo "--- the upgrade's console (LSU lines and errors)"; grep -E '^LSU|ERROR|GrpcRequest' "$NET/logs/lsu-console.log" 2>/dev/null | cut -c1-400 | tail -n 30 || true
    echo "--- the builder's log (tail)"; tail -n 30 "$NET/logs/builder.log" 2>/dev/null | cut -c1-400 || true
    echo "--- the last journal lines"; tail -q -n 12 "$CZE_STATE_DIR"/builder/journal/*.jsonl 2>/dev/null | cut -c1-400 || true
    echo "--- Canton warnings and errors"; grep -E 'WARN|ERROR' "$NET/logs/canton.log" 2>/dev/null | cut -c1-500 | tail -n 20 || true
  fi
  touch "$OUT/stop-watch" "$WORK/stop-sender" 2>/dev/null || true
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  [ ! -d "$CZE_STATE_DIR/builder/journal" ] || cp -r "$CZE_STATE_DIR/builder/journal" "$OUT/journal" 2>/dev/null || true
  cp "$NET/logs"/*.log "$OUT/" 2>/dev/null || true
  "$ROOT/network/reth/stop.sh" --wipe-persistent || true
  rm -rf "$WORK"   # the exported keys go with it; with LSU_OUT unset, the results too
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

echo "== the sidecars: the real one for legs, the stand-ins in front of it for verify (ports $OP_PORT, $CONF_PORT)"
VK=$(printf 'cd%.0s' $(seq 32)); RC=$(printf 'ef%.0s' $(seq 32)); PROOF=$(printf 'ee%.0s' $(seq 768))$VK$RC
cargo build --release --locked --manifest-path "$ROOT/sidecar/Cargo.toml"
background real-sidecar "$ROOT/sidecar/target/release/zk-sidecar" --program-vk "$VK" --root-c "$RC" --listen 127.0.0.1:9085
for port in "$OP_PORT" "$CONF_PORT"; do
  background "stand-in-$port" env DEMO_SIDECAR_HOLD_FILE="$WORK/hold" python3 "$ROOT/tests/demo_sidecar.py" "$port" 9085 "$VK" "$RC" "$PROOF"
done
for _ in $(seq 1 30); do curl -sf http://127.0.0.1:9085/api/v1/version >/dev/null && break; sleep 1; done

echo "== Canton on protocol version $FROM_PV, with the successor's sequencer2 and mediator2 waiting (network/canton/lsu.conf)"
CONF=(-c "$ROOT/network/canton/canton.conf" -c "$ROOT/network/canton/lsu.conf")
if [ "$OP_PORT $CONF_PORT" != "8085 8086" ]; then
  printf 'canton.participants.operator.parameters.engine.extensions.canton-zk-evm.port = %s\ncanton.participants.confirmer.parameters.engine.extensions.canton-zk-evm.port = %s\n' \
    "$OP_PORT" "$CONF_PORT" > "$WORK/sidecar-ports.conf"
  CONF+=(-c "$WORK/sidecar-ports.conf")
fi
background canton env CANTON_PROTOCOL_VERSION="$FROM_PV" java -Xmx4g -jar "$CANTON_JAR" daemon "${CONF[@]}" --bootstrap "$ROOT/network/canton/bootstrap.canton" --no-tty
canton_pid=${pids[-1]}
for _ in $(seq 1 600); do
  grep -q "BOOTSTRAP DONE" "$NET/logs/canton.log" && break
  kill -0 "$canton_pid" 2>/dev/null || fail "Canton stopped"
  sleep 1
done
grep -q "BOOTSTRAP DONE" "$NET/logs/canton.log" || fail "the bootstrap did not finish"
grep -qxF "SYNCHRONIZER PROTOCOL VERSION $FROM_PV" "$NET/logs/canton.log" || fail "the synchronizer is not on protocol version $FROM_PV"
python3 "$ROOT/network/canton/propose.py" --genesis-hash "${GENESIS_HASH#0x}" --genesis-state-root "${GENESIS_STATE_ROOT#0x}" --program-vk "$VK" --root-c "$RC" --rules-hash "$(printf '12%.0s' $(seq 32))" > "$NET/chain.json"
# shellcheck disable=SC1091
. "$CZE_STATE_DIR/canton/parties.env"

# The builder's settings, for `once` and `run` and for the checks.
export DEMO_PROOF_PROGRAM_VK=$VK DEMO_PROOF_ROOT_C=$RC
export CZE_LEDGER_USER=builder CZE_BUILDER_PARTY=$BUILDER_PARTY CZE_FEE_RECIPIENT=0x0000000000000000000000000000000000000fee
export CZE_MAKE_INPUT_CMD=$ROOT/builder/tests/fake-make-input.sh CZE_PROVE_CMD=$ROOT/tests/pipeline_prove.sh
export CZE_READ_AS="$OPERATOR_PARTY $GATEWAY_PARTY"
export PIPELINE_PROVE_DELAY=${PIPELINE_PROVE_DELAY:-1} PIPELINE_PROVED_LOG=$WORK/proved.log
check() { "$PY" "$ROOT/tests/pipeline_check.py" "$@"; }
export CZE_SOURCE_COMMIT=${CZE_SOURCE_COMMIT:-$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || printf 'a%.0s' $(seq 40))}

echo "== block 1: an empty block, so that the persistent reth never has to go back to the genesis"
first=$(PIPELINE_PROVE_DELAY=0 "$PY" "$ROOT/builder/builder.py" once --read-as "$OPERATOR_PARTY" --read-as "$GATEWAY_PARTY") || fail "block 1 was not made: $first"
jq -e '.committed == true and .number == 1' <<<"$first" >/dev/null || fail "block 1 was not committed: $first"

echo "== the builder at depth $DEPTH, the sender and the watch of the two chains"
JOURNAL=$CZE_STATE_DIR/builder/journal
: > "$OUT/sent.txt"
background watch "$PY" "$ROOT/tests/pipeline_check.py" watch "$OUT/watch.txt" "$OUT/stop-watch"
background builder "$PY" "$ROOT/builder/builder.py" run --read-as "$OPERATOR_PARTY" --read-as "$GATEWAY_PARTY" --max-in-flight "$DEPTH" \
  --idle-ms 500 --heartbeat-seconds "${LSU_HEARTBEAT:-15}" --test
builder_pid=${pids[-1]}
# One plain transfer every LSU_SEND_EVERY seconds until the stop file is there; each hash a line of sent.txt.
sender() {
  until [ -e "$WORK/stop-sender" ]; do
    "$PY" "$ROOT/tests/demo_w1.py" plain 1 >> "$OUT/sent.txt" 2>> "$NET/logs/sender.log" || echo "send failed at $(date -u +%T)" >> "$NET/logs/sender.log"
    sleep "${LSU_SEND_EVERY:-2}"
  done
}
sender & pids+=($!); sender_pid=$!
jstat() { check stats "$JOURNAL" 2>/dev/null | jq -r ".$1" 2>/dev/null || echo 0; }
alive() { kill -0 "$builder_pid" 2>/dev/null || fail "the builder stopped"; kill -0 "$canton_pid" 2>/dev/null || fail "Canton stopped"; }
deadline=$(( $(date +%s) + ${LSU_TIMEOUT:-1800} ))
overdue() { [ "$(date +%s)" -lt "$deadline" ] || fail "the run did not finish in ${LSU_TIMEOUT:-1800} s: $(check stats "$JOURNAL")"; }

start=$(date +%s)
until [ "$(( $(date +%s) - start ))" -ge "${LSU_BEFORE_SECONDS:-60}" ] && [ "$(jstat committed)" -ge 5 ]; do alive; overdue; sleep 2; done
echo "before the upgrade: $(check stats "$JOURNAL")"

echo "== the upgrade: protocol version $FROM_PV -> $TO_PV, upgrade time ${LSU_LEAD_SECONDS:-60} s after the announcement, $SWITCH switch"
mkdir -p "$WORK/lsu-export"
background lsu-console env LSU_EXPORT_DIR="$WORK/lsu-export" LSU_TO_PV="$TO_PV" LSU_LEAD_SECONDS="${LSU_LEAD_SECONDS:-60}" LSU_SWITCH="$SWITCH" \
  java -Xmx2g -jar "$CANTON_JAR" run "$ROOT/network/canton/lsu.canton" -c "$ROOT/network/canton/lsu-console.conf" --no-tty
console_pid=${pids[-1]}
if [ "$HOLD" != 0 ]; then
  # From WINDOW seconds before the upgrade time to one second after it, the stand-ins hold each validation call HOLD seconds.
  hold_validation() {
    local up=""
    for _ in $(seq 1 600); do up=$(sed -n 's/^LSU upgrade_time [^ ]* //p' "$NET/logs/lsu-console.log" 2>/dev/null); [ -n "$up" ] && break; sleep 0.5; done
    [ -n "$up" ] || return 0
    "$PY" -c '
import pathlib, sys, time, datetime as d
up = d.datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00")).timestamp()
hold = pathlib.Path(sys.argv[4])
time.sleep(max(0.0, up - float(sys.argv[2]) - time.time())); hold.write_text(sys.argv[3])
time.sleep(max(0.0, up + 1 - time.time())); hold.unlink(missing_ok=True)' "$up" "$WINDOW" "$HOLD" "$WORK/hold"
  }
  hold_validation & pids+=($!)
fi
while kill -0 "$console_pid" 2>/dev/null; do alive; overdue; sleep 2; done
wait "$console_pid" || fail "the upgrade's console failed (above)"
grep -E '^LSU ' "$NET/logs/lsu-console.log" | cut -c1-300
grep -q '^LSU DONE ' "$NET/logs/lsu-console.log" || fail "the upgrade did not finish"
grep -q '^LSU freeze_probe .* refused: ' "$NET/logs/lsu-console.log" || fail "a new party was not refused in the topology freeze"
grep -q '^LSU party_after .* allocated ' "$NET/logs/lsu-console.log" || fail "no new party could be allocated after the upgrade"
[ "$(grep -c '^LSU switched ' "$NET/logs/lsu-console.log")" = 3 ] || fail "not every participant is on the successor"
grep -q "TOPOLOGY_LSU_TOPOLOGY_FREEZE" "$NET/logs/lsu-console.log" || fail "the freeze's refusal is not Canton's TOPOLOGY_LSU_TOPOLOGY_FREEZE"
at_switch=$(jstat committed)

echo "== $AFTER_BLOCKS more blocks on the successor"
until [ "$(jstat committed)" -ge "$(( at_switch + AFTER_BLOCKS ))" ]; do alive; overdue; sleep 2; done
touch "$WORK/stop-sender"; wait "$sender_pid" 2>/dev/null || true
last=$(tail -n 1 "$OUT/sent.txt")
[ -n "$last" ] || fail "the sender sent nothing"
mined() { [ "$(rpc eth_getTransactionReceipt "\"$last\"" | jq -r '.result.blockNumber // empty')" != "" ]; }
final_number() { rpc eth_getBlockByNumber '"finalized",false' | jq -r '.result.number'; }
until mined && [ "$(( $(final_number) ))" -ge "$(( $(rpc eth_getTransactionReceipt "\"$last\"" | jq -r '.result.blockNumber') ))" ]; do alive; overdue; sleep 2; done
echo "== all $(wc -l < "$OUT/sent.txt") transfers are in final blocks; stopping the builder"
kill -TERM "$builder_pid"
for _ in $(seq 1 60); do kill -0 "$builder_pid" 2>/dev/null || break; sleep 1; done
! kill -0 "$builder_pid" 2>/dev/null || fail "the builder did not stop on SIGTERM"
touch "$OUT/stop-watch"; sleep 3

echo "== the record"
"$PY" "$ROOT/tests/lsu_record.py" "$JOURNAL" "$NET/logs/lsu-console.log" "$OUT/record.json" | tee "$OUT/record.txt"
if [ "$HOLD" != 0 ]; then
  echo "validation calls held ${HOLD} s around the upgrade time: $(cat "$FAKE_LOG.held" 2>/dev/null | wc -l)" | tee -a "$OUT/record.txt"
fi

echo "== the checks"
check journal "$JOURNAL" --sent "$OUT/sent.txt" || fail "the journal broke a rule (above)"
check chain "$JOURNAL" --sent "$OUT/sent.txt" || fail "reth and the journal disagree (above)"
check settled || fail "Canton's head is not reth's finalized block (above)"
if grep -qv '^samples' "$OUT/watch.txt"; then
  grep -v '^samples' "$OUT/watch.txt" | head -n 5 || true
  fail "the two chains disagreed during the run (above)"
fi
jq -e --argjson n "$AFTER_BLOCKS" '.commits.afterUpgrade >= $n' "$OUT/record.json" >/dev/null || fail "fewer than $AFTER_BLOCKS blocks committed after the upgrade"
jq -e --argjson g "$MAX_GAP" '.commits.gapAcrossUpgrade != null and .commits.gapAcrossUpgrade < $g' "$OUT/record.json" >/dev/null \
  || fail "the gap across the upgrade is not under $MAX_GAP s: $(jq -c .commits "$OUT/record.json")"
jq -e '.lost == 0' "$OUT/record.json" >/dev/null || fail "the journal names lost transactions"
echo "== the upgrade scenario passed: $(jq -c '{from: .upgrade.from, to: .upgrade.to, switch: .upgrade.switch, commits: .commits, inFlight: [.inFlightAtUpgrade[] | {number, outcome, reason}]}' "$OUT/record.json")"
