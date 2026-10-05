#!/usr/bin/env bash
# Run once, before network/up.sh: installs the demo's Python packages (by hash, into $CZE_STATE_DIR/venv, which up.sh and the
# builder use too), makes V's key and U's address for this run, and writes the genesis that also funds V (demo/evm.py genesis).
# Then start the network with that genesis:
#   CZE_GENESIS_FILE=<state>/demo/genesis.json network/up.sh
# Nothing here is committed: the keys are made per run, in the state folder, mode 0600.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
export CZE_STATE_DIR=${CZE_STATE_DIR:-$ROOT/state}
umask 077
mkdir -p "$CZE_STATE_DIR"
[ -x "$CZE_STATE_DIR/venv/bin/python3" ] || python3 -m venv "$CZE_STATE_DIR/venv"
# The builder needs Python 3.12: with an older one it cannot read Canton's times and skips every leg, saying "its allocation's settle-before time cannot be read" as the reason (run.sh then stops on its own check of the leg count).
"$CZE_STATE_DIR/venv/bin/python3" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)' \
  || { echo "FAIL: the Python in $CZE_STATE_DIR/venv is older than 3.12 (the builder needs Python 3.12): remove that folder and run this with python3 at 3.12 or newer" >&2; exit 1; }
"$CZE_STATE_DIR/venv/bin/pip" install --quiet --require-hashes -r "$ROOT/demo/requirements.txt"
"$CZE_STATE_DIR/venv/bin/python3" "$ROOT/demo/evm.py" genesis
echo "now: CZE_GENESIS_FILE=$CZE_STATE_DIR/demo/genesis.json network/up.sh"
