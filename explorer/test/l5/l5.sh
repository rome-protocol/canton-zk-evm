#!/usr/bin/env bash
# L5 of the nightly load test: the tools developers verify and read contracts with, pointed at the explorer's Etherscan-compatible API. The steps, in the order
# tests/demo_nightly_chain.sh runs them (probe, tools and prepare on the runner; build and verify in the pinned browser image, which has glibc and Node 24):
#   l5.sh probe                     whether the Etherscan-compatible API is there, from GET /api/openapi.json (paths['/api'].get['x-modules'], never a live call to the API):
#                                   exit 0 and the modules in it on stdout (L5 runs), 3 no /api door in the description, 4 the description cannot be read, or has the door without its x-modules (3 and 4 both fail the job: the door is in the explorer) (EXPLORER)
#   l5.sh no-door                   the JSON of the failure for exit 3 (no /api door in the description)
#   l5.sh tools <folder>            Foundry, the release and SHA-256 of tests/FOUNDRY, into <folder>
#   l5.sh prepare <folder>          this directory, with foundry.toml filled in for the chain, into <folder> (L5_EXPLORER, L5_CHAIN_ID)
#   l5.sh build                     in <folder>/project: npm ci, forge build, and the creation code of three builds (optimizer runs 200, 201, 202) to <folder>/creation-<runs>.hex
#   l5.sh verify                    in <folder>/project: the checks of l5.mjs against the deployed contracts, those of the modules in L5_MODULES (a module of L5's missing from them fails)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
UA='Rome Protocol rome@romeprotocol.com'
fail() { echo "FAIL: $*" >&2; exit 1; }

# shellcheck disable=SC1091
. "$HERE/TOOLS"
export L5_SOLC_VERSION L5_SOLC

case "${1:-}" in
  probe)
    : "${EXPLORER:?EXPLORER is not set}"
    # Whether the Etherscan-compatible API is there is read from the explorer's own description of itself, GET /api/openapi.json: paths['/api'].get['x-modules'] is the table
    # of modules the door answers from, so it lists what exists and cannot drift. A live call to the API decides nothing: a timeout, a 429 or a regressed module must not be
    # a skip, and a skip is a green job. The description itself is retried; when it cannot be read the explorer is broken and L5 FAILS (exit 4).
    # Exit 0 and the modules, comma separated, on stdout: the door is there and L5 runs the checks of the modules in it. Exit 3: the description has no /api door (a skip).
    spec=""
    for try in $(seq 1 "${L5_PROBE_TRIES:-3}"); do
      out=$(curl -s -m 20 -A "$UA" -w '\n%{http_code}' "$EXPLORER/api/openapi.json" || true)
      code=${out##*$'\n'}; body=${out%$'\n'*}
      if [ "$code" = 200 ] && jq -e '.paths | type == "object"' <<<"$body" >/dev/null 2>&1; then spec=$body; break; fi
      [ "$try" = "${L5_PROBE_TRIES:-3}" ] || sleep "${L5_PROBE_WAIT:-5}"
    done
    if [ -z "$spec" ]; then
      echo "L5 FAIL: GET /api/openapi.json answered HTTP $code and no OpenAPI document: ${body:0:200}" >&2
      exit 4
    fi
    if ! jq -e '(.paths["/api"] // null) != null' <<<"$spec" >/dev/null 2>&1; then
      exit 3   # no /api door in the explorer's description: a skip
    fi
    if ! jq -e '(.paths["/api"].get["x-modules"] // null) | type == "object"' <<<"$spec" >/dev/null 2>&1; then
      echo "L5 FAIL: /api/openapi.json has the /api door without its x-modules" >&2   # the door exists (it is in main), so a description without its modules is a regression
      exit 4
    fi
    modules=$(jq -r '.paths["/api"].get["x-modules"] | keys_unsorted | join(",")' <<<"$spec")
    [ -n "$modules" ] || { echo "L5 FAIL: /api/openapi.json lists the /api door with no modules" >&2; exit 4; }
    echo "$modules"
    exit 0
    ;;
  no-door)
    # The results when the explorer's description has no /api door: a failure, as the door is in the explorer.
    jq -n '{status: "failed", checks: [], failures: ["L5: /api/openapi.json has no Etherscan-compatible /api door (paths[\"/api\"].get[\"x-modules\"]), and the door is in the explorer"]}'
    ;;
  tools)
    dir=${2:?the folder for Foundry}
    # the release and its SHA-256 are tests/FOUNDRY's (one pin for every Foundry the tests run), the linux amd64 tarball
    # shellcheck disable=SC1091
    . "$HERE/../../../tests/FOUNDRY"
    FOUNDRY_URL="https://github.com/foundry-rs/foundry/releases/download/$FOUNDRY_VERSION/foundry_${FOUNDRY_VERSION}_linux_amd64.tar.gz"
    FOUNDRY_SHA256=$FOUNDRY_LINUX_AMD64_SHA256
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
    mkdir -p "$dir/project" "$dir/home/.svm/0.8.28"
    # The compiler is the run's pinned solc (the one in PINS' SOLC_IMAGE), which tests/demo_nightly_chain.sh mounts at L5_SOLC in the container: nothing is downloaded from the Solidity
    # servers. Forge reads it from foundry.toml (solc = path, auto_detect_solc = false); `forge verify-contract --flatten` looks in svm's folder for the version, so the link is there; Hardhat
    # takes it from hardhat.config.cjs (a SUBTASK_COMPILE_SOLIDITY_GET_SOLC_BUILD override). The link points into the container: it is dangling on the runner, and that is right.
    ln -sfn "$L5_SOLC" "$dir/home/.svm/0.8.28/solc-0.8.28"
    cp "$HERE/package.json" "$HERE/l5.mjs" "$HERE/summary.ts" "$dir/"
    cp -R "$HERE/project/contracts" "$HERE/project/package.json" "$HERE/project/package-lock.json" "$HERE/project/hardhat.config.cjs" "$dir/project/"
    sed -e "s|@SOLC@|$L5_SOLC|" -e "s|@CHAIN_ID@|$L5_CHAIN_ID|" -e "s|@EXPLORER@|$L5_EXPLORER|" "$HERE/project/foundry.toml.in" > "$dir/project/foundry.toml"
    ;;
  build)
    npm ci --ignore-scripts --no-audit --no-fund
    # One build for each optimizer runs, each in its own out and cache folders: `forge verify-contract` takes the compiler input from the last build in `out`, not from the
    # settings it runs with, so one folder would send the explorer the settings of whichever build came last (run 39928946884: the contract built with 200 was submitted as 202).
    # three different runtime codes (the optimizer runs 200, 201 and 202 change the metadata hash at the end of the code), so that verifying one contract is never a "similar match" for the other two
    for runs in 200 201 202; do
      export FOUNDRY_OPTIMIZER_RUNS=$runs FOUNDRY_OUT="out-$runs" FOUNDRY_CACHE_PATH="cache-$runs"
      forge build
      forge inspect Counter bytecode | sed 's/^0x//' > "../creation-$runs.hex"
      [ -s "../creation-$runs.hex" ] || fail "forge produced no creation code for runs $runs"
    done
    cmp -s ../creation-200.hex ../creation-201.hex && fail "the creation codes of runs 200 and 201 are the same"
    cmp -s ../creation-201.hex ../creation-202.hex && fail "the creation codes of runs 201 and 202 are the same"
    cmp -s ../creation-200.hex ../creation-202.hex && fail "the creation codes of runs 200 and 202 are the same"
    echo "Counter's creation code: $(($(wc -c < ../creation-200.hex) / 2)) bytes, three builds"
    unset FOUNDRY_OPTIMIZER_RUNS FOUNDRY_OUT FOUNDRY_CACHE_PATH
    # Hardhat compiles with the runs of the third contract (202) now, so that `hardhat verify` finds its artifact: on its own it did not compile ("its bytecode doesn't match any of your local contracts")
    L5_HARDHAT_RUNS=202 npx hardhat compile
    ;;
  verify)
    node ../l5.mjs
    ;;
  *)
    fail "usage: l5.sh probe | no-door | tools <folder> | prepare <folder> | build | verify"
    ;;
esac
