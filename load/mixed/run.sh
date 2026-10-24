#!/usr/bin/env bash
# The mixed load's runner. Everything runs in the repo's pinned containers; nothing but Docker is needed on the machine.
#
#   run.sh build            install the pinned packages (npm ci) and compile every contract (Foundry, two builds: see scripts/prepare.mjs)
#   run.sh deploy           deploy the contracts and write addresses.json (idempotent: what exists is skipped)
#   run.sh verify           verify every deployed contract on the explorer
#   run.sh node <args...>   run any node command in the kit's Node container (the deploy and the driver are scripts/*.mjs)
#
# RUN_DIR (default ./runs/<UTC date>) holds the run's own files: keys/ (0700), addresses.json, txs.json, logs. Keys never leave it and are never printed.
# keys/distributor.key (0600, put there by you) is the funded account that deploys and funds the test wallets.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"; . "$HERE/PINS"
cd "$HERE"
RUN_DIR=${RUN_DIR:-$HERE/runs/$(date -u +%F)}
mkdir -p -m 0700 "$RUN_DIR" "$RUN_DIR/keys"
RUN_DIR=$(cd "$RUN_DIR" && pwd)
mkdir -p .home .npm-cache
UIDGID="$(id -u):$(id -g)"

node_c() { docker run --rm --user "$UIDGID" -e HOME=/w/.home -e npm_config_cache=/w/.npm-cache -e RUN_DIR=/run-dir \
  -v "$HERE:/w" -v "$RUN_DIR:/run-dir" -w /w "$EXPLORER_NODE_IMAGE" "$@"; }
forge_c() { docker run --rm --user "$UIDGID" -e HOME=/w/.home -v "$HERE:/w" -w /w --entrypoint forge "$FOUNDRY_IMAGE" "$@"; }

case ${1:-} in
  build)
    node_c npm ci --ignore-scripts --no-audit --no-fund
    mkdir -p gen/pair
    printf '// SPDX-License-Identifier: GPL-3.0-or-later\npragma solidity >=0.5.16;\nimport "@uniswap/v2-core/contracts/UniswapV2Pair.sol";\n' > gen/pair/Pair.sol
    forge_c build --profile pair
    node_c node scripts/prepare.mjs
    forge_c build
    ;;
  deploy) shift; node_c node scripts/deploy.mjs "$@" ;;
  verify) shift; node_c node scripts/verify.mjs "$@" ;;
  node) shift; node_c node "$@" ;;
  *) sed -n 2,9p "$0"; exit 2 ;;
esac
