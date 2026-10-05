#!/usr/bin/env bash
# Shared settings for the prover scripts. Source this file; do not run it.
#
# All of these can be set in the environment:
#   ZISK_DIR              where ZisK is installed             (default: ~/.zisk)
#   ZISK_COORDINATOR_URL  where proofs are requested             (default: http://127.0.0.1:7000)
#   CZE_PROVER_STATE      logs, pid files, the built guest     (default: ./state/prover, ignored by git)
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
set -a
# shellcheck disable=SC1091
. "$ROOT/PINS"
set +a
export ZISK_DIR=${ZISK_DIR:-$HOME/.zisk}
export ZISK_HOME=$ZISK_DIR
export ZISK_COORDINATOR_URL=${ZISK_COORDINATOR_URL:-http://127.0.0.1:7000}
export PATH="$ZISK_DIR/bin:$HOME/.cargo/bin:$PATH"
STATE=${CZE_PROVER_STATE:-$ROOT/state/prover}
# shellcheck disable=SC2034  # used by the scripts that source this file
GUEST_ELF=${CZE_GUEST_ELF:-$STATE/guest/zec-reth.elf}
fail() { echo "FAIL: $*" >&2; exit 1; }
