#!/usr/bin/env bash
# A chain that runs is moved to the next version of the Daml package, its gas cap is raised, and the builder takes the block gas limit above the
# old cap, on the real network (the local one: the pinned Canton with three participants, the real reth through network/reth/launch.sh with
# discovery off, the real builder, the real sidecar for the legs check). What is not real is the zero-knowledge proof, as in
# tests/demo_rehearsal.sh: a stand-in prover and a stand-in in front of the sidecar for `verify`/`verify2` (the stand-in checks the hash of a
# `verify2` line as the sidecar does).
#
#   1. The chain starts on 0.2.0: the DAR built from the tag v0.2.0 (its package id must be the one the live chain runs). Blocks commit with the
#      builder pinned to that id (--package-id): a setup block, and a deposit whose leg settles. The sidecar is asked `verify`, never `verify2`.
#   2. A second deposit is made, still on 0.2.0. Then the new DAR (the current source, 0.3.0) goes onto each participant in the steps of
#      network/external/setup.py --package-step: check (nothing kept), upload (not vetted: the package is listed and nothing else changes), vet with
#      a dry run first (the dry run changes nothing), vet. The chain does not switch by itself.
#   3. The builder is pinned to 0.3.0: the block commits (the sidecar is asked `verify2` now), the chain contract and the block's record are made
#      under 0.3.0, and the legs of the deposits that were made under 0.2.0 settle. The block gas limit is still 30,000,000.
#   4. The chain gets a change delay of 8 s with network/external/setup.py --change-delay-step (a dry run, the proposal, the acceptance: the chain has
#      no delay yet, so this one is at once). From here a change waits out the delay: an acceptance right after its proposal is refused with the time
#      from which it may be accepted, and goes through once that time has passed.
#      The gas cap is raised from 30,000,000 to 60,000,000 with network/external/setup.py --gas-cap-step: a dry run of the proposal (nothing is
#      proposed), the operator's proposal, a dry run of the acceptance on the confirmer's participant (the cap is unchanged), the confirmer's
#      acceptance. A second proposal and a second acceptance change nothing, and a cap that is not higher is refused (its message is checked and no
#      proposal exists afterwards).
#      Then the chain's program key, ZisK root and rules hash are replaced with network/external/setup.py --program-step (a dry run of the proposal,
#      the proposal, a dry run of the acceptance, the acceptance; a proposal of the values the chain holds is refused) and put back with the same two
#      steps, so the chain goes on with the program it had. Then the delay is taken away again (a proposal of 0, which waits out the 8 s; the chain
#      contract must not hold a delay when 0.2.0 code consumes it in stage 6). No block is made in between.
#   5. The builder asks reth for a block gas limit of 31,000,000 (--target-gas-limit). First an Advance whose header hex has a capital letter in it
#      is refused by Canton at `verify2` (the runtime lowercases what it sends, so the hash in the line differs: the stand-in says it refused at the
#      hash, and the refusal is the sidecar's, with the reason "no malformed input"), and the chain stays where it was. Then block 4 is built again
#      without the capital letter and commits under 0.3.0, and each header's gas limit moves up by exactly parent/1024 - 1, so the first block is
#      over the old cap of 30,000,000.
#   6. The builder is pinned back to 0.2.0 (the downgrade): a block with a gas limit over 30,000,000 commits, 0.2.0 code consumes the 0.3.0 chain
#      contract and deposit, and the new chain contract is a 0.2.0 one, with the raised cap.
#   7. Forward again: a deposit, the builder pinned to 0.3.0, the block commits. Then the legs are paused for real (setup.py --pause-step pause, the
#      confirmer alone): a block with no legs still commits, a block that carries a deposit is refused by Canton and reth goes back, and after
#      --pause-step unpause the same deposit's block commits.
# At every block the package id of the chain contract that Advance made is read from the ledger and compared with the pin.
# Needs Docker, Java 21, Rust, Python 3.12, jq, curl, git and network access. No GPU.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"
WORK=$(mktemp -d)
export CZE_STATE_DIR=$WORK/state FAKE_LOG=$WORK/calls
NET=$CZE_STATE_DIR/net
DEMO=$CZE_STATE_DIR/demo
umask 077
mkdir -p "$NET/logs"
: > "$FAKE_LOG"; : > "$FAKE_LOG.refused"
LIVE_PACKAGE_ID=a07a2e4d5fc10ba0ef486164dfadce6af066cb92879425ff1e0ec7629c43da7e   # 0.2.0, as the daml workflow says
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
  "$ROOT/network/reth/stop.sh" || true
  git -C "$ROOT" worktree remove --force "$WORK/v0.2.0" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT
background() { local name=$1; shift; nohup "$@" > "$NET/logs/$name.log" 2>&1 < /dev/null & pids+=($!); }
rpc() { curl -sf -H 'content-type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":[${2:-}]}" "http://127.0.0.1:${RETH_HTTP_PORT:-8545}" | jq -c .result; }

step "the demo's keys and funded genesis"
"$ROOT/demo/prepare.sh"
export CZE_GENESIS_FILE=$DEMO/genesis.json
PY=$CZE_STATE_DIR/venv/bin/python3
evm() { "$PY" "$ROOT/demo/evm.py" "$@"; }
canton() { "$PY" "$ROOT/demo/canton.py" "$@"; }

step "reth, through launch.sh"
"$ROOT/network/reth/launch.sh"
for _ in $(seq 1 60); do rpc eth_chainId >/dev/null 2>&1 && break; sleep 1; done
rpc eth_chainId >/dev/null || fail "reth does not answer"
"$ROOT/network/reth/check.sh"
GENESIS_HASH=$(rpc eth_getBlockByNumber '"0x0",false' | jq -r .hash)
GENESIS_STATE_ROOT=$(rpc eth_getBlockByNumber '"0x0",false' | jq -r .stateRoot)

step "the two DARs: 0.2.0 from the tag v0.2.0, and 0.3.0 from this source, with the pinned Daml compiler"
tools=$("$ROOT/network/canton/fetch.sh")
CANTON_JAR=$(sed -n 's/^CANTON_JAR=//p' <<<"$tools")
export CZE_TOOLS_DIR=${CZE_TOOLS_DIR:-$CZE_STATE_DIR/tools}
git -C "$ROOT" rev-parse -q --verify refs/tags/v0.2.0 >/dev/null || git -C "$ROOT" fetch --no-tags --depth=1 origin tag v0.2.0
git -C "$ROOT" worktree add --detach "$WORK/v0.2.0" v0.2.0 >/dev/null 2>&1
grep -qx 'version: 0.2.0' "$WORK/v0.2.0/daml/daml.yaml" || fail "the tag v0.2.0 is not version 0.2.0"
OLD_DAR=$WORK/old.dar; NEW_DAR=$WORK/new.dar
cp "$("$WORK/v0.2.0/network/canton/build-dar.sh")" "$OLD_DAR"
cp "$("$ROOT/network/canton/build-dar.sh")" "$NEW_DAR"
OLD=$("$ROOT/network/canton/dar-id.sh" "$OLD_DAR" | sed -n 's/^package_id=//p')
NEW=$("$ROOT/network/canton/dar-id.sh" "$NEW_DAR" | sed -n 's/^package_id=//p')
is "$OLD" "$LIVE_PACKAGE_ID" "the package id of 0.2.0 as rebuilt from the tag"
[[ $NEW =~ ^[0-9a-f]{64}$ ]] || fail "no package id for the current DAR: $NEW"
[ "$NEW" != "$OLD" ] || fail "the current source has the package id of 0.2.0: it was not changed, so there is nothing to upgrade to"
echo "0.2.0 is $OLD, 0.3.0 is $NEW"
{ echo "dar_sha256=$(sha256sum "$OLD_DAR" | cut -d' ' -f1)"; echo "package_id=$OLD"; } > "$NET/dar.txt"

step "the sidecars: the real one for legs, the stand-in in front of it for verify/verify2"
VK=$(printf 'cd%.0s' $(seq 32)); RC=$(printf 'ef%.0s' $(seq 32)); PROOF=$(printf 'ee%.0s' $(seq 768))$VK$RC
cargo build --release --locked --manifest-path "$ROOT/sidecar/Cargo.toml"
background real-sidecar "$ROOT/sidecar/target/release/zk-sidecar" --program-vk "$VK" --root-c "$RC" --listen 127.0.0.1:9085
for port in 8085 8086; do
  background "stand-in-$port" python3 "$ROOT/tests/demo_sidecar.py" "$port" 9085 "$VK" "$RC" "$PROOF"
done
sleep 2
for _ in $(seq 1 30); do curl -sf http://127.0.0.1:9085/api/v1/version >/dev/null && break; sleep 1; done

step "Canton, with 0.2.0 on every participant, and the chain"
export CZE_DAR=$OLD_DAR
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
export DEMO_PROOF_PROGRAM_VK=$VK DEMO_PROOF_ROOT_C=$RC
export CZE_MAKE_INPUT_CMD=$ROOT/builder/tests/fake-make-input.sh CZE_PROVE_CMD=$ROOT/tests/demo_fake_prove.sh

# <ZkChain|BlockRecord|DepositRequest>: the package ids the ledger says the active contracts of that template were made under.
probe() { "$PY" "$ROOT/tests/demo_package_probe.py" "$CZE_STATE_DIR" "$1"; }
chain_package() { local one; one=$(probe ZkChain | jq -c '.contracts | [.[]]'); [ "$(jq length <<<"$one")" = 1 ] || fail "not exactly one ZkChain: $one"; jq -r '.[0]' <<<"$one"; }
# The stand-in's answers by function: `verify` is what 0.2.0 asks, `verify2` what 0.3.0 asks.
calls() { grep -c " $1 " "$FAKE_LOG" || true; }
# <block number>: the gas limit in the header of that block, as reth has it.
gas_limit() { printf '%d' "$(rpc eth_getBlockByNumber "\"$(printf '0x%x' "$1")\",false" | jq -r .gasLimit)"; }
# <package id>: one builder run, pinned to it, with the arguments in BUILDER_EXTRA (BUILDER_PROGRAM is the builder itself).
# Prints the builder's JSON line; the exit status is the builder's.
BUILDER_EXTRA=()
BUILDER_PROGRAM=$ROOT/builder/builder.py
build() {
  CZE_LEDGER_USER=builder CZE_BUILDER_PARTY=$BUILDER_PARTY CZE_FEE_RECIPIENT=0x0000000000000000000000000000000000000fee \
    "$PY" "$BUILDER_PROGRAM" once ${BUILDER_EXTRA[@]+"${BUILDER_EXTRA[@]}"} --package-id "$1" --read-as "$OPERATOR_PARTY" --read-as "$GATEWAY_PARTY" --disclosed "$DEMO/disclosed.json"
}
# <package id> <block number> <legs> <what>: one pinned block commits, Canton's head is that block, and the chain contract Advance made is under the pin.
block_under() {
  local out status
  set +e; out=$(build "$1"); status=$?; set -e
  echo "$out" | jq -c .
  is "$status" 0 "the builder's exit status for $4 ($out)"
  is "$(jq -r .committed <<<"$out")" true "$4 committed"
  is "$(jq -r .number <<<"$out")" "$2" "$4's block number"
  is "$(jq -r .legs <<<"$out")" "$3" "$4's legs"
  is "$(canton status | jq -r '.chain[0].headNumber')" "$2" "Canton's head after $4"
  local chain records
  chain=$(chain_package); records=$(probe BlockRecord)
  echo "   after $4: the chain contract is under the package $chain; the record of block $2 is under $(jq -r --arg n "$2" '.records[$n]' <<<"$records")"
  is "$chain" "$1" "the package the chain contract is under after $4"
  is "$(jq -r --arg n "$2" '.records[$n]' <<<"$records")" "$1" "the package the record of block $2 is under after $4"
  is "$(jq -r '.numbers | length' <<<"$records")" "$2" "the block records after $4"
  is "$(rpc eth_getBlockByNumber '"finalized",false' | jq -r .hash)" "$(jq -r .blockHash <<<"$out")" "reth's finalized block after $4"
}
# <label> <package id the request is made under>: U deposits 10 TKB and claims 10 wTKB. The request is a contract of the package, made by name.
deposit() {
  local made id before new=""
  before=$(probe DepositRequest | jq -c '.contracts | keys')
  made=$(canton deposit "$1" "$U_ADDR" 10); id=$(jq -r .depositId <<<"$made")
  evm claim u "$id" "$WTKB" 10 | jq -r .tx > /dev/null
  for _ in $(seq 1 30); do   # the request reaches the operator's participant a moment after the depositor's commit
    new=$(probe DepositRequest | jq -c --argjson b "$before" '.contracts | with_entries(select(.key as $k | $b | index($k) | not)) | [.[]]')
    [ "$new" = "[]" ] || break
    sleep 1
  done
  [ "$new" = "[\"$2\"]" ] || fail "the request of $1 is not one new contract under the package $2: $new"
}
U_ADDR=$(jq -r .u "$DEMO/addresses.json")

step "stage 1: the chain on 0.2.0"
is "$(chain_package)" "$OLD" "the package the chain contract was made under at the start"
canton upload-dars >/dev/null
canton setup >/dev/null
evm deploy | jq -r .tx > /dev/null
made=$(evm register v "Wrapped TKB" wTKB); WTKB=$(jq -r .token <<<"$made")
block_under "$OLD" 1 0 "the setup block, pinned to 0.2.0"
canton register-token "$WTKB" >/dev/null
canton accept u >/dev/null
deposit dep-1 "$OLD"
block_under "$OLD" 2 1 "the first deposit's block, pinned to 0.2.0"
is "$(evm wrapped "$WTKB" "$U_ADDR" finalized | jq -c .)" '{"balance":"10.0","supply":"10.0"}' "U's wTKB after block 2"
[ "$(calls verify)" -ge 1 ] || fail "blocks 1 and 2 ran under 0.2.0 and the sidecar was not asked verify"
is "$(calls verify2)" 0 "the verify2 calls under 0.2.0"

step "stage 2: a deposit on 0.2.0, then 0.3.0 goes on every participant: check, upload (not vetted), vet with a dry run first"
deposit dep-2 "$OLD"
step_on() {   # <participant port> <step> [--dry-run]: network/external/setup.py --package-step on one participant, which has no login here
  local port=$1; shift
  CZE_LEDGER_NO_AUTH=1 python3 "$ROOT/network/external/setup.py" --ledger-url "http://127.0.0.1:$port" --dar "$NEW_DAR" --package-step "$@" 2> "$WORK/setup.err" \
    || { cat "$WORK/setup.err" >&2; fail "setup.py --package-step $* on $port failed"; }
}
PARTICIPANTS="7575 7576 7577"   # operator, confirmer, users
for port in $PARTICIPANTS; do
  r=$(step_on "$port" check); jq -e --arg p "$NEW" '.step == "check" and .valid == true and .packageId == $p' <<<"$r" >/dev/null || fail "check on $port: $r"
  # A check keeps nothing: the participant does not list the package.
  curl -sf "http://127.0.0.1:$port/v2/packages" | jq -e --arg p "$NEW" '.packageIds | index($p) | not' >/dev/null || fail "the check kept the package on $port"
done
for port in $PARTICIPANTS; do
  r=$(step_on "$port" upload); jq -e '.step == "upload" and .uploaded == true and .vetted == false' <<<"$r" >/dev/null || fail "upload on $port: $r"
  r=$(step_on "$port" upload); jq -e '.uploaded == false and .vetted == false' <<<"$r" >/dev/null || fail "the second upload on $port: $r"
done
for port in $PARTICIPANTS; do
  r=$(step_on "$port" vet --dry-run); jq -e '.dryRun == true' <<<"$r" >/dev/null || fail "dry run on $port: $r"
  r=$(step_on "$port" upload); jq -e '.vetted == false' <<<"$r" >/dev/null || fail "the dry run vetted the package on $port: $r"
done
# Listed but not vetted: a deposit made by name still makes 0.2.0 contracts, and an unpinned choice would still be 0.2.0.
deposit dep-3 "$OLD"
for port in $PARTICIPANTS; do
  r=$(step_on "$port" vet); jq -e '.dryRun == false and (.synchronizers | to_entries | all(.value == "vetted"))' <<<"$r" >/dev/null || fail "vet on $port: $r"
  r=$(step_on "$port" vet); jq -e '.synchronizers | to_entries | all(.value == "already")' <<<"$r" >/dev/null || fail "the second vet on $port: $r"
done
# The vetting reaches the other participants' view of the synchronizer: poll (the operator's participant lists every participant's vetting) until all
# three list the new package, for up to 30 s.
vetted_by() {
  curl -sf -H 'content-type: application/json' --data "{\"packageMetadataFilter\":{\"packageIds\":[\"$NEW\"],\"packageNamePrefixes\":[]},\"topologyStateFilter\":{\"participantIds\":[],\"synchronizerIds\":[]}}" \
    "http://127.0.0.1:7575/v2/package-vetting/list" \
    | jq -r --arg p "$NEW" '[.vettedPackages[]? | select(any(.packages[]?; .packageId == $p)) | .participantId] | unique | length'
}
seen=0
for _ in $(seq 1 30); do
  seen=$(vetted_by || echo 0); [ "$seen" = 3 ] && break; sleep 1
done
[ "$seen" = 3 ] || fail "after 30 s only $seen of 3 participants list the package $NEW as vetted (the vetting did not reach them)"
is "$(chain_package)" "$OLD" "the package the chain contract is under after 0.3.0 was vetted (nothing switched)"

step "stage 3: the builder is pinned to 0.3.0; the legs of deposits made under 0.2.0 settle"
block_under "$NEW" 3 2 "the block pinned to 0.3.0"   # dep-2 and dep-3, both made under 0.2.0
is "$(gas_limit 3)" 30000000 "the gas limit of block 3 (no target was asked: reth stays at the genesis cap)"
is "$(probe DepositRequest | jq '.contracts | length')" 0 "the requests of dep-2 and dep-3 are settled"
[ "$(calls verify2)" -ge 1 ] || fail "block 3 ran under 0.3.0 and the sidecar was not asked verify2"
is "$(evm wrapped "$WTKB" "$U_ADDR" finalized | jq -c .)" '{"balance":"30.0","supply":"30.0"}' "U's wTKB after block 3"


step "stage 4: the gas cap goes from 30,000,000 to 60,000,000 (setup.py --gas-cap-step: dry runs first, the operator proposes, the confirmer accepts)"
cap_step() {   # <participant port> <propose|accept> <new cap> [--dry-run]: network/external/setup.py --gas-cap-step on one participant, which has no login here
  local port=$1 step=$2 cap=$3; shift 3
  CZE_LEDGER_NO_AUTH=1 python3 "$ROOT/network/external/setup.py" --ledger-url "http://127.0.0.1:$port" --gas-cap-step "$step" --new-gas-cap "$cap" "$@" 2> "$WORK/setup.err" \
    || { cat "$WORK/setup.err" >&2; fail "setup.py --gas-cap-step $step $cap $* on $port failed"; }
}
accept_when_ready() {   # <setup.py arguments>: an accept on the confirmer's participant, tried again each second while the proposal has not reached it or its wait is not over (60 s at most)
  local out
  for _ in $(seq 1 60); do
    if out=$(CZE_LEDGER_NO_AUTH=1 python3 "$ROOT/network/external/setup.py" --ledger-url http://127.0.0.1:7576 "$@" 2> "$WORK/setup.err"); then echo "$out"; return 0; fi
    grep -q "may be accepted from\|is on this participant" "$WORK/setup.err" || { cat "$WORK/setup.err" >&2; return 1; }
    sleep 1
  done
  cat "$WORK/setup.err" >&2; return 1
}
delay_step() {   # <participant port> <propose|accept> <seconds> [--dry-run]: network/external/setup.py --change-delay-step on one participant
  local port=$1 step=$2 seconds=$3; shift 3
  CZE_LEDGER_NO_AUTH=1 python3 "$ROOT/network/external/setup.py" --ledger-url "http://127.0.0.1:$port" --change-delay-step "$step" --delay-seconds "$seconds" "$@" 2> "$WORK/setup.err" \
    || { cat "$WORK/setup.err" >&2; fail "setup.py --change-delay-step $step $seconds $* on $port failed"; }
}
is "$(probe ZkChain | jq -r '.changeDelays | join(",")')" none "the change delay before the change (0.2.0 had none)"
r=$(delay_step 7575 propose 8 --dry-run); jq -e '.dryRun == true and .submitted == false and .changeDelaySeconds == 0' <<<"$r" >/dev/null || fail "the dry run of the delay proposal: $r"
is "$(probe ChangeDelayProposal | jq '.contracts | length')" 0 "the delay proposals after the dry run"
r=$(delay_step 7575 propose 8); jq -e '.submitted == true and .alreadyProposed == false and .acceptableAt == .proposedAt' <<<"$r" >/dev/null || fail "the delay proposal: $r"
r=$(accept_when_ready --change-delay-step accept --delay-seconds 8); jq -e '.submitted == true' <<<"$r" >/dev/null || fail "the delay acceptance: $r"
is "$(probe ZkChain | jq -r '.changeDelays | join(",")')" 8000000 "the change delay after the acceptance"
is "$(probe ChangeDelayProposal | jq '.contracts | length')" 0 "the delay proposals after the acceptance (it is used up)"
is "$(chain_package)" "$NEW" "the package the chain contract is under after the delay change (SetChangeDelay is 0.3.0's)"
is "$(probe ZkChain | jq -r '.gasCaps | join(",")')" 30000000 "the gas cap before the change"
r=$(cap_step 7575 propose 60000000 --dry-run); jq -e '.step == "propose" and .dryRun == true and .submitted == false and .currentGasCap == "30000000"' <<<"$r" >/dev/null || fail "the dry run of the proposal: $r"
is "$(probe GasCapProposal | jq '.contracts | length')" 0 "the proposals after the dry run"
r=$(cap_step 7575 propose 60000000); jq -e '.submitted == true and .alreadyProposed == false' <<<"$r" >/dev/null || fail "the proposal: $r"
r=$(cap_step 7575 propose 60000000); jq -e '.submitted == false and .alreadyProposed == true' <<<"$r" >/dev/null || fail "the second proposal: $r"
is "$(probe GasCapProposal | jq '.contracts | length')" 1 "the proposals after the proposal"
# The proposal reaches the confirmer's participant a moment after the operator's commit: the dry run of the acceptance waits for it, up to 30 s.
r=""
for _ in $(seq 1 30); do
  r=$(CZE_LEDGER_NO_AUTH=1 python3 "$ROOT/network/external/setup.py" --ledger-url http://127.0.0.1:7576 --gas-cap-step accept --new-gas-cap 60000000 --dry-run 2> "$WORK/setup.err") && break
  r=""; sleep 1
done
jq -e '.step == "accept" and .dryRun == true and .submitted == false and .currentGasCap == "30000000" and .changeDelaySeconds == 8 and .acceptableAt > .proposedAt' <<<"$r" >/dev/null || fail "the dry run of the acceptance: $r $(tail -n 5 "$WORK/setup.err")"
# The acceptance right after the proposal is refused, with the time from which it may be accepted; nothing changes.
if CZE_LEDGER_NO_AUTH=1 python3 "$ROOT/network/external/setup.py" --ledger-url http://127.0.0.1:7576 --gas-cap-step accept --new-gas-cap 60000000 > /dev/null 2> "$WORK/setup.err"; then
  fail "the gas cap was accepted before the delay had passed"
fi
grep -q "may be accepted from" "$WORK/setup.err" || { cat "$WORK/setup.err" >&2; fail "the refusal before the delay does not say when it may be accepted"; }
# The same acceptance sent past setup.py's own clock check: the ledger itself refuses it, with the Daml's message, and the cap stays.
if CZE_SKIP_WAIT_CHECK=1 CZE_LEDGER_NO_AUTH=1 python3 "$ROOT/network/external/setup.py" --ledger-url http://127.0.0.1:7576 --gas-cap-step accept --new-gas-cap 60000000 > /dev/null 2> "$WORK/setup.err"; then
  fail "the ledger accepted the gas cap before the delay had passed"
fi
if ! { grep -q "was refused: HTTP" "$WORK/setup.err" && grep -q "may be accepted from" "$WORK/setup.err"; }; then cat "$WORK/setup.err" >&2; fail "the ledger's own refusal of the early gas cap acceptance does not carry the Daml message"; fi
is "$(probe ZkChain | jq -r '.gasCaps | join(",")')" 30000000 "the gas cap after the dry runs"
r=$(accept_when_ready --gas-cap-step accept --new-gas-cap 60000000); jq -e '.submitted == true' <<<"$r" >/dev/null || fail "the acceptance: $r"
is "$(probe ZkChain | jq -r '.gasCaps | join(",")')" 60000000 "the gas cap after the acceptance"
is "$(probe GasCapProposal | jq '.contracts | length')" 0 "the proposals after the acceptance (it is used up)"
is "$(canton status | jq -r '.chain[0].headNumber')" 3 "Canton's head after the gas cap change (no block was made)"
r=$(cap_step 7576 accept 60000000); jq -e '.submitted == false and .alreadyAccepted == true' <<<"$r" >/dev/null || fail "the second acceptance: $r"
if CZE_LEDGER_NO_AUTH=1 python3 "$ROOT/network/external/setup.py" --ledger-url http://127.0.0.1:7575 --gas-cap-step propose --new-gas-cap 60000000 > /dev/null 2> "$WORK/setup.err"; then
  fail "a proposal for a cap that is not above the chain's was sent"
fi
grep -q "must be above" "$WORK/setup.err" || { cat "$WORK/setup.err" >&2; fail "the refusal of a cap that is not higher does not say so"; }
is "$(probe GasCapProposal | jq '.contracts | length')" 0 "the proposals after the refused proposal (nothing was sent)"
is "$(chain_package)" "$NEW" "the package the chain contract is under after the acceptance (SetGasCap is 0.3.0's)"

# The pause and leg-limits steps, as dry runs only (a pause or a quota would be on the chain when the scenario goes back to 0.2.0, which cannot read them): they read
# the chain contract that the real ledger gives, whose 0.3.0 fields are null, and print what they would do.
r=$(CZE_LEDGER_NO_AUTH=1 python3 "$ROOT/network/external/setup.py" --ledger-url http://127.0.0.1:7575 --leg-limits-step propose --quota 1000 --quota-window-seconds 86400 --dry-run 2> "$WORK/setup.err") \
  || { cat "$WORK/setup.err" >&2; fail "the dry run of the leg limits proposal failed"; }
jq -e '.dryRun == true and .submitted == false and .current.quota == null and .new.quota == "1000" and .new.quotaWindowSeconds == 86400' <<<"$r" >/dev/null || fail "the dry run of the leg limits proposal: $r"
r=$(CZE_LEDGER_NO_AUTH=1 python3 "$ROOT/network/external/setup.py" --ledger-url http://127.0.0.1:7576 --pause-step pause --dry-run 2> "$WORK/setup.err") \
  || { cat "$WORK/setup.err" >&2; fail "the dry run of the pause failed"; }
jq -e '.dryRun == true and .submitted == false and .paused == false and .pauseLimitSeconds == 259200' <<<"$r" >/dev/null || fail "the dry run of the pause: $r"
is "$(probe LegLimitsProposal | jq '.contracts | length')" 0 "the leg limits proposals after the dry run"

step "stage 4b: the program keys change and change back (setup.py --program-step)"
program_step() {   # <participant port> <propose|accept> <vk> <root> <rules> [--dry-run]
  local port=$1 step=$2 vk=$3 root=$4 rules=$5; shift 5
  CZE_LEDGER_NO_AUTH=1 python3 "$ROOT/network/external/setup.py" --ledger-url "http://127.0.0.1:$port" --program-step "$step" --program-vk "$vk" --root-c "$root" --rules-hash "$rules" "$@" 2> "$WORK/setup.err" \
    || { cat "$WORK/setup.err" >&2; fail "setup.py --program-step $step on $port failed"; }
}
OLD_RULES=$(printf '12%.0s' $(seq 32)); NEW_VK=$(printf 'ab%.0s' $(seq 32)); NEW_RC=$(printf 'cd%.0s' $(seq 32)); NEW_RULES=$(printf 'ef%.0s' $(seq 32))
OLD_PROGRAM="$VK/$RC/$OLD_RULES"; NEW_PROGRAM="$NEW_VK/$NEW_RC/$NEW_RULES"
is "$(probe ZkChain | jq -r '.programs | join(",")')" "$OLD_PROGRAM" "the program keys before the change"
r=$(program_step 7575 propose "$NEW_VK" "$NEW_RC" "$NEW_RULES" --dry-run); jq -e '.dryRun == true and .submitted == false' <<<"$r" >/dev/null || fail "the dry run of the program proposal: $r"
is "$(probe ProgramProposal | jq '.contracts | length')" 0 "the program proposals after the dry run"
r=$(program_step 7575 propose "$NEW_VK" "$NEW_RC" "$NEW_RULES"); jq -e '.submitted == true and .alreadyProposed == false' <<<"$r" >/dev/null || fail "the program proposal: $r"
is "$(probe ProgramProposal | jq '.contracts | length')" 1 "the program proposals after the proposal"
r=""
for _ in $(seq 1 30); do
  r=$(program_step 7576 accept "$NEW_VK" "$NEW_RC" "$NEW_RULES" --dry-run 2>/dev/null) && break
  r=""; sleep 1
done
jq -e '.step == "accept" and .dryRun == true and .submitted == false' <<<"$r" >/dev/null || fail "the dry run of the program acceptance: $r"
is "$(probe ZkChain | jq -r '.programs | join(",")')" "$OLD_PROGRAM" "the program keys after the dry runs"
if CZE_LEDGER_NO_AUTH=1 python3 "$ROOT/network/external/setup.py" --ledger-url http://127.0.0.1:7576 --program-step accept --program-vk "$NEW_VK" --root-c "$NEW_RC" --rules-hash "$NEW_RULES" > /dev/null 2> "$WORK/setup.err"; then
  fail "the program was accepted before the delay had passed"
fi
grep -q "may be accepted from" "$WORK/setup.err" || { cat "$WORK/setup.err" >&2; fail "the refusal of the program before the delay does not say when it may be accepted"; }
if CZE_SKIP_WAIT_CHECK=1 CZE_LEDGER_NO_AUTH=1 python3 "$ROOT/network/external/setup.py" --ledger-url http://127.0.0.1:7576 --program-step accept --program-vk "$NEW_VK" --root-c "$NEW_RC" --rules-hash "$NEW_RULES" > /dev/null 2> "$WORK/setup.err"; then
  fail "the ledger accepted the program before the delay had passed"
fi
if ! { grep -q "was refused: HTTP" "$WORK/setup.err" && grep -q "may be accepted from" "$WORK/setup.err"; }; then cat "$WORK/setup.err" >&2; fail "the ledger's own refusal of the early program acceptance does not carry the Daml message"; fi
is "$(probe ZkChain | jq -r '.programs | join(",")')" "$OLD_PROGRAM" "the program keys after the refused acceptance"
r=$(accept_when_ready --program-step accept --program-vk "$NEW_VK" --root-c "$NEW_RC" --rules-hash "$NEW_RULES"); jq -e '.submitted == true' <<<"$r" >/dev/null || fail "the program acceptance: $r"
is "$(probe ZkChain | jq -r '.programs | join(",")')" "$NEW_PROGRAM" "the program keys after the acceptance"
is "$(probe ProgramProposal | jq '.contracts | length')" 0 "the program proposals after the acceptance (it is used up)"
if CZE_LEDGER_NO_AUTH=1 python3 "$ROOT/network/external/setup.py" --ledger-url http://127.0.0.1:7575 --program-step propose --program-vk "$NEW_VK" --root-c "$NEW_RC" --rules-hash "$NEW_RULES" > /dev/null 2> "$WORK/setup.err"; then
  fail "a proposal for the values the chain holds was sent"
fi
grep -q "holds these values already" "$WORK/setup.err" || { cat "$WORK/setup.err" >&2; fail "the refusal of the values the chain holds does not say so"; }
# The way back: the same two steps with the old values.
r=$(program_step 7575 propose "$VK" "$RC" "$OLD_RULES"); jq -e '.submitted == true' <<<"$r" >/dev/null || fail "the proposal of the old program: $r"
r=""
for _ in $(seq 1 30); do
  r=$(program_step 7576 accept "$VK" "$RC" "$OLD_RULES" --dry-run 2>/dev/null) && break
  r=""; sleep 1
done
[ -n "$r" ] || fail "the proposal of the old program did not reach the confirmer's participant"
r=$(accept_when_ready --program-step accept --program-vk "$VK" --root-c "$RC" --rules-hash "$OLD_RULES"); jq -e '.submitted == true' <<<"$r" >/dev/null || fail "the acceptance of the old program: $r"
is "$(probe ZkChain | jq -r '.programs | join(",")')" "$OLD_PROGRAM" "the program keys after the way back"
# The delay is taken away again; the proposal waits out the 8 s that are in force. A chain that holds a delay cannot go back to 0.2.0 code.
r=$(delay_step 7575 propose 0); jq -e '.submitted == true and .changeDelaySeconds == 8' <<<"$r" >/dev/null || fail "the proposal that takes the delay away: $r"
r=$(accept_when_ready --change-delay-step accept --delay-seconds 0); jq -e '.submitted == true' <<<"$r" >/dev/null || fail "the acceptance that takes the delay away: $r"
is "$(probe ZkChain | jq -r '.changeDelays | join(",")')" none "the change delay after it was taken away"
is "$(chain_package)" "$NEW" "the package the chain contract is under after the program changes"
is "$(canton status | jq -r '.chain[0].headNumber')" 3 "Canton's head after the program changes (no block was made)"

step "stage 5: a capital letter in the header is refused; then the builder asks for a gas limit of 31,000,000 and the blocks commit over the old cap of 30,000,000"
BUILDER_EXTRA=(--target-gas-limit 31000000)
deposit dep-4 "$NEW"
# The header hex of this Advance has a capital letter in it. The runtime lowercases the line it sends, so the hash in the line is of text the sidecar
# never sees: Canton refuses the block at verify2 (the legs are not asked), and nothing changes.
BUILDER_PROGRAM=$ROOT/tests/demo_capital_advance.py
verify2_before=$(calls verify2)
refused_before=$(grep -c ' hash$' "$FAKE_LOG.refused" || true)
set +e; out=$(build "$NEW"); status=$?; set -e
BUILDER_PROGRAM=$ROOT/builder/builder.py
echo "$out" | jq -c '{committed, rejected, reason: (.reason // "" | .[0:300])}'
is "$status" 2 "the builder's exit status for the block with a capital letter in its header"
is "$(jq -r .committed <<<"$out")" false "the block with a capital letter in its header committed"
is "$(( $(calls verify2) > verify2_before ))" 1 "the sidecar was asked verify2 for the block with a capital letter"
is "$(tail -n 1 "$FAKE_LOG" | cut -d' ' -f2)" verify2 "the last call of the refused block (the legs were not asked: it was refused at verify2)"
jq -e '.rejected == true and (.reason | contains("the sidecar refused the block: no malformed input"))' <<<"$out" >/dev/null || fail "the refusal of the block with a capital letter is not the sidecar's: $out"
# The stand-in says which of its checks refused the line: the hash in front (the runtime lowercased the text, so it differs), not the form of the hex.
is "$(( $(grep -c ' hash$' "$FAKE_LOG.refused" || true) - refused_before ))" 1 "the verify2 refusals at the hash for the block with a capital letter (the text was lowercased in transit)"
is "$(grep -c ' form$' "$FAKE_LOG.refused" || true)" 0 "the verify2 refusals at the form of the hex (the case was not kept)"
is "$(canton status | jq -r '.chain[0].headNumber')" 3 "Canton's head after the refused block"
is "$(chain_package)" "$NEW" "the package the chain contract is under after the refused block"
is "$(rpc eth_getBlockByNumber '"latest",false' | jq -r .number)" 0x3 "reth's head after the refused block (it went back)"
# Block 4 is built again, without the capital letter, and commits: the first one over the old cap.
block_under "$NEW" 4 1 "the first block of the ramp, pinned to 0.3.0"
is "$(gas_limit 4)" 30029295 "the gas limit of block 4 (30,000,000 and 30,000,000/1024 - 1)"
deposit dep-5 "$NEW"
block_under "$NEW" 5 1 "the second block of the ramp, pinned to 0.3.0"
is "$(gas_limit 5)" "$(( $(gas_limit 4) + $(gas_limit 4) / 1024 - 1 ))" "the gas limit of block 5 (the parent's and its 1/1024 - 1)"
[ "$(gas_limit 5)" -gt 30000000 ] || fail "block 5 is not over the old cap"
is "$(evm wrapped "$WTKB" "$U_ADDR" finalized | jq -c .)" '{"balance":"50.0","supply":"50.0"}' "U's wTKB after block 5"

step "stage 6: a deposit made under 0.3.0, then the builder is pinned back to 0.2.0 (the downgrade): a block over the old cap commits under 0.2.0"
deposit dep-6 "$NEW"
block_under "$OLD" 6 1 "the block pinned back to 0.2.0"
is "$(gas_limit 6)" "$(( $(gas_limit 5) + $(gas_limit 5) / 1024 - 1 ))" "the gas limit of block 6 (over the old cap, under 0.2.0)"
is "$(probe ZkChain | jq -r '.gasCaps | join(",")')" 60000000 "the gas cap after the downgrade (the chain contract keeps it)"
is "$(probe BlockRecord | jq -c '.contracts | length')" 6 "the block records after the downgrade"

step "stage 7: forward again, to 0.3.0"
deposit dep-7 "$NEW"
block_under "$NEW" 7 1 "the block pinned to 0.3.0 again"
is "$(gas_limit 7)" "$(( $(gas_limit 6) + $(gas_limit 6) / 1024 - 1 ))" "the gas limit of block 7"
is "$(evm wrapped "$WTKB" "$U_ADDR" finalized | jq -c .)" '{"balance":"70.0","supply":"70.0"}' "U's wTKB after block 7"

# The pause for real, under 0.3.0, which the scenario does not leave again: the emergency brake is sent for the first time here and not during an incident.
pause_run() {   # <pause|unpause>: network/external/setup.py --pause-step on the confirmer's participant, which has no login here
  CZE_LEDGER_NO_AUTH=1 python3 "$ROOT/network/external/setup.py" --ledger-url http://127.0.0.1:7576 --pause-step "$1" 2> "$WORK/setup.err" \
    || { cat "$WORK/setup.err" >&2; fail "setup.py --pause-step $1 failed"; }
}
r=$(pause_run pause); jq -e '.submitted == true and .paused == true and .pausedUntil != null and .pauseCooldownUntil != null' <<<"$r" >/dev/null || fail "the pause: $r"
is "$(chain_package)" "$NEW" "the package the chain contract is under after the pause"
block_under "$NEW" 8 0 "a block with no legs, while the legs are paused"
deposit dep-8 "$NEW"
# The builder reads the pause and leaves the deposit out of the block: it commits a block with no legs, Canton does not refuse it, and the deposit stays in the pool.
set +e; out=$(build "$NEW"); status=$?; set -e
echo "$out" | jq -c '{committed, number, legs, legTransactions, leftOut}'
is "$status" 0 "the builder's exit status for the block cut while the legs are paused ($out)"
jq -e '.committed == true and .number == 9 and (.legTransactions | length) == 0' <<<"$out" >/dev/null || fail "the block cut under the pause carries a leg or is not block 9: $out"
jq -e '(.leftOut | length) >= 1 and all(.leftOut[]; .reason | startswith("the Canton legs are paused until"))' <<<"$out" >/dev/null || fail "the deposit is not left out for the pause: $out"
is "$(canton status | jq -r '.chain[0].headNumber')" 9 "Canton's head after the block cut under the pause (a block with no legs commits)"
is "$(evm wrapped "$WTKB" "$U_ADDR" finalized | jq -c .)" '{"balance":"70.0","supply":"70.0"}' "U's wTKB after block 9 (the deposit is not in it)"
r=$(pause_run unpause); jq -e '.submitted == true and .paused == false' <<<"$r" >/dev/null || fail "the unpause: $r"
# The unpause clears the pause, so the next block takes the deposit that stayed in the pool.
block_under "$NEW" 10 1 "the block with the deposit, after the pause is lifted"
is "$(evm wrapped "$WTKB" "$U_ADDR" finalized | jq -c .)" '{"balance":"80.0","supply":"80.0"}' "U's wTKB after block 10"
echo "package upgrade, gas cap raise, ramp over the old cap, downgrade, upgrade again and a real pause (the legs left out, then included): passed"
