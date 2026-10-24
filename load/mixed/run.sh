#!/usr/bin/env bash
# The mixed load's runner. Everything runs in the repo's pinned containers; nothing but Docker is needed on the machine.
#
#   run.sh build            install the pinned packages (npm ci) and compile every contract (Foundry, two passes: see scripts/prepare.mjs)
#   run.sh deploy           deploy the contracts and write addresses.json (idempotent: what exists is skipped)
#   run.sh verify           verify every deployed contract on the explorer
#   run.sh smoke            one action of each kind from the test wallets (writes smoke.json)
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
CHAIN_ID=$(grep -o '"chainId": *[0-9]*' config.json | grep -o '[0-9]*$')
RPC=${RPC:-$(grep -o '"rpc": *"[^"]*"' config.json | cut -d'"' -f4)}
EXPLORER_API=$(grep -o '"explorerApi": *"[^"]*"' config.json | cut -d'"' -f4)

node_c() { docker run --rm --user "$UIDGID" -e HOME=/w/.home -e npm_config_cache=/w/.npm-cache -e RUN_DIR=/run-dir \
  -v "$HERE:/w" -v "$RUN_DIR:/run-dir" -w /w "$EXPLORER_NODE_IMAGE" "$@"; }
forge_c() { docker run --rm --user "$UIDGID" -e HOME=/w/.home -e FOUNDRY_PROFILE="${PROFILE:-default}" -v "$HERE:/w" -w /w --entrypoint forge "$FOUNDRY_IMAGE" "$@"; }

case ${1:-} in
  build)
    node_c npm ci --ignore-scripts --no-audit --no-fund
    rm -rf contracts/gen
    forge_c build
    node_c node scripts/prepare.mjs
    forge_c build
    node_c node scripts/prepare.mjs check
    ;;
  deploy) shift; node_c node scripts/deploy.mjs "$@" ;;
  smoke) shift; node_c node scripts/smoke.mjs "$@" ;;
  verify)
    node_c node scripts/verify.mjs list
    # The explorer takes 30 verifications an hour from one client: a submission that is refused is tried again after the pause it asks for.
    while IFS=$'\t' read -r name addr target compiler evm runs args; do
      echo "== $name $addr"
      for try in 1 2 3 4 5 6 7 8; do
        out=$(forge_c verify-contract "$addr" "$target" --chain-id "$CHAIN_ID" --verifier etherscan --verifier-url "$EXPLORER_API" --etherscan-api-key any \
          --rpc-url "$RPC" --compiler-version "$compiler" --evm-version "$evm" --num-of-optimizations "$runs" ${args:+--constructor-args "$args"} --watch --retries 60 --delay 5 2>&1) && rc=0 || rc=$?
        echo "$out" | tail -4 | cut -c1-300
        if echo "$out" | grep -qi "hour\|limit\|429\|Retry"; then echo "rate limit: waiting 130 s"; sleep 130; else break; fi
      done
      sleep 125
    done < "$RUN_DIR/verify-list.tsv"
    node_c node scripts/verify.mjs check
    ;;
  node) shift; node_c node "$@" ;;
  *) sed -n 2,9p "$0"; exit 2 ;;
esac
