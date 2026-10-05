#!/usr/bin/env bash
# Builds the real (external-call) form of the Daml package with the Daml compiler pinned in PINS, and prints the
# path of the DAR. Run network/canton/fetch.sh first (it installs the compiler).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"
TOOLS=${CZE_TOOLS_DIR:-${CZE_STATE_DIR:-$ROOT/state}/tools}
[ -x "$TOOLS/bin/dpm" ] || { echo "FAIL: no dpm in $TOOLS; run network/canton/fetch.sh" >&2; exit 1; }
export DPM_HOME=$TOOLS/dpm DPM_REGISTRY
export PATH="$TOOLS/bin:$PATH"
SDK_VERSION=$DAML_SDK_VERSION TARGET=$DAML_TARGET "$ROOT/daml/build.sh" external >&2
echo "$ROOT/daml/dist/canton-zk-evm-external.dar"
