#!/usr/bin/env bash
# Foundry against a running explorer's Etherscan door, contract module: `forge verify-contract` in both formats (the standard JSON input, and --flatten, the single file),
# then `cast source` and `cast interface` read back what was verified. The contract is explorer/clients/hardhat/contracts/Box.sol, deployed twice with the constructor argument 42.
# tests/demo_rehearsal.sh runs this against its explorer with the verifier role on; explorer/server/rest/etherscan-contract-tools.test.ts runs it against a server of its own.
#
#   demo_etherscan_contract.sh build <folder>    builds Box twice and writes, for each of `standard` and `flat`, <folder>/<name>.creation and <name>.runtime (hex without 0x) and
#                                                <name>.deploy (the creation code with the argument 42 after it, to deploy). The two builds differ in the optimizer's runs (200 and
#                                                201), which changes the metadata hash at the end of the code: the two contracts do not have the same code, so neither is a
#                                                similar match of the other (design 6.3, point 6, and forge asks the door first, and stops at a contract that shows a source).
#   demo_etherscan_contract.sh verify            verifies the contract deployed from standard.deploy as the standard JSON input and the one from flat.deploy with --flatten.
#
# Needs: SOLC (a solc 0.8.28 that runs on this machine; forge compiles with it, and --flatten finds it where svm keeps it, so nothing is downloaded). To verify, also
# EXPLORER (where it listens), CHAIN_ID, BOX_STANDARD and BOX_FLAT (the two addresses). FORGE and CAST name the programs to use; without them the release in tests/FOUNDRY
# is downloaded (Linux x86-64), checked against its SHA-256 and used from a folder of this run's own, removed on exit. The release is pinned there and not in PINS,
# because the chain has no funded test accounts and PINS must not pin Foundry (tests/static.sh).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/tests/FOUNDRY"
COMPILER=0.8.28+commit.7893614a
ARG=42
ARG_HEX=$(printf '%064x' "$ARG")
RUNS_STANDARD=200
RUNS_FLAT=201
fail() { echo "FAIL: $*" >&2; exit 1; }
usage() { echo "usage: $0 build <folder> | $0 verify" >&2; exit 2; }
mode=${1:-}
case $mode in
  build) [ $# -eq 2 ] || usage ;;
  verify)
    [ $# -eq 1 ] || usage
    : "${EXPLORER:?EXPLORER is not set}" "${CHAIN_ID:?CHAIN_ID is not set}" "${BOX_STANDARD:?BOX_STANDARD is not set}" "${BOX_FLAT:?BOX_FLAT is not set}" ;;
  *) usage ;;
esac
: "${SOLC:?SOLC is not set}"
[ -x "$SOLC" ] || fail "SOLC is not a program: $SOLC"
case $("$SOLC" --version) in *"$COMPILER"*) ;; *) fail "SOLC is not solc $COMPILER" ;; esac

# A folder of this run's own, removed on exit: the downloaded Foundry, the project and the home folder the tools use.
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
if [ -z "${FORGE:-}" ] || { [ "$mode" = verify ] && [ -z "${CAST:-}" ]; }; then
  [ "$(uname -s)-$(uname -m)" = Linux-x86_64 ] || fail "the pinned Foundry is the Linux x86-64 build; set FORGE and CAST to use another"
  curl -sSfL -o "$WORK/foundry.tar.gz" "https://github.com/foundry-rs/foundry/releases/download/$FOUNDRY_VERSION/foundry_${FOUNDRY_VERSION}_linux_amd64.tar.gz"
  echo "$FOUNDRY_LINUX_AMD64_SHA256  $WORK/foundry.tar.gz" | sha256sum -c -
  mkdir "$WORK/bin"
  tar -xzf "$WORK/foundry.tar.gz" -C "$WORK/bin" forge cast
  FORGE=$WORK/bin/forge
  CAST=$WORK/bin/cast
fi

PROJECT=$WORK/project
HOME_DIR=$WORK/home
mkdir -p "$PROJECT/src" "$HOME_DIR/.svm/0.8.28"
ln -s "$SOLC" "$HOME_DIR/.svm/0.8.28/solc-0.8.28"
cp "$ROOT/explorer/clients/hardhat/contracts/Box.sol" "$PROJECT/src/Box.sol"
cat > "$PROJECT/foundry.toml" <<EOF
[profile.default]
src = "src"
out = "out-standard"
libs = []
solc = "$SOLC"
auto_detect_solc = false
optimizer = true
optimizer_runs = $RUNS_STANDARD
evm_version = "cancun"

[profile.flat]
out = "out-flat"
optimizer_runs = $RUNS_FLAT

[etherscan]
ostia = { key = "any", chain = ${CHAIN_ID:-1}, url = "${EXPLORER:-http://127.0.0.1}/api" }
EOF
# The tools run in the project, in a profile (default or flat), with a home of this run's own.
tool() {
  local profile=$1; shift
  (cd "$PROJECT" && env -i PATH="$PATH" HOME="$HOME_DIR" FOUNDRY_DISABLE_NIGHTLY_WARNING=1 NO_COLOR=1 FOUNDRY_PROFILE="$profile" "$@" 2>&1)
}

build_box() {
  local profile=$1 name=$2 dir=$3 out
  out=$(tool "$profile" "$FORGE" build) || fail "forge build ($name) failed: $(tail -n 5 <<<"$out")"
  jq -r '.bytecode.object | ltrimstr("0x")' "$PROJECT/out-$name/Box.sol/Box.json" > "$dir/$name.creation"
  jq -r '.deployedBytecode.object | ltrimstr("0x")' "$PROJECT/out-$name/Box.sol/Box.json" > "$dir/$name.runtime"
  [[ $(cat "$dir/$name.creation") =~ ^[0-9a-f]{200,}$ ]] || fail "forge gave no creation code for $name"
  printf '%s%s\n' "$(cat "$dir/$name.creation")" "$ARG_HEX" > "$dir/$name.deploy"
}

if [ "$mode" = build ]; then
  mkdir -p "$2"
  build_box default standard "$2"
  build_box flat flat "$2"
  [ "$(cat "$2/standard.runtime")" != "$(cat "$2/flat.runtime")" ] || fail "the two builds have the same code: neither contract would be verified by its own submission"
  echo "built Box twice into $2 (optimizer runs $RUNS_STANDARD and $RUNS_FLAT)"
  exit 0
fi

echo "using $("$FORGE" --version | head -n 1) and $("$CAST" --version | head -n 1)"
# A refusal for the door's rate is HTTP 200 with a Retry-After, as Etherscan's is: wait it out, as a client does.
door() {
  local n=0 out
  while :; do
    out=$(curl -sSf -D "$WORK/headers" "$EXPLORER/api?$1")
    grep -qi '^retry-after:' "$WORK/headers" || break
    n=$((n + 1)); [ "$n" -lt 20 ] || fail "the door kept asking to wait: $out"
    sleep "$(tr -d '\r' < "$WORK/headers" | awk 'tolower($1) == "retry-after:" { print $2 }')"
  done
  printf '%s\n' "$out"
}
verify() {
  local profile=$1 at=$2 runs=$3; shift 3
  tool "$profile" "$FORGE" verify-contract "$at" src/Box.sol:Box --chain "$CHAIN_ID" --verifier etherscan --verifier-url "$EXPLORER/api" --etherscan-api-key any \
    --constructor-args "$ARG_HEX" --rpc-url "$EXPLORER/rpc" --compiler-version "$COMPILER" --num-of-optimizations "$runs" --watch "$@"
}
# What the door's getsourcecode says of a verified Box, as Etherscan says it.
check_verified() {
  local at=$1 runs=$2 r
  r=$(door "module=contract&action=getsourcecode&address=$at")
  jq -e --arg v "v$COMPILER" --arg a "$ARG_HEX" --arg runs "$runs" '.status == "1" and .message == "OK" and .result[0].ContractName == "Box" and .result[0].CompilerVersion == $v and .result[0].OptimizationUsed == "1" and .result[0].Runs == $runs and .result[0].ConstructorArguments == $a and .result[0].Proxy == "0"' <<<"$r" > /dev/null \
    || fail "getsourcecode for $at is not a verified Box: $(jq -c '.result[0] | del(.SourceCode, .ABI)' <<<"$r" | cut -c1-500)"
  jq -e '.result[0].SourceCode | contains("contract Box")' <<<"$r" > /dev/null || fail "getsourcecode for $at has no source"
  jq -e '.status == "1"' <<<"$(door "module=contract&action=getabi&address=$at")" > /dev/null || fail "getabi for $at is not an answer"
  jq -e --arg at "$at" '.status == "1" and (.result[0].contractAddress | ascii_downcase) == ($at | ascii_downcase)' <<<"$(door "module=contract&action=getcontractcreation&contractaddresses=$at")" > /dev/null \
    || fail "getcontractcreation does not know $at"
}
has() { grep -qiF -- "$2" <<<"$1"; }

echo "== forge verify-contract, the standard JSON input"
out=$(verify default "$BOX_STANDARD" "$RUNS_STANDARD") || fail "forge verify-contract (standard JSON) failed: $(tail -n 8 <<<"$out")"
has "$out" "verified" || fail "forge did not say the contract is verified: $(tail -n 8 <<<"$out")"
check_verified "$BOX_STANDARD" "$RUNS_STANDARD"
[ "$(door "module=contract&action=getsourcecode&address=$BOX_STANDARD" | jq -r '.result[0].SourceCode[0:2]')" = '{{' ] || fail "the standard JSON source is not stored as {{ ... }}"

echo "== forge verify-contract --flatten, the single file"
out=$(verify flat "$BOX_FLAT" "$RUNS_FLAT" --flatten) || fail "forge verify-contract --flatten failed: $(tail -n 8 <<<"$out")"
has "$out" "verified" || fail "forge did not say the flattened contract is verified: $(tail -n 8 <<<"$out")"
check_verified "$BOX_FLAT" "$RUNS_FLAT"
[ "$(door "module=contract&action=getsourcecode&address=$BOX_FLAT" | jq -r '.result[0].SourceCode[0:2]')" != '{{' ] || fail "the flattened source is stored as a standard JSON input"

echo "== a second verification is told the contract is already verified"
out=$(verify default "$BOX_STANDARD" "$RUNS_STANDARD") || true
has "$out" "already verified" || fail "forge was not told the contract is already verified: $(tail -n 8 <<<"$out")"

echo "== cast source and cast interface"
out=$(tool default "$CAST" source "$BOX_STANDARD" --chain "$CHAIN_ID" --etherscan-api-key any --explorer-api-url "$EXPLORER/api" --explorer-url "$EXPLORER") || fail "cast source failed: $(tail -n 8 <<<"$out")"
{ has "$out" 'contract Box' && has "$out" 'uint256 public value'; } || fail "cast source did not print Box: $(head -n 8 <<<"$out")"
out=$(tool default "$CAST" interface "$BOX_STANDARD" --chain "$CHAIN_ID" --etherscan-api-key any) || fail "cast interface failed: $(tail -n 8 <<<"$out")"
{ has "$out" 'interface Box {' && has "$out" 'function set(uint256 v) external;' && has "$out" 'function value() external view returns (uint256);'; } \
  || fail "cast interface did not print Box's interface: $(head -n 12 <<<"$out")"
echo "forge, cast and the contract module agree"
