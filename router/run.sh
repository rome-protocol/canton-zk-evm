#!/usr/bin/env bash
# Runs the router's Foundry tests with the pinned tools (tools.sh). Extra arguments go to forge test.
set -euo pipefail
# shellcheck disable=SC1091
. "$(dirname "$0")/tools.sh"
cd "$HERE"
"$FORGE" --version | head -n 1
"$FORGE" test -vv "$@"
