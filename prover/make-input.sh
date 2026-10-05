#!/usr/bin/env bash
# Builds the prover input for one block, with zisk-eth-client's own input code.
#
# Usage: make-input.sh <block.json> <witness.json> <genesis.json> <out.bin>
#
# Clones zisk-eth-client at the commit in PINS into state/zisk-eth-client, builds the small tool
# in prover/make-input against it (needs Rust; the first build takes a few minutes), and runs it.
# See prover/make-input/src/main.rs for what the files are.
set -euo pipefail
# shellcheck disable=SC1091
. "$(dirname "$0")/common.sh"

CHECKOUT=$ROOT/state/zisk-eth-client
TOOL=$ROOT/prover/make-input
if [ ! -d "$CHECKOUT/.git" ]; then
  git clone --quiet https://github.com/0xPolygonHermez/zisk-eth-client "$CHECKOUT"
fi
git -C "$CHECKOUT" checkout --quiet "$ZISK_ETH_CLIENT_COMMIT"
[ -f "$TOOL/Cargo.lock" ] || cp "$CHECKOUT/Cargo.lock" "$TOOL/Cargo.lock"

cargo build --release --quiet --manifest-path "$TOOL/Cargo.toml"
"$TOOL/target/release/cze-make-input" "$@"
