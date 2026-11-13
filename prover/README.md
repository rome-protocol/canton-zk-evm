# prover

Scripts that run the ZisK prover for this guest on the GPU machine. Machine hosting, creation and deletion are outside this repository's scope. `ZISK_COORDINATOR_URL` selects the coordinator and defaults to the one on the same machine.

The supplied installer targets Linux x86-64 with `apt`, `sudo`, an installed NVIDIA driver and about 100 GB of free disk. It installs system packages and changes memory-lock limits. See [docs/METRICS.md](../docs/METRICS.md#the-machine) for the tested hardware and memory measurements. Minimum GPU memory for the whole prover is not established here.

| Script | What it does |
|---|---|
| `install.sh` | Installs the ZisK release in `PINS` (GPU build), its proving key and the PLONK setup. It checks the installer, the release binaries and both keys against their SHA-256 in `PINS` before it installs them, and every installed key file against `zisk-<version>-keys.sha256` afterwards (see "The release files"). |
| `build-guest.sh` | Copies the guest sources into one fixed folder (`/tmp/cze-guest-build`), builds the guest ELF there, and prints its SHA-256, programVK, rootC and the rules hash. It takes an optional genesis file in place of `network/genesis.json`, for a chain whose Osaka fork starts later than genesis. The folder you run it from does not change the ELF: two fresh checkouts gave the same programVK on real ZisK (see `guest/README.md`). It stops if the ELF still holds a build path. `guest-env.sh` has what it uses for that. Run one build at a time: the folder is emptied at the start of each. |
| `start.sh` | Starts the coordinator and one GPU worker with the PLONK key loaded, and leaves them running. |
| `prove-one.sh` | Proves one input, verifies the proof with `cargo-zisk`, and writes the 1,344-byte wrapped proof as hex. |
| `make-block.py` | Makes one block with one transfer on a temporary copy of the chain, through reth's testing and Engine APIs, and saves the block and its execution witness. |
| `make-input.sh` | Turns that block, its witness and the genesis into the prover input, using zisk-eth-client's own input code. |

## The Rust toolchain

ZisK's installer installs the Rust toolchain with `cargo-zisk toolchain install`, which takes the highest `zisk-4.x.y` release of 0xPolygonHermez/rust that exists, so the toolchain it installs changes when a release is published there (it asked for `zisk-4.1.0` before that release had any files, and the install stopped on a 404). `install.sh` therefore downloads the release named by `ZISK_TOOLCHAIN` in `PINS` (`zisk-4.0.0`), checks the archive against `ZISK_TOOLCHAIN_SHA256`, and gives it to the installer through `ZISK_TOOLCHAIN_SOURCE_DIR`. That toolchain builds the same guest ELF and gives the same programVK as the earlier builds. Moving to another toolchain release is a change to those two lines of `PINS`, and the guest is rebuilt and its programVK checked afterwards.

## The release files

ZisK's installer, `ziskup`, checks each key it downloads only against an md5 file that sits next to it in the same bucket, and it does not check the binaries. That finds a broken download, not a changed file. So `install.sh` downloads the three files itself (the release binaries `cargo_zisk_linux_amd64.tar.gz`, the proving key and the PLONK key), checks each against its SHA-256 in `PINS` (`ZISK_RELEASE_SHA256`, `ZISK_STARK_SETUP_SHA256`, `ZISK_PLONK_SETUP_SHA256`), and only then lets `ziskup` install them, from a copy of `ziskup` whose two download addresses point at the folder that holds them (`zisk-artifacts.sh`; `tests/zisk-artifacts.sh` checks that the copy differs from the pinned `ziskup` in those two lines and nothing else). After the install it checks every file the two keys unpacked against `zisk-<version>-keys.sha256`, a list taken from the checked tarballs; the files ZisK generates next to them later, such as the constant trees, are not in it.

`ZISK_ARTIFACTS_DIR` names a folder for the three files. A file already there with the pinned checksum is used without a download, so a kept copy installs without ZisK's servers; files with another checksum are downloaded again and checked. Without it they go to a folder under the prover state and are deleted after the install. The keys are about 5 GB and 22 GB, and `ziskup` copies each once more before it unpacks it.

The powers-of-tau file the PLONK key is built on is pinned too (`ZISK_PTAU_BLAKE2B`, the blake2b-512 that snarkjs's README publishes, and `ZISK_PTAU_SHA256`), for rebuilding a PLONK key; `install.sh` does not download it. The addresses in ZisK's docs answer 403; `https://circom.info/powersOfTau28_hez_final_24.ptau` serves it.

## The wrapped proof

1,344 bytes: the PLONK proof (768), the programVK (32), rootC (32) and the public values (512), one after the other. `prove-one.sh` writes them as `wrapped-proof.hex` and as the JSON that `cargo-zisk-dev export-solidity-calldata` makes.

## Why `make-input.sh` is not zisk-eth-client's `input-gen`

`input-gen` reads a block from an RPC node over HTTP and refuses any chain it does not know. Ours is not one of them, and reth's debug API is not on our HTTP port. `make-input.sh` builds a small program against the same input code at the same pinned commit and gives it the block, the witness and the chain config as files.

## Fixtures

`fixtures/` holds a one-transfer block's GPU proof and its recorded details (see `session.txt`). This is public data. `tests/fixtures.sh` checks its consistency.

## The ZisK release

`PINS` pins ZisK 1.3.2-alpha. It fixes the soundness advisory GHSA-3j5v-j2rm-9c5f of 1.3.1-alpha (see [SECURITY.md](../SECURITY.md)), and a prover must not run 1.3.1 for a new chain. The fixture is the proof of our guest built and proven under 1.3.2, and `session.txt` records its program key and root. It also keeps `previous_programVK` and `previous_rootC` (the guest that stopped at Prague, under 1.3.1, which the recorded demo results ran) and `zisk_1_3_1_programVK`, the key this guest has when it is built for 1.3.1, which is the key of blocks a chain proved under 1.3.1. A new chain's sidecars and explorer are pinned to the keys in `session.txt` and to ZisK 1.3.2.
