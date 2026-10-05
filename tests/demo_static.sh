#!/usr/bin/env bash
# Checks on the demo that need no Docker, Canton or GPU:
#   - the solc image is pinned by digest, and TKA.bin is a checked-in build of TKA.sol (the compile itself is checked in CI)
#   - nothing in demo/ or the demo's tests starts or names reth's image: reth is started only by network/reth/launch.sh
#   - demo/prove-tampered.sh changes exactly one hex digit of the proof, and nothing else, and refuses what it cannot tamper with
#   - the demo's genesis override keeps the chain settings and refuses a genesis with other ones
#   - demo/prepare.sh stops, before it installs anything, when the Python of the builder's venv is older than 3.12
#   - the recorded results of the present demo, if there are any, are complete and consistent
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

[[ ${SOLC_IMAGE:-} =~ @sha256:[0-9a-f]{64}$ ]] || fail "SOLC_IMAGE is not pinned by digest"
[[ $(cat "$ROOT/demo/TKA.bin") =~ ^[0-9a-f]{200,}$ ]] || fail "demo/TKA.bin is not creation code in hex"
grep -q "pragma solidity $SOLC_VERSION;" "$ROOT/demo/TKA.sol" || fail "demo/TKA.sol does not pin solc $SOLC_VERSION"

others=$(grep -rIlE 'RETH_IMAGE|paradigmxyz|reth node' "$ROOT/demo" "$ROOT"/tests/demo_* 2>/dev/null | grep -v 'tests/demo_static.sh$' || true)
[ -z "$others" ] || fail "something in the demo starts or names reth's image: $others"
! grep -rInE '(secret|password|passwd|private[-_ ]?key) *[=:] *["'"'"']?[A-Za-z0-9+/]{16,}' "$ROOT/demo" || fail "something that looks like a secret in demo/"

# prepare.sh refuses a venv whose Python is older than 3.12: the builder cannot read Canton's times with an older one (fromisoformat
# does not take a trailing Z before 3.11, and takes only 3 or 6 fractional digits) and would skip every leg, with the reason "its allocation's settle-before time cannot be read" (run.sh then stops on its own check of the leg count).
mkdir -p "$WORK/old/venv/bin"
printf '#!/bin/sh\nexit 1\n' > "$WORK/old/venv/bin/python3"; chmod +x "$WORK/old/venv/bin/python3"
printf '#!/bin/sh\necho "pip must not be reached" >&2; exit 3\n' > "$WORK/old/venv/bin/pip"; chmod +x "$WORK/old/venv/bin/pip"
if out=$(CZE_STATE_DIR="$WORK/old" "$ROOT/demo/prepare.sh" 2>&1); then fail "demo/prepare.sh accepted a venv with an old Python"; fi
grep -q "Python 3.12" <<<"$out" || fail "demo/prepare.sh's refusal of an old Python does not say 3.12: $out"
! grep -q "pip must not be reached" <<<"$out" || fail "demo/prepare.sh installed packages into a venv with an old Python"

# prove-tampered.sh, against a stand-in prover command that writes a proof of ee..ee.
cat > "$WORK/prove" <<'PROVER'
#!/usr/bin/env bash
mkdir -p "$2"; echo "$1" > "$2/seen"
head -c 1344 /dev/zero | od -An -v -tx1 | tr -d ' \n' | sed 's/00/ee/g' > "$2/wrapped-proof.hex"
PROVER
chmod +x "$WORK/prove"; echo input > "$WORK/in.bin"
out=$(CZE_TAMPER_REAL_PROVE_CMD=$WORK/prove "$ROOT/demo/prove-tampered.sh" "$WORK/in.bin" "$WORK/out")
grep -q 'tampered: byte 100' <<<"$out" || fail "prove-tampered.sh does not say what it changed"
[ "$(cat "$WORK/out/seen")" = "$WORK/in.bin" ] || fail "prove-tampered.sh did not pass the input to the real prover command"
proof=$(cat "$WORK/out/wrapped-proof.hex")
good=$(head -c 1344 /dev/zero | od -An -v -tx1 | tr -d ' \n' | sed 's/00/ee/g')
[ "${#proof}" = 2688 ] || fail "the tampered proof has another length"
diff=0; for i in $(seq 0 2687); do [ "${proof:$i:1}" = "${good:$i:1}" ] || { diff=$((diff + 1)); at=$i; }; done
[ "$diff" = 1 ] || fail "prove-tampered.sh changed $diff digits, expected 1"
[ "$at" = 200 ] || fail "prove-tampered.sh changed digit $at, expected 200 (the first digit of byte 100)"
[[ $proof =~ ^[0-9a-f]+$ ]] || fail "the tampered proof is not lowercase hex"
CZE_TAMPER_REAL_PROVE_CMD=false "$ROOT/demo/prove-tampered.sh" "$WORK/in.bin" "$WORK/out2" >/dev/null 2>&1 && fail "prove-tampered.sh went on after the real prover failed"
"$ROOT/demo/prove-tampered.sh" "$WORK/in.bin" "$WORK/out3" >/dev/null 2>&1 && fail "prove-tampered.sh ran without a real prover command"
cat > "$WORK/short" <<'SHORT'
#!/usr/bin/env bash
mkdir -p "$2"; echo abc > "$2/wrapped-proof.hex"
SHORT
chmod +x "$WORK/short"
CZE_TAMPER_REAL_PROVE_CMD=$WORK/short "$ROOT/demo/prove-tampered.sh" "$WORK/in.bin" "$WORK/out4" >/dev/null 2>&1 && fail "prove-tampered.sh tampered with a proof of the wrong size"

# make-state.sh: the demo's funded genesis is taken as it is, plus the gateway; one with other chain settings is refused; no override copies network/genesis.json plus the gateway.
without_gateway() { jq -S --arg a "$GATEWAY_ADDRESS" 'del(.alloc[$a])' "$1"; }
cp "$ROOT/network/genesis.json" "$WORK/funded.json"
jq '.alloc["0x00000000000000000000000000000000000000aa"] = {"balance": "0x1"}' "$ROOT/network/genesis.json" > "$WORK/funded.json"
CZE_STATE_DIR=$WORK/s1 CZE_GENESIS_FILE=$WORK/funded.json "$ROOT/network/make-state.sh"
[ "$(without_gateway "$WORK/s1/genesis.json")" = "$(jq -S . "$WORK/funded.json")" ] || fail "make-state.sh did not use CZE_GENESIS_FILE"
jq '.config.chainId = 1' "$ROOT/network/genesis.json" > "$WORK/other.json"
CZE_STATE_DIR=$WORK/s2 CZE_GENESIS_FILE=$WORK/other.json "$ROOT/network/make-state.sh" >/dev/null 2>&1 && fail "make-state.sh accepted a genesis with other chain settings"
CZE_STATE_DIR=$WORK/s3 "$ROOT/network/make-state.sh"
[ "$(without_gateway "$WORK/s3/genesis.json")" = "$(jq -S . "$ROOT/network/genesis.json")" ] || fail "make-state.sh without an override did not copy network/genesis.json"

# tests/demo_results.sh accepts results that say what the runs must show, and refuses each of the ones that do not.
"$ROOT/tests/demo_results_selftest.sh"

# The recorded results, once the demo has been run in its present form (a setup block and five runs). The results of the first
# version of the demo, which had two runs and no setup, stay in demo/results/ until a GPU session replaces them.
R=$ROOT/demo/results
if [ -f "$R/setup.txt" ] || { [ -f "$R/run1.txt" ] && ! grep -qx 'format=1' "$R/run1.txt"; }; then
  "$ROOT/tests/demo_results.sh"
elif [ -f "$R/run1.txt" ]; then
  echo "the recorded results are the first version's (format 1); a GPU run replaces them"
else
  echo "no recorded results of the present demo yet"
fi
echo "demo static checks passed"
