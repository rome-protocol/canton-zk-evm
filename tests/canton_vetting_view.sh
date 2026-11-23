#!/usr/bin/env bash
# Does Canton check package vetting per view, on the pinned Canton? Three participants on one synchronizer: Rome's, and two for users, one of which has not vetted
# the probe package (tests/canton_vetting_view/, a package of Rome's own with a choice that takes a token-standard transfer and records it). The same choice runs as
# one transaction and, as two, the accept and then the record. The test checks the controls and asserts the answer: the user's participant takes part in the accept
# only, so with vetting checked per view the one transaction commits, and it fails if the one transaction is refused.
# Needs Java 21, network access to the registries in PINS, and PYTHON (default python3) to be a Python 3.12. No GPU, no reth, no ZisK.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"
WORK=$(mktemp -d)
export CZE_STATE_DIR=$WORK/state WORK CANTON_PROTOCOL_VERSION
export CZE_TOOLS_DIR=${CZE_TOOLS_DIR:-$CZE_STATE_DIR/tools}
export DARS=$ROOT/daml/dars
fail() { echo "FAIL: $*" >&2; exit 1; }
pids=()
cleanup() {
  local status=$?
  if [ "$status" != 0 ]; then
    for log in rome users; do
      echo "--- $log node log (errors)"; grep -E 'ERROR|WARN|Exception|rror' "$WORK/$log.log" 2>/dev/null | head -n 15 | cut -c1-400 || true
    done
  fi
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT
umask 077

tools=$("$ROOT/network/canton/fetch.sh")
CANTON_JAR=$(sed -n 's/^CANTON_JAR=//p' <<<"$tools")
DPM=$(sed -n 's/^DPM=//p' <<<"$tools")
export DPM_HOME=$CZE_TOOLS_DIR/dpm DPM_REGISTRY

# The probe package, built in a copy of its folder.
mkdir -p "$WORK/probe"
cp -R "$ROOT/tests/canton_vetting_view/src" "$WORK/probe/src"
sed "s|__SDK__|$DAML_SDK_VERSION|; s|__TARGET__|$DAML_TARGET|; s|__DARS__|$DARS|" "$ROOT/tests/canton_vetting_view/daml.yaml" > "$WORK/probe/daml.yaml"
(cd "$WORK/probe" && "$DPM" build -o "$WORK/probe.dar" >/dev/null)
export DAR=$WORK/probe.dar

start() {   # name, last line of its bootstrap: a node in a process of its own
  nohup java -Xmx2g -jar "$CANTON_JAR" daemon -c "$ROOT/tests/canton_vetting_view/$1.conf" --bootstrap "$ROOT/tests/canton_vetting_view/$1.canton" --no-tty > "$WORK/$1.log" 2>&1 < /dev/null &
  pids+=("$!")
  for _ in $(seq 1 300); do
    grep -q "$2" "$WORK/$1.log" && return 0
    kill -0 "$!" 2>/dev/null || fail "the $1 node stopped"
    sleep 1
  done
  fail "the $1 node did not finish its bootstrap"
}
start rome "ROME NODE DONE"
start users "USERS NODE DONE"
"${PYTHON:-python3}" "$ROOT/tests/canton_vetting_view/check.py" "$WORK"
