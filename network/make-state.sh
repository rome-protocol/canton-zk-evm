#!/usr/bin/env bash
# Creates the per-run state: the Engine JWT secret and the genesis file reth reads.
# Nothing here is committed; the state folder is ignored by git.
#
# network/genesis.json holds the chain settings and the Prague system contracts. It has
# no funded accounts, so the copy is identical and carries no keys or addresses of ours.
# CZE_GENESIS_FILE names another genesis to copy instead. The demo uses it for a copy that
# also funds its own per-run test key (demo/evm.py genesis); the chain settings stay the same.
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
cp "$GENESIS" "$STATE/genesis.json"
chmod 644 "$STATE/genesis.json"   # the container user must be able to read it
