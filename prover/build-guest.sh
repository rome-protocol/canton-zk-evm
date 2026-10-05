#!/usr/bin/env bash
# Builds the guest ELF and prints what identifies it:
#   elf_sha256   SHA-256 of the ELF file
#   programVK    the program's key, 32 bytes as hex (what a verifier pins; same form as in a proof)
#   rootC        the key of ZisK's final circuit, 32 bytes as hex (a property of the installed ZisK)
#   rulesHash    the hash of the chain rules built into the guest (see guest/README.md)
#
# Needs ZisK installed (prover/install.sh). It does not need the GPU. The ELF is copied to
# the prover state folder, where prove-one.sh looks for it.
#
# The build runs in one fixed folder, /tmp/cze-guest-build, not in the source folder. The script
# empties that folder, copies the guest sources into it (guest/ and network/genesis.json, in the
# same layout), and builds there with CARGO_HOME and CARGO_TARGET_DIR inside it. The aim is that the
# folder the sources came from does not change the ELF, and so not the programVK: cargo hashes the
# absolute path of each path dependency into the crate's metadata, and --remap-path-prefix does not
# change that. The script also drops the caller's compiler settings and maps the folders it builds
# in to fixed names, then looks for those folders in the finished ELF and stops if it finds one.
# Confirmed on real ZisK on 2026-10-04: two fresh checkouts gave the same programVK and the same ELF
# (see guest/README.md). tests/guest-repro.sh checks the script's steps against stand-ins for the ZisK tools.
# Two builds at the same time would share the folder, so run one at a time.
set -euo pipefail
# shellcheck disable=SC1091
. "$(dirname "$0")/common.sh"
# shellcheck disable=SC1091
. "$ROOT/prover/guest-env.sh"

LOCK=$ROOT/guest/bin/guests/stateless-validator-reth/Cargo.lock
guest_prepare_build
guest_build_env
PKG=$GUEST_BUILD_PKG
( cd "$PKG" && cargo-zisk build --release )
cmp -s "$LOCK" "$PKG/Cargo.lock" || fail "the build changed Cargo.lock; commit the new lock ($PKG/Cargo.lock) first"

mkdir -p "$STATE/guest"
built=""
for c in "$CARGO_TARGET_DIR/elf/riscv64ima-zisk-zkvm-elf/release/zec-reth" "$PKG/target/elf/riscv64ima-zisk-zkvm-elf/release/zec-reth"; do
  if [ -f "$c" ]; then built=$c; break; fi
done
[ -n "$built" ] || fail "the guest ELF is not under $CARGO_TARGET_DIR or $PKG/target"
cp "$built" "$GUEST_ELF"
leak=$(guest_elf_build_path "$GUEST_ELF")
[ -z "$leak" ] || fail "the guest ELF still holds a build path ($leak), so its programVK would depend on the build folder; not reporting it"

# The program key comes out of the ROM setup, which writes it to a file of four little-endian u64.
SETUP=$(mktemp -d); trap 'rm -rf "$SETUP"' EXIT
cargo-zisk-dev program-setup -e "$GUEST_ELF" -o "$SETUP" >&2
vk_file=$(ls "$SETUP"/*.verkey.bin)

PROVING_KEY=$ZISK_DIR/provingKey
name=$(jq -r '.name // "pilout"' "$PROVING_KEY/pilout.globalInfo.json")

python3 - "$vk_file" "$PROVING_KEY/$name/vadcop_final/vadcop_final.verkey.json" <<'PY'
import json, struct, sys
vk = struct.unpack("<4Q", open(sys.argv[1], "rb").read())
root_c = [int(x) for x in json.load(open(sys.argv[2]))]
be = lambda words: "0x" + b"".join(w.to_bytes(8, "big") for w in words).hex()
print("programVK=" + be(vk))
print("rootC=" + be(root_c))
PY

echo "elf_sha256=$(sha256sum "$GUEST_ELF" | cut -d' ' -f1)"
echo "rulesHash=$(cargo run -q --release --locked --manifest-path "$ROOT/guest/rules/Cargo.toml" --bin rules-hash)"
