#!/usr/bin/env bash
# Refuses a Daml compiler that is not the pinned one. The SDK manifest in PINS names the compiler by version only, and a
# snapshot's version tag in the registry can be pushed again with other contents. This asks the registry for damlc's
# manifest (the Linux x86-64 one, which lists every file of the compiler by SHA-256, and dpm checks each file it
# downloads against that list) and compares the SHA-256 of that manifest with DAMLC_LINUX_AMD64_MANIFEST_SHA256 in PINS.
# Usage: check-damlc.sh [expected sha256]    (default: the pin)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"
fail() { echo "FAIL: $*" >&2; exit 1; }
expected=${1:-${DAMLC_LINUX_AMD64_MANIFEST_SHA256:-}}
[[ $expected =~ ^[0-9a-f]{64}$ ]] || fail "the pinned damlc manifest SHA-256 is missing or malformed: '$expected'"
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
url=https://${DPM_REGISTRY%%/*}/v2/${DPM_REGISTRY#*/}/components/damlc/manifests/$DAMLC_VERSION.linux_amd64
curl -sSf -H 'Accept: application/vnd.oci.image.manifest.v1+json' -o "$tmp" "$url" || fail "could not read damlc $DAMLC_VERSION from the registry"
got=$(sha "$tmp")
[ "$got" = "$expected" ] || fail "damlc $DAMLC_VERSION is not the pinned one: the registry's manifest for it is $got, PINS has $expected (was the snapshot tag pushed again?)"
echo "damlc $DAMLC_VERSION: the registry's manifest is the pinned one"
