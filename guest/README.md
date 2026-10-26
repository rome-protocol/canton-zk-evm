# guest

The EVM program that gets proven: a stateless reth block validator for the ZisK zkVM.

## Where it comes from

This is a copy of part of [zisk-eth-client](https://github.com/0xPolygonHermez/zisk-eth-client), tag `v0.13.1` (commit `edf8adcda75c015f4225abe3aabb3bed03e21beb`, the one in `PINS`). Upstream's code here is licensed under Apache-2.0 or MIT, at your option; the two licence files, `LICENSE-APACHE` and `LICENSE-MIT`, are upstream's and stay with the code. `rules/`, `fixtures/`, this README, the trimmed `Cargo.toml`, the two changes marked `canton-zk-evm change` and the two added lockfile entries are Rome Protocol's, under the repository's [LICENSE](../LICENSE); see [NOTICE](../NOTICE).

Only what is needed to build the reth guest is here:

| Path here | Same path upstream |
|---|---|
| `bin/guests/stateless-validator-reth/` (without its ELF and test inputs) | the same |
| `crates/clients/reth/guest/` | the same |
| `crates/common/guest-common/` | the same |
| `Cargo.toml` | the workspace `Cargo.toml`, cut down to those crates and the dependencies they use |

## What was changed

The chain-rules check has two marked changes, each labelled `canton-zk-evm change` in the code:

- `crates/clients/reth/guest/src/run.rs` calls `cze_rules::check` right after it reads the chain config from the input, and the guest stops with an error if the config is not this chain's.
- `crates/clients/reth/guest/Cargo.toml` adds the `cze-rules` dependency.

The lockfile `bin/guests/stateless-validator-reth/Cargo.lock` is changed too: it has two entries that upstream's does not, the `cze-rules` package and the `cze-rules` line in the reth guest's dependencies. The file carries no marking of its own; this README and [NOTICE](../NOTICE) record the change.

Upstream's guest accepts the chain config supplied in the input. This guest accepts only chain id 770101 with every fork from genesis up to Osaka, the `config` of the genesis file it was built from (default `network/genesis.json`). The check is part of the program, so the programVK identifies a program that rejects blocks under any other rules.

The copy leaves out upstream's `.cargo/config.toml`, and with it the `rustflags` that file sets. So the ELF is built with only the flags `cargo-zisk build` adds itself, plus the path mappings described under "Building". Building it with upstream's flags would give a different ELF and a different programVK.

## The rules

`rules/` is the small crate that holds the chain config and the check. It builds and tests on its own (`cd rules && cargo test`), with none of the guest's dependencies.

Any edit to `network/genesis.json` changes the programVK. The genesis starts Osaka at time 0 (`osakaTime`, with an `osaka` entry in `blobSchedule` that has Prague's values), so a new chain runs Osaka from its first block; Osaka adds no field to the genesis header, so the genesis block hash is the one the Prague-only file gave.

A chain that starts Osaka at a later time T builds its own guest: `prover/build-guest.sh path/to/genesis.json` copies that file in place of `network/genesis.json`, builds from it and prints that guest's programVK and rulesHash. With no argument it uses `network/genesis.json`. Once a programVK is published, treat that file as fixed.

**rulesHash** is the SHA-256 of the canonical encoding of the chain config: the config as JSON written by `alloy-genesis`, with the keys of every object in byte order and no spaces. `guest/fixtures/rules-hash.txt` records it. `prover/build-guest.sh` prints it next to the ELF's SHA-256, programVK and rootC.

## Building

`prover/build-guest.sh` builds the guest ELF with the ZisK toolchain. The supplied installer, `prover/install.sh`, targets Linux x86-64 with `apt`, `sudo`, an installed NVIDIA driver and about 100 GB of free disk. It installs system packages and changes memory-lock limits. See [docs/METRICS.md](../docs/METRICS.md#the-machine) for the tested hardware and memory measurements. Minimum GPU memory for the whole prover is not established here.

### The build runs in one fixed folder

The programVK identifies the ELF. Reproducing the key requires an identical ELF. In a plain build, rustc embeds the paths it sees in the ELF. Cargo also hashes each path dependency's absolute path into the crate's metadata; `--remap-path-prefix` does not change that hash. Building the same sources in different folders can therefore produce different ELFs and programVKs.

`prover/build-guest.sh` builds in a fixed folder with these steps:

- empties `/tmp/cze-guest-build` and copies `guest/` (without any `target` folder) and the genesis file into it, keeping their layout, because the rules crate includes the genesis file by a relative path (as `network/genesis.json`; the file is the repository's, or the one named on the command line, see below);
- builds there, with `CARGO_HOME` and `CARGO_TARGET_DIR` set to folders inside it;
- drops the compiler settings of the caller (`RUSTFLAGS`, `CARGO_ENCODED_RUSTFLAGS`, `CARGO_BUILD_RUSTFLAGS`, `CARGO_TARGET_*_RUSTFLAGS`, `CARGO_PROFILE_*`, `CARGO_TARGET_DIR`), which would change the ELF;
- passes `--remap-path-prefix` for the build folders, `RUSTUP_HOME`, the ZisK folder and the home folder, so rustc writes fixed names (`/build/src`, `/build/cargo` and so on) in their place;
- stops, without printing a programVK, if the build changed `Cargo.lock`, or if the finished ELF still mentions one of those folders or the source folder.

The check on the ELF is there because a remapping covers the paths rustc writes itself, not every way a crate can embed a path (`env!("CARGO_MANIFEST_DIR")`, for one). It only finds a build path that is written into the ELF; a difference that leaves no path in it passes the check. Run one build at a time, because they share the folder.

**Confirmed on real ZisK.** On 2026-10-04 two fresh checkouts of the same commit at different source paths were built sequentially under one user on one GPU machine, each with its own prover state folder, for the guest that stopped at Prague. Both produced the same programVK and a byte-identical ELF; rootC and the rules hash matched, and the builds took 133 s and 126 s. On 2026-10-26 the guest with Osaka from genesis was built the same way on a fresh machine from a fresh clone, and gave programVK `0xdbe132ed93824452dc2466618977d8825653b829576a384f1b6e4367bca00688`, the one recorded for it earlier, with a byte-identical ELF (SHA-256 `bf067676867a5b6b6d26ee11087c256dcab3b8bb968333393c235a1b7f626011`) and rootC `0xc3f12b9f8707c6a1e96df2bf6702c2ebdfbafedabeac654644a380befe091ac4`. On real ZisK, `cargo-zisk build` writes the ELF under the package's own `target` folder, outside `CARGO_TARGET_DIR`; the script finds it there. Reproducibility for another user or machine requires reproducing the recorded programVK there.

**The record in `prover/fixtures/session.txt` is from this build.** It contains the programVK, the ELF's SHA-256, rootC, the rules hash and a one-transfer block's proof and details, recorded on 2026-10-26. The block was made on a local chain that runs Osaka from genesis, and its proof was checked with `cargo-zisk`. A second block on such a chain, holding a P256VERIFY call (`0x100`), the CLZ opcode and modexp calls on both sides of the 1,024-byte limit, was also proved and checked. The guest refuses an input whose chain config is another chain id, or the same chain without `osakaTime`.

`tests/guest-repro.sh` runs the real script against stand-ins for the ZisK tools. It shows that the script builds in the fixed folder on a fresh copy of the sources, with fixed `CARGO_HOME` and `CARGO_TARGET_DIR`, and that with those stand-ins three different source folders give the same ELF. It cannot show that a real ZisK build does the same.
