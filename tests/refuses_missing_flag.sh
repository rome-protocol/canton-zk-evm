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
for f in --engine.always-process-payload-attributes-on-canonical-head --engine.allow-unwind-canonical-header --testing.skip-invalid-transactions; do
  grep -q -- " $f " <<<"$out " || { echo "FAIL: dry run lacks $f" >&2; exit 1; }
done
grep -q -- " --rpc.eth-proof-window 1 " <<<"$out " || { echo "FAIL: dry run lacks --rpc.eth-proof-window 1" >&2; exit 1; }
grep -q -- " --rpc.gascap $GAS_CAP " <<<"$out " || { echo "FAIL: dry run lacks --rpc.gascap $GAS_CAP" >&2; exit 1; }
grep -q -- " --http.api eth,net,web3,trace " <<<"$out " || { echo "FAIL: dry run lacks --http.api eth,net,web3,trace" >&2; exit 1; }
grep -q -- " --log.file.max-files 0 " <<<"$out " || { echo "FAIL: dry run lacks --log.file.max-files 0" >&2; exit 1; }
grep -q -- " --builder.gaslimit $GAS_CAP " <<<"$out " || { echo "FAIL: dry run lacks --builder.gaslimit $GAS_CAP" >&2; exit 1; }
# Every published port is bound to 127.0.0.1, and the p2p port is not published.
while read -r p; do
  [[ $p == 127.0.0.1:* ]] || { echo "FAIL: port published beyond localhost: $p" >&2; exit 1; }
done < <(grep -oE -- '-p [^ ]+' <<<"$out" | cut -d' ' -f2)
! grep -q -- ':30303' <<<"$out" || { echo "FAIL: p2p port is published" >&2; exit 1; }
# The container is hardened: no new privileges, a user that is not root, every capability dropped, a read-only root filesystem with a tmpfs for /tmp, and limits
# on processes and memory (swap included). Nothing adds a capability or runs privileged.
for f in "--security-opt no-new-privileges" "--cap-drop ALL" --read-only "--tmpfs /tmp"; do
  grep -q -- " $f " <<<"$out " || { echo "FAIL: dry run lacks $f" >&2; exit 1; }
done
user=$(grep -oE -- ' --user [0-9]+:[0-9]+ ' <<<"$out " | awk '{print $2}')
[ -n "$user" ] && [ "${user%%:*}" != 0 ] || { echo "FAIL: dry run does not run reth as a non-root user (--user '$user')" >&2; exit 1; }
grep -qE -- ' --pids-limit [1-9][0-9]* ' <<<"$out " || { echo "FAIL: dry run has no --pids-limit" >&2; exit 1; }
mem=$(grep -oE -- ' --memory [1-9][0-9]*[bkmg]? ' <<<"$out " | awk '{print $2}')
[ -n "$mem" ] || { echo "FAIL: dry run has no memory limit" >&2; exit 1; }
grep -q -- " --memory-swap $mem " <<<"$out " || { echo "FAIL: dry run does not hold swap to the memory limit" >&2; exit 1; }
! grep -qE -- ' (--privileged|--cap-add)' <<<"$out " || { echo "FAIL: dry run adds a capability or runs privileged" >&2; exit 1; }

# 1b. The persistent mode (CZE_PERSIST=1) keeps reth's data in the state folder and changes nothing else: every flag above is still
#     there, the ports are still on 127.0.0.1 only, and the dry run makes no folder. Resuming without state, and starting a new chain on
#     data that is there already, are refused before Docker is reached.
fresh_copy
persist_out=$(PATH="$WORK/bin:$PATH" CZE_STATE_DIR="$WORK/pstate" CZE_PERSIST=1 LAUNCH_DRY_RUN=1 "$WORK/repo/network/reth/launch.sh")
for f in --disable-discovery "--nat none" "--max-outbound-peers 0" "--max-inbound-peers 0" "--addr 127.0.0.1" --ipcdisable \
    --engine.always-process-payload-attributes-on-canonical-head --engine.allow-unwind-canonical-header --testing.skip-invalid-transactions "--rpc.eth-proof-window 1" "--builder.gaslimit $GAS_CAP" "--rpc.gascap $GAS_CAP"; do
  grep -q -- "$f" <<<"$persist_out" || { echo "FAIL: persistent dry run lacks $f" >&2; exit 1; }
done
for f in "--security-opt no-new-privileges" "--cap-drop ALL" --read-only "--tmpfs /tmp" --pids-limit --memory --memory-swap; do
  grep -q -- " $f " <<<"$persist_out " || { echo "FAIL: persistent dry run lacks $f" >&2; exit 1; }
done
# A hard kill must not lose blocks Canton has already committed: reth writes every block to disk as soon as it is imported.
grep -q -- " --engine.persistence-threshold 0 " <<<"$persist_out " || { echo "FAIL: persistent dry run lacks --engine.persistence-threshold 0" >&2; exit 1; }
grep -q -- " --engine.memory-block-buffer-target 0 " <<<"$persist_out " || { echo "FAIL: persistent dry run lacks --engine.memory-block-buffer-target 0" >&2; exit 1; }
! grep -q -- "engine.persistence-threshold" <<<"$out" || { echo "FAIL: the default mode changed reth's persistence settings" >&2; exit 1; }
grep -q -- " -v $WORK/pstate/reth-data:/data " <<<"$persist_out " || { echo "FAIL: persistent dry run does not keep reth's data in the state folder" >&2; exit 1; }
! grep -q -- 'cze-reth-data' <<<"$persist_out" || { echo "FAIL: persistent dry run uses the Docker volume that stop.sh removes" >&2; exit 1; }
while read -r p; do
  [[ $p == 127.0.0.1:* ]] || { echo "FAIL: persistent mode publishes a port beyond localhost: $p" >&2; exit 1; }
done < <(grep -oE -- '-p [^ ]+' <<<"$persist_out" | cut -d' ' -f2)
[ ! -e "$WORK/pstate/reth-data" ] || { echo "FAIL: the dry run made the data folder" >&2; exit 1; }
expect_persistent_refusal() {
  local label=$1 want=$2; shift 2
  if env "$@" PATH="$WORK/bin:$PATH" "$WORK/repo/network/reth/launch.sh" >"$WORK/out" 2>"$WORK/err"; then
    echo "FAIL: launch.sh started: $label" >&2; exit 1
  fi
  grep -qF -- "$want" "$WORK/err" || { echo "FAIL: refusal does not name '$want' ($label): $(cat "$WORK/err")" >&2; exit 1; }
  ! grep -q "docker was called" "$WORK/err" "$WORK/out" || { echo "FAIL: Docker was reached: $label" >&2; exit 1; }
  echo "ok: refused $label"
}
expect_persistent_refusal "a resume without state" "no persistent reth state" CZE_STATE_DIR="$WORK/empty" CZE_PERSIST=1 CZE_RESUME=1
mkdir -p "$WORK/full/reth-data"; touch "$WORK/full/reth-data/db"
expect_persistent_refusal "a new persistent chain on data that is there" "has data already" CZE_STATE_DIR="$WORK/full" CZE_PERSIST=1

# 2. Remove each required flag in turn; every variant must be refused.
for flag in --disable-discovery --nat --max-outbound-peers --max-inbound-peers --addr --ipcdisable \
    --engine.always-process-payload-attributes-on-canonical-head --engine.allow-unwind-canonical-header --testing.skip-invalid-transactions --builder.gaslimit --rpc.eth-proof-window --rpc.gascap --http.api --log.file.max-files; do
  fresh_copy
  sed -E -i.bak "/^ *$flag( |\$)/d" "$WORK/repo/network/reth/launch.sh"
  if grep -qE -- "^ *$flag( |\$)" "$WORK/repo/network/reth/launch.sh"; then
    echo "FAIL: test could not remove $flag" >&2; exit 1
  fi
  expect_refusal "without $flag" "$flag"
done

# 2b. In the persistent mode the two persistence flags are required too, with the value 0.
for flag in --engine.persistence-threshold --engine.memory-block-buffer-target; do
  fresh_copy
  sed -E -i.bak "/^ *$flag( |\$)/d" "$WORK/repo/network/reth/launch.sh"
  if grep -qE -- "^ *$flag( |\$)" "$WORK/repo/network/reth/launch.sh"; then
    echo "FAIL: test could not remove $flag" >&2; exit 1
  fi
  expect_persistent_refusal "persistent without $flag" "$flag" CZE_STATE_DIR="$WORK/pstate2" CZE_PERSIST=1
  fresh_copy
  sed -E -i.bak "s/^( *$flag) 0\$/\1 7/" "$WORK/repo/network/reth/launch.sh"
  expect_persistent_refusal "persistent with $flag 7" "$flag 0" CZE_STATE_DIR="$WORK/pstate2" CZE_PERSIST=1
done

# 2c. The same for each hardening option of the Docker command: removed, or given another value, it is refused before Docker is called.
for flag in --security-opt --user --cap-drop --read-only --tmpfs --pids-limit --memory --memory-swap; do
  fresh_copy
  sed -E -i.bak "/^ *$flag( |\$)/d" "$WORK/repo/network/reth/launch.sh"
  if grep -qE -- "^ *$flag( |\$)" "$WORK/repo/network/reth/launch.sh"; then
    echo "FAIL: test could not remove $flag" >&2; exit 1
  fi
  expect_refusal "without $flag" "$flag"
done
hardening_value() {  # flag, its value as written, a weaker one, what the refusal names
  fresh_copy
  sed -E -i.bak "s|^( *$1) $2\$|\1 $3|" "$WORK/repo/network/reth/launch.sh"
  grep -qE -- "^ *$1 $3\$" "$WORK/repo/network/reth/launch.sh" || { echo "FAIL: test could not set $1 $3" >&2; exit 1; }
  expect_refusal "with $1 $3" "$4"
}
hardening_value --cap-drop ALL NET_RAW "--cap-drop ALL"
hardening_value --tmpfs /tmp /var/tmp "--tmpfs /tmp"
hardening_value --security-opt no-new-privileges seccomp=unconfined "--security-opt no-new-privileges"
# shellcheck disable=SC2016
hardening_value --user '"\$RUN_UID:\$RUN_GID"' '"0:0"' "--user"
# shellcheck disable=SC2016
hardening_value --memory-swap '"\$RETH_MEMORY"' '"-1"' "--memory-swap"
forbid() {  # label, awk edit, text the refusal must name
  fresh_copy
  awk "$2" "$WORK/repo/network/reth/launch.sh" > "$WORK/launch.new"
  cmp -s "$WORK/launch.new" "$WORK/repo/network/reth/launch.sh" && { echo "FAIL: test could not add $1" >&2; exit 1; }
  cp "$WORK/launch.new" "$WORK/repo/network/reth/launch.sh"
  expect_refusal "with $1" "$3"
}
forbid "--privileged" '{sub(/^  docker run -d /, "  docker run -d --privileged ")} {print}' "--privileged"
forbid "--cap-add" '{sub(/^  docker run -d /, "  docker run -d --cap-add SYS_ADMIN ")} {print}' "--cap-add"
# The limits are settings, and a nonsense value is refused. Root is refused, and so is data that the container's user does not own, with the command that fixes it.
fresh_copy
for bad in "CZE_RETH_PIDS=0" "CZE_RETH_PIDS=many" "CZE_RETH_MEMORY=0" "CZE_RETH_MEMORY=lots"; do
  if env "$bad" PATH="$WORK/bin:$PATH" CZE_STATE_DIR="$WORK/state" "$WORK/repo/network/reth/launch.sh" >"$WORK/out" 2>"$WORK/err"; then echo "FAIL: launch.sh started with $bad" >&2; exit 1; fi
  grep -q "${bad%%=*}" "$WORK/err" || { echo "FAIL: refusal does not name ${bad%%=*}: $(cat "$WORK/err")" >&2; exit 1; }
  ! grep -q "docker was called" "$WORK/err" || { echo "FAIL: Docker was reached with $bad" >&2; exit 1; }
  echo "ok: refused $bad"
done
mkdir "$WORK/idbin"
fake_id() {  # a user id and group id for this script's `id`
  # shellcheck disable=SC2016
  printf '#!/bin/sh\nif [ "$1" = -g ]; then echo %s; else echo %s; fi\n' "$2" "$1" > "$WORK/idbin/id"; chmod +x "$WORK/idbin/id"
}
fake_id 0 0
if PATH="$WORK/idbin:$WORK/bin:$PATH" CZE_STATE_DIR="$WORK/state" "$WORK/repo/network/reth/launch.sh" >"$WORK/out" 2>"$WORK/err"; then echo "FAIL: launch.sh started as root" >&2; exit 1; fi
grep -q "must not run as root" "$WORK/err" || { echo "FAIL: refusal does not say root is refused: $(cat "$WORK/err")" >&2; exit 1; }
! grep -q "docker was called" "$WORK/err" || { echo "FAIL: Docker was reached as root" >&2; exit 1; }
echo "ok: refused to run as root"
# Data written by another user (here: this script runs as 4242, the files are ours): refused, with the exact command that hands the data over.
mkdir -p "$WORK/owned/reth-data"; echo x > "$WORK/owned/genesis.json"; echo x > "$WORK/owned/jwt.hex"; touch "$WORK/owned/reth-data/db"
fake_id 4242 4243
if PATH="$WORK/idbin:$WORK/bin:$PATH" CZE_STATE_DIR="$WORK/owned" CZE_PERSIST=1 CZE_RESUME=1 "$WORK/repo/network/reth/launch.sh" >"$WORK/out" 2>"$WORK/err"; then echo "FAIL: launch.sh started on data of another owner" >&2; exit 1; fi
for n in "does not own" "chown -R 4242:4243 /d" "--cap-add CHOWN" "--cap-add DAC_READ_SEARCH" "$WORK/owned/reth-data:/d"; do
  grep -qF -- "$n" "$WORK/err" || { echo "FAIL: refusal does not name '$n': $(cat "$WORK/err")" >&2; exit 1; }
done
! grep -q "docker was called" "$WORK/err" || { echo "FAIL: Docker was reached on data of another owner" >&2; exit 1; }
echo "ok: refused data of another owner, with the command that fixes it"
# Data of the user that runs the script is accepted: the run goes on to Docker (the fake one, which fails).
rm "$WORK/idbin/id"
if PATH="$WORK/bin:$PATH" CZE_STATE_DIR="$WORK/owned" CZE_PERSIST=1 CZE_RESUME=1 "$WORK/repo/network/reth/launch.sh" >"$WORK/out" 2>"$WORK/err"; then echo "FAIL: the fake Docker did not stop the run" >&2; exit 1; fi
grep -q "docker was called" "$WORK/err" || { echo "FAIL: data of the running user was refused: $(cat "$WORK/err")" >&2; exit 1; }
echo "ok: data of the running user is accepted"

# 3. A wrong value is refused as well as a missing flag. The refusal names the flag and
#    the value it has to have.
wrong_value() {
  fresh_copy
  sed -E -i.bak "s|^( *$1) $2\$|\1 $3|" "$WORK/repo/network/reth/launch.sh"
  grep -qE -- "^ *$1 $3\$" "$WORK/repo/network/reth/launch.sh" || { echo "FAIL: test could not set $1 $3" >&2; exit 1; }
  expect_refusal "with $1 $3" "$1 $2"
}
wrong_value --max-outbound-peers 0 5
wrong_value --max-inbound-peers 0 5
wrong_value --addr 127.0.0.1 0.0.0.0
wrong_value --rpc.eth-proof-window 1 0
# The HTTP port serves trace for the indexer and nothing that builds or debugs: a list with debug or txpool, or without trace, is refused.
for apis in "eth,net,web3" "eth,net,web3,trace,debug" "eth,net,web3,trace,txpool" "eth,net,web3,trace,testing"; do
  fresh_copy
  sed -E -i.bak "s/^( *--http.api) \"eth,net,web3,trace\"\$/\1 \"$apis\"/" "$WORK/repo/network/reth/launch.sh"
  grep -qF -- "--http.api \"$apis\"" "$WORK/repo/network/reth/launch.sh" || { echo "FAIL: test could not set --http.api $apis" >&2; exit 1; }
  expect_refusal "with --http.api $apis" "--http.api eth,net,web3,trace"
done

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
