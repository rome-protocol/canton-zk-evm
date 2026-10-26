#!/usr/bin/env bash
# A chain that runs is switched to another program key (and a ZisK release) with the fork it is to run from a later time, on the real network
# (the local one: the pinned Canton with three participants, the real reth through network/reth/launch.sh with discovery off, the real builder, the real
# sidecar for the legs check). What is not real is the zero-knowledge proof, as in tests/demo_rehearsal.sh: a stand-in prover, and a stand-in in front of
# the sidecar for `verify2` that answers with the program key and the ZisK root it was started with, as the real sidecar answers with the ones it was
# started with. The stand-in therefore tells two keys apart exactly where the real sidecar does: the chain contract compares what the sidecar says
# with the key it holds.
#
#   1. The chain starts under Prague only: a copy of the genesis without osakaTime and without the Osaka blob entry (the chain settings the chains made
#      before Osaka had), reth on it in the persistent mode (launch.sh, discovery off), program key A, ZisK 1.3.1 (zisk=1.3.1 in the chain's guest.txt).
#      Blocks commit: the setup block and two deposits. The CLZ opcode (0x1e) does not exist on this chain.
#   2. The switch, in this order, the producer stopped throughout (the builder is run by hand, one block at a time, so none runs between the steps):
#        a. the new program on the prover: the prover is a stand-in here, so there is nothing to register;
#        b. the producer stops after its block (Canton's head and reth's head are the same);
#        c. the chain's genesis copy gets osakaTime = T (a time a few blocks ahead) and the Osaka blob entry, and reth restarts on its data: its head
#           and the hash of its genesis are what they were;
#        d. both sidecars restart with program key B, ZisK root B and --zisk-release 1.3.2, and the chain's guest.txt records zisk=1.3.2;
#        e. the operator proposes the program, the confirmer accepts it (network/external/setup.py --program-step: a dry run of each first, and
#           the dry runs change nothing); the chain contract then holds key B;
#        f. the producer starts again.
#   3. Blocks commit under key B, still before T (the Osaka rules are not yet in force: the block times are checked against T).
#   4. The old key is refused: the stand-ins and the stand-in prover are put back on key A, a block is built, and Canton refuses it with "the block
#      was proven by another program": the chain stays where it was and reth goes back. With key B again the same block commits.
#   5. The rollback before T: the same steps back to key A, ZisK 1.3.1 and a genesis copy without osakaTime; the chain holds key A and commits a block.
#   6. The switch to key B once more, with a new time T2 a few minutes ahead. Before T2 a transaction over the per-transaction gas cap is accepted and
#      mined, and the calls answer as on a chain without Osaka. A block at or after T2 commits, and then on reth: a modexp with an input over 1,024
#      bytes fails (EIP-7823), a transaction over 2^24 gas is refused by the pool (EIP-7825), P256VERIFY (0x100) and CLZ (0x1e) work, and a block
#      with a transaction at the cap and a contract that uses CLZ and P256VERIFY commits.
# Needs Docker, Java 21, Rust, Python 3.12, jq, curl, git and network access. No GPU.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"
WORK=$(mktemp -d)
export CZE_STATE_DIR=$WORK/state FAKE_LOG=$WORK/calls
CUR_OSAKA=none   # the osakaTime of the chain's genesis copy at this stage
export CZE_PERSIST=1   # reth's data stays in the state folder, so that reth can be restarted on it
NET=$CZE_STATE_DIR/net
DEMO=$CZE_STATE_DIR/demo
umask 077
mkdir -p "$NET/logs"
: > "$FAKE_LOG"; : > "$FAKE_LOG.refused"
fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo "== $* ($(date -u +%T))"; }
is() { [ "$1" = "$2" ] || fail "$3: got $1, expected $2"; }
pids=()
cleanup() {
  local status=$?
  if [ "$status" != 0 ]; then
    echo "--- Canton warnings and errors"; grep -E 'WARN|ERROR' "$NET/logs/canton.log" 2>/dev/null | cut -c1-700 | tail -n 40 || true
    echo "--- reth log (tail)"; docker logs --tail 30 "${RETH_CONTAINER:-cze-reth}" 2>&1 || true
  fi
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  "$ROOT/network/reth/stop.sh" --wipe-persistent || true
  rm -rf "${WORK:?}"
}
trap cleanup EXIT
background() { local name=$1; shift; nohup "$@" > "$NET/logs/$name.log" 2>&1 < /dev/null & pids+=($!); echo $! > "$NET/$name.pid"; }
stop_background() {   # the processes by name, and each one is gone (its port is free) when this returns
  local f pid
  for f in "$@"; do
    [ -f "${NET:?}/${f:?}.pid" ] || continue
    pid=$(cat "$NET/$f.pid"); kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
    ! kill -0 "$pid" 2>/dev/null || fail "$f (process $pid) did not stop"
    rm -f "${NET:?}/${f:?}.pid"
  done
}
rpc() { curl -sf -H 'content-type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":[${2:-}]}" "http://127.0.0.1:${RETH_HTTP_PORT:-8545}" | jq -c .result; }
wait_reth() {
  for _ in $(seq 1 60); do rpc eth_chainId >/dev/null 2>&1 && break; sleep 1; done
  rpc eth_chainId >/dev/null || fail "reth does not answer"
  "$ROOT/network/reth/check.sh"
}
# <number>: the time in the header of that block (or of "latest"), as a decimal number.
block_time() { printf '%d' "$(rpc eth_getBlockByNumber "\"$1\",false" | jq -r .timestamp)"; }

# The two program keys: A is the chain's, B is the one it is switched to (the key, the ZisK root and the rules hash of each).
VK_A=$(printf 'cd%.0s' $(seq 32)); RC_A=$(printf 'ef%.0s' $(seq 32)); RULES_A=$(printf '12%.0s' $(seq 32))
VK_B=$(printf 'ab%.0s' $(seq 32)); RC_B=$(printf '34%.0s' $(seq 32)); RULES_B=$(printf '56%.0s' $(seq 32))
PROGRAM_A="$VK_A/$RC_A/$RULES_A"; PROGRAM_B="$VK_B/$RC_B/$RULES_B"
SWITCH_T_SECONDS=${CZE_SWITCH_T_SECONDS:-900}   # how far ahead of the first switch T is: the stages up to the rollback happen before it
SWITCH_T2_SECONDS=${CZE_SWITCH_T2_SECONDS:-300}   # and of the second switch T2 is: the chain commits a block before it and then waits for it

step "the demo's keys and funded genesis"
"$ROOT/demo/prepare.sh"
export CZE_GENESIS_FILE=$DEMO/genesis.json
PY=$CZE_STATE_DIR/venv/bin/python3
evm() { "$PY" "$ROOT/demo/evm.py" "$@"; }
canton() { "$PY" "$ROOT/demo/canton.py" "$@"; }

step "reth on a Prague-only genesis, through launch.sh (persistent, discovery off)"
# network/make-state.sh makes the genesis copy (the demo's funded accounts and the gateway) and refuses chain settings other than network/genesis.json's,
# which has Osaka from the start. The copy this chain runs from is that one without osakaTime and without the Osaka blob entry. launch.sh is run on
# data that is there already (CZE_RESUME), which is what a chain that runs has; the folder only has to be non-empty, reth makes its database in it.
"$ROOT/network/make-state.sh"
jq -e '.config.osakaTime == 0 and (.config.blobSchedule | has("osaka"))' "$CZE_STATE_DIR/genesis.json" >/dev/null || fail "the base genesis is not the one with Osaka from the start"
jq 'del(.config.osakaTime) | del(.config.blobSchedule.osaka)' "$CZE_STATE_DIR/genesis.json" > "$CZE_STATE_DIR/genesis.json.new"
mv "$CZE_STATE_DIR/genesis.json.new" "$CZE_STATE_DIR/genesis.json"; chmod 644 "$CZE_STATE_DIR/genesis.json"
jq -e '.config | has("osakaTime") | not' "$CZE_STATE_DIR/genesis.json" >/dev/null || fail "the genesis copy still has osakaTime"
mkdir -p "$CZE_STATE_DIR/reth-data"; : > "$CZE_STATE_DIR/reth-data/.keep"
CZE_RESUME=1 "$ROOT/network/reth/launch.sh"
wait_reth
GENESIS_HASH=$(rpc eth_getBlockByNumber '"0x0",false' | jq -r .hash)
GENESIS_STATE_ROOT=$(rpc eth_getBlockByNumber '"0x0",false' | jq -r .stateRoot)
# The CLZ opcode (Osaka) is not in this chain: the call fails, and a call that fails has no result.
CLZ_ADDR=0x00000000000000000000000000000000000000c1
CLZ_CODE=0x$(printf '6001%s600052%s' 1e 60206000f3)   # PUSH1 1, CLZ, PUSH1 0, MSTORE, PUSH1 32, PUSH1 0, RETURN
clz() { rpc eth_call "{\"to\":\"$CLZ_ADDR\"},\"latest\",{\"$CLZ_ADDR\":{\"code\":\"$CLZ_CODE\"}}" || true; }
is "$(clz)" null "the answer of CLZ on the Prague-only chain (it has no such opcode)"

step "the Daml package, and the sidecars on key A: the real one for legs, the stand-in in front of it for verify2"
tools=$("$ROOT/network/canton/fetch.sh")
CANTON_JAR=$(sed -n 's/^CANTON_JAR=//p' <<<"$tools")
export CZE_TOOLS_DIR=${CZE_TOOLS_DIR:-$CZE_STATE_DIR/tools}
CZE_DAR=$("$ROOT/network/canton/build-dar.sh"); export CZE_DAR
"$ROOT/network/canton/dar-id.sh" "$CZE_DAR" > "$NET/dar.txt"
cargo build --release --locked --manifest-path "$ROOT/sidecar/Cargo.toml"
# <vk> <root> <zisk release>: the three sidecar processes of a chain with that key (the real one, and a stand-in on each port Canton calls).
start_sidecars() {
  local vk=$1 rc=$2 release=$3 proof port
  proof=$(printf 'ee%.0s' $(seq 768))$vk$rc
  background real-sidecar "$ROOT/sidecar/target/release/zk-sidecar" --program-vk "$vk" --root-c "$rc" --zisk-release "$release" --listen 127.0.0.1:9085
  for port in 8085 8086; do
    background "stand-in-$port" python3 "$ROOT/tests/demo_sidecar.py" "$port" 9085 "$vk" "$rc" "$proof"
  done
  for _ in $(seq 1 30); do curl -sf http://127.0.0.1:9085/api/v1/version >/dev/null && break; sleep 1; done
  curl -sf http://127.0.0.1:9085/api/v1/version >/dev/null || fail "the real sidecar does not answer"
  for port in 8085 8086; do
    for _ in $(seq 1 30); do curl -sf "http://127.0.0.1:$port/" >/dev/null && break; sleep 1; done
    curl -sf "http://127.0.0.1:$port/" >/dev/null || fail "the stand-in on $port does not answer"
  done
  # The fake prover writes proofs of this key, which the stand-ins accept.
  export DEMO_PROOF_PROGRAM_VK=$vk DEMO_PROOF_ROOT_C=$rc
}
start_sidecars "$VK_A" "$RC_A" 1.3.1

step "Canton, and the chain under key A"
background canton java -Xmx3g -jar "$CANTON_JAR" daemon -c "$ROOT/network/canton/canton.conf" --bootstrap "$ROOT/network/canton/bootstrap.canton" --no-tty
for _ in $(seq 1 600); do
  grep -q "BOOTSTRAP DONE" "$NET/logs/canton.log" && break
  kill -0 "$(cat "$NET/canton.pid")" 2>/dev/null || fail "Canton stopped"
  sleep 1
done
grep -q "BOOTSTRAP DONE" "$NET/logs/canton.log" || fail "the bootstrap did not finish"
python3 "$ROOT/network/canton/propose.py" --genesis-hash "${GENESIS_HASH#0x}" --genesis-state-root "${GENESIS_STATE_ROOT#0x}" --program-vk "$VK_A" --root-c "$RC_A" --rules-hash "$RULES_A" | tee "$NET/chain.json"
# The chain's record of its guest, as network/up.sh writes it, with the ZisK release the chain runs under.
write_guest() {   # <vk> <root> <rules> <zisk release>
  printf 'elf_sha256=%s\nprogramVK=0x%s\nrootC=0x%s\nrulesHash=%s\nzisk=%s\n' "$(printf '00%.0s' $(seq 32))" "$1" "$2" "$3" "$4" > "$NET/guest.txt"
}
write_guest "$VK_A" "$RC_A" "$RULES_A" 1.3.1
# shellcheck disable=SC1091
. "$CZE_STATE_DIR/canton/parties.env"
export CZE_MAKE_INPUT_CMD=$ROOT/builder/tests/fake-make-input.sh CZE_PROVE_CMD=$ROOT/tests/demo_fake_prove.sh

# <ZkChain|BlockRecord|DepositRequest|ProgramProposal>: the active contracts of that template, as tests/demo_package_probe.py prints them.
probe() { "$PY" "$ROOT/tests/demo_package_probe.py" "$CZE_STATE_DIR" "$1"; }
chain_programs() { local one; one=$(probe ZkChain | jq -c '.programs'); [ "$(jq length <<<"$one")" = 1 ] || fail "not exactly one ZkChain: $one"; jq -r '.[0]' <<<"$one"; }
head_number() { canton status | jq -r '.chain[0].headNumber'; }
# One builder run: prints the builder's JSON line; the exit status is the builder's.
build() {
  CZE_GENESIS=$CZE_STATE_DIR/genesis.json CZE_LEDGER_USER=builder CZE_BUILDER_PARTY=$BUILDER_PARTY CZE_FEE_RECIPIENT=0x0000000000000000000000000000000000000fee \
    "$PY" "$ROOT/builder/builder.py" once --read-as "$OPERATOR_PARTY" --read-as "$GATEWAY_PARTY" --disclosed "$DEMO/disclosed.json"
}
# <lines of $FAKE_LOG before the builder ran>: every input the builder made since was made from the chain's own genesis copy (the file reth reads),
# and that file has the osakaTime of the current stage (none: no osakaTime). The guest stops on any config but the one it was built from.
check_inputs() {
  local gen=$CZE_STATE_DIR/genesis.json n=0 line file
  while read -r line; do
    read -r _ _ _ file _ <<<"$line"
    [ "$file" = "$gen" ] || fail "make-input got $file, not the chain's genesis copy $gen"
    n=$((n + 1))
  done < <(tail -n +$(( $1 + 1 )) "$FAKE_LOG" | grep '^make-input ')
  [ "$n" -ge 1 ] || fail "the builder made no input"
  if [ "$CUR_OSAKA" = none ]; then jq -e '.config | has("osakaTime") | not' "$gen" >/dev/null || fail "the genesis copy has an osakaTime, the stage has none"
  else jq -e --argjson t "$CUR_OSAKA" '.config.osakaTime == $t' "$gen" >/dev/null || fail "the genesis copy's osakaTime is not $CUR_OSAKA"; fi
}
# <block number> <legs> <what>: one block commits, Canton's head is that block, and reth's finalized block is the builder's.
block() {
  local out status lines
  lines=$(wc -l < "$FAKE_LOG")
  set +e; out=$(build); status=$?; set -e
  echo "$out" | jq -c .
  check_inputs "$lines"
  is "$status" 0 "the builder's exit status for $3 ($out)"
  is "$(jq -r .committed <<<"$out")" true "$3 committed"
  is "$(jq -r .number <<<"$out")" "$1" "$3's block number"
  is "$(jq -r .legs <<<"$out")" "$2" "$3's legs"
  is "$(head_number)" "$1" "Canton's head after $3"
  is "$(rpc eth_getBlockByNumber '"finalized",false' | jq -r .hash)" "$(jq -r .blockHash <<<"$out")" "reth's finalized block after $3"
}
# <label>: U deposits 10 TKB and claims 10 wTKB.
deposit() {
  local made id before after=""
  before=$(probe DepositRequest | jq '.contracts | length')
  made=$(canton deposit "$1" "$U_ADDR" 10); id=$(jq -r .depositId <<<"$made")
  evm claim u "$id" "$WTKB" 10 | jq -r .tx > /dev/null
  for _ in $(seq 1 30); do   # the request reaches the operator's participant a moment after the depositor's commit
    after=$(probe DepositRequest | jq '.contracts | length')
    [ "$after" -gt "$before" ] && break
    sleep 1
  done
  [ "$after" -gt "$before" ] || fail "the request of $1 did not reach the operator's participant"
}
U_ADDR=$(jq -r .u "$DEMO/addresses.json")

step "stage 1: the chain under key A, Prague only"
is "$(chain_programs)" "$PROGRAM_A" "the program the chain holds at the start"
canton upload-dars >/dev/null
canton setup >/dev/null
evm deploy | jq -r .tx > /dev/null
made=$(evm register v "Wrapped TKB" wTKB); WTKB=$(jq -r .token <<<"$made")
block 1 0 "the setup block under key A"
canton register-token "$WTKB" >/dev/null
canton accept u >/dev/null
deposit dep-1
block 2 1 "the first deposit's block under key A"
deposit dep-2
block 3 1 "the second deposit's block under key A"
is "$(evm wrapped "$WTKB" "$U_ADDR" finalized | jq -c .)" '{"balance":"20.0","supply":"20.0"}' "U's wTKB under key A"
is "$(clz)" null "the answer of CLZ before the switch"

# The switch of a running chain, in the order the README gives: <label> <vk> <root> <rules> <ZisK release> <osakaTime, or "none" to take it away> <Canton's head>.
# The producer is stopped throughout (the builder is run by hand, one block at a time, so none runs between the steps).
switch_program() {
  local label=$1 vk=$2 rc=$3 rules=$4 release=$5 osaka=$6 head=$7 head_hash next r
  P_VK=$vk; P_RC=$rc; P_RULES=$rules
  echo "a. the new program on the prover: the prover is a stand-in, there is nothing to register"
  echo "a2. the operator proposes the program while the producer still runs: the pause does not wait for a change delay (there is none on this chain)"
  r=$(program_step 7575 propose --dry-run); jq -e '.dryRun == true and .submitted == false' <<<"$r" >/dev/null || fail "the dry run of the program proposal: $r"
  is "$(probe ProgramProposal | jq '.contracts | length')" 0 "the program proposals after the dry run"
  r=$(program_step 7575 propose); jq -e '.submitted == true and .alreadyProposed == false' <<<"$r" >/dev/null || fail "the program proposal: $r"
  [ "$(chain_programs)" != "$vk/$rc/$rules" ] || fail "the chain holds the program of $label before the acceptance"
  CUR_OSAKA=$osaka
  echo "b. the producer is stopped: no builder runs from here until step f"
  ! pgrep -f "builder/builder.py" >/dev/null || fail "a builder is running"
  head_hash=$(rpc eth_getBlockByNumber '"latest",false' | jq -r .hash)
  is "$(head_number)" "$head" "Canton's head at the switch to $label"
  is "$(printf '%d' "$(rpc eth_blockNumber | jq -r .)")" "$head" "reth's head at the switch to $label"
  echo "c. osakaTime = $osaka in the genesis copy, and reth restarts on its data"
  if [ "$osaka" = none ]; then
    jq 'del(.config.osakaTime) | del(.config.blobSchedule.osaka)' "$CZE_STATE_DIR/genesis.json" > "$CZE_STATE_DIR/genesis.json.new"
  else
    jq --argjson t "$osaka" --slurpfile base "$ROOT/network/genesis.json" '.config.osakaTime = $t | .config.blobSchedule.osaka = $base[0].config.blobSchedule.osaka' "$CZE_STATE_DIR/genesis.json" > "$CZE_STATE_DIR/genesis.json.new"
  fi
  mv "$CZE_STATE_DIR/genesis.json.new" "$CZE_STATE_DIR/genesis.json"; chmod 644 "$CZE_STATE_DIR/genesis.json"
  # The only change to the chain settings is the Osaka entries: with osakaTime = 0 they are the base genesis's settings.
  if [ "$osaka" = none ]; then
    jq -e --slurpfile base "$ROOT/network/genesis.json" '(.config | has("osakaTime") | not) and ((.config | .osakaTime = 0 | .blobSchedule.osaka = $base[0].config.blobSchedule.osaka) == $base[0].config)' "$CZE_STATE_DIR/genesis.json" >/dev/null \
      || fail "the genesis copy for $label differs from the base genesis in more than the Osaka entries"
  else
    jq -e --argjson t "$osaka" --slurpfile base "$ROOT/network/genesis.json" '.config.osakaTime == $t and (.config | .osakaTime = 0) == $base[0].config' "$CZE_STATE_DIR/genesis.json" >/dev/null \
      || fail "the new genesis copy differs from the base genesis in more than osakaTime"
  fi
  docker stop -t 60 "${RETH_CONTAINER:-cze-reth}" >/dev/null
  docker rm -f "${RETH_CONTAINER:-cze-reth}" >/dev/null
  CZE_PERSIST=1 CZE_RESUME=1 "$ROOT/network/reth/launch.sh"
  wait_reth
  is "$(rpc eth_getBlockByNumber '"0x0",false' | jq -r .hash)" "$GENESIS_HASH" "the hash of reth's genesis after the restart for $label"
  is "$(rpc eth_getBlockByNumber '"latest",false' | jq -r .hash)" "$head_hash" "reth's head after the restart for $label"
  is "$(printf '%d' "$(rpc eth_blockNumber | jq -r .)")" "$head" "reth's head number after the restart for $label"
  # reth's own view of the fork schedule, where its eth_config answers: the next fork is Osaka at T (and none when it is taken away).
  next=$(rpc eth_config 2>/dev/null | jq -r '.next.activationTime // empty' || true)
  if [ "$osaka" != none ] && [ -n "$next" ]; then is "$next" "$osaka" "the activation time of the next fork, as reth says it"
  elif [ "$osaka" = none ] && [ -n "$next" ]; then fail "reth names a next fork ($next) after Osaka was taken away"
  else echo "   (reth's eth_config says no next fork, or does not answer: not checked here)"; fi
  echo "d. both sidecars restart with the key of $label and --zisk-release $release, and the chain's guest.txt records zisk=$release"
  stop_background real-sidecar stand-in-8085 stand-in-8086
  sleep 1
  start_sidecars "$vk" "$rc" "$release"
  write_guest "$vk" "$rc" "$rules" "$release"
  is "$(sed -n 's/^zisk=//p' "$NET/guest.txt")" "$release" "the ZisK release recorded in guest.txt"
  ps -p "$(cat "$NET/real-sidecar.pid")" -o args= | grep -q -- "--zisk-release $release" || fail "the real sidecar does not run with --zisk-release $release"
  echo "e. the confirmer accepts the program the operator proposed before the pause, a dry run first"
  r=""
  for _ in $(seq 1 30); do   # the proposal reaches the confirmer's participant a moment after the operator's commit
    r=$(program_step 7576 accept --dry-run 2>/dev/null) && break
    r=""; sleep 1
  done
  jq -e '.step == "accept" and .dryRun == true and .submitted == false' <<<"$r" >/dev/null || fail "the dry run of the program acceptance: $r"
  r=$(chain_programs); [ "$r" != "$vk/$rc/$rules" ] || fail "the chain holds the program of $label before the acceptance"
  r=$(program_step 7576 accept); jq -e '.submitted == true' <<<"$r" >/dev/null || fail "the program acceptance: $r"
  is "$(chain_programs)" "$vk/$rc/$rules" "the program the chain holds after the acceptance"
  is "$(probe ProgramProposal | jq '.contracts | length')" 0 "the program proposals after the acceptance (it is used up)"
  is "$(head_number)" "$head" "Canton's head after the switch (no block was made in between)"
  echo "f. the producer starts again"
}
# The program of the switch that is running is P_VK, P_RC and P_RULES (set by switch_program).
program_step() {   # <participant port> <propose|accept> [--dry-run]: network/external/setup.py --program-step on one participant, which has no login here
  local port=$1 step=$2; shift 2
  CZE_LEDGER_NO_AUTH=1 python3 "$ROOT/network/external/setup.py" --ledger-url "http://127.0.0.1:$port" --program-step "$step" --program-vk "$P_VK" --root-c "$P_RC" --rules-hash "$P_RULES" "$@" 2> "$WORK/setup.err" \
    || { cat "$WORK/setup.err" >&2; fail "setup.py --program-step $step on $port failed"; }
}

step "stage 2: the switch to key B and ZisK 1.3.2, osakaTime = T in the chain's genesis copy"
T=$(( $(date +%s) + SWITCH_T_SECONDS ))
switch_program B "$VK_B" "$RC_B" "$RULES_B" 1.3.2 "$T" 3

step "stage 3: blocks under key B, before T"
deposit dep-3
block 4 1 "the first block under key B"
deposit dep-4
block 5 1 "the second block under key B"
is "$(evm wrapped "$WTKB" "$U_ADDR" finalized | jq -c .)" '{"balance":"40.0","supply":"40.0"}' "U's wTKB under key B"
[ "$(block_time latest)" -lt "$T" ] || fail "block 5 is at $(block_time latest), not before T = $T: raise CZE_SWITCH_T_SECONDS (it is $SWITCH_T_SECONDS)"
is "$(clz)" null "the answer of CLZ before T"

step "stage 4: a block proven under the old key A is refused, and the same block commits under key B"
deposit dep-5
stop_background real-sidecar stand-in-8085 stand-in-8086
sleep 1
start_sidecars "$VK_A" "$RC_A" 1.3.1
lines=$(wc -l < "$FAKE_LOG")
set +e; out=$(build); status=$?; set -e
check_inputs "$lines"
echo "$out" | jq -c '{committed, rejected, reason: (.reason // "" | .[0:300])}'
is "$status" 2 "the builder's exit status for the block under the old key"
is "$(jq -r .committed <<<"$out")" false "the block under the old key committed"
jq -e '.rejected == true and (.reason | contains("the block was proven by another program"))' <<<"$out" >/dev/null || fail "the refusal of the old key is not the chain contract's: $out"
is "$(head_number)" 5 "Canton's head after the refused block"
is "$(chain_programs)" "$PROGRAM_B" "the program the chain holds after the refused block"
is "$(rpc eth_getBlockByNumber '"latest",false' | jq -r .number)" 0x5 "reth's head after the refused block (it went back)"
stop_background real-sidecar stand-in-8085 stand-in-8086
sleep 1
start_sidecars "$VK_B" "$RC_B" 1.3.2
block 6 1 "the block of the deposit refused under key A, now under key B"
[ "$(block_time latest)" -lt "$T" ] || fail "block 6 is at $(block_time latest), not before T = $T: raise CZE_SWITCH_T_SECONDS (it is $SWITCH_T_SECONDS)"

step "stage 5: the rollback before T: the chain goes back to key A, ZisK 1.3.1 and Prague only, and commits under A"
[ "$(date +%s)" -lt "$T" ] || fail "T = $T has passed before the rollback: raise CZE_SWITCH_T_SECONDS (it is $SWITCH_T_SECONDS)"
switch_program A "$VK_A" "$RC_A" "$RULES_A" 1.3.1 none 6
deposit dep-6
block 7 1 "the block under key A after the rollback"
is "$(evm wrapped "$WTKB" "$U_ADDR" finalized | jq -c .)" '{"balance":"60.0","supply":"60.0"}' "U's wTKB after the rollback"
is "$(clz)" null "the answer of CLZ after the rollback"

# The Osaka rules, as reth applies them at its newest block. <before|after>: the answers when the newest block is before the activation time, or at or after it.
# eth_call has no result when the call fails, as in the check of CLZ above.
ZERO31=$(printf '00%.0s' $(seq 31)); ONE_WORD="\"0x${ZERO31}01\""
call_data() { rpc eth_call "{\"to\":\"$1\",\"data\":\"$2\"},\"latest\"" || true; }
osaka_calls() {
  local when=$1 r modexp=0x0000000000000000000000000000000000000005 p256=0x0000000000000000000000000000000000000100
  [ "$(call_data "$modexp" "$("$PY" "$ROOT/tests/demo_osaka.py" modexp 1024)")" != null ] || fail "modexp with a 1,024-byte base fails ($when)"
  r=$(rpc eth_call "{\"data\":\"$("$PY" "$ROOT/tests/demo_osaka.py" initcode)\"},\"latest\"" || true)
  if [ "$when" = before ]; then
    [ "$(call_data "$modexp" "$("$PY" "$ROOT/tests/demo_osaka.py" modexp 1025)")" != null ] || fail "modexp with a 1,025-byte base fails before the activation time"
    is "$(call_data "$p256" "$("$PY" "$ROOT/tests/demo_osaka.py" p256 valid)")" '"0x"' "the answer of address 0x100 before the activation time (nothing is there)"
    is "$(clz)" null "the answer of CLZ before the activation time"
    is "$r" null "the contract that needs CLZ and P256VERIFY, run as a call, before the activation time"
  else
    is "$(call_data "$modexp" "$("$PY" "$ROOT/tests/demo_osaka.py" modexp 1025)")" null "modexp with a 1,025-byte base after the activation time (EIP-7823)"
    is "$(call_data "$p256" "$("$PY" "$ROOT/tests/demo_osaka.py" p256 valid)")" "$ONE_WORD" "P256VERIFY on a valid signature (EIP-7951)"
    is "$(call_data "$p256" "$("$PY" "$ROOT/tests/demo_osaka.py" p256 invalid)")" '"0x"' "P256VERIFY on a signature with a changed hash"
    is "$(clz)" "\"0x${ZERO31}ff\"" "CLZ of 1 (EIP-7939)"
    is "$r" '"0x"' "the contract that needs CLZ and P256VERIFY, run as a call, after the activation time"
  fi
}
send_tx() { "$PY" "$ROOT/tests/demo_osaka.py" send "$DEMO" "$@"; }   # prints {"sent": hash} or {"refused": reason}
receipt_status() { rpc eth_getTransactionReceipt "\"$1\"" | jq -r '.status + " " + .blockNumber'; }
CAP=16777216   # 2^24, the most gas one transaction may have once Osaka rules (EIP-7825)

step "stage 6: the switch to key B and ZisK 1.3.2 again, osakaTime = T2, and the chain past T2"
T2=$(( $(date +%s) + SWITCH_T2_SECONDS ))
switch_program B "$VK_B" "$RC_B" "$RULES_B" 1.3.2 "$T2" 7
# Before T2 the old rules are in force: a transaction over the cap is accepted by the pool and mined, and the calls answer as on a chain without Osaka.
before_tx=$(send_tx cap $((CAP + 1))); jq -e 'has("sent")' <<<"$before_tx" >/dev/null || fail "the pool refused a transaction over the cap before T2: $before_tx"
deposit dep-7
block 8 1 "the block under key B before T2, with a transaction over the gas cap"
[ "$(block_time latest)" -lt "$T2" ] || fail "block 8 is at $(block_time latest), not before T2 = $T2: raise CZE_SWITCH_T2_SECONDS (it is $SWITCH_T2_SECONDS)"
is "$(receipt_status "$(jq -r .sent <<<"$before_tx")")" "0x1 0x8" "the receipt of the transaction over the cap, mined before T2"
osaka_calls before
echo "waiting for T2 = $T2"
while [ "$(date +%s)" -le "$T2" ]; do sleep 2; done
deposit dep-8
block 9 1 "the first block at or after T2, under key B"
[ "$(block_time latest)" -ge "$T2" ] || fail "block 9 is at $(block_time latest), before T2 = $T2"
osaka_calls after
refused=$(send_tx cap $((CAP + 1)))
jq -e 'has("refused")' <<<"$refused" >/dev/null || fail "the pool took a transaction over the gas cap after T2 (EIP-7825): $refused"
echo "the pool's answer: $(jq -r .refused <<<"$refused" | cut -c1-200)"
at_cap=$(send_tx cap "$CAP"); jq -e 'has("sent")' <<<"$at_cap" >/dev/null || fail "the pool refused a transaction at the gas cap after T2: $at_cap"
uses=$(send_tx create); jq -e 'has("sent")' <<<"$uses" >/dev/null || fail "the pool refused the contract that uses CLZ and P256VERIFY: $uses"
block 10 0 "the block with a transaction at the gas cap and the contract that uses CLZ and P256VERIFY"
is "$(receipt_status "$(jq -r .sent <<<"$at_cap")")" "0x1 0xa" "the receipt of the transaction at the gas cap"
is "$(receipt_status "$(jq -r .sent <<<"$uses")")" "0x1 0xa" "the receipt of the contract that uses CLZ and P256VERIFY (it reverts unless both work)"
is "$(chain_programs)" "$PROGRAM_B" "the program the chain holds at the end"
echo "PASS: the chain was switched from key A to key B at block 3, committed blocks 4 to 6 under B before T = $T and refused a block under A, went back to A and committed block 7 before T, then was switched to B again with T2 = $T2 at block 7 and committed blocks 8 to 10 under B: before T2 the Prague rules, after it the Osaka rules (modexp over 1,024 bytes refused, a transaction over 2^24 gas refused by the pool, P256VERIFY and CLZ working and in a committed block)"
