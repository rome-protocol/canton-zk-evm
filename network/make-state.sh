#!/usr/bin/env bash
# Creates the per-run state: the Engine JWT secret and the genesis file reth reads.
# Nothing here is committed; the state folder is ignored by git.
#
# network/genesis.json holds the chain settings and the Prague system contracts. It has
# no funded accounts, so the copy is identical and carries no keys or addresses of ours.
# CZE_GENESIS_FILE names another genesis to copy instead. The demo uses it for a copy that
# also funds its own per-run test key (demo/evm.py genesis); the chain settings stay the same.
#
# Whichever genesis is copied, the copy also holds the gateway: its runtime code (gateway/Gateway.bin-runtime) at GATEWAY_ADDRESS
# from PINS, with nonce 1, no balance and no storage. It is added here and not written into network/genesis.json, because the
# guest program includes that file whole and any edit to it would change the program key. A genesis that already has
# something at that address is refused.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
STATE=${CZE_STATE_DIR:-$ROOT/state}

umask 077
mkdir -p "$STATE"
[ -s "$STATE/jwt.hex" ] || openssl rand -hex 32 > "$STATE/jwt.hex"

GENESIS=${CZE_GENESIS_FILE:-$ROOT/network/genesis.json}
# Whatever genesis is used, the chain settings are the pinned ones: the guest refuses blocks under any other.
jq -e --slurpfile base "$ROOT/network/genesis.json" '.config == $base[0].config' "$GENESIS" >/dev/null \
  || { echo "FAIL: the genesis $GENESIS has chain settings other than network/genesis.json's" >&2; exit 1; }
# shellcheck disable=SC1091
. "$ROOT/PINS"
CODE_FILE=$ROOT/gateway/Gateway.bin-runtime
[[ ${GATEWAY_ADDRESS:-} =~ ^0x[0-9a-f]{40}$ ]] || { echo "FAIL: PINS has no GATEWAY_ADDRESS" >&2; exit 1; }
[ -s "$CODE_FILE" ] || { echo "FAIL: the gateway's runtime code $CODE_FILE is missing or empty (gateway/build.sh makes it)" >&2; exit 1; }
CODE=0x$(tr -d '[:space:]' < "$CODE_FILE")
[[ $CODE =~ ^0x([0-9a-f]{2})+$ ]] || { echo "FAIL: $CODE_FILE is not hex" >&2; exit 1; }
# An address may be written with capitals or without the 0x: all of those are the same account.
jq -e --arg a "${GATEWAY_ADDRESS#0x}" '[.alloc | keys[] | ascii_downcase | ltrimstr("0x")] | any(. == $a) | not' "$GENESIS" >/dev/null \
  || { echo "FAIL: the genesis $GENESIS already has an account at the gateway's address $GATEWAY_ADDRESS" >&2; exit 1; }
# Written to a temporary file in the state folder first, so that a failure leaves no half-written genesis.
jq --arg a "$GATEWAY_ADDRESS" --arg c "$CODE" '.alloc[$a] = {balance: "0x0", nonce: "0x1", code: $c}' "$GENESIS" > "$STATE/genesis.json.new"
mv "$STATE/genesis.json.new" "$STATE/genesis.json"
chmod 644 "$STATE/genesis.json"   # the container user must be able to read it
