#!/usr/bin/env bash
# Tests deploy.py against a local chain (anvil) with throwaway keystores: the deploy, the settings through the timelock, every read-back and its refusals.
# Builds the contracts with the pinned tools first. Nothing leaves this machine.
set -euo pipefail
# shellcheck source=tools.sh
. "$(dirname "$0")/tools.sh"
cd "$HERE"
command -v cast >/dev/null && command -v anvil >/dev/null || fail "cast and anvil are needed on PATH"
"$FORGE" build
python3 test_deploy.py "$@"
