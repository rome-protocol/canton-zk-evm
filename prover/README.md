# prover

Scripts that run the ZisK prover for this guest on the GPU machine. Machine hosting, creation and deletion are outside this repository's scope. `ZISK_COORDINATOR_URL` selects the coordinator and defaults to the one on the same machine.

The supplied installer targets Linux x86-64 with `apt`, `sudo`, an installed NVIDIA driver and about 100 GB of free disk. It installs system packages and changes memory-lock limits. See [docs/METRICS.md](../docs/METRICS.md#the-machine) for the tested hardware and memory measurements. Minimum GPU memory for the whole prover is not established here.

| Script | What it does |
|---|---|
| `install.sh` | Installs the ZisK release in `PINS` (GPU build), its proving key and the PLONK setup. It checks the installer against the checksum in `PINS` before running it. |
| `build-guest.sh` | Copies the guest sources into one fixed folder (`/tmp/cze-guest-build`), builds the guest ELF there, and prints its SHA-256, programVK, rootC and the rules hash. The folder you run it from does not change the ELF: two fresh checkouts gave the same programVK on real ZisK (see `guest/README.md`). It stops if the ELF still holds a build path. `guest-env.sh` has what it uses for that. Run one build at a time: the folder is emptied at the start of each. |
| `start.sh` | Starts the coordinator and one GPU worker with the PLONK key loaded, and leaves them running. |
| `prove-one.sh` | Proves one input, verifies the proof with `cargo-zisk`, and writes the 1,344-byte wrapped proof as hex. |
| `make-block.py` | Makes one block with one transfer on a temporary copy of the chain, through reth's testing and Engine APIs, and saves the block and its execution witness. |
| `make-input.sh` | Turns that block, its witness and the genesis into the prover input, using zisk-eth-client's own input code. |

## The wrapped proof

1,344 bytes: the PLONK proof (768), the programVK (32), rootC (32) and the public values (512), one after the other. `prove-one.sh` writes them as `wrapped-proof.hex` and as the JSON that `cargo-zisk-dev export-solidity-calldata` makes.

## Why `make-input.sh` is not zisk-eth-client's `input-gen`

`input-gen` reads a block from an RPC node over HTTP and refuses any chain it does not know. Ours is not one of them, and reth's debug API is not on our HTTP port. `make-input.sh` builds a small program against the same input code at the same pinned commit and gives it the block, the witness and the chain config as files.

## Fixtures

`fixtures/` holds a one-transfer block's GPU proof and its recorded details (see `session.txt`). This is public data. `tests/fixtures.sh` checks its consistency.
