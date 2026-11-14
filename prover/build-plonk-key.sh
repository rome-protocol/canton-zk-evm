#!/usr/bin/env bash
# Builds this chain's PLONK key: the final SNARK of ZisK ZISK_VERSION, set up by us on ZisK's published Poseidon1 proving key and the pinned
# powers-of-tau file. ZisK 1.4.0 publishes no PLONK key (its default final proof is pilfflonk, which our verifier does not check), so the
# key the verifier crate and the sidecar are pinned to is built here, and every file of it is pinned by SHA-256 in PINS.
#
# Usage: build-plonk-key.sh [--install]
#   no flag     builds into $OUT (below), compares the key files with PINS and prints their SHA-256
#   --install   then moves the key into $ZISK_DIR/provingKeySnark, where the prover's worker reads it
#
# Needs ZisK installed with the Poseidon1 proving key (prover/install.sh does it; it does not need the GPU), the pinned Node (NODE_VERSION) on
# PATH, about 60 GB of free disk and 16 GB of RAM. It takes about 7 minutes after the downloads. Environment:
#   CZE_PLONK_KEY_OUT      the build folder              (default: $STATE/plonk-key)
#   ZISK_PTAU              the powers-of-tau file         (default: $ZISK_ARTIFACTS_DIR or the build folder; downloaded when absent)
#   CZE_PLONK_OFFLINE      auto (default), 1 or 0: run the setup with no network (see below)
#
# Nothing the build runs comes from an unpinned source:
#   - the Node packages (pil2-compiler, snarkjs, circomlib and their 150-odd dependencies) are installed from prover/plonk-key/package-lock.json
#     (npm ci, install scripts off) and the finished node_modules tree is checked against PLONK_NODE_TREE_SHA256 in PINS. ZisK's own setup would
#     run `npm install` with no lock file, which takes whatever the registry and the pil2-compiler branch hold that day.
#   - the setup is pointed at that tree (PIL2C_EXEC, SNARKJS_PATH, CIRCOMLIB_PATH), and `npm` is replaced for its run by a stub that stops, so it
#     cannot fetch anything. When the machine allows it (sudo and unshare), the setup also runs in an empty network namespace, so that it cannot.
#   - the ptau is checked against ZISK_PTAU_BLAKE2B and ZISK_PTAU_SHA256, the Poseidon1 key against the file list of the release
#     (prover/zisk-$ZISK_VERSION-keys.sha256), and the result against the key pins of PINS.
# The build is deterministic: the same inputs gave byte-identical key files on two machines.
set -euo pipefail
# shellcheck disable=SC1091
. "$(dirname "$0")/common.sh"
# shellcheck disable=SC1091
. "$(dirname "$0")/zisk-artifacts.sh"

INSTALL=0
case "${1:-}" in
  "") ;;
  --install) INSTALL=1 ;;
  *) fail "usage: build-plonk-key.sh [--install]" ;;
esac

command -v cargo-zisk-dev >/dev/null || fail "cargo-zisk-dev is not installed (prover/install.sh)"
command -v node >/dev/null || fail "node is not on PATH (NODE_VERSION $NODE_VERSION)"
[ "$(node -v)" = "v$NODE_VERSION" ] || fail "node is $(node -v), PINS has NODE_VERSION $NODE_VERSION"
command -v npm >/dev/null || fail "npm is not on PATH"
[ -d "$ZISK_DIR/provingKey" ] || fail "no proving key in $ZISK_DIR/provingKey (prover/install.sh)"
# ziskup writes the hash mode of the key it installed here; a PLONK final proof takes a Poseidon key only.
grep -qx 'hash_mode=Poseidon1' "$ZISK_DIR/.zisk-bundle" || fail "the installed proving key is not the Poseidon1 one ($ZISK_DIR/.zisk-bundle)"

OUT=${CZE_PLONK_KEY_OUT:-$STATE/plonk-key}
case $OUT in /?*) ;; *) fail "CZE_PLONK_KEY_OUT must be an absolute path: $OUT" ;; esac
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
if [ -n "${ZISK_PTAU:-}" ]; then PTAU=$ZISK_PTAU
elif [ -n "${ZISK_ARTIFACTS_DIR:-}" ]; then PTAU=$ZISK_ARTIFACTS_DIR/powersOfTau28_hez_final_24.ptau
else PTAU=$OUT/powersOfTau28_hez_final_24.ptau; fi

# --- the powers of tau ---------------------------------------------------------------------------------------------------------------------
ptau_ok() { [ -f "$1" ] && [ "$(stat -c %s "$1")" = 19327435928 ] && echo "$ZISK_PTAU_SHA256  $1" | sha256sum -c --status - \
  && [ "$(b2sum "$1" | cut -d' ' -f1)" = "$ZISK_PTAU_BLAKE2B" ]; }
if ptau_ok "$PTAU"; then
  echo "ptau: present, SHA-256 and blake2b-512 match PINS"
else
  # circom.info drops long HTTP/2 transfers, so this is HTTP/1.1 and resumes where it stopped.
  for _ in $(seq 1 20); do
    if curl --http1.1 -sSfL -C - --retry 3 -o "$PTAU" https://circom.info/powersOfTau28_hez_final_24.ptau; then break; fi
    sleep 5
  done
  ptau_ok "$PTAU" || fail "the ptau at $PTAU does not match ZISK_PTAU_SHA256 and ZISK_PTAU_BLAKE2B in PINS"
  echo "ptau: downloaded, SHA-256 and blake2b-512 match PINS"
fi

# --- the Node packages, from the lock file ---------------------------------------------------------------------------------------------------
NODE_DEPS=$OUT/node-deps
zisk_install_node_deps "$NODE_DEPS" "$ROOT/prover/plonk-key"

# --- the setup ----------------------------------------------------------------------------------------------------------------------------
BUILD=$OUT/build
rm -rf "$BUILD"
mkdir -p "$BUILD" "$OUT/stub"
ln -s "$ZISK_DIR/provingKey" "$BUILD/provingKey"
printf '#!/bin/sh\necho "npm must not run during the PLONK key build" >&2\nexit 1\n' > "$OUT/stub/npm"
chmod +x "$OUT/stub/npm"
SETUP_ENV=("PATH=$OUT/stub:$(dirname "$(command -v node)"):$PATH" "HOME=$HOME" "ZISK_HOME=$ZISK_DIR" "XDG_CACHE_HOME=$OUT/cache"
  "PIL2C_EXEC=$NODE_DEPS/node_modules/pil2-compiler/src/pil.js" "SNARKJS_PATH=$NODE_DEPS/node_modules/snarkjs"
  "CIRCOMLIB_PATH=$NODE_DEPS/node_modules/circomlib/circuits")
# The layout of the final circuit's public inputs (68 values, the program key included): state-machines/publics.json of ZisK at ZISK_COMMIT,
# kept here and checked against PINS; setup-snark needs it, and the final circuit does not compile without it.
PUBLICS=$ROOT/prover/plonk-key/publics.json
echo "$ZISK_PUBLICS_INFO_SHA256  $PUBLICS" | sha256sum -c --status - || fail "$PUBLICS does not match ZISK_PUBLICS_INFO_SHA256 in PINS"
SETUP_CMD=(cargo-zisk-dev proofman-setup setup-snark -b "$BUILD" --publics-info "$PUBLICS" --powers-of-tau "$PTAU" --final-snark plonk -v)

run_setup() {
  local mode=${CZE_PLONK_OFFLINE:-auto}
  if [ "$mode" != 0 ] && sudo -n unshare --net true 2>/dev/null; then
    echo "setup: running with no network (an empty network namespace)"
    sudo -n unshare --net -- setpriv --reuid="$(id -u)" --regid="$(id -g)" --init-groups env -i "${SETUP_ENV[@]}" "$(command -v cargo-zisk-dev)" "${SETUP_CMD[@]:1}"
  elif [ "$mode" = 1 ]; then
    fail "CZE_PLONK_OFFLINE=1 but this machine cannot run a command with no network (sudo and unshare)"
  else
    echo "setup: no network sandbox here; npm is stubbed out, every tool is the pinned one"
    env -i "${SETUP_ENV[@]}" "${SETUP_CMD[@]}"
  fi
}
start=$(date +%s)
run_setup > "$OUT/setup-snark.log" 2>&1 || { tail -n 40 "$OUT/setup-snark.log" >&2; fail "setup-snark failed (log: $OUT/setup-snark.log)"; }
echo "setup-snark took $(( $(date +%s) - start )) s"

# --- the result -----------------------------------------------------------------------------------------------------------------------------
SNARK=$BUILD/provingKeySnark
for f in final/final.zkey final/final.verkey.json final/PlonkVerifier.sol vadcop_final.verkey.json recursivef/recursivef.verkey.json; do
  [ -s "$SNARK/$f" ] || fail "the setup did not write $f"
done
# Every file of the key, as provingKeySnark/<path>, against the list kept in the repository (22 files: two builds on two machines agreed on every one,
# the compiled witness libraries final.so and recursivef.so included). The five files below are the ones a proof depends on; they are also pinned by
# name in PINS (tests/static.sh checks that PINS and the list agree), and the zkey is only read once here, which takes minutes.
( cd "$BUILD" && find provingKeySnark -type f | LC_ALL=C sort | xargs sha256sum ) > "$OUT/plonk-key-all.sha256"
cat "$OUT/plonk-key-all.sha256"
if ! diff <(LC_ALL=C sort -k2 "$ROOT/prover/zisk-$ZISK_VERSION-plonk-key.sha256") <(LC_ALL=C sort -k2 "$OUT/plonk-key-all.sha256"); then
  fail "the key built here differs from prover/zisk-$ZISK_VERSION-plonk-key.sha256 (the lines above: < the list, > this build)"
fi
echo "the PLONK key matches prover/zisk-$ZISK_VERSION-plonk-key.sha256"

if [ "$INSTALL" = 1 ]; then
  rm -rf "$ZISK_DIR/provingKeySnark"
  mv "$SNARK" "$ZISK_DIR/provingKeySnark"
  echo "installed in $ZISK_DIR/provingKeySnark"
fi
