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
#   all    setup, then legs (the default).
#
# Usage: demo/live.sh [setup|legs|all]        demo/live.sh --help
#
# Needs the participant and the chain to be ready as network/README.md says: the test token's DAR vetted (canton.py upload-dars), the parties made
# (network/external/setup.py --demo), V's and U's addresses (evm.py keys prints them) holding the chain's coin, and the block producer running with
# --disclosed $CZE_STATE_DIR/demo/disclosed.json (the file canton.py setup writes). Settings: CZE_STATE_DIR, CZE_LEDGER_URL, CZE_RPC_URL, the
# token files and CZE_USER_PREFIX of demo/canton.py, CZE_WTROME (the WtROME address; legs), CZE_SOURCE_COMMIT (the full commit hash of the
# source that runs; legs), CZE_WTKB (a wrapped TKB that setup does not make: one that is not yet registered on Canton must be called Wrapped TKB / wTKB), CZE_LIVE_WAIT_SECONDS (default 600),
# CZE_LIVE_RESULTS. CZE_LIVE_EVM and CZE_LIVE_CANTON name other commands in place of evm.py and canton.py (for tests only).
set -euo pipefail
shopt -s inherit_errexit 2>/dev/null || { echo "FAIL: demo/live.sh needs bash 4.4 or later" >&2; exit 1; }   # set -e then holds inside "$(...)" too
ROOT=$(cd "$(dirname "$0")/.." && pwd)
fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo "== $* ($(date -u +%T))"; }
usage() { echo "Usage: demo/live.sh [setup|legs|all]    (setup: token rules, wTKB, acceptance; legs: deposit, payment, withdrawal; all: both, the default)"; }

mode=all
case $# in
  0) ;;
  1) case $1 in
       setup | legs | all) mode=$1 ;;
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
[ "$CZE_CANTON" = external ] || fail "live.sh runs on an existing participant: CZE_CANTON must be external, not $CZE_CANTON"
[ -n "${CZE_LEDGER_URL:-}" ] || fail "set CZE_LEDGER_URL to the participant's JSON Ledger API"
[ -n "${CZE_RPC_URL:-}" ] || fail "set CZE_RPC_URL to the chain's JSON-RPC"
[[ $PAY =~ ^[1-9][0-9]*$ ]] || fail "CZE_LIVE_PAY must be a whole number of WtROME, 1 or more: $PAY"
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

legs() {
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
  local tag; tag=live-$(date -u +%m%d%H%M%S)
  local day; day=$(date -u +%F)

  local start; start=$(canton balances)
  custody_is_supply "$start" "before the runs"
  # Run 1 allocates 10 TKB and run 2 allocates 10 more (two allocations of 10): a U with less than 20 would stop in run 2, after run 1 had changed things.
  awk -v a="$(total "$start" u)" 'BEGIN { exit !(a >= 20) }' || fail "U holds less than 20 TKB, which the deposit and the payment need (10 each): $(totals "$start")"

  # ---- run 1
  step "run 1, a deposit: U puts 10 TKB with the gateway and claims 10 wTKB"
  local w0 deposit deposit_id claim_tx r1 n1 h1 u1 after1 w1
  w0=$(wrapped "$U_ADDR")
  deposit=$(canton deposit "$tag-dep" "$U_ADDR" 10); echo "$deposit" | jq -c .
  deposit_id=$(jq -r .depositId <<<"$deposit")
  claim_tx=$(evm claim u "$deposit_id" "$WTKB" 10 | jq -r .tx)
  r1=$(final "$claim_tx" "the claim"); n1=$(jq -r .block <<<"$r1"); h1=$(jq -r .blockHash <<<"$r1")
  u1=$(check_leg "$n1" claim gateway "$h1"); local rec1; rec1=$(canton block "$n1" gateway | jq -c .record)
  after1=$(canton balances); w1=$(wrapped "$U_ADDR")
  is "$(num "$(total "$after1" u)")" "$(sum "$(total "$start" u)" -10)" "U's TKB after run 1"
  is "$(num "$(total "$after1" gateway)")" "$(sum "$(total "$start" gateway)" 10)" "the custody after run 1"
  is "$(num "$(jq -r .balance <<<"$w1")")" "$(sum "$(jq -r .balance <<<"$w0")" 10)" "U's wTKB after run 1"
  is "$(num "$(jq -r .supply <<<"$w1")")" "$(sum "$(jq -r .supply <<<"$w0")" 10)" "wTKB's supply after run 1"
  is "$(jq -c '[.allocations, .deposits]' <<<"$after1")" "$(jq -c '[.allocations, .deposits]' <<<"$start")" "the allocations and deposit requests after run 1"
  custody_is_supply "$after1" "after run 1"

  # ---- run 2
  step "run 2, a payment: V pays U $PAY WtROME through the gateway, and U's 10 TKB go to V"
  local held wrap_tx approve_tx dvp payment pay_tx r2 n2 h2 u2 after2 rome_u rome_v
  held=$(coin "$CZE_WTROME" "$V_ADDR")
  if [ "$held" -lt "$PAY" ]; then
    wrap_tx=$(evm wrap v "$CZE_WTROME" "$PAY" | jq -r .tx)
    final "$wrap_tx" "V's wrapping of $PAY coin" >/dev/null
  fi
  rome_u=$(coin "$CZE_WTROME" "$U_ADDR"); rome_v=$(coin "$CZE_WTROME" "$V_ADDR")
  [ "$rome_v" -ge "$PAY" ] || fail "V holds $rome_v WtROME after wrapping, less than $PAY"
  approve_tx=$(evm approve v "$CZE_WTROME" gateway "$PAY" | jq -r .tx)
  final "$approve_tx" "V's approval of the gateway" >/dev/null
  dvp=$(canton dvp "$tag-dvp" "$CZE_WTROME" "$U_ADDR" "$PAY"); echo "$dvp" | jq -c .
  payment=$(jq -r .id <<<"$dvp")
  local pid; pid=$(canton payment-id "$tag-dvp"); pid=$(jq -r .id <<<"$pid")
  is "$payment" "$pid" "the payment id of $tag-dvp"
  pay_tx=$(evm pay v "$payment" "$CZE_WTROME" "$U_ADDR" "$PAY" | jq -r .tx)
  r2=$(final "$pay_tx" "the payment"); n2=$(jq -r .block <<<"$r2"); h2=$(jq -r .blockHash <<<"$r2")
  u2=$(check_leg "$n2" pay v "$h2"); local rec2; rec2=$(canton block "$n2" v | jq -c .record)
  after2=$(canton balances)
  is "$(num "$(total "$after2" u)")" "$(sum "$(total "$after1" u)" -10)" "U's TKB after run 2"
  is "$(num "$(total "$after2" v)")" "$(sum "$(total "$after1" v)" 10)" "V's TKB after run 2"
  is "$(jq -c '[.allocations, .terms]' <<<"$after2")" "$(jq -c '[.allocations, .terms]' <<<"$after1")" "the allocations and terms after run 2"
  local rome_u2 rome_v2; rome_u2=$(coin "$CZE_WTROME" "$U_ADDR"); rome_v2=$(coin "$CZE_WTROME" "$V_ADDR")
  is "$rome_u2" $((rome_u + PAY)) "U's WtROME after run 2"
  is "$rome_v2" $((rome_v - PAY)) "V's WtROME after run 2"
  custody_is_supply "$after2" "after run 2"

  # ---- run 3
  step "run 3, a withdrawal: U's address burns 4 wTKB, and 4 TKB go from the gateway to U"
  local withdraw_tx r3 n3 h3 u3 after3 w3
  withdraw_tx=$(evm withdraw u "$WTKB" 4 "$U_PARTY" | jq -r .tx)
  r3=$(final "$withdraw_tx" "the withdrawal"); n3=$(jq -r .block <<<"$r3"); h3=$(jq -r .blockHash <<<"$r3")
  u3=$(check_leg "$n3" withdraw u "$h3"); local rec3; rec3=$(canton block "$n3" u | jq -c .record)
  after3=$(canton balances); w3=$(wrapped "$U_ADDR")
  is "$(num "$(total "$after3" u)")" "$(sum "$(total "$after2" u)" 4)" "U's TKB after run 3"
  is "$(num "$(total "$after3" gateway)")" "$(sum "$(total "$after2" gateway)" -4)" "the custody after run 3"
  is "$(num "$(jq -r .balance <<<"$w3")")" "$(sum "$(jq -r .balance <<<"$w1")" -4)" "U's wTKB after run 3"
  is "$(num "$(jq -r .supply <<<"$w3")")" "$(sum "$(jq -r .supply <<<"$w1")" -4)" "wTKB's supply after run 3"
  custody_is_supply "$after3" "after run 3"

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
    echo "deposit_id=$deposit_id"
    echo "deposit_block=$n1"
    echo "deposit_block_hash=$h1"
    echo "deposit_claim_tx=$claim_tx"
    echo "deposit_request=$(short "$(jq -r .request <<<"$deposit")")"
    echo "deposit_allocation=$(short "$(jq -r .allocation <<<"$deposit")")"
    echo "deposit_canton_update=$u1"
    echo "deposit_proof_sha256=$(jq -r .proofSha256 <<<"$rec1")"
    echo "payment_id=$payment"
    echo "payment_block=$n2"
    echo "payment_block_hash=$h2"
    echo "payment_approve_tx=$approve_tx"
    echo "payment_pay_tx=$pay_tx"
    echo "payment_amount_wtrome=$PAY"
    echo "payment_terms=$(short "$(jq -r .terms <<<"$dvp")")"
    echo "payment_allocation=$(short "$(jq -r .allocation <<<"$dvp")")"
    echo "payment_canton_update=$u2"
    echo "payment_proof_sha256=$(jq -r .proofSha256 <<<"$rec2")"
    echo "withdrawal_block=$n3"
    echo "withdrawal_block_hash=$h3"
    echo "withdrawal_tx=$withdraw_tx"
    echo "withdrawal_canton_update=$u3"
    echo "withdrawal_proof_sha256=$(jq -r .proofSha256 <<<"$rec3")"
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

case $mode in
  setup) setup ;;
  legs) legs ;;
  all) setup; legs ;;
esac
