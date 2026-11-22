#!/usr/bin/env bash
# Tests deploy.py and deploy_note_board.py against a local chain (anvil) with throwaway keystores: the deploy, the settings through the timelock, every read-back and its refusals.
# Builds the contracts with the pinned tools first. Nothing leaves this machine.
set -euo pipefail
# shellcheck disable=SC1091
. "$(dirname "$0")/tools.sh"
cd "$HERE"
for t in cast anvil; do command -v "$t" >/dev/null || fail "$t is needed on PATH"; done
"$FORGE" build
python3 test_deploy.py "$@"
python3 test_note_board_deploy.py "$@"
