#!/usr/bin/env bash
# Compiles gateway/Gateway.sol and gateway/Vault.sol with the solc image in PINS and writes each one's runtime code, as hex without
# 0x, to gateway/Gateway.bin-runtime and gateway/Vault.bin-runtime (or, if $1 is given, the gateway's to the file named by $1 and the
# vault's to Vault.bin-runtime beside it). network/make-state.sh puts the gateway's code into each run's genesis.
# With --check it compiles to temporary files and fails unless both checked-in files are identical, and unless the gateway's address
# in Vault.sol is GATEWAY_ADDRESS in PINS.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"
mode="write"
if [ "${1:-}" = --check ]; then mode="check"; shift; fi
OUT=${1:-$ROOT/gateway/Gateway.bin-runtime}
VAULT_OUT=$(dirname "$OUT")/Vault.bin-runtime
if [ "$mode" = check ]; then OUT=$(mktemp); VAULT_OUT=$(mktemp); fi
umask 022

# compile <Name> <out>: compiles gateway/<Name>.sol. The flags are fixed: the same source and the same compiler give the same bytes.
# Gateway.sol also holds the wrapped token, whose creation code sits inside the gateway's runtime code, so the output is picked out
# by the contract's name.
compile() {
  docker run --rm -v "$ROOT/gateway:/src:ro" "$SOLC_IMAGE" --evm-version cancun --optimize --optimize-runs 200 --no-cbor-metadata --bin-runtime "/src/$1.sol" \
    | awk -v name="$1" '$0 ~ ("^======= (.*/)?" name "\\.sol:" name " =======$") { on = 1; next } /^======= / { on = 0 } on && /^Binary of the runtime part:/ { getline; printf "%s", $0 }' > "$2"
  [[ $(cat "$2") =~ ^[0-9a-f]{200,}$ ]] || { echo "FAIL: the compiler did not give runtime code for $1" >&2; exit 1; }
}
compile Gateway "$OUT"
compile Vault "$VAULT_OUT"

if [ "$mode" = check ]; then
  for name in Gateway Vault; do
    if [ "$name" = Gateway ]; then new=$OUT; else new=$VAULT_OUT; fi
    cmp -s "$new" "$ROOT/gateway/$name.bin-runtime" || { echo "FAIL: gateway/$name.bin-runtime is not what gateway/$name.sol compiles to (run gateway/build.sh)" >&2; rm -f "$OUT" "$VAULT_OUT"; exit 1; }
  done
  rm -f "$OUT" "$VAULT_OUT"
  echo "gateway/Gateway.bin-runtime and gateway/Vault.bin-runtime are what Gateway.sol and Vault.sol compile to"
  want=$(tr 'A-F' 'a-f' <<<"$GATEWAY_ADDRESS")
  have=$(sed -n 's/^    address public constant GATEWAY = \(0x[0-9a-fA-F]\{40\}\);$/\1/p' "$ROOT/gateway/Vault.sol" | tr 'A-F' 'a-f')
  [ "$have" = "$want" ] || { echo "FAIL: GATEWAY in gateway/Vault.sol ($have) is not GATEWAY_ADDRESS in PINS ($want)" >&2; exit 1; }
  echo "the vault's gateway is GATEWAY_ADDRESS"
fi
