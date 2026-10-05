#!/usr/bin/env bash
# Checks on how the explorer is run, which need no Docker: its images are pinned by digest (and the Rust one is the toolchain the repository
# pins), the Dockerfile takes every base image from PINS, and explorer/run.sh gives the container only what it needs: the reader party,
# the pins file and the faucet's key, the last two read-only, and no more rights than that.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

[[ ${EXPLORER_NODE_IMAGE:-} =~ @sha256:[0-9a-f]{64}$ ]] || fail "EXPLORER_NODE_IMAGE is not pinned by digest"
[[ ${EXPLORER_RUST_IMAGE:-} =~ @sha256:[0-9a-f]{64}$ ]] || fail "EXPLORER_RUST_IMAGE is not pinned by digest"
channel=$(sed -n 's/^channel = "\(.*\)"$/\1/p' "$ROOT/rust-toolchain.toml")
[[ $EXPLORER_RUST_IMAGE == */rust:"$channel"-*@sha256:* ]] || fail "EXPLORER_RUST_IMAGE is not Rust $channel, the toolchain rust-toolchain.toml pins"

# The Dockerfile names no image of its own: each stage starts from an image PINS pins, so there is one place to change them.
froms=$(grep -E '^FROM ' "$ROOT/explorer/Dockerfile")
[ -n "$froms" ] || fail "explorer/Dockerfile has no FROM"
while read -r line; do
  [[ $line =~ ^FROM\ \$\{EXPLORER_(NODE|RUST)_IMAGE\}\ AS\ [a-z]+$ ]] || fail "a FROM in explorer/Dockerfile does not take its image from PINS: $line"
done <<<"$froms"
for arg in EXPLORER_NODE_IMAGE EXPLORER_RUST_IMAGE; do
  grep -q "^ARG $arg\$" "$ROOT/explorer/Dockerfile" || fail "the Dockerfile does not declare $arg, with no default"
done

# run.sh, without calling Docker: what it would start.
S=$WORK/state
mkdir -p "$S/canton" "$S/net" "$S/faucet"
printf 'OPERATOR_PARTY=operator::1220aa\nREADER_PARTY=reader::1220bb\n' > "$S/canton/parties.env"
printf 'programVK=0x%s\nrootC=0x%s\n' "$(printf 'cd%.0s' $(seq 32))" "$(printf 'ef%.0s' $(seq 32))" > "$S/net/guest.txt"
printf 'SECRET-KEY-TEXT\n' > "$S/faucet/key"
dry() { EXPLORER_DRY_RUN=1 CZE_STATE_DIR="$S" "$ROOT/explorer/run.sh" "$@"; }
has() { grep -qF -- "$2" <<<"$1" || fail "$3: no \"$2\" in: $1"; }
lacks() { ! grep -qF -- "$2" <<<"$1" || fail "$3: \"$2\" is in: $1"; }

start=$(dry start)
has "$start" "docker build" "start builds the image"
has "$start" "--build-arg EXPLORER_NODE_IMAGE=$EXPLORER_NODE_IMAGE" "the build takes the Node image from PINS"
has "$start" "--build-arg EXPLORER_RUST_IMAGE=$EXPLORER_RUST_IMAGE" "the build takes the Rust image from PINS"
has "$start" "docker run" "start runs the image"
has "$start" "-e READER_PARTY=reader::1220bb" "the reader party comes from the run's parties file"
lacks "$start" "operator::1220aa" "the other parties"
has "$start" "-e PINS_FILE=/run/explorer/guest.txt" "the run's own pins"
has "$start" "-v $S/net/guest.txt:/run/explorer/guest.txt:ro" "the pins file is mounted read-only"
has "$start" "-e FAUCET_KEY_FILE=/run/explorer/key" "the faucet's key"
has "$start" "-v $S/faucet/key:/run/explorer/key:ro" "the key is mounted read-only"
lacks "$start" "SECRET-KEY-TEXT" "the key's contents"
has "$start" "--read-only" "the container's own files"
has "$start" "--cap-drop ALL" "the container's capabilities"
has "$start" "--security-opt no-new-privileges" "the container's privileges"
has "$start" "--user $(id -u):$(id -g)" "the container runs as the caller, who owns the key"
has "$start" "--network host" "the explorer reads the chain's local ports"
lacks "$start" "--privileged" "the container"
lacks "$start" "docker.sock" "the container"
lacks "$start" " -p " "a published port"

# Without a key the faucet is off: nothing about it is passed. Settings given by the caller win over the run's files.
rm "$S/faucet/key"
nokey=$(dry start); lacks "$nokey" "FAUCET_KEY_FILE" "a run with no key"
printf 'programVK=0x00\n' > "$WORK/other-pins.txt"
over=$(READER_PARTY=reader::other PINS_FILE=$WORK/other-pins.txt dry start)
has "$over" "-e READER_PARTY=reader::other" "READER_PARTY given by the caller"
has "$over" "-e PINS_FILE=/run/explorer/other-pins.txt" "PINS_FILE given by the caller"
has "$over" "-v $WORK/other-pins.txt:/run/explorer/other-pins.txt:ro" "the caller's pins file"

# A file the caller names must exist and be a regular file, and is mounted by its absolute path: a path that is missing would be made into a
# directory by Docker, a bare name would become a named volume, and a directory is not a file to read.
mkdir "$WORK/adir"; printf 'k\n' > "$WORK/relkey"
for bad in "PINS_FILE=$WORK/no-such-pins" "PINS_FILE=$WORK/adir" "PINS_FILE=no-such-pins" "FAUCET_KEY_FILE=$WORK/no-such-key" "FAUCET_KEY_FILE=$WORK/adir"; do
  if out=$(env "$bad" EXPLORER_DRY_RUN=1 CZE_STATE_DIR="$S" "$ROOT/explorer/run.sh" start 2>&1); then fail "start ran with $bad"; fi
  has "$out" "${bad%%=*}" "the refusal for $bad"
  lacks "$out" "docker run" "a start with $bad"
done
if out=$(CZE_GENESIS_FILE=$WORK/no-such-genesis EXPLORER_DRY_RUN=1 CZE_STATE_DIR="$S" "$ROOT/explorer/run.sh" setup 2>&1); then fail "setup ran with a genesis that is not there"; fi
has "$out" "CZE_GENESIS_FILE" "the refusal for the genesis"
if out=$(CZE_GENESIS_FILE=$WORK/adir EXPLORER_DRY_RUN=1 CZE_STATE_DIR="$S" "$ROOT/explorer/run.sh" setup 2>&1); then fail "setup ran with a genesis that is a directory"; fi
rel=$(cd "$WORK" && FAUCET_KEY_FILE=relkey EXPLORER_DRY_RUN=1 CZE_STATE_DIR="$S" "$ROOT/explorer/run.sh" start)
has "$rel" "-v $WORK/relkey:/run/explorer/relkey:ro" "a relative file is mounted by its absolute path"
rm -rf "$WORK/adir"

# No reader party anywhere: it stops, and says which setting.
rm "$S/canton/parties.env"
if out=$(dry start 2>&1); then fail "start ran without a reader party"; fi
has "$out" "READER_PARTY" "the refusal"

# setup lets the container write the faucet's folder and nothing else of the state.
setup=$(dry setup)
has "$setup" "node server/faucet-setup.ts" "setup runs the faucet's script"
has "$setup" "-v $S/faucet:$S/faucet" "setup may write the faucet's folder"
lacks "$setup" "-v $S:$S" "setup may write the whole state"
has "$setup" "-e CZE_GENESIS_FILE=$ROOT/network/genesis.json" "the genesis it copies, when none is named"
has "$setup" "-v $ROOT/network/genesis.json:$ROOT/network/genesis.json:ro" "the genesis is read-only"
lacks "$setup" "--network host" "setup needs no network"
printf '{}\n' > "$WORK/g.json"
named=$(CZE_GENESIS_FILE=$WORK/g.json dry setup)
has "$named" "-e CZE_GENESIS_FILE=$WORK/g.json" "the genesis the caller names"

# stop, and what it is not given.
has "$(dry stop)" "docker rm -f cze-explorer" "stop"
if dry nonsense >/dev/null 2>&1; then fail "run.sh accepted a command it does not have"; fi
echo "explorer run checks passed"
