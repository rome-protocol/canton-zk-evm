#!/usr/bin/env bash
# The Canton side of the network, on its own and for real: the pinned Canton and Daml tools, the real (external-call)
# form of the Daml package, network/canton/canton.conf and bootstrap.canton, propose.py, and one Advance, against a
# stand-in for the sidecars (tests/fake_sidecar.py) and for reth (tests/fake_reth.py). It checks that
#   - the bootstrap, the upload and the vetting work, the main package id that dar-id.sh reads from the DAR is in the
#     operator participant's package list (GET /v2/packages), and the chain is proposed and accepted;
#   - the chain names the gateway party and the gateway contract's address from PINS, and the users' rights on the Ledger API are the right ones: the builder's user reads as the gateway and cannot act as it, the operator's acts as it;
#   - a token (the test token's registry, and a wrapped token that the stand-in reth says the gateway made) is registered:
#     proposed by the operator and the gateway, accepted by the confirmer;
#   - a block whose "sidecar" answers are good commits, and a block is refused and changes nothing when the answer of `verify`
#     is `no`, when the answer of `legs` is `no` or is not the line Daml expects, also when only the confirmer's sidecar says
#     `no` and the operator's says `ok`;
#   - Canton makes the external calls (verify, then legs) on the operator's participant when the block is submitted and on
#     both confirming participants when it validates it, and never needs a sidecar for the users participant.
#   - the demo's Canton helpers (demo/canton.py) make an acceptance, DvP terms and a deposit request that the real package takes.
# Needs Java 21 and network access to the registry in PINS. No GPU, no reth, no ZisK.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"
WORK=$(mktemp -d)
export CZE_STATE_DIR=$WORK/state FAKE_LOG=$WORK/calls FAKE_ANSWER=$WORK/answer
fail() { echo "FAIL: $*" >&2; exit 1; }
pids=()
cleanup() {
  local status=$?
  [ "$status" = 0 ] || { echo "--- Canton log (tail)"; tail -n 40 "$WORK/canton.log" 2>/dev/null || true; }
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

tools=$("$ROOT/network/canton/fetch.sh")
CANTON_JAR=$(sed -n 's/^CANTON_JAR=//p' <<<"$tools")
export CZE_TOOLS_DIR=${CZE_TOOLS_DIR:-$CZE_STATE_DIR/tools}
CZE_DAR=$("$ROOT/network/canton/build-dar.sh"); export CZE_DAR

H0=$(printf 'ab%.0s' $(seq 32)); H1=$(printf 'bb%.0s' $(seq 32)); VK=$(printf 'cd%.0s' $(seq 32)); RC=$(printf 'ef%.0s' $(seq 32))
SR=$(printf '55%.0s' $(seq 32)); GW=${GATEWAY_ADDRESS#0x}
# What the sidecar answers for `verify`: ok, programVK, rootC, blockHash, parentHash, number, stateRoot, timestamp, gasLimit, gasUsed, txCount.
VERIFY_OK="ok $VK $RC $H1 $H0 1 $SR 1700000000 30000000 0 0"
# ... and for `legs`: ok, the state root and number it was given, the gateway's address, and how many legs (none here).
LEGS_OK="ok $SR 1 $GW 0"
answers() { echo "$VERIFY_OK" > "$FAKE_ANSWER.verify"; echo "$LEGS_OK" > "$FAKE_ANSWER.legs"; rm -f "$FAKE_ANSWER".80*.*; : > "$FAKE_LOG"; }
answers
for port in 8085 8086; do
  python3 "$ROOT/tests/fake_sidecar.py" $port & pids+=($!)
done
python3 "$ROOT/tests/fake_reth.py" 18545 & pids+=($!)
sleep 1

java -Xmx3g -jar "$CANTON_JAR" daemon -c "$ROOT/network/canton/canton.conf" --bootstrap "$ROOT/network/canton/bootstrap.canton" --no-tty > "$WORK/canton.log" 2>&1 &
pids+=($!)
for _ in $(seq 1 300); do grep -q "BOOTSTRAP DONE" "$WORK/canton.log" && break; kill -0 "${pids[-1]}" 2>/dev/null || fail "Canton stopped"; sleep 1; done
grep -q "BOOTSTRAP DONE" "$WORK/canton.log" || fail "the bootstrap did not finish"

# The package id that dar-id.sh reads from the DAR is a package the operator participant holds (what smoke.sh checks
# before it records the id).
package_id=$("$ROOT/network/canton/dar-id.sh" "$CZE_DAR" | sed -n 's/^package_id=//p')
"$ROOT/network/canton/check-package.sh" "$package_id" http://127.0.0.1:7575 || fail "the DAR's main package ($package_id) is not in the operator participant's package list"

python3 "$ROOT/network/canton/propose.py" --genesis-hash "$H0" --genesis-state-root "$(printf '44%.0s' $(seq 32))" --program-vk "$VK" --root-c "$RC" --rules-hash "$(printf '12%.0s' $(seq 32))" --gateway-address "$GW" >/dev/null
# The chain names the gateway party and the gateway contract's address; the builder's user reads as the gateway and cannot act as it, and the operator's user acts as it.
[ "$(python3 "$ROOT/tests/canton_advance.py" "$CZE_STATE_DIR" gateway "$GW")" = ok ] || fail "the chain does not name the gateway, or the Ledger API users' rights on the gateway are wrong"

# A token: the test token's registry (its rules are the transfer factory) and a wrapped token that reth says the gateway made.
# The operator and the gateway propose it, the confirmer accepts it.
python3 "$ROOT/demo/canton.py" upload-dars >/dev/null
rules=$(python3 "$ROOT/demo/canton.py" setup | jq -r .rules)
registry=$(sed -n 's/^REGISTRY_PARTY=//p' "$CZE_STATE_DIR/canton/parties.env")
token=$(printf '12%.0s' $(seq 20))
registered=$(python3 "$ROOT/network/canton/propose.py" token --evm-token "$token" --instrument-admin "$registry" --instrument-id TKB --factory "$rules" --reth-url http://127.0.0.1:18545)
jq -e --arg t "$token" --arg r "$registry" '.evmToken == $t and .instrumentId == {admin: $r, id: "TKB"}' <<<"$registered" >/dev/null || fail "the token was not registered as proposed: $registered"
# The same token cannot be registered twice.
dup=$(python3 "$ROOT/network/canton/propose.py" token --evm-token "$token" --instrument-admin "$registry" --instrument-id TKB --factory "$rules" --reth-url http://127.0.0.1:18545 2>&1 >/dev/null) \
  && fail "a token was registered twice"
grep -q "registered or proposed already" <<<"$dup" || fail "the second registration failed for another reason: $dup"
# ... and, as the operator, exactly one token is registered for that address.
python3 - "$ROOT" "$CZE_STATE_DIR" "$token" <<'PY' || fail "there is not exactly one registered token for $token"
import sys
from pathlib import Path
root, state, token = sys.argv[1:]
sys.path.insert(0, root + "/network/canton")
import propose
parties = propose.read_env_file(Path(state) / "canton" / "parties.env")
found = [c for c in propose.operator_ledger("http://127.0.0.1:7575", parties).active("GatewayToken") if c["evmToken"] == token]
assert len(found) == 1, f"{len(found)} tokens are registered for {token}"
PY

# The demo's Canton helpers make contracts that the real Daml package accepts: a standing acceptance, DvP terms (whose payment id the
# template's `ensure` insists is the SHA-256 of U's and V's party ids and the label), and a deposit request with its allocation to the gateway.
canton() { python3 "$ROOT/demo/canton.py" "$@"; }
canton accept u >/dev/null
dvp=$(canton dvp dvp-1 "$token" "$token" 10)
deposit=$(canton deposit deposit-1 "$token" 10)
[ "$(jq -r .id <<<"$dvp")" = "$(canton payment-id dvp-1 | jq -r .id)" ] || fail "the terms carry another payment id than payment-id gives: $dvp"
[[ $(jq -r .depositId <<<"$deposit") =~ ^[0-9a-f]{64}$ ]] || fail "the deposit request has no deposit id: $deposit"
helped=$(canton status)
jq -e '.terms == 1 and .deposits == 1 and .acceptances == 1 and (.allocations | sort) == ["deposit-1", "dvp-1"] and .tkb.u == [80] and .custody == []' <<<"$helped" >/dev/null \
  || fail "the demo's helpers left Canton in another state than expected: $helped"

# A refused block: the sidecar says no to verify. Nothing moves, and the head stays 0.
echo "no the proof does not verify" > "$FAKE_ANSWER.verify"
[ "$(python3 "$ROOT/tests/canton_advance.py" "$CZE_STATE_DIR" refused 2>/dev/null)" = 0 ] || fail "a refused block moved the head"
# A block the operator's sidecar accepts and the confirmer's sidecar does not: the confirmer's participant refuses it when it
# validates, so nothing moves. The confirmer is a signatory of the chain: its own sidecar, not the operator's, decides for it.
answers
echo "no the confirmer's sidecar does not accept the proof" > "$FAKE_ANSWER.8086.verify"
[ "$(python3 "$ROOT/tests/canton_advance.py" "$CZE_STATE_DIR" refused 2>/dev/null)" = 0 ] || fail "a block the confirmer's sidecar refused moved the head"
grep -q '^8085 verify submission$' "$FAKE_LOG" || fail "the operator's sidecar was not asked, so the case did not test the confirmer"
grep -q '^8086 verify validation$' "$FAKE_LOG" || fail "the confirmer's sidecar was not asked, so the case did not test the confirmer"
# The legs check: a sidecar that says no (the legs are not the ones the block recorded) stops the block, and so does an
# answer that is `ok` but not the line Daml expects (here, a count that is not the number of legs attached).
answers
echo "no the legs are not the ones the block recorded" > "$FAKE_ANSWER.legs"
[ "$(python3 "$ROOT/tests/canton_advance.py" "$CZE_STATE_DIR" refused 2>/dev/null)" = 0 ] || fail "a block whose legs the sidecar refused moved the head"
grep -q '^8085 legs submission$' "$FAKE_LOG" || fail "the operator's sidecar was never asked for legs"
answers
echo "ok $SR 1 $GW 1" > "$FAKE_ANSWER.legs"
[ "$(python3 "$ROOT/tests/canton_advance.py" "$CZE_STATE_DIR" refused 2>/dev/null)" = 0 ] || fail "a block moved the head on a legs answer that was not the expected line"
# The same for the confirmer alone.
answers
echo "no the legs are not the ones the block recorded" > "$FAKE_ANSWER.8086.legs"
[ "$(python3 "$ROOT/tests/canton_advance.py" "$CZE_STATE_DIR" refused 2>/dev/null)" = 0 ] || fail "a block whose legs the confirmer's sidecar refused moved the head"
grep -q '^8085 legs submission$' "$FAKE_LOG" || fail "the operator's sidecar was not asked for legs, so the case did not test the confirmer"
grep -q '^8086 legs validation$' "$FAKE_LOG" || fail "the confirmer's sidecar was not asked for legs, so the case did not test the confirmer"
# A good block.
answers
[ "$(python3 "$ROOT/tests/canton_advance.py" "$CZE_STATE_DIR" accepted)" = 1 ] || fail "a good block did not move the head to 1"

# Calls: Canton asked the operator's sidecar in submission mode and both sidecars in validation mode, for verify and for legs only.
for function in verify legs; do
  grep -q "^8085 $function submission\$" "$FAKE_LOG" || fail "no submission-mode $function call on the operator's sidecar"
  grep -q "^8085 $function validation\$" "$FAKE_LOG" || fail "no validation-mode $function call on the operator's sidecar"
  grep -q "^8086 $function validation\$" "$FAKE_LOG" || fail "no validation-mode $function call on the confirmer's sidecar"
done
! grep -qvE ' (verify|legs) ' "$FAKE_LOG" || fail "a call other than verify and legs"
echo "canton network test passed"
