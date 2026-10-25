#!/usr/bin/env bash
# A chain that runs is moved to the next version of the Daml package, and back, on the real network (the local one: the pinned Canton with three
# participants, the real reth through network/reth/launch.sh with discovery off, the real builder, the real sidecar for the legs check). What is
# not real is the zero-knowledge proof, as in tests/demo_rehearsal.sh: a stand-in prover and a stand-in in front of the sidecar for `verify`.
#
#   1. The chain starts on 0.1.0: the DAR built from the tag v0.1.0 (its package id must be the one the live chain runs). Blocks commit with the
#      builder pinned to that id (--package-id): a setup block, and a deposit whose leg settles.
#   2. A second deposit is made, still on 0.1.0. Then the new DAR (the current source, 0.2.0) goes onto each participant in the steps of
#      network/external/setup.py --package-step: check (nothing kept), upload (not vetted: the package is listed and nothing else changes), vet with
#      a dry run first (the dry run changes nothing), vet. The chain does not switch by itself.
#   3. The builder is pinned to 0.2.0: the block commits, the chain contract and the block's record are made under 0.2.0, and the leg of the
#      deposit that was made under 0.1.0 settles.
#   4. A deposit is made (the participants pick 0.2.0 by package name now), then the builder is pinned back to 0.1.0, the downgrade: the block
#      commits, 0.1.0 code consumes the 0.2.0 chain contract and the 0.2.0 deposit, and the new chain contract is a 0.1.0 one.
#   5. Forward again: a deposit, the builder pinned to 0.2.0, the block commits.
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
: > "$FAKE_LOG"
LIVE_PACKAGE_ID=ea89dbabb095e49f05b3d23b22916592f6ab65a2f3ad98400c6a68262495bb08   # 0.1.0, as daml/README.md and the daml workflow say
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
  git -C "$ROOT" worktree remove --force "$WORK/v0.1.0" 2>/dev/null || true
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

step "the two DARs: 0.1.0 from the tag v0.1.0, and 0.2.0 from this source, with the pinned Daml compiler"
tools=$("$ROOT/network/canton/fetch.sh")
CANTON_JAR=$(sed -n 's/^CANTON_JAR=//p' <<<"$tools")
export CZE_TOOLS_DIR=${CZE_TOOLS_DIR:-$CZE_STATE_DIR/tools}
git -C "$ROOT" rev-parse -q --verify refs/tags/v0.1.0 >/dev/null || git -C "$ROOT" fetch --no-tags --depth=1 origin tag v0.1.0
git -C "$ROOT" worktree add --detach "$WORK/v0.1.0" v0.1.0 >/dev/null 2>&1
grep -qx 'version: 0.1.0' "$WORK/v0.1.0/daml/daml.yaml" || fail "the tag v0.1.0 is not version 0.1.0"
OLD_DAR=$WORK/old.dar; NEW_DAR=$WORK/new.dar
cp "$("$WORK/v0.1.0/network/canton/build-dar.sh")" "$OLD_DAR"
cp "$("$ROOT/network/canton/build-dar.sh")" "$NEW_DAR"
OLD=$("$ROOT/network/canton/dar-id.sh" "$OLD_DAR" | sed -n 's/^package_id=//p')
NEW=$("$ROOT/network/canton/dar-id.sh" "$NEW_DAR" | sed -n 's/^package_id=//p')
is "$OLD" "$LIVE_PACKAGE_ID" "the package id of 0.1.0 as rebuilt from the tag"
[[ $NEW =~ ^[0-9a-f]{64}$ ]] || fail "no package id for the current DAR: $NEW"
[ "$NEW" != "$OLD" ] || fail "the current source has the package id of 0.1.0: it was not changed, so there is nothing to upgrade to"
echo "0.1.0 is $OLD, 0.2.0 is $NEW"
{ echo "dar_sha256=$(sha256sum "$OLD_DAR" | cut -d' ' -f1)"; echo "package_id=$OLD"; } > "$NET/dar.txt"

step "the sidecars: the real one for legs, the stand-in in front of it for verify"
VK=$(printf 'cd%.0s' $(seq 32)); RC=$(printf 'ef%.0s' $(seq 32)); PROOF=$(printf 'ee%.0s' $(seq 768))$VK$RC
cargo build --release --locked --manifest-path "$ROOT/sidecar/Cargo.toml"
background real-sidecar "$ROOT/sidecar/target/release/zk-sidecar" --program-vk "$VK" --root-c "$RC" --listen 127.0.0.1:9085
for port in 8085 8086; do
  background "stand-in-$port" python3 "$ROOT/tests/demo_sidecar.py" "$port" 9085 "$VK" "$RC" "$PROOF"
done
sleep 2
for _ in $(seq 1 30); do curl -sf http://127.0.0.1:9085/api/v1/version >/dev/null && break; sleep 1; done

step "Canton, with 0.1.0 on every participant, and the chain"
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
# <package id>: one builder run, pinned to it. Prints the builder's JSON line; the exit status is the builder's.
build() {
  CZE_LEDGER_USER=builder CZE_BUILDER_PARTY=$BUILDER_PARTY CZE_FEE_RECIPIENT=0x0000000000000000000000000000000000000fee \
    "$PY" "$ROOT/builder/builder.py" once --package-id "$1" --read-as "$OPERATOR_PARTY" --read-as "$GATEWAY_PARTY" --disclosed "$DEMO/disclosed.json"
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
  is "$(chain_package)" "$1" "the package the chain contract is under after $4"
  is "$(probe BlockRecord | jq -r '.numbers | length')" "$2" "the block records after $4"
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

step "stage 1: the chain on 0.1.0"
is "$(chain_package)" "$OLD" "the package the chain contract was made under at the start"
canton upload-dars >/dev/null
canton setup >/dev/null
evm deploy | jq -r .tx > /dev/null
made=$(evm register v "Wrapped TKB" wTKB); WTKB=$(jq -r .token <<<"$made")
block_under "$OLD" 1 0 "the setup block, pinned to 0.1.0"
canton register-token "$WTKB" >/dev/null
canton accept u >/dev/null
deposit dep-1 "$OLD"
block_under "$OLD" 2 1 "the first deposit's block, pinned to 0.1.0"
is "$(evm wrapped "$WTKB" "$U_ADDR" finalized | jq -c .)" '{"balance":"10.0","supply":"10.0"}' "U's wTKB after block 2"

step "stage 2: a deposit on 0.1.0, then 0.2.0 goes on every participant: check, upload (not vetted), vet with a dry run first"
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
# Listed but not vetted: a deposit made by name still makes 0.1.0 contracts, and an unpinned choice would still be 0.1.0.
deposit dep-3 "$OLD"
for port in $PARTICIPANTS; do
  r=$(step_on "$port" vet); jq -e '.dryRun == false and (.synchronizers | to_entries | all(.value == "vetted"))' <<<"$r" >/dev/null || fail "vet on $port: $r"
  r=$(step_on "$port" vet); jq -e '.synchronizers | to_entries | all(.value == "already")' <<<"$r" >/dev/null || fail "the second vet on $port: $r"
done
sleep 5   # the vetting reaches the other participants' view of the synchronizer
is "$(chain_package)" "$OLD" "the package the chain contract is under after 0.2.0 was vetted (nothing switched)"

step "stage 3: the builder is pinned to 0.2.0; the legs of deposits made under 0.1.0 settle"
block_under "$NEW" 3 2 "the block pinned to 0.2.0"   # dep-2 and dep-3, both made under 0.1.0
is "$(probe DepositRequest | jq '.contracts | length')" 0 "the requests of dep-2 and dep-3 are settled"
is "$(evm wrapped "$WTKB" "$U_ADDR" finalized | jq -c .)" '{"balance":"30.0","supply":"30.0"}' "U's wTKB after block 3"

step "stage 4: a deposit made under 0.2.0, then the builder is pinned back to 0.1.0 (the downgrade)"
deposit dep-4 "$NEW"
block_under "$OLD" 4 1 "the block pinned back to 0.1.0"
is "$(probe BlockRecord | jq -c '.contracts | length')" 4 "the block records after the downgrade"

step "stage 5: forward again, to 0.2.0"
deposit dep-5 "$NEW"
block_under "$NEW" 5 1 "the block pinned to 0.2.0 again"
is "$(evm wrapped "$WTKB" "$U_ADDR" finalized | jq -c .)" '{"balance":"50.0","supply":"50.0"}' "U's wTKB after block 5"
echo "package upgrade, downgrade and upgrade again: passed"
