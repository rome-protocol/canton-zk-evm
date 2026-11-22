#!/usr/bin/env bash
# Writes the build that is about to be deployed to artifacts/deployed-v1/build-info.json: the compiler's input and output for src/ with the storage layout,
# without this machine's paths. upgrade-check.sh compares every later version against it. Run it when the version to deploy is final, and check the file in.
# For a later deploy, copy the folder to deployed-v2 and point upgrade-check.sh at it (REFERENCE).
set -euo pipefail
# shellcheck source=tools.sh
. "$(dirname "$0")/tools.sh"
cd "$HERE"
FOUNDRY_PROFILE=upgrade "$FORGE" build --force --skip 'test/**' --out "$WORK/out" --cache-path "$WORK/cache"
[ "$(find "$WORK/out/build-info" -name "*.json" | wc -l)" -eq 1 ] || fail "expected one build info file"
mkdir -p artifacts/deployed-v1
jq -c 'del(.id, .input.allowPaths, .allowPaths, .basePath, .includePaths, .input.basePath, .input.includePaths)' "$WORK"/out/build-info/*.json > artifacts/deployed-v1/build-info.json
! grep -qF -e "$ROOT" -e "$WORK" artifacts/deployed-v1/build-info.json || fail "a path of this machine is left in the build info"
echo "wrote artifacts/deployed-v1/build-info.json"
