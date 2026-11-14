#!/usr/bin/env bash
# Installs ZisK on the machine that has the GPU: the system packages, Rust, the pinned ZisK
# release (GPU build), its Poseidon1 proving key and our PLONK key. Run it once.
#
# Needs sudo, an NVIDIA driver (525.60.13 or newer) and about 100 GB of free disk (ZISK_CPU_ONLY=1 installs the CPU build instead,
# with no GPU and no driver: for a machine that builds the guest or the key and proves nothing).
# The version, its commit, the checksum of its installer and the Rust toolchain release with its checksum come from PINS,
# and so do the SHA-256 of the release binaries and of the proving key. ZISK_ARTIFACTS_DIR may name a folder that already
# holds those four files and our PLONK key (see below).
set -euo pipefail
# shellcheck disable=SC1091
. "$(dirname "$0")/common.sh"

if [ "${ZISK_CPU_ONLY:-0}" = 1 ]; then ZISKUP_BUILD=--cpu; else
  command -v nvidia-smi >/dev/null || fail "no NVIDIA driver: nvidia-smi is missing"
  ZISKUP_BUILD=--gpu
fi

sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y xz-utils jq curl build-essential qemu-system \
  libomp-dev libgmp-dev nlohmann-json3-dev protobuf-compiler uuid-dev libgrpc++-dev libsecp256k1-dev \
  libsodium-dev libpqxx-dev nasm libopenmpi-dev openmpi-bin openmpi-common libclang-dev clang \
  gcc-riscv64-unknown-elf git pkg-config libssl-dev

# ZisK keeps its proving memory locked, so the limit must be unlimited.
echo '* - memlock unlimited' | sudo tee /etc/security/limits.d/99-zisk.conf >/dev/null
sudo mkdir -p /etc/systemd/system.conf.d
printf '[Manager]\nDefaultLimitMEMLOCK=infinity\n' | sudo tee /etc/systemd/system.conf.d/zisk.conf >/dev/null

command -v cargo >/dev/null || curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal

# Everything ZisK's own servers supply, each file checked against its SHA-256 in PINS before it is used (zisk-artifacts.sh says why):
# the installer (ziskup, from ZisK's GitHub), the Rust toolchain release (from 0xPolygonHermez/rust), the release binaries (GitHub)
# and the Poseidon1 proving key (ZisK's setup bucket). They go to ZISK_ARTIFACTS_DIR when it is set, and stay there; a file already there with the
# pinned checksum is used as it is, so a kept copy of the files installs without ZisK's servers (what is still fetched is the
# system packages, Rust's rustup if cargo is missing, Node, and the Node packages of the PLONK key from the lock file). Otherwise they go to a folder
# under the prover state and are deleted once installed. The proving key is about 5 GB, and ziskup copies it once more before it unpacks it.
#
# The Rust toolchain: left to itself, ZisK's installer takes the highest zisk-4.x.y release of 0xPolygonHermez/rust, so what it installs changes when
# a release is published there, and the guest ELF and its programVK come from the toolchain. The release in PINS is checked here and handed to the
# installer as the source of the toolchain (ZISK_TOOLCHAIN_SOURCE_DIR, which holds the archive).
#
# The key is the Poseidon1 one (ziskup --poseidon1), not the default blake3 key: only a Poseidon key can be wrapped in PLONK, which is the final proof
# our verifier checks. ZisK 1.4.0 publishes no PLONK key and its setup_snark installs pilfflonk, so setup_snark is not run: our own PLONK key is put in
# place instead (below).
# shellcheck disable=SC1091
. "$(dirname "$0")/zisk-artifacts.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
ART=${ZISK_ARTIFACTS_DIR:-$STATE/zisk-artifacts}
WORK=$STATE/zisk-install
mkdir -p "$ART" "$WORK"
ART=$(cd "$ART" && pwd)
ZISKUP_URL=https://raw.githubusercontent.com/0xPolygonHermez/zisk/v${ZISK_VERSION}/ziskup/ziskup
RELEASE_URL=https://github.com/0xPolygonHermez/zisk/releases/download/v$ZISK_VERSION
BUCKET_URL=https://storage.googleapis.com/zisk-setup
TOOLCHAIN_ASSET=rust-toolchain-x86_64-unknown-linux-gnu.tar.gz
TOOLCHAIN_URL=https://github.com/0xPolygonHermez/rust/releases/download/${ZISK_TOOLCHAIN}/${TOOLCHAIN_ASSET}
PROVINGKEY=zisk-provingkey-$ZISK_VERSION-poseidon1.tar.gz
zisk_fetch_checked "$ZISKUP_URL" "$ART/ziskup" "$ZISKUP_SHA256"
zisk_fetch_checked "$TOOLCHAIN_URL" "$ART/$TOOLCHAIN_ASSET" "$ZISK_TOOLCHAIN_SHA256"
export ZISK_TOOLCHAIN_SOURCE_DIR=$ART
zisk_fetch_checked "$RELEASE_URL/cargo_zisk_linux_amd64.tar.gz" "$ART/cargo_zisk_linux_amd64.tar.gz" "$ZISK_RELEASE_SHA256"
zisk_fetch_checked "$BUCKET_URL/$PROVINGKEY" "$ART/$PROVINGKEY" "$ZISK_STARK_SETUP_SHA256"
zisk_local_installer "$ART/ziskup" "$TMP/ziskup-local" "$ART"
( cd "$WORK" && bash "$TMP/ziskup-local" -v "$ZISK_VERSION" --provingkey --poseidon1 "$ZISKUP_BUILD" -y )
[ -n "${ZISK_ARTIFACTS_DIR:-}" ] || rm -f "$ART/$PROVINGKEY" "$ART/$PROVINGKEY.md5"
rm -rf "$WORK"

# Every file the proving key put in place, against the list taken from the checked tarball (files ZisK writes next to them later,
# such as the constant trees, are not in the list).
KEYS_LIST=$ROOT/prover/zisk-$ZISK_VERSION-keys.sha256
[ -s "$KEYS_LIST" ] || fail "no list of the key files for $ZISK_VERSION: $KEYS_LIST"
( cd "$ZISK_DIR" && sha256sum -c --quiet "$KEYS_LIST" ) || fail "an installed key file differs from $KEYS_LIST"
echo "installed keys match $(basename "$KEYS_LIST")"

# Node, at the pinned version (build-plonk-key.sh and the Node packages of the PLONK key need exactly it). cargo-zisk checks a PLONK proof by running snarkjs.
if [ "$(node -v 2>/dev/null || true)" != "v$NODE_VERSION" ]; then
  curl -sSfL -o "$TMP/node.tar.xz" "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"
  echo "$NODE_SHA256  $TMP/node.tar.xz" | sha256sum -c - || fail "Node does not match NODE_SHA256"
  sudo tar -xJf "$TMP/node.tar.xz" -C /usr/local --strip-components=1
fi

# snarkjs, with the packages of the PLONK key's lock file (prover/plonk-key/package-lock.json), not an unlocked `npm install -g`: the tree is checked against PLONK_NODE_TREE_SHA256.
zisk_install_node_deps "$ZISK_DIR/node-deps" "$ROOT/prover/plonk-key"
# cargo-zisk finds it on PATH; ZISK_SNARKJS_LINK says where the link goes (default /usr/local/bin/snarkjs; a machine that keeps another ZisK install
# beside this one, with its own snarkjs there, names another place and puts it on PATH for this install).
SNARKJS_LINK=${ZISK_SNARKJS_LINK:-/usr/local/bin/snarkjs}
mkdir -p "$(dirname "$SNARKJS_LINK")" 2>/dev/null || sudo mkdir -p "$(dirname "$SNARKJS_LINK")"
sudo ln -sf "$ZISK_DIR/node-deps/node_modules/.bin/snarkjs" "$SNARKJS_LINK"
[ "$("$SNARKJS_LINK" --version 2>&1 | head -1)" = "snarkjs@$SNARKJS_VERSION" ] || fail "snarkjs is not $SNARKJS_VERSION"

# Our PLONK key (provingKeySnark/), the final SNARK of the wrapped proof. In order: already installed and matching the list; a kept copy (the folder
# provingKeySnark/ in ZISK_ARTIFACTS_DIR, or the one ZISK_PLONK_KEY_DIR names); a download (ZISK_PLONK_KEY_URL, a tar.gz of that folder); otherwise it
# is built here from the Poseidon1 key (prover/build-plonk-key.sh: about 15 minutes after the 19 GB ptau). Whatever the source, the five files that
# matter and the others of the list (22 files, prover/zisk-<version>-plonk-key.sha256; check_plonk_key_list) must match before the key is put in place: a
# copy or a download is checked where it is, and a key that is built here is checked by build-plonk-key.sh against the same list.
PLONK_LIST=$ROOT/prover/zisk-$ZISK_VERSION-plonk-key.sha256
if check_plonk_key_list "$ZISK_DIR/provingKeySnark" "$PLONK_LIST" 2>/dev/null; then
  echo "PLONK key: already installed, files match $(basename "$PLONK_LIST")"
else
  KEPT=${ZISK_PLONK_KEY_DIR:-$ART/provingKeySnark}
  if [ -n "${ZISK_PLONK_KEY_URL:-}" ] && ! [ -d "$KEPT" ]; then
    KEPT=$ZISK_DIR/provingKeySnark.download
    rm -rf "$KEPT" "$KEPT.tar.gz"
    curl -sSfL --retry 3 -o "$KEPT.tar.gz" "$ZISK_PLONK_KEY_URL" || fail "could not download $ZISK_PLONK_KEY_URL"
    mkdir -p "$KEPT.unpack" && tar --no-same-owner -xzf "$KEPT.tar.gz" -C "$KEPT.unpack"
    mv "$KEPT.unpack/provingKeySnark" "$KEPT" && rm -rf "$KEPT.unpack" "$KEPT.tar.gz"
  fi
  if [ -d "$KEPT" ]; then
    check_plonk_key_list "$KEPT" "$PLONK_LIST" || fail "the PLONK key in $KEPT does not match $(basename "$PLONK_LIST")"
    rm -rf "$ZISK_DIR/provingKeySnark"
    if [ "$KEPT" = "$ZISK_DIR/provingKeySnark.download" ]; then mv "$KEPT" "$ZISK_DIR/provingKeySnark"; else cp -a "$KEPT" "$ZISK_DIR/provingKeySnark"; fi
    echo "PLONK key: installed from $KEPT, files match $(basename "$PLONK_LIST")"
  else
    ZISK_ARTIFACTS_DIR=$ART bash "$ROOT/prover/build-plonk-key.sh" --install
  fi
fi
[ -n "${ZISK_ARTIFACTS_DIR:-}" ] || rm -rf "$ART"

rustup toolchain list | grep -q '^zisk' || fail "the zisk Rust toolchain is not installed"

version=$(cargo-zisk --version)
echo "$version"
[[ $version == *"$ZISK_VERSION"* && $version == *"${ZISK_COMMIT:0:7}"* ]] \
  || fail "cargo-zisk is not $ZISK_VERSION at commit $ZISK_COMMIT"
echo "installed: $version"
