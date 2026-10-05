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
         DAMLC_LINUX_AMD64_MANIFEST_SHA256 DPM_VERSION DPM_LINUX_AMD64_SHA256 DPM_REGISTRY DAML_TARGET JAVA_MAJOR; do
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
