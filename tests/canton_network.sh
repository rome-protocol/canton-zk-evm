#!/usr/bin/env bash
# The Canton side of the network, on its own and for real: the pinned Canton and Daml tools, the real (external-call)
# form of the Daml package, network/canton/canton.conf and bootstrap.canton, propose.py, and one Advance, against a
# stand-in for the sidecars (tests/fake_sidecar.py). It checks that
#   - the bootstrap, the upload and the vetting work, the main package id that dar-id.sh reads from the DAR is in the
#     operator participant's package list (GET /v2/packages), and the chain is proposed and accepted;
#   - a block whose "sidecar" answer is good commits, and a block whose answer is `no` is refused and changes nothing,
#     also when only the confirmer's sidecar says `no` and the operator's says `ok`;
#   - Canton makes the external call on the operator's participant when the block is submitted and on both confirming
#     participants when it validates it, and never needs a sidecar for the users participant.
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
# What the sidecar answers for `verify`: ok, programVK, rootC, blockHash, parentHash, number, stateRoot, timestamp, gasLimit, gasUsed, txCount.
echo "ok $VK $RC $H1 $H0 1 $(printf '55%.0s' $(seq 32)) 1700000000 30000000 0 0" > "$FAKE_ANSWER"
: > "$FAKE_LOG"
for port in 8085 8086; do
  python3 "$ROOT/tests/fake_sidecar.py" $port & pids+=($!)
done
sleep 1

java -Xmx3g -jar "$CANTON_JAR" daemon -c "$ROOT/network/canton/canton.conf" --bootstrap "$ROOT/network/canton/bootstrap.canton" --no-tty > "$WORK/canton.log" 2>&1 &
pids+=($!)
for _ in $(seq 1 300); do grep -q "BOOTSTRAP DONE" "$WORK/canton.log" && break; kill -0 "${pids[-1]}" 2>/dev/null || fail "Canton stopped"; sleep 1; done
grep -q "BOOTSTRAP DONE" "$WORK/canton.log" || fail "the bootstrap did not finish"

# The package id that dar-id.sh reads from the DAR is a package the operator participant holds (what smoke.sh checks
# before it records the id).
package_id=$("$ROOT/network/canton/dar-id.sh" "$CZE_DAR" | sed -n 's/^package_id=//p')
"$ROOT/network/canton/check-package.sh" "$package_id" http://127.0.0.1:7575 || fail "the DAR's main package ($package_id) is not in the operator participant's package list"

python3 "$ROOT/network/canton/propose.py" --genesis-hash "$H0" --genesis-state-root "$(printf '44%.0s' $(seq 32))" --program-vk "$VK" --root-c "$RC" --rules-hash "$(printf '12%.0s' $(seq 32))" >/dev/null

# A refused block: the sidecar says no. Nothing moves, and the head stays 0.
echo "no the proof does not verify" > "$FAKE_ANSWER"
[ "$(python3 "$ROOT/tests/canton_advance.py" "$CZE_STATE_DIR" refused 2>/dev/null)" = 0 ] || fail "a refused block moved the head"
# A block the operator's sidecar accepts and the confirmer's sidecar does not: the confirmer's participant refuses it when it
# validates, so nothing moves. The confirmer is a signatory of the chain: its own sidecar, not the operator's, decides for it.
echo "no the confirmer's sidecar does not accept the proof" > "$FAKE_ANSWER.8086"
echo "ok $VK $RC $H1 $H0 1 $(printf '55%.0s' $(seq 32)) 1700000000 30000000 0 0" > "$FAKE_ANSWER"
: > "$FAKE_LOG"
[ "$(python3 "$ROOT/tests/canton_advance.py" "$CZE_STATE_DIR" refused 2>/dev/null)" = 0 ] || fail "a block the confirmer's sidecar refused moved the head"
grep -q '^8085 verify submission$' "$FAKE_LOG" || fail "the operator's sidecar was not asked, so the case did not test the confirmer"
grep -q '^8086 verify validation$' "$FAKE_LOG" || fail "the confirmer's sidecar was not asked, so the case did not test the confirmer"
rm -f "$FAKE_ANSWER.8086"
# A good block.
echo "ok $VK $RC $H1 $H0 1 $(printf '55%.0s' $(seq 32)) 1700000000 30000000 0 0" > "$FAKE_ANSWER"
[ "$(python3 "$ROOT/tests/canton_advance.py" "$CZE_STATE_DIR" accepted)" = 1 ] || fail "a good block did not move the head to 1"

# Calls: Canton asked the operator's sidecar in submission mode and both sidecars in validation mode, only for verify.
grep -q '^8085 verify submission$' "$FAKE_LOG" || fail "no submission-mode call on the operator's sidecar"
grep -q '^8085 verify validation$' "$FAKE_LOG" || fail "no validation-mode call on the operator's sidecar"
grep -q '^8086 verify validation$' "$FAKE_LOG" || fail "no validation-mode call on the confirmer's sidecar"
! grep -qv ' verify ' "$FAKE_LOG" || fail "a call other than verify"
echo "canton network test passed"
