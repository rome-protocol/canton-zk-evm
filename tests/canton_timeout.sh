#!/usr/bin/env bash
# What Canton's rejection says when one participant stops answering, on the pinned Canton: a synchronizer with a confirmation timeout of 6 seconds, one
# participant that proposes (its parties are hosted on a participant of their own, in a process of its own) and one that accepts. The proposing participant's
# process is stopped (SIGSTOP) while a choice needs its parties to confirm, so the mediator times out. The builder's own readers (builder/builder.py) must find
# the unresponsive parties in the JSON API's answer and in the command's completion: MEDIATOR_SAYS_TX_TIMED_OUT names them, for one party and for two.
# A probe package, not Ostia's (tests/canton_timeout/). Needs Java 21, network access to the registries in PINS, and PYTHON (default python3) to be a Python 3.12
# that has the builder's one dependency (builder/requirements.txt). No GPU, no reth, no ZisK.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"
WORK=$(mktemp -d)
export CZE_STATE_DIR=$WORK/state WORK CANTON_PROTOCOL_VERSION
export CZE_TOOLS_DIR=${CZE_TOOLS_DIR:-$CZE_STATE_DIR/tools}
fail() { echo "FAIL: $*" >&2; exit 1; }
pids=()
cleanup() {
  local status=$?
  if [ "$status" != 0 ]; then
    for log in submitter silent; do
      echo "--- $log node log (errors)"; grep -E 'ERROR|WARN|Exception|rror' "$WORK/$log.log" 2>/dev/null | head -n 15 | cut -c1-400 || true
    done
  fi
  for p in "${pids[@]}"; do kill -CONT "$p" 2>/dev/null || true; kill "$p" 2>/dev/null || true; done
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
cp -R "$ROOT/tests/canton_timeout/src" "$WORK/probe/src"
sed "s|__SDK__|$DAML_SDK_VERSION|" "$ROOT/tests/canton_timeout/daml.yaml" > "$WORK/probe/daml.yaml"
(cd "$WORK/probe" && "$DPM" build -o "$WORK/probe.dar" >/dev/null)
export DAR=$WORK/probe.dar

start() {   # name, config, script: a node in a process of its own; waits for the script's last line
  nohup java -Xmx2g -jar "$CANTON_JAR" daemon -c "$ROOT/tests/canton_timeout/$2" --bootstrap "$ROOT/tests/canton_timeout/$3" --no-tty > "$WORK/$1.log" 2>&1 < /dev/null &
  pids+=("$!")
  for _ in $(seq 1 300); do
    grep -q "$4" "$WORK/$1.log" && return 0
    kill -0 "$!" 2>/dev/null || fail "the $1 node stopped"
    sleep 1
  done
  fail "the $1 node did not finish its bootstrap"
}
start submitter submitter.conf submitter.canton "SUBMITTER NODE DONE"
start silent silent.conf silent.canton "SILENT NODE DONE"
"${PYTHON:-python3}" "$ROOT/tests/canton_timeout/check.py" "$WORK" "${pids[1]}"
