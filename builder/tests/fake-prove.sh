#!/usr/bin/env bash
# Stands in for prover/prove-one.sh: <input.bin> <out-folder>
set -euo pipefail
[ $# -eq 2 ] || { echo "usage: $0 input out" >&2; exit 2; }
[ -s "$1" ] || { echo "missing $1" >&2; exit 1; }
echo "prove $*" >> "${FAKE_LOG:?}"
# A pool of provers: FAKE_PROVER_PLAN is a folder with a file per coordinator URL (the URL with every character outside a-z, 0-9 turned into "_"),
# one line per job, taken in order: "ok", "fail", "connect" (the coordinator cannot be reached), "busy" / "capacity" (the coordinator refuses at once: its workers are busy / it has no ready worker), "hang" (never finishes), "sleep <seconds>" (slow, then ok),
# "wrong" (a proof of another block). No line left, or no file: "ok". Each job is also logged, as "<file> <line>", to the folder's own file "log".
if [ -n "${FAKE_PROVER_PLAN:-}" ]; then
  tag=$(printf %s "${ZISK_COORDINATOR_URL:-none}" | tr -c 'a-z0-9\n' _)
  action=ok
  if [ -s "$FAKE_PROVER_PLAN/$tag" ]; then
    action=$(head -n 1 "$FAKE_PROVER_PLAN/$tag"); tail -n +2 "$FAKE_PROVER_PLAN/$tag" > "$FAKE_PROVER_PLAN/$tag.tmp"; mv "$FAKE_PROVER_PLAN/$tag.tmp" "$FAKE_PROVER_PLAN/$tag"
  fi
  echo "$tag $action" >> "$FAKE_PROVER_PLAN/log"
  case "$action" in
    fail) echo "the prover is down" >&2; exit 1 ;;
    connect) echo "error trying to connect: tcp connect error: Connection refused (os error 111)" >&2; exit 1 ;;
    busy) echo "Error: JobRequest RPC failed ... code: The service is currently unavailable, message: Cluster unavailable: workers are busy running another job; retry shortly" >&2; exit 1 ;;
    capacity) echo "Error: JobRequest RPC failed ... code: The service is currently unavailable, message: Cluster unavailable: insufficient ready capacity for the request" >&2; exit 1 ;;
    hang) exec sleep 3607 ;;
    sleep\ *) sleep "${action#sleep }" ;;
    wrong) FAKE_PROVER_WRONG_BLOCK=1 ;;
  esac
fi
sleep "${FAKE_PROVER_SLEEP:-0}"   # a slow prover, to signal the builder in the middle of a block
if [ "${FAKE_PROVER_FAILS:-}" = 1 ]; then echo "the prover is down" >&2; exit 1; fi
mkdir -p "$2"
if [ "${FAKE_PROVER_WRITES_NOTHING:-}" = 1 ]; then exit 0; fi   # exits 0 and leaves no proof
# 832 bytes of 0xab, then public values in the layout the sidecar accepts: 64 slots of a 4-byte word and four zero bytes; the words are
# 0x20, the 32-byte block hash and zeros. FAKE_PROVER_WRONG_BLOCK=1 commits to another block.
python3 - "$(tr -d '\n' < "$1")" "${FAKE_PROVER_WRONG_BLOCK:-}" > "$2/wrapped-proof.hex" <<'PY'
import sys
block = sys.argv[1][2:] if not sys.argv[2] else "ff" * 32
words = (bytes([0x20]) + bytes.fromhex(block)).ljust(256, b"\0")
public = b"".join(words[i:i + 4] + b"\0" * 4 for i in range(0, 256, 4))
sys.stdout.write((b"\xab" * 832 + public).hex())
PY
