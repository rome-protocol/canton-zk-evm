#!/usr/bin/env bash
# launch.sh must refuse to start reth if a discovery flag is missing or has the wrong
# value, or if its command line carries a forbidden option. For each case we copy the
# scripts, change the copy, and expect a refusal that names the problem, before Docker
# is ever called.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT

# A Docker that fails loudly: refusal has to happen before it is reached.
mkdir "$WORK/bin"
printf '#!/bin/sh\necho "docker was called" >&2\nexit 99\n' > "$WORK/bin/docker"
chmod +x "$WORK/bin/docker"

fresh_copy() {
  rm -rf "$WORK/repo"; mkdir -p "$WORK/repo"
  cp -R "$ROOT/network" "$ROOT/PINS" "$WORK/repo/"
}

# Runs the copy's launch.sh, which must refuse. Standard error is kept apart; it has to
# name every given text, and Docker must not have been reached.
expect_refusal() {
  local label=$1; shift
  if PATH="$WORK/bin:$PATH" CZE_STATE_DIR="$WORK/state" "$WORK/repo/network/reth/launch.sh" >"$WORK/out" 2>"$WORK/err"; then
    echo "FAIL: launch.sh started: $label" >&2; exit 1
  fi
  local n
  for n in "$@"; do
    grep -qF -- "$n" "$WORK/err" || { echo "FAIL: refusal does not name '$n' ($label): $(cat "$WORK/err")" >&2; exit 1; }
  done
  if grep -q "docker was called" "$WORK/err" "$WORK/out"; then
    echo "FAIL: Docker was reached: $label" >&2; exit 1
  fi
  echo "ok: refused $label"
}

# 1. The untouched script passes its self-check and prints the full command.
fresh_copy
out=$(PATH="$WORK/bin:$PATH" CZE_STATE_DIR="$WORK/state" LAUNCH_DRY_RUN=1 "$WORK/repo/network/reth/launch.sh")
for f in --disable-discovery "--nat none" "--max-outbound-peers 0" "--max-inbound-peers 0" "--addr 127.0.0.1" --ipcdisable; do
  grep -q -- "$f" <<<"$out" || { echo "FAIL: dry run lacks $f" >&2; exit 1; }
done
# The block-building flags are in the command, the gas limit is the pinned cap, and proofs reach back one block (the parent's).
# shellcheck disable=SC1091
. "$ROOT/PINS"
for f in --engine.always-process-payload-attributes-on-canonical-head --engine.allow-unwind-canonical-header; do
  grep -q -- " $f " <<<"$out " || { echo "FAIL: dry run lacks $f" >&2; exit 1; }
done
grep -q -- " --rpc.eth-proof-window 1 " <<<"$out " || { echo "FAIL: dry run lacks --rpc.eth-proof-window 1" >&2; exit 1; }
grep -q -- " --builder.gaslimit $GAS_CAP " <<<"$out " || { echo "FAIL: dry run lacks --builder.gaslimit $GAS_CAP" >&2; exit 1; }
# Every published port is bound to 127.0.0.1, and the p2p port is not published.
while read -r p; do
  [[ $p == 127.0.0.1:* ]] || { echo "FAIL: port published beyond localhost: $p" >&2; exit 1; }
done < <(grep -oE -- '-p [^ ]+' <<<"$out" | cut -d' ' -f2)
! grep -q -- ':30303' <<<"$out" || { echo "FAIL: p2p port is published" >&2; exit 1; }

# 2. Remove each required flag in turn; every variant must be refused.
for flag in --disable-discovery --nat --max-outbound-peers --max-inbound-peers --addr --ipcdisable \
    --engine.always-process-payload-attributes-on-canonical-head --engine.allow-unwind-canonical-header --builder.gaslimit --rpc.eth-proof-window; do
  fresh_copy
  sed -E -i.bak "/^ *$flag( |\$)/d" "$WORK/repo/network/reth/launch.sh"
  if grep -qE -- "^ *$flag( |\$)" "$WORK/repo/network/reth/launch.sh"; then
    echo "FAIL: test could not remove $flag" >&2; exit 1
  fi
  expect_refusal "without $flag" "$flag"
done

# 3. A wrong value is refused as well as a missing flag. The refusal names the flag and
#    the value it has to have.
wrong_value() {
  fresh_copy
  sed -E -i.bak "s/^( *$1) $2\$/\1 $3/" "$WORK/repo/network/reth/launch.sh"
  grep -qE -- "^ *$1 $3\$" "$WORK/repo/network/reth/launch.sh" || { echo "FAIL: test could not set $1 $3" >&2; exit 1; }
  expect_refusal "with $1 $3" "$1 $2"
}
wrong_value --max-outbound-peers 0 5
wrong_value --max-inbound-peers 0 5
wrong_value --addr 127.0.0.1 0.0.0.0
wrong_value --rpc.eth-proof-window 1 0

# 4. Options that would let peers in or find peers are refused. The first three go into
#    reth's arguments, the last two into the Docker command.
forbid() {  # label, awk edit, text the refusal must name
  fresh_copy
  awk "$2" "$WORK/repo/network/reth/launch.sh" > "$WORK/launch.new"
  cmp -s "$WORK/launch.new" "$WORK/repo/network/reth/launch.sh" && { echo "FAIL: test could not add $1" >&2; exit 1; }
  cp "$WORK/launch.new" "$WORK/repo/network/reth/launch.sh"
  expect_refusal "with $1" "$3"
}
reth_arg() { printf '{print} /^  --ipcdisable$/{print "  %s"}' "$1"; }
forbid "--trusted-peers" "$(reth_arg '--trusted-peers enode://x@1.2.3.4:30303')" --trusted-peers
forbid "--bootnodes" "$(reth_arg '--bootnodes enode://x@1.2.3.4:30303')" --bootnodes
forbid "--max-peers" "$(reth_arg '--max-peers 5')" --max-peers
forbid "--network host" '{sub(/^  docker run -d /, "  docker run -d --network host ")} {print}' "--network host"
forbid "-P" '{sub(/^  docker run -d /, "  docker run -d -P ")} {print}' "-P"
echo "refusal tests passed"
