#!/usr/bin/env bash
# Checks that need no Docker: the pins are well formed and agree with the genesis.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
set -a
# shellcheck disable=SC1091
. "$ROOT/PINS"
set +a

fail() { echo "FAIL: $*" >&2; exit 1; }

for k in CHAIN_ID GAS_CAP RETH_VERSION RETH_IMAGE BUSYBOX_IMAGE \
         ZISK_VERSION ZISK_COMMIT ZISK_ETH_CLIENT_VERSION ZISK_ETH_CLIENT_COMMIT \
         CANTON_VERSION CANTON_JAR_SHA256 DAML_SDK_TAG DAML_SDK_VERSION DAML_SDK_MANIFEST_SHA256 DAMLC_VERSION \
         DAMLC_LINUX_AMD64_MANIFEST_SHA256 DPM_VERSION DPM_LINUX_AMD64_SHA256 DPM_REGISTRY DAML_TARGET JAVA_MAJOR GATEWAY_ADDRESS SOLC_VERSION SOLC_IMAGE; do
  [ -n "${!k:-}" ] || fail "PINS is missing $k"
done
[[ $RETH_IMAGE =~ @sha256:[0-9a-f]{64}$ ]] || fail "RETH_IMAGE is not pinned by digest"
[[ $BUSYBOX_IMAGE =~ @sha256:[0-9a-f]{64}$ ]] || fail "BUSYBOX_IMAGE is not pinned by digest"
[[ ${EXPLORER_NODE_IMAGE:-} =~ @sha256:[0-9a-f]{64}$ ]] || fail "EXPLORER_NODE_IMAGE is missing or not pinned by digest"
[ -z "${FOUNDRY_IMAGE:-}${FOUNDRY_VERSION:-}" ] || fail "PINS must not pin Foundry: the chain has no funded test accounts"
[[ $ZISK_COMMIT =~ ^[0-9a-f]{40}$ ]] || fail "ZISK_COMMIT is not a full commit hash"
[[ $ZISK_ETH_CLIENT_COMMIT =~ ^[0-9a-f]{40}$ ]] || fail "ZISK_ETH_CLIENT_COMMIT is not a full commit hash"

# The Canton and Daml toolchain is pinned by content: a SHA-256 for the Canton jar, the dpm program, the SDK manifest and the compiler's registry manifest.
for k in CANTON_JAR_SHA256 DPM_LINUX_AMD64_SHA256 DAML_SDK_MANIFEST_SHA256 DAMLC_LINUX_AMD64_MANIFEST_SHA256; do
  [[ ${!k} =~ ^[0-9a-f]{64}$ ]] || fail "$k is not a SHA-256"
done
[[ $CANTON_VERSION == 3.6.* ]] || fail "CANTON_VERSION is not a 3.6 build (the external call is in 3.6)"
[[ $DAML_SDK_TAG == weekly-snapshot-3.6.* ]] || fail "DAML_SDK_TAG is not a 3.6 weekly snapshot"
[[ $DAMLC_VERSION == 3.6.* ]] || fail "DAMLC_VERSION is not a 3.6 build"
[ "$DAML_TARGET" = 2.4 ] || fail "DAML_TARGET is not LF 2.4, the first version with the external call"
[[ $JAVA_MAJOR =~ ^[0-9]+$ ]] || fail "JAVA_MAJOR is not a number"

[ "$(jq .config.chainId "$ROOT/network/genesis.json")" = "$CHAIN_ID" ] || fail "genesis chain id differs from PINS"
[ "$(printf '0x%x' "$GAS_CAP")" = "$(jq -r .gasLimit "$ROOT/network/genesis.json")" ] || fail "GAS_CAP differs from the genesis gas limit"
[ "$(jq .config.pragueTime "$ROOT/network/genesis.json")" = "0" ] || fail "Prague is not active from genesis"

# The gateway: one contract at a fixed address, put into each run's genesis by network/make-state.sh. It is not in
# network/genesis.json (the guest program includes that file whole, so any edit would change the program key).
# A far, unused address: not one of the low addresses Ethereum uses for precompiles and system contracts.
[[ ${GATEWAY_ADDRESS:-} =~ ^0x[0-9a-f]{40}$ ]] || fail "GATEWAY_ADDRESS is missing or is not 40 lowercase hex digits"
[[ $GATEWAY_ADDRESS > 0x0000000000000000000000000000000000ffffff ]] || fail "GATEWAY_ADDRESS is in the range of the precompiles"
[ "$(jq --arg a "$GATEWAY_ADDRESS" '.alloc | has($a)' "$ROOT/network/genesis.json")" = false ] || fail "network/genesis.json holds the gateway: it belongs in each run's genesis, not in this file"
GW=$ROOT/gateway/Gateway.sol
head -n 2 "$GW" | grep -q '^// SPDX-License-Identifier: LicenseRef-Rome-Protocol$' || fail "gateway/Gateway.sol does not carry the Rome Protocol licence identifier"
grep -q "pragma solidity $SOLC_VERSION;" "$GW" || fail "gateway/Gateway.sol does not pin solc $SOLC_VERSION"
[[ ${SOLC_IMAGE:-} =~ @sha256:[0-9a-f]{64}$ ]] || fail "SOLC_IMAGE is not pinned by digest"
# The storage layout is part of the contract's interface: the sidecar reads legs[n] at slot 0. These four come first, in this order.
decls=$(awk '/^contract Gateway /{on=1} on && /\/\/ slot [0-9]+/{print}' "$GW")
want=$(printf '%s\n' \
  '    mapping(uint256 => bytes32) public legs; // slot 0: keep it first' \
  '    mapping(bytes32 => bool) public used; // slot 1' \
  '    mapping(address => bool) public wrapped; // slot 2' \
  '    uint256 public withdrawals; // slot 3')
[ "$decls" = "$want" ] || fail "gateway/Gateway.sol's storage is not the four slots in the order the sidecar reads them: $decls"
first=$(awk '/^contract Gateway /{on=1; next} on && /^    [a-z]/{print; exit}' "$GW")
[ "$first" = "$(sed -n 1p <<<"$want")" ] || fail "the first declaration in Gateway is not legs (slot 0): $first"
[[ $(cat "$ROOT/gateway/Gateway.bin-runtime") =~ ^[0-9a-f]{200,}$ ]] || fail "gateway/Gateway.bin-runtime is not runtime code in hex without 0x"
[ "$(( $(wc -c < "$ROOT/gateway/Gateway.bin-runtime") / 2 ))" -le 24576 ] || fail "the gateway's runtime code is over the 24576-byte limit"
# The gateway has no owner, no upgrade and no way to be removed.
! grep -qE 'Ownable|onlyOwner|selfdestruct|delegatecall' "$GW" || fail "gateway/Gateway.sol has an owner modifier, selfdestruct or delegatecall"

# The gateway's test starts reth only through launch.sh and checks the flags with check.sh; nothing else in gateway/ names reth's image.
others=$(grep -rIlE 'RETH_IMAGE|paradigmxyz|reth node' "$ROOT/gateway" 2>/dev/null || true)
[ -z "$others" ] || fail "something in gateway/ starts or names reth's image: $others"
gw_code=$(grep -v '^[[:space:]]*#' "$ROOT/gateway/tests/run.sh" || true)  # the calls, not the header comment that names them
grep -q 'network/reth/launch.sh' <<<"$gw_code" || fail "gateway/tests/run.sh does not start reth through launch.sh"
grep -q 'network/reth/check.sh' <<<"$gw_code" || fail "gateway/tests/run.sh does not check that discovery is off"
grep -q 'network/reth/stop.sh' <<<"$gw_code" || fail "gateway/tests/run.sh does not stop reth through stop.sh"

# The sidecar's fixture capture starts reth only through launch.sh, checks the flags with check.sh and stops it with stop.sh; nothing else in sidecar/ names reth's image or runs it.
CAP=$ROOT/sidecar/tests/capture_fixtures.sh
others=$(grep -rIlE 'RETH_IMAGE|paradigmxyz|reth node' "$ROOT/sidecar" --exclude-dir=target 2>/dev/null || true)
[ -z "$others" ] || fail "something in sidecar/ starts or names reth's image: $others"
cap_code=$(grep -v '^[[:space:]]*#' "$CAP" || true)  # the calls, not the header comment that names them
grep -q 'network/reth/launch.sh' <<<"$cap_code" || fail "sidecar/tests/capture_fixtures.sh does not start reth through launch.sh"
grep -q 'network/reth/check.sh' <<<"$cap_code" || fail "sidecar/tests/capture_fixtures.sh does not check that discovery is off"
grep -q 'network/reth/stop.sh' <<<"$cap_code" || fail "sidecar/tests/capture_fixtures.sh does not stop reth through stop.sh"

# The genesis funds no account: the chain has no test accounts or keys.
[ "$(jq '[.alloc[] | select((.balance // "0x0") != "0x0")] | length' "$ROOT/network/genesis.json")" = 0 ] || fail "genesis funds an account"
# A rough guard only: it looks for the word "private" and cannot tell a key from other text.
! grep -qi 'private' "$ROOT/network/genesis.json" || fail "genesis mentions a private key"
# Our code is under the repository's LICENSE: each of our crates points at that file, and none claims another licence.
# (guest/ keeps upstream's own licence files; NOTICE lists them.)
for toml in sidecar verifier mpt guest/rules prover/make-input; do
  grep -q '^license-file = "\(\.\./\)*LICENSE"$' "$ROOT/$toml/Cargo.toml" || fail "$toml/Cargo.toml does not point at the repository's LICENSE"
  [ -f "$ROOT/$toml/$(sed -n 's/^license-file = "\(.*\)"$/\1/p' "$ROOT/$toml/Cargo.toml")" ] || fail "$toml/Cargo.toml's license-file is not a file"
  ! grep -q '^license *= ' "$ROOT/$toml/Cargo.toml" || fail "$toml/Cargo.toml names a licence of its own"
done
head -n 2 "$ROOT/demo/TKA.sol" | grep -q '^// SPDX-License-Identifier: LicenseRef-Rome-Protocol$' || fail "demo/TKA.sol does not carry the Rome Protocol licence identifier"
# The explorer is private to this repository's licence, and every dependency is pinned to one exact version (the lockfile pins the rest).
[ "$(jq -r .license "$ROOT/explorer/package.json")" = "SEE LICENSE IN LICENSE" ] || fail "explorer/package.json does not point at the repository's LICENSE"
[ "$(jq .private "$ROOT/explorer/package.json")" = true ] || fail "explorer/package.json is not private"
[ "$(jq '[.dependencies, .devDependencies | to_entries[] | select(.value | test("^[0-9]+\\.[0-9]+\\.[0-9]+$") | not)] | length' "$ROOT/explorer/package.json")" = 0 ] || fail "an explorer dependency is not pinned to one exact version"
echo "static checks passed"
