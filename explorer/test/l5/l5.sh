#!/usr/bin/env bash
# L5 of the nightly load test: the tools developers verify and read contracts with, pointed at the explorer's Etherscan-compatible API. The steps, in the order
# tests/demo_nightly_chain.sh runs them (probe, tools and prepare on the runner; build and verify in the pinned browser image, which has glibc and Node 24):
#   l5.sh probe                     DOOR (in this folder) says whether the Etherscan-compatible API is there; the probe GET /api?module=proxy&action=eth_blockNumber must agree:
#                                   exit 0 there and answering (L5 runs), 3 absent and not answering (a skip), 4 anything else (a failure) (EXPLORER)
#   l5.sh skipped                   the JSON of a skip
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
    # Whether the API's door is there is fixed in the repo, in DOOR ("absent" or "present"): whoever lands E8b (the proxy module) and E9b (the contract module) sets it
    # to "present". A live probe alone must not decide it, because a timeout, a 429 or a regressed module would then be a skip, and a skip is a green job.
    marker=$(tr -d '[:space:]' < "${L5_DOOR_FILE:-$HERE/DOOR}")
    [ "$marker" = present ] || [ "$marker" = absent ] || fail "DOOR says '$marker': it must be 'absent' or 'present'"
    answered=0
    for try in $(seq 1 "${L5_PROBE_TRIES:-3}"); do
      out=$(curl -s -m 20 -A "$UA" -w '\n%{http_code}' "$EXPLORER/api?module=proxy&action=eth_blockNumber" || true)
      code=${out##*$'\n'}; body=${out%$'\n'*}
      if [ "$code" = 200 ] && jq -e '.result | strings | test("^0x[0-9a-fA-F]+$")' <<<"$body" >/dev/null 2>&1; then answered=1; break; fi
      [ "$marker" = absent ] && break
      [ "$try" = "${L5_PROBE_TRIES:-3}" ] || sleep "${L5_PROBE_WAIT:-5}"
    done
    if [ "$marker" = present ]; then
      [ "$answered" = 1 ] && exit 0
      echo "L5 FAIL: DOOR says the Etherscan-compatible API is there, but GET /api?module=proxy&action=eth_blockNumber answered HTTP $code: ${body:0:200}" >&2
      exit 4
    fi
    if [ "$answered" = 1 ]; then
      echo "L5 FAIL: the explorer answers GET /api?module=proxy&action=eth_blockNumber, but DOOR still says 'absent': set it to 'present' so that L5 runs" >&2
      exit 4
    fi
    exit 3   # absent, and nothing answers: a skip
    ;;
  skipped)
    # The results of a skip. It is not a pass: the status says "skipped" and the reason says what is missing.
    jq -n '{status: "skipped", reason: "SKIPPED: E8b/E9b not landed", checks: [], failures: []}'
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
    fail "usage: l5.sh probe | skipped | tools <folder> | prepare <folder> | build | verify"
    ;;
esac
