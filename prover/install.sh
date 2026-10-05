#!/usr/bin/env bash
# Installs ZisK on the machine that has the GPU: the system packages, Rust, the pinned ZisK
# release (GPU build), its proving key and the PLONK/SNARK setup. Run it once.
#
# Needs sudo, an NVIDIA driver (525.60.13 or newer) and about 100 GB of free disk.
# The version, its commit and the checksum of its installer come from PINS.
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

# The installer of the pinned release, checked against the checksum in PINS before it runs.
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
curl -sSfL -o "$TMP/ziskup" "https://raw.githubusercontent.com/0xPolygonHermez/zisk/v${ZISK_VERSION}/ziskup/ziskup"
echo "$ZISKUP_SHA256  $TMP/ziskup" | sha256sum -c - || fail "ziskup does not match ZISKUP_SHA256"

bash "$TMP/ziskup" -v "$ZISK_VERSION" --provingkey --gpu -y
bash "$TMP/ziskup" setup_snark

# cargo-zisk checks a PLONK proof by running snarkjs, which needs Node.
if ! command -v snarkjs >/dev/null; then
  curl -sSfL -o "$TMP/node.tar.xz" "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"
  echo "$NODE_SHA256  $TMP/node.tar.xz" | sha256sum -c - || fail "Node does not match NODE_SHA256"
  sudo tar -xJf "$TMP/node.tar.xz" -C /usr/local --strip-components=1
  sudo npm install -g "snarkjs@${SNARKJS_VERSION}"
fi

version=$(cargo-zisk --version)
echo "$version"
[[ $version == *"$ZISK_VERSION"* && $version == *"${ZISK_COMMIT:0:7}"* ]] \
  || fail "cargo-zisk is not $ZISK_VERSION at commit $ZISK_COMMIT"
echo "installed: $version"
