#!/usr/bin/env bash
# L5 of the nightly load test: the tools developers verify and read contracts with, pointed at the explorer's Etherscan-compatible API. The steps, in the order
# tests/demo_nightly_chain.sh runs them (probe, tools and prepare on the runner; build and verify in the pinned browser image, which has glibc and Node 24):
#   l5.sh probe                     does the explorer answer GET /api?module=proxy&action=eth_blockNumber as Etherscan does? exit 0 yes, 3 no (EXPLORER)
#   l5.sh tools <folder>            Foundry, the release and SHA-256 in TOOLS, into <folder>
#   l5.sh prepare <folder>          this directory, with foundry.toml filled in for the chain, into <folder> (L5_EXPLORER, L5_CHAIN_ID)
#   l5.sh build                     in <folder>/project: npm ci, forge build, and the contract's creation code to <folder>/creation.hex
#   l5.sh verify                    in <folder>/project: the checks of l5.mjs against the deployed contracts
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
UA='Rome Protocol rome@romeprotocol.com'
fail() { echo "FAIL: $*" >&2; exit 1; }

# shellcheck disable=SC1091
. "$HERE/TOOLS"
export L5_SOLC_VERSION

case "${1:-}" in
  probe)
    : "${EXPLORER:?EXPLORER is not set}"
    out=$(curl -s -m 20 -A "$UA" -w '\n%{http_code}' "$EXPLORER/api?module=proxy&action=eth_blockNumber" || true)
    code=${out##*$'\n'}; body=${out%$'\n'*}
    if [ "$code" = 200 ] && jq -e '.result | strings | test("^0x[0-9a-fA-F]+$")' <<<"$body" >/dev/null 2>&1; then exit 0; fi
    exit 3
    ;;
  tools)
    dir=${2:?the folder for Foundry}
    mkdir -p "$dir"
    tgz="$dir/foundry.tar.gz"
    curl -fsSL -A "$UA" -o "$tgz" "$FOUNDRY_URL" || fail "Foundry could not be downloaded"
    echo "$FOUNDRY_SHA256  $tgz" | sha256sum -c - >/dev/null || { rm -f "$tgz"; fail "the Foundry download is not the release TOOLS pins"; }
    tar xzf "$tgz" -C "$dir" forge cast
    rm -f "$tgz"
    "$dir/forge" --version | head -1
    ;;
  prepare)
    dir=${2:?the work folder}
    : "${L5_EXPLORER:?L5_EXPLORER is not set}" "${L5_CHAIN_ID:?L5_CHAIN_ID is not set}"
    [[ $L5_CHAIN_ID =~ ^[0-9]+$ ]] || fail "L5_CHAIN_ID is not a number"
    mkdir -p "$dir/project" "$dir/home"
    cp "$HERE/package.json" "$HERE/l5.mjs" "$HERE/summary.ts" "$dir/"
    cp -R "$HERE/project/contracts" "$HERE/project/package.json" "$HERE/project/package-lock.json" "$HERE/project/hardhat.config.cjs" "$dir/project/"
    sed -e "s|@SOLC@|$L5_SOLC_VERSION|" -e "s|@CHAIN_ID@|$L5_CHAIN_ID|" -e "s|@EXPLORER@|$L5_EXPLORER|" "$HERE/project/foundry.toml.in" > "$dir/project/foundry.toml"
    ;;
  build)
    npm ci --ignore-scripts --no-audit --no-fund
    forge build
    forge inspect Counter bytecode | sed 's/^0x//' > ../creation.hex
    [ -s ../creation.hex ] || fail "forge produced no creation code"
    echo "Counter's creation code: $(($(wc -c < ../creation.hex) / 2)) bytes"
    ;;
  verify)
    node ../l5.mjs
    ;;
  *)
    fail "usage: l5.sh probe | tools <folder> | prepare <folder> | build | verify"
    ;;
esac
