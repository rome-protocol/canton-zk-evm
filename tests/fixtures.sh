#!/usr/bin/env bash
# The recorded proof of the one-transfer block is consistent: the checksums hold, the 1,344-byte
# hex is the four fields of the JSON one after the other, and the facts in session.txt agree with
# the JSON, with PINS and with the recorded rules hash. This needs no GPU.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
F=$ROOT/prover/fixtures
fail() { echo "FAIL: $*" >&2; exit 1; }

if command -v sha256sum >/dev/null; then sums="sha256sum -c"; else sums="shasum -a 256 -c"; fi
( cd "$F" && $sums SHA256SUMS >/dev/null ) || fail "a fixture does not match SHA256SUMS"

hex=$(tr -d '\n' < "$F/wrapped-proof.hex")
{ [[ $hex =~ ^[0-9a-f]+$ ]] && [ "${#hex}" = 2688 ]; } || fail "wrapped-proof.hex is not 1,344 bytes of lower-case hex"
joined=$(jq -j '[.proofBytes, .programVK, .rootCVadcopFinal, .publicValues] | map(ltrimstr("0x")) | join("")' "$F/transfer-proof.json")
[ "$hex" = "$joined" ] || fail "wrapped-proof.hex is not the four fields of transfer-proof.json"

fact() { grep -E "^$1=" "$F/session.txt" | cut -d= -f2-; }
[ "$(fact programVK)" = "$(jq -r .programVK "$F/transfer-proof.json")" ] || fail "programVK differs between session.txt and the proof"
[ "$(fact rootC)" = "$(jq -r .rootCVadcopFinal "$F/transfer-proof.json")" ] || fail "rootC differs between session.txt and the proof"
[ "$(fact rulesHash)" = "$(tr -d '\n' < "$ROOT/guest/fixtures/rules-hash.txt")" ] || fail "rulesHash differs from guest/fixtures/rules-hash.txt"
# shellcheck disable=SC1091
ZISK_VERSION=$(. "$ROOT/PINS"; echo "$ZISK_VERSION")
[ "$(fact zisk)" = "$ZISK_VERSION" ] || fail "session.txt is for another ZisK release than PINS"
for k in elf_sha256 input_sha256; do
  [[ $(fact $k) =~ ^[0-9a-f]{64}$ ]] || fail "$k in session.txt is not a SHA-256"
done
echo "fixtures consistent"
