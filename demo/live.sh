#!/usr/bin/env bash
# The demo's legs on a chain that is already running (Ostia on an existing participant, with a block producer that makes the blocks):
#
#   setup  Everything is made only if it is not there, so it can be run again and changes nothing that is complete.
#          The token rules and U's 100 TKB on Canton (canton.py setup); wTKB, the EVM form of TKB, made by the gateway (evm.py register, one
#          transaction from V, kept in $CZE_STATE_DIR/demo/wtkb.json) and registered on Canton (canton.py register-token) once that block is
#          final; U's standing acceptance of withdrawals.
#   legs   Run 1, a deposit: U puts 10 TKB with the gateway and claims 10 wTKB.
#          Run 2, a payment: U puts 10 TKB aside for V, and V pays U $CZE_LIVE_PAY (default 1) WtROME through the gateway (V wraps WtROME first
#          if it holds too little, and approves the gateway).
#          Run 3, a withdrawal: U's address withdraws 4 wTKB to U's party.
#          Each transaction is waited for at reth's finalized block (the producer makes the blocks; this script never builds one). Then it
#          checks that the block has exactly one leg of the kind, that Canton's BlockRecord is that block (and holds a proof), that the
#          BlockRecord and the new holding came from one Canton update (canton.py settled), the TKB and wTKB balances, and that Canton's custody
#          equals wTKB's supply. It stops at the first claim that does not hold, and writes $CZE_LIVE_RESULTS/live-<date>.txt.
#   cycle  A balanced cycle, repeated: the three runs of `legs` (a deposit of 10 TKB, a payment, a withdrawal of the 10 wTKB that the deposit made),
#          then V sends U the 10 TKB the payment moved (canton.py return-tkb, the token standard's plain transfer) and U sends V the WtROME it was paid
#          (evm.py give). Every balance is back where it was when the cycle ends, so the lane can run for as long as it is asked to: U needs 20 TKB, and no
#          more. A cycle starts every CZE_LIVE_CYCLE_MINUTES (default 10; 0 = one after the other) until $CZE_LIVE_STOP_FILE exists (default
#          $CZE_STATE_DIR/demo/cycle.stop) or CZE_LIVE_CYCLES cycles have run (default 0 = no limit). A cycle makes the checks of `legs`, and that every
#          balance is back at its start; it appends one line to $CZE_LIVE_RESULTS/cycle-<start time>.txt (result=pass with the three blocks, or
#          result=fail with the reason). A failed check stops the lane: nothing is retried and nothing is minted to cover a difference.
#          A stop file left from an earlier lane is refused at the start (remove it first). Stop the lane with the stop file, which ends it between cycles;
#          a TERM, INT or HUP during a cycle writes a result=fail line for it (the balances may be part-way through), and between cycles an end=signal line.
#   all    setup, then legs (the default).
#
# Usage: demo/live.sh [setup|legs|cycle|all]        demo/live.sh --help
#
# Needs the participant and the chain to be ready as network/README.md says: the test token's DAR vetted (canton.py upload-dars), the parties made
# (network/external/setup.py --demo), V's and U's addresses (evm.py keys prints them) holding the chain's coin, and the block producer running with
# --disclosed $CZE_STATE_DIR/demo/disclosed.json (the file canton.py setup writes). Settings: CZE_STATE_DIR, CZE_LEDGER_URL, CZE_RPC_URL, the
# token files and CZE_USER_PREFIX of demo/canton.py, CZE_WTROME (the WtROME address; legs), CZE_SOURCE_COMMIT (the full commit hash of the
# source that runs; legs), CZE_WTKB (a wrapped TKB that setup does not make: one that is not yet registered on Canton must be called Wrapped TKB / wTKB), CZE_LIVE_WAIT_SECONDS (default 600),
# CZE_LIVE_RESULTS, and for cycle CZE_LIVE_CYCLE_MINUTES, CZE_LIVE_CYCLES, CZE_LIVE_STOP_FILE. CZE_LIVE_EVM and CZE_LIVE_CANTON name other commands in place of evm.py and canton.py (for tests only).
set -euo pipefail
shopt -s inherit_errexit 2>/dev/null || { echo "FAIL: demo/live.sh needs bash 4.4 or later" >&2; exit 1; }   # set -e then holds inside "$(...)" too
ROOT=$(cd "$(dirname "$0")/.." && pwd)
FAIL_HOOK=   # the name of a function that is told the reason before the run stops (the cycle writes its failed line there)
fail() { echo "FAIL: $*" >&2; [ -z "$FAIL_HOOK" ] || "$FAIL_HOOK" "$*" || true; exit 1; }
step() { echo "== $* ($(date -u +%T))"; }
usage() { echo "Usage: demo/live.sh [setup|legs|cycle|all]    (setup: token rules, wTKB, acceptance; legs: deposit, payment, withdrawal; cycle: a balanced set of the three, repeated; all: setup and legs, the default)"; }

mode=all
case $# in
  0) ;;
  1) case $1 in
       setup | legs | cycle | all) mode=$1 ;;
       -h | --help) usage; exit 0 ;;
       *) usage >&2; fail "unknown argument: $1" ;;
     esac ;;
  *) usage >&2; fail "at most one argument" ;;
esac

export CZE_STATE_DIR=${CZE_STATE_DIR:-$ROOT/state}
export CZE_CANTON=${CZE_CANTON:-external}
DEMO=$CZE_STATE_DIR/demo
RESULTS=${CZE_LIVE_RESULTS:-$ROOT/demo/results}
WAIT_SECONDS=${CZE_LIVE_WAIT_SECONDS:-600}
PAY=${CZE_LIVE_PAY:-1}
CYCLE_MINUTES=${CZE_LIVE_CYCLE_MINUTES:-10}
CYCLES=${CZE_LIVE_CYCLES:-0}
STOP_FILE=${CZE_LIVE_STOP_FILE:-$DEMO/cycle.stop}
[ "$CZE_CANTON" = external ] || fail "live.sh runs on an existing participant: CZE_CANTON must be external, not $CZE_CANTON"
[ -n "${CZE_LEDGER_URL:-}" ] || fail "set CZE_LEDGER_URL to the participant's JSON Ledger API"
[ -n "${CZE_RPC_URL:-}" ] || fail "set CZE_RPC_URL to the chain's JSON-RPC"
[[ $PAY =~ ^[1-9][0-9]*$ ]] || fail "CZE_LIVE_PAY must be a whole number of WtROME, 1 or more: $PAY"
[[ $CYCLE_MINUTES =~ ^(0|[1-9][0-9]*)$ ]] || fail "CZE_LIVE_CYCLE_MINUTES must be a whole number: $CYCLE_MINUTES"
[[ $CYCLES =~ ^(0|[1-9][0-9]*)$ ]] || fail "CZE_LIVE_CYCLES must be a whole number (0 for no limit): $CYCLES"
[[ $WAIT_SECONDS =~ ^[0-9]+$ ]] || fail "CZE_LIVE_WAIT_SECONDS must be a whole number: $WAIT_SECONDS"
if [ "$mode" != setup ]; then
  [[ ${CZE_SOURCE_COMMIT:-} =~ ^[0-9a-f]{40}$ ]] || fail "set CZE_SOURCE_COMMIT to the full commit hash of the source that is running"
  [[ ${CZE_WTROME:-} =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "set CZE_WTROME to the address of WtROME on the chain"
fi
[[ -z ${CZE_WTKB:-} || ${CZE_WTKB} =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "CZE_WTKB must be an address"
command -v jq >/dev/null || fail "jq is needed"

PY=${CZE_PY:-$CZE_STATE_DIR/venv/bin/python3}
[ -x "$PY" ] || PY=python3
if [ -n "${CZE_LIVE_EVM:-}" ]; then EVM=("$CZE_LIVE_EVM"); else EVM=("$PY" "$ROOT/demo/evm.py"); fi
if [ -n "${CZE_LIVE_CANTON:-}" ]; then CANTON=("$CZE_LIVE_CANTON"); else CANTON=("$PY" "$ROOT/demo/canton.py"); fi
evm() { "${EVM[@]}" "$@"; }
canton() { "${CANTON[@]}" "$@"; }
is() { [ "$1" = "$2" ] || fail "$3: got $1, expected $2"; }
num() { awk -v a="$1" 'BEGIN { printf "%.10g", a + 0 }'; }
sum() { num "$(awk -v a="$1" -v b="$2" 'BEGIN { printf "%.10f", a + b }')"; }
short() { printf '%s' "${1:0:16}"; }

GATEWAY=$(sed -n 's/^GATEWAY_ADDRESS=//p' "$ROOT/PINS" | head -1)
[[ $GATEWAY =~ ^0x[0-9a-f]{40}$ ]] || fail "PINS has no GATEWAY_ADDRESS"
addresses=$(evm keys)   # makes V's and U's keys if there are none (0600, never printed); prints only the addresses
V_ADDR=$(jq -r .v <<<"$addresses"); U_ADDR=$(jq -r .u <<<"$addresses")
[[ $V_ADDR =~ ^0x[0-9a-fA-F]{40}$ && $U_ADDR =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "evm.py keys gave no addresses: $addresses"
# A command's result is stored first, as `x=$(command)`, and only then checked: set -e (with inherit_errexit) stops the run when the command fails, which it does not
# do for a command inside "$(...)" in the arguments of a check.
for who in "$V_ADDR" "$U_ADDR"; do
  ether=$(evm ether "$who"); wei=$(jq -r .wei <<<"$ether")
  [ "$wei" != 0 ] || fail "$who has no coin for fees: send some to it first"
done

# <tx> <what>: wait until the transaction is in a finalized block; its status must be 1. Prints the receipt.
final() {
  local receipt
  receipt=$(evm wait "$1" "$WAIT_SECONDS") || fail "$2: $1 is not in a finalized block"
  is "$(jq -r .status <<<"$receipt")" 1 "the status of $2 ($1)"
  echo "$receipt"
}

# <token>: the gateway token at that address, in the finalized block, is named Wrapped TKB / wTKB. The address that `evm.py register` gives is
# worked out before the transaction is sent; if something else is there, wtkb.json names an address that is some other token. An error from the
# chain stops the run in `evm describe` (set -e): only an answer that says "no token" or another name gets here.
# A second argument "CZE_WTKB" is for the address the operator gave: the message names the setting, not wtkb.json.
named() {
  local described name symbol state registered
  described=$(evm describe "$1" finalized); name=$(jq -r .name <<<"$described"); symbol=$(jq -r .symbol <<<"$described")
  if [ "$name" != "Wrapped TKB" ] || [ "$symbol" != wTKB ]; then
    [ "${2:-}" != CZE_WTKB ] || fail "CZE_WTKB names the token at $1, which is called '$name' ($symbol), not 'Wrapped TKB' (wTKB). Setup registered nothing on Canton. Check the address"
    state=$(canton registered "$1"); registered=$(jq -r .registered <<<"$state")
    # Clearing wtkb.json makes another wTKB: never advised where this address is registered on Canton already.
    [ "$registered" != true ] || fail "the token at $1 is called '$name' ($symbol), not 'Wrapped TKB' (wTKB), and it is registered on Canton: stop and look at it"
    fail "the token at $1 is called '$name' ($symbol), not 'Wrapped TKB' (wTKB): another registration took the address first. Clear $DEMO/wtkb.json and run setup again"
  fi
}

# ---------------------------------------------------------------- setup
setup() {
  step "the token rules and U's TKB on Canton"
  canton setup | jq -c .   # makes the rules and U's holding only if they are not there

  local wtkb_file=$DEMO/wtkb.json wtkb tx state
  if [ -n "${CZE_WTKB:-}" ]; then
    wtkb=$CZE_WTKB
    # An unregistered token is about to become TKB's EVM form: it must be the gateway's wTKB, or a mistyped address would be registered.
    state=$(canton registered "$wtkb")
    [ "$(jq -r .registered <<<"$state")" = true ] || named "$wtkb" CZE_WTKB
  elif [ -f "$wtkb_file" ]; then
    wtkb=$(jq -r .token "$wtkb_file"); tx=$(jq -r .tx "$wtkb_file")
    step "wTKB was made before, at $wtkb"
    final "$tx" "the registration of wTKB" >/dev/null
    named "$wtkb"
  else
    step "V makes wTKB"
    local made; made=$(evm register v "Wrapped TKB" wTKB)
    tx=$(jq -r .tx <<<"$made"); wtkb=$(jq -r .token <<<"$made")
    [[ $wtkb =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "evm.py register gave no token address: $made"
    mkdir -p "$DEMO"
    printf '{"tx":"%s","token":"%s"}\n' "$tx" "$wtkb" > "$wtkb_file"   # before the wait, so that a second run waits for this one and makes no other
    final "$tx" "the registration of wTKB" >/dev/null
    named "$wtkb"
  fi

  step "wTKB is registered on Canton as the EVM form of TKB, and U accepts withdrawals"
  local is_registered registered_token accepted_now accepted
  state=$(canton registered "$wtkb"); is_registered=$(jq -r .registered <<<"$state")
  if [ "$is_registered" = true ]; then
    echo "wTKB is registered already"
  else
    # A proposal that an earlier run left for the confirmer is accepted by register-token. The address comes back in lowercase, as the user may not give it.
    registered_token=$(canton register-token "$wtkb")
    is "$(jq -r .evmToken <<<"$registered_token")" "$(tr A-F a-f <<<"${wtkb#0x}")" "the registered token"
  fi
  accepted_now=$(canton accepted u); accepted=$(jq -r .accepted <<<"$accepted_now")
  if [ "$accepted" = true ]; then
    echo "U accepts withdrawals already"
  else
    accepted_now=$(canton accept u); jq -c . <<<"$accepted_now"
  fi
  state=$(canton registered "$wtkb"); is_registered=$(jq -r .registered <<<"$state")
  is "$is_registered" true "wTKB is registered on Canton"
  echo "wTKB is at $wtkb"
}

# ---------------------------------------------------------------- legs
totals() { jq -c '{u: (.tkb.u | add // 0), v: (.tkb.v | add // 0), gateway: (.custody | add // 0)}' <<<"$1"; }
total() { jq -r ".$2" <<<"$(totals "$1")"; }
wrapped() { evm wrapped "$WTKB" "$1" finalized; }   # <holder address>: {"balance", "supply"}
coin() { local b; b=$(evm balance "$1" "$2" finalized) && jq -r .tka <<<"$b"; }   # <token> <holder>: whole tokens
fin_number() { local b; b=$(evm block finalized); jq -r .number <<<"$b"; }

# <block number> <kind> <party> <block hash>: one leg of that kind in the block, Canton's record is that block, and the block and the party's
# newest TKB holding were made by one Canton update. Prints the update id.
check_leg() {
  local n=$1 found legs head update record finalized
  legs=$(evm legs "$n")
  is "$(jq -r .legs <<<"$legs")" 1 "the legs in block $n"
  is "$(jq -c .kinds <<<"$legs")" "[\"$2\"]" "the kind of block $n's leg"
  finalized=$(fin_number)
  [ "$finalized" -ge "$n" ] || fail "reth's finalized block is below block $n"
  found=$(canton block "$n" "$3")   # read from the update of that party's newest holding: not every record of a long chain
  record=$(jq -c .record <<<"$found")
  head=$(jq -r '.chain[0].headNumber' <<<"$found")
  [ "$head" -ge "$n" ] || fail "Canton's head $head is below block $n"
  is "0x$(jq -r .blockHash <<<"$record")" "$4" "the block hash in the BlockRecord of block $n"
  [ -n "$(jq -r .proofHex <<<"$record")" ] || fail "the BlockRecord of block $n holds no proof"
  found=$(canton settled "$n" "$3")
  update=$(jq -r .record.updateId <<<"$found")
  [ -n "$update" ] || fail "Canton gave no update id for block $n's BlockRecord"
  is "$(jq -r .holding.updateId <<<"$found")" "$update" "the update that made $3's holding and the one that made block $n's BlockRecord"
  is "$(jq -r .holding.offset <<<"$found")" "$(jq -r .record.offset <<<"$found")" "the offset of $3's holding and of block $n's BlockRecord"
  echo "$update"
}
# <canton balances> <what>: Canton's custody is wTKB's supply at the finalized block.
custody_is_supply() {
  local w; w=$(wrapped "$U_ADDR")
  is "$(num "$(total "$1" gateway)")" "$(num "$(jq -r .supply <<<"$w")")" "Canton's custody and wTKB's supply $2"
}

# What the legs and the cycle need before they start: wTKB, its registration, U's acceptance, the parties. Sets WTKB and U_PARTY.
prepare_legs() {
  local wtkb_file=$DEMO/wtkb.json
  if [ -n "${CZE_WTKB:-}" ]; then WTKB=$CZE_WTKB
  elif [ -f "$wtkb_file" ]; then WTKB=$(jq -r .token "$wtkb_file")
  else fail "no wTKB: run demo/live.sh setup first"; fi
  local state is_registered accepted_now accepted
  state=$(canton registered "$WTKB"); is_registered=$(jq -r .registered <<<"$state")
  [ "$is_registered" = true ] || fail "wTKB at $WTKB is not registered on Canton: run demo/live.sh setup first"
  accepted_now=$(canton accepted u); accepted=$(jq -r .accepted <<<"$accepted_now")
  [ "$accepted" = true ] || fail "U has made no acceptance of withdrawals: run demo/live.sh setup first"
  [ -f "$CZE_STATE_DIR/canton/parties.env" ] || fail "no $CZE_STATE_DIR/canton/parties.env: run network/external/setup.py --demo"
  # shellcheck disable=SC1091
  . "$CZE_STATE_DIR/canton/parties.env"
  [ -n "${U_PARTY:-}" ] || fail "parties.env has no U_PARTY"
}

# The three runs. Each takes the Canton balances from before it and sets AFTER (the Canton balances after it), W_BEFORE and W_AFTER (wTKB's
# balance and supply for U's address before and after), and the variables of its own leg (DEP_*, PAY_*, WD_*) that the results print.
# <tag> <canton balances before> <amount of TKB>
run_deposit() {
  local tag=$1 before=$2 amount=$3 deposit
  step "run 1, a deposit: U puts $amount TKB with the gateway and claims $amount wTKB"
  W_BEFORE=$(wrapped "$U_ADDR")
  deposit=$(canton deposit "$tag-dep" "$U_ADDR" "$amount"); echo "$deposit" | jq -c .
  DEP_JSON=$deposit; DEP_ID=$(jq -r .depositId <<<"$deposit")
  DEP_TX=$(evm claim u "$DEP_ID" "$WTKB" "$amount" | jq -r .tx)
  local r; r=$(final "$DEP_TX" "the claim"); DEP_N=$(jq -r .block <<<"$r"); DEP_H=$(jq -r .blockHash <<<"$r")
  DEP_UPDATE=$(check_leg "$DEP_N" claim gateway "$DEP_H"); DEP_REC=$(canton block "$DEP_N" gateway | jq -c .record)
  AFTER=$(canton balances); W_AFTER=$(wrapped "$U_ADDR")
  is "$(num "$(total "$AFTER" u)")" "$(sum "$(total "$before" u)" "-$amount")" "U's TKB after run 1"
  is "$(num "$(total "$AFTER" gateway)")" "$(sum "$(total "$before" gateway)" "$amount")" "the custody after run 1"
  is "$(num "$(jq -r .balance <<<"$W_AFTER")")" "$(sum "$(jq -r .balance <<<"$W_BEFORE")" "$amount")" "U's wTKB after run 1"
  is "$(num "$(jq -r .supply <<<"$W_AFTER")")" "$(sum "$(jq -r .supply <<<"$W_BEFORE")" "$amount")" "wTKB's supply after run 1"
  is "$(jq -c '[.allocations, .deposits]' <<<"$AFTER")" "$(jq -c '[.allocations, .deposits]' <<<"$before")" "the allocations and deposit requests after run 1"
  custody_is_supply "$AFTER" "after run 1"
}
# <tag> <canton balances before>. Also sets ROME_U and ROME_V, U's and V's WtROME before the payment (after V has wrapped what it lacked).
run_payment() {
  local tag=$1 before=$2
  step "run 2, a payment: V pays U $PAY WtROME through the gateway, and U's 10 TKB go to V"
  local held wrap_tx pid
  held=$(coin "$CZE_WTROME" "$V_ADDR")
  if [ "$held" -lt "$PAY" ]; then
    wrap_tx=$(evm wrap v "$CZE_WTROME" "$PAY" | jq -r .tx)
    final "$wrap_tx" "V's wrapping of $PAY coin" >/dev/null
  fi
  ROME_U=$(coin "$CZE_WTROME" "$U_ADDR"); ROME_V=$(coin "$CZE_WTROME" "$V_ADDR")
  [ "$ROME_V" -ge "$PAY" ] || fail "V holds $ROME_V WtROME after wrapping, less than $PAY"
  PAY_APPROVE_TX=$(evm approve v "$CZE_WTROME" gateway "$PAY" | jq -r .tx)
  final "$PAY_APPROVE_TX" "V's approval of the gateway" >/dev/null
  PAY_DVP=$(canton dvp "$tag-dvp" "$CZE_WTROME" "$U_ADDR" "$PAY"); echo "$PAY_DVP" | jq -c .
  PAY_ID=$(jq -r .id <<<"$PAY_DVP")
  pid=$(canton payment-id "$tag-dvp"); pid=$(jq -r .id <<<"$pid")
  is "$PAY_ID" "$pid" "the payment id of $tag-dvp"
  PAY_TX=$(evm pay v "$PAY_ID" "$CZE_WTROME" "$U_ADDR" "$PAY" | jq -r .tx)
  local r; r=$(final "$PAY_TX" "the payment"); PAY_N=$(jq -r .block <<<"$r"); PAY_H=$(jq -r .blockHash <<<"$r")
  PAY_UPDATE=$(check_leg "$PAY_N" pay v "$PAY_H"); PAY_REC=$(canton block "$PAY_N" v | jq -c .record)
  AFTER=$(canton balances)
  is "$(num "$(total "$AFTER" u)")" "$(sum "$(total "$before" u)" -10)" "U's TKB after run 2"
  is "$(num "$(total "$AFTER" v)")" "$(sum "$(total "$before" v)" 10)" "V's TKB after run 2"
  is "$(jq -c '[.allocations, .terms]' <<<"$AFTER")" "$(jq -c '[.allocations, .terms]' <<<"$before")" "the allocations and terms after run 2"
  local rome_u2 rome_v2; rome_u2=$(coin "$CZE_WTROME" "$U_ADDR"); rome_v2=$(coin "$CZE_WTROME" "$V_ADDR")
  is "$rome_u2" $((ROME_U + PAY)) "U's WtROME after run 2"
  is "$rome_v2" $((ROME_V - PAY)) "V's WtROME after run 2"
  custody_is_supply "$AFTER" "after run 2"
}
# <canton balances before> <amount of wTKB>
run_withdraw() {
  local before=$1 amount=$2
  step "run 3, a withdrawal: U's address burns $amount wTKB, and $amount TKB go from the gateway to U"
  W_BEFORE=$(wrapped "$U_ADDR")
  WD_TX=$(evm withdraw u "$WTKB" "$amount" "$U_PARTY" | jq -r .tx)
  local r; r=$(final "$WD_TX" "the withdrawal"); WD_N=$(jq -r .block <<<"$r"); WD_H=$(jq -r .blockHash <<<"$r")
  WD_UPDATE=$(check_leg "$WD_N" withdraw u "$WD_H"); WD_REC=$(canton block "$WD_N" u | jq -c .record)
  AFTER=$(canton balances); W_AFTER=$(wrapped "$U_ADDR")
  is "$(num "$(total "$AFTER" u)")" "$(sum "$(total "$before" u)" "$amount")" "U's TKB after run 3"
  is "$(num "$(total "$AFTER" gateway)")" "$(sum "$(total "$before" gateway)" "-$amount")" "the custody after run 3"
  is "$(num "$(jq -r .balance <<<"$W_AFTER")")" "$(sum "$(jq -r .balance <<<"$W_BEFORE")" "-$amount")" "U's wTKB after run 3"
  is "$(num "$(jq -r .supply <<<"$W_AFTER")")" "$(sum "$(jq -r .supply <<<"$W_BEFORE")" "-$amount")" "wTKB's supply after run 3"
  custody_is_supply "$AFTER" "after run 3"
}

legs() {
  prepare_legs
  local tag; tag=live-$(date -u +%m%d%H%M%S)
  local day; day=$(date -u +%F)

  local start; start=$(canton balances)
  custody_is_supply "$start" "before the runs"
  # Run 1 allocates 10 TKB and run 2 allocates 10 more (two allocations of 10): a U with less than 20 would stop in run 2, after run 1 had changed things.
  awk -v a="$(total "$start" u)" 'BEGIN { exit !(a >= 20) }' || fail "U holds less than 20 TKB, which the deposit and the payment need (10 each): $(totals "$start")"

  run_deposit "$tag" "$start" 10
  local w0=$W_BEFORE after1=$AFTER
  run_payment "$tag" "$after1"
  local after2=$AFTER
  run_withdraw "$after2" 4
  local after3=$AFTER w3=$W_AFTER

  # ---- results
  mkdir -p "$RESULTS"
  local chain code_hash; chain=$(evm chain); code_hash=$(evm code "$GATEWAY")
  local out=$RESULTS/live-$day.txt
  [ ! -e "$out" ] || out=$RESULTS/live-$day-$(date -u +%H%M%S).txt
  {
    echo "# Live legs on a running chain: a deposit, a payment in WtROME and a withdrawal, each in a block the running producer made, each waited for at reth's finalized block."
    echo "# Contract ids are shortened to their first 16 hex digits."
    echo "format=2"
    echo "date=$(date -u +%FT%TZ)"
    echo "source_commit=$CZE_SOURCE_COMMIT"
    echo "chain_id=$(jq -r .chainId <<<"$chain")"
    echo "gateway=$GATEWAY"
    echo "gateway_code_hash=$(jq -r .codeHash <<<"$code_hash")"
    echo "wtkb=$WTKB"
    echo "wtrome=$CZE_WTROME"
    echo "u_address=$U_ADDR"
    echo "v_address=$V_ADDR"
    echo "deposit_id=$DEP_ID"
    echo "deposit_block=$DEP_N"
    echo "deposit_block_hash=$DEP_H"
    echo "deposit_claim_tx=$DEP_TX"
    echo "deposit_request=$(short "$(jq -r .request <<<"$DEP_JSON")")"
    echo "deposit_allocation=$(short "$(jq -r .allocation <<<"$DEP_JSON")")"
    echo "deposit_canton_update=$DEP_UPDATE"
    echo "deposit_proof_sha256=$(jq -r .proofSha256 <<<"$DEP_REC")"
    echo "payment_id=$PAY_ID"
    echo "payment_block=$PAY_N"
    echo "payment_block_hash=$PAY_H"
    echo "payment_approve_tx=$PAY_APPROVE_TX"
    echo "payment_pay_tx=$PAY_TX"
    echo "payment_amount_wtrome=$PAY"
    echo "payment_terms=$(short "$(jq -r .terms <<<"$PAY_DVP")")"
    echo "payment_allocation=$(short "$(jq -r .allocation <<<"$PAY_DVP")")"
    echo "payment_canton_update=$PAY_UPDATE"
    echo "payment_proof_sha256=$(jq -r .proofSha256 <<<"$PAY_REC")"
    echo "withdrawal_block=$WD_N"
    echo "withdrawal_block_hash=$WD_H"
    echo "withdrawal_tx=$WD_TX"
    echo "withdrawal_canton_update=$WD_UPDATE"
    echo "withdrawal_proof_sha256=$(jq -r .proofSha256 <<<"$WD_REC")"
    echo "one_leg_per_block=yes"
    echo "block_record_and_holding_in_one_update=yes"
    echo "reth_finalized=yes"
    echo "tkb_u_before=$(total "$start" u)"
    echo "tkb_v_before=$(total "$start" v)"
    echo "tkb_u_after=$(total "$after3" u)"
    echo "tkb_v_after=$(total "$after3" v)"
    echo "custody_before=$(total "$start" gateway)"
    echo "custody_after=$(total "$after3" gateway)"
    echo "wtkb_supply_before=$(jq -r .supply <<<"$w0")"
    echo "wtkb_supply_after=$(jq -r .supply <<<"$w3")"
    echo "custody_equals_supply=yes"
    echo "wtkb_u_before=$(jq -r .balance <<<"$w0")"
    echo "wtkb_u_after=$(jq -r .balance <<<"$w3")"
  } > "$out"
  echo "written: $out"
}

# ---------------------------------------------------------------- cycle
# A balanced cycle, repeated: the same three runs as `legs` (a deposit of 10 TKB, a payment of $PAY WtROME against 10 TKB, a withdrawal of the 10 wTKB
# that the deposit made), then the two things that give back what the payment moved: V sends U the 10 TKB by the token standard's plain transfer
# (canton.py return-tkb), and U sends V the $PAY WtROME (evm.py give). After the cycle every balance is what it was before it: if one is not, the lane stops.
# Each cycle appends one line to $CYCLE_OUT; a failed check appends a line that says why, and stops the lane (nothing is retried).
CYCLE_N=0; IN_CYCLE=0; CYCLE_OUT=
cycle_line() { printf '%s\n' "$*" >> "$CYCLE_OUT"; }
cycle_failed() {   # the reason: one line for the failed cycle, if there is not one yet
  [ "$IN_CYCLE" = 1 ] && [ -n "$CYCLE_OUT" ] || return 0
  ! tail -1 "$CYCLE_OUT" | grep -q "^cycle=$CYCLE_N .*result=fail" || return 0
  local reason; reason=$(printf '%s' "$1" | tr '\n\t"' "  '" | cut -c1-300)   # one line, and no double quote inside the quoted reason
  cycle_line "cycle=$CYCLE_N date=$(date -u +%FT%TZ) result=fail reason=\"$reason\""
}
cycle_exit() {   # an unexpected stop (a command failed with no message of ours): the line says so
  local rc=$?
  [ "$rc" = 0 ] || cycle_failed "a command failed with exit $rc; the log above names it"
}
cycle_signal() {   # <exit code>: the lane was killed (TERM, INT, HUP): the results say where, as the balances may be part-way through a cycle
  if [ "$IN_CYCLE" = 1 ]; then cycle_failed "stopped by a signal during cycle $CYCLE_N; the balances may be part-way through the cycle (up to 20 TKB moved)"
  else cycle_line "end=signal cycles=$CYCLE_N"; fi
  exit "$1"
}
interval_wait() {   # <started (epoch seconds)>: until the interval since then has passed; leaves early when the stop file appears
  local deadline=$(($1 + CYCLE_MINUTES * 60))
  while [ "$(date +%s)" -lt "$deadline" ] && [ ! -e "$STOP_FILE" ]; do sleep 1; done
}
one_cycle() {   # <tag>
  local tag=$1 start after1 after2 after3 after4 w_start
  IN_CYCLE=1
  start=$(canton balances); w_start=$(wrapped "$U_ADDR")
  custody_is_supply "$start" "at the start of cycle $CYCLE_N"
  awk -v a="$(total "$start" u)" 'BEGIN { exit !(a >= 20) }' || fail "U holds less than 20 TKB, which the deposit and the payment need (10 each): $(totals "$start")"

  run_deposit "$tag" "$start" 10
  after1=$AFTER
  run_payment "$tag" "$after1"
  after2=$AFTER
  run_withdraw "$after2" 10
  after3=$AFTER

  step "the return: V sends U 10 TKB, and U sends V $PAY WtROME"
  canton return-tkb "$tag-ret" 10 | jq -c .
  after4=$(canton balances)
  is "$(num "$(total "$after4" u)")" "$(sum "$(total "$after3" u)" 10)" "U's TKB after V's transfer"
  is "$(num "$(total "$after4" v)")" "$(sum "$(total "$after3" v)" -10)" "V's TKB after V's transfer"
  is "$(num "$(total "$after4" gateway)")" "$(num "$(total "$after3" gateway)")" "the custody after V's transfer"
  local give_tx; give_tx=$(evm give u "$CZE_WTROME" "$V_ADDR" "$PAY" | jq -r .tx)
  final "$give_tx" "U's return of $PAY WtROME" >/dev/null

  # Every balance is what it was at the start of the cycle (WtROME: after V's own wrapping, if it had to wrap).
  local w_end end rome_u_end rome_v_end
  end=$after4; w_end=$(wrapped "$U_ADDR")
  rome_u_end=$(coin "$CZE_WTROME" "$U_ADDR"); rome_v_end=$(coin "$CZE_WTROME" "$V_ADDR")
  is "$(num "$(total "$end" u)")" "$(num "$(total "$start" u)")" "U's TKB at the end of cycle $CYCLE_N"
  is "$(num "$(total "$end" v)")" "$(num "$(total "$start" v)")" "V's TKB at the end of cycle $CYCLE_N"
  is "$(num "$(total "$end" gateway)")" "$(num "$(total "$start" gateway)")" "the custody at the end of cycle $CYCLE_N"
  is "$(num "$(jq -r .balance <<<"$w_end")")" "$(num "$(jq -r .balance <<<"$w_start")")" "U's wTKB at the end of cycle $CYCLE_N"
  is "$(num "$(jq -r .supply <<<"$w_end")")" "$(num "$(jq -r .supply <<<"$w_start")")" "wTKB's supply at the end of cycle $CYCLE_N"
  is "$rome_u_end" "$ROME_U" "U's WtROME at the end of cycle $CYCLE_N"
  is "$rome_v_end" "$ROME_V" "V's WtROME at the end of cycle $CYCLE_N"
  is "$(jq -c '[.allocations, .terms, .deposits, .acceptances]' <<<"$end")" "$(jq -c '[.allocations, .terms, .deposits, .acceptances]' <<<"$start")" "the allocations, terms, deposit requests and acceptances at the end of cycle $CYCLE_N"
  custody_is_supply "$end" "at the end of cycle $CYCLE_N"

  cycle_line "cycle=$CYCLE_N date=$(date -u +%FT%TZ) result=pass deposit_block=$DEP_N payment_block=$PAY_N withdrawal_block=$WD_N deposit_update=$DEP_UPDATE payment_update=$PAY_UPDATE withdrawal_update=$WD_UPDATE return_tx=$give_tx tkb_u=$(total "$end" u) tkb_v=$(total "$end" v) custody=$(total "$end" gateway) wtkb_supply=$(jq -r .supply <<<"$w_end") wtkb_u=$(jq -r .balance <<<"$w_end") wtrome_u=$rome_u_end wtrome_v=$rome_v_end"
  IN_CYCLE=0
}

cycle() {
  [ ! -e "$STOP_FILE" ] || fail "the stop file $STOP_FILE exists (from an earlier lane?): remove it, then start the lane again"
  prepare_legs
  local started n=0
  CYCLE_OUT=$RESULTS/cycle-$(date -u +%Y%m%dT%H%M%SZ).txt
  mkdir -p "$RESULTS"
  {
    echo "# A balanced cycle on a running chain, repeated: a deposit, a payment in WtROME, a withdrawal, then the TKB and the WtROME of the payment back."
    echo "# One line a cycle: result=pass with the blocks and Canton updates of the three legs and the balances after the cycle, or result=fail with the reason, after which the lane stops."
    echo "format=1"
    echo "date=$(date -u +%FT%TZ)"
    echo "source_commit=$CZE_SOURCE_COMMIT"
    echo "wtkb=$WTKB"
    echo "wtrome=$CZE_WTROME"
    echo "u_address=$U_ADDR"
    echo "v_address=$V_ADDR"
    echo "pay_wtrome=$PAY"
    echo "minutes=$CYCLE_MINUTES"
    echo "cycles=$CYCLES"
  } > "$CYCLE_OUT"
  echo "results: $CYCLE_OUT   (stop it with: touch $STOP_FILE)"
  FAIL_HOOK=cycle_failed
  trap cycle_exit EXIT
  trap 'cycle_signal 143' TERM; trap 'cycle_signal 130' INT; trap 'cycle_signal 129' HUP
  while :; do
    if [ -e "$STOP_FILE" ]; then cycle_line "end=stop-file cycles=$n"; echo "stopped: $STOP_FILE exists, after $n cycles"; return 0; fi
    if [ "$CYCLES" != 0 ] && [ "$n" -ge "$CYCLES" ]; then cycle_line "end=count cycles=$n"; echo "done: $n cycles"; return 0; fi
    n=$((n + 1)); CYCLE_N=$n; started=$(date +%s)
    one_cycle "cyc-$(date -u +%m%d%H%M%S)-$n"
    if [ "$CYCLES" = 0 ] || [ "$n" -lt "$CYCLES" ]; then interval_wait "$started"; fi
  done
}

case $mode in
  setup) setup ;;
  legs) legs ;;
  cycle) cycle ;;
  all) setup; legs ;;
esac
