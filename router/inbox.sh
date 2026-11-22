#!/usr/bin/env bash
# Writes the inbox's creation code, as hex without 0x, to artifacts/CantonInbox.creation.hex, and the same bytes into src/InboxCode.sol.
# Run it only when the inbox's source changes on purpose: the checked-in bytes, not a fresh compile, are what every router embeds, so an
# inbox address never moves with a compiler or a setting. It prints the code hash that test/vectors/r1.json pins as inboxCodeHash.
# Needs forge and the solc named by SOLC (a path), as run.sh sets them up.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE"
code=$(forge inspect CantonInbox bytecode | sed 's/^0x//')
[[ $code =~ ^[0-9a-f]{200,}$ ]] || { echo "FAIL: no creation code for CantonInbox" >&2; exit 1; }
printf '%s' "$code" > artifacts/CantonInbox.creation.hex
cat > src/InboxCode.sol <<SOL
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
pragma solidity 0.8.28;

// The inbox's creation code, from artifacts/CantonInbox.creation.hex (written by inbox.sh). Every router build embeds these bytes.
library InboxCode {
    bytes internal constant CREATION = hex"$code";
}
SOL
echo "inboxCodeHash $(cast keccak "0x$code")"
