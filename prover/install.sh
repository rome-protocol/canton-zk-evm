#!/usr/bin/env bash
# Installs ZisK on the machine that has the GPU: the system packages, Rust, the pinned ZisK
# release (GPU build), its proving key and the PLONK/SNARK setup. Run it once.
#
# Needs sudo, an NVIDIA driver (525.60.13 or newer) and about 100 GB of free disk.
# The version, its commit, the checksum of its installer and the Rust toolchain release with its checksum come from PINS,
# and so do the SHA-256 of the release binaries and of both keys. ZISK_ARTIFACTS_DIR may name a folder that already holds
# those five files (see below).
set -euo pipefail
# shellcheck disable=SC1091
. "$(dirname "$0")/common.sh"

command -v nvidia-smi >/dev/null || fail "no NVIDIA driver: nvidia-smi is missing"

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
# and the two keys (ZisK's setup bucket). They go to ZISK_ARTIFACTS_DIR when it is set, and stay there; a file already there with the
# pinned checksum is used as it is, so a kept copy of the five files installs without ZisK's servers (what is still fetched is the
# system packages, Rust's rustup if cargo is missing, and Node and snarkjs). Otherwise they go to a folder under the prover state and
# are deleted once installed. The keys are about 5 GB and 22 GB, and ziskup copies each once more before it unpacks it.
#
# The Rust toolchain: left to itself, ZisK's installer takes the highest zisk-4.x.y release of 0xPolygonHermez/rust, so what it installs changes when
# a release is published there (zisk-4.1.0 was published on 2026-10-26, and the guest ELF and its programVK come from the toolchain). The release in
# PINS is checked here and handed to the installer as the source of the toolchain (ZISK_TOOLCHAIN_SOURCE_DIR, which holds the archive).
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
PROVINGKEY=zisk-provingkey-$ZISK_VERSION.tar.gz
PLONKKEY=zisk-provingkey-plonk-$ZISK_VERSION.tar.gz
zisk_fetch_checked "$ZISKUP_URL" "$ART/ziskup" "$ZISKUP_SHA256"
zisk_fetch_checked "$TOOLCHAIN_URL" "$ART/$TOOLCHAIN_ASSET" "$ZISK_TOOLCHAIN_SHA256"
export ZISK_TOOLCHAIN_SOURCE_DIR=$ART
zisk_fetch_checked "$RELEASE_URL/cargo_zisk_linux_amd64.tar.gz" "$ART/cargo_zisk_linux_amd64.tar.gz" "$ZISK_RELEASE_SHA256"
zisk_fetch_checked "$BUCKET_URL/$PROVINGKEY" "$ART/$PROVINGKEY" "$ZISK_STARK_SETUP_SHA256"
zisk_local_installer "$ART/ziskup" "$TMP/ziskup-local" "$ART"
( cd "$WORK" && bash "$TMP/ziskup-local" -v "$ZISK_VERSION" --provingkey --gpu -y )
[ -n "${ZISK_ARTIFACTS_DIR:-}" ] || rm -f "$ART/$PROVINGKEY" "$ART/$PROVINGKEY.md5"
zisk_fetch_checked "$BUCKET_URL/$PLONKKEY" "$ART/$PLONKKEY" "$ZISK_PLONK_SETUP_SHA256"
( cd "$WORK" && bash "$TMP/ziskup-local" setup_snark )
[ -n "${ZISK_ARTIFACTS_DIR:-}" ] || rm -rf "$ART"
rm -rf "$WORK"

# Every file the two keys put in place, against the list taken from the checked tarballs (files ZisK writes next to them later,
# such as the constant trees, are not in the list).
KEYS_LIST=$ROOT/prover/zisk-$ZISK_VERSION-keys.sha256
[ -s "$KEYS_LIST" ] || fail "no list of the key files for $ZISK_VERSION: $KEYS_LIST"
( cd "$ZISK_DIR" && sha256sum -c --quiet "$KEYS_LIST" ) || fail "an installed key file differs from $KEYS_LIST"
echo "installed keys match $(basename "$KEYS_LIST")"

# cargo-zisk checks a PLONK proof by running snarkjs, which needs Node.
if ! command -v snarkjs >/dev/null; then
  curl -sSfL -o "$TMP/node.tar.xz" "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"
  echo "$NODE_SHA256  $TMP/node.tar.xz" | sha256sum -c - || fail "Node does not match NODE_SHA256"
  sudo tar -xJf "$TMP/node.tar.xz" -C /usr/local --strip-components=1
  sudo npm install -g "snarkjs@${SNARKJS_VERSION}"
fi

rustup toolchain list | grep -q '^zisk' || fail "the zisk Rust toolchain is not installed"

version=$(cargo-zisk --version)
echo "$version"
[[ $version == *"$ZISK_VERSION"* && $version == *"${ZISK_COMMIT:0:7}"* ]] \
  || fail "cargo-zisk is not $ZISK_VERSION at commit $ZISK_COMMIT"
echo "installed: $version"
