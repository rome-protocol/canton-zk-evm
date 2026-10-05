# canton-zk-evm

Ostia, a Canton zkEVM (chain id 770101), is an EVM chain whose blocks are ordered by Canton and proven by a zero-knowledge virtual machine, so that an EVM transaction and a Daml action can settle together in one Canton transaction.

Every EVM block becomes one Canton transaction, and only once it is proven. That transaction carries the block, its proof and any attached Daml actions. Canton's confirmers check the proof. Daml checks that the block follows the chain's current head. The block and its attached actions commit together, or neither does. If an allocation is gone when the builder checks, it leaves out that leg and the block can commit without it. If the allocation is withdrawn after that check, Canton refuses the submission. Blocks are made on demand. Each builder run builds, proves and submits one block. Speed and throughput are not goals yet. See [docs/DESIGN.md](docs/DESIGN.md) for the design and [docs/METRICS.md](docs/METRICS.md) for measurements, hardware and versions.

## Status

Ostia is an early release. It runs on a local test network that keeps no state between runs, with one builder, one operator and one confirmer. This code and ZisK 1.3.1-alpha are not yet audited. tROME is a test coin with no value. Do not use Ostia for anything of value.

The repository also has a local Canton network, a settlement demo that runs on it, and a block explorer with a tROME faucet and an in-browser proof check. The demo (`demo/`) ran on a GPU on 2026-10-04. A rehearsal also runs in CI without a GPU.

The guest and prover proved the first block on a GPU: one plain transfer on this chain. ZisK's own verifier and the verifier crate both checked the proof.

Network: on one machine with a GPU, the builder made one empty block, the prover proved it, `Advance` committed it on a local Canton with the real external call, the chain's head moved to 1 and reth marked the block final. The facts are in [demo/results/smoke.txt](demo/results/smoke.txt). The Canton and the Daml compiler are 3.6 snapshots, because no release has the external call yet; [network/README.md](network/README.md) says which, and how they are pinned. It ran on 2026-10-04, after `up.sh` had checked that the guest it built has the recorded program key.

Both demo runs passed their checks on 2026-10-04, from this repository's first commit, `c6d81619c05ad8efa76cd0345178f01410a3dac9` (the results files record it under an earlier id; see [demo/README.md](demo/README.md#results)), on one machine with one NVIDIA RTX PRO 6000 GPU. A leg settles only if the holder's balance rose by exactly the expected amount in the proven block. See [demo/README.md](demo/README.md#results) for the tests and the recorded runs. In run 1, V's 10-TKA transfer was proven and committed in block 3. In the same Canton update, U's 10-TKB allocation became V's holding (U 90 TKB, V 10 TKB; U 10 TKA, V 990 TKA). In run 2, one hex digit of the proof was flipped. Canton refused `Advance` with the sidecar's answer "no the proof does not verify". Nothing moved on Canton and reth went back to block 3. This used one local network, one operator, test tokens and keys made for the run; Ostia does not yet run as a standing network. The results, proof and versions are in [demo/results/](demo/results/).

## Layout

| Folder | What it holds |
|---|---|
| `network/` | The reth launch (peer discovery always off), the genesis, the local Canton network, the scripts that start it all and the smoke test |
| `tests/` | Tests that run in CI |
| `docs/` | The design, and what was measured on which machine ([METRICS.md](docs/METRICS.md)) |
| `verifier/` | Checks the wrapped proof in plain Rust |
| `mpt/` | Checks a value in the proven EVM state |
| `guest/` | The EVM program that gets proven, with this chain's rules built in |
| `prover/` | Scripts to run the prover, and the first proof |
| `sidecar/` | The service beside each Canton confirmer |
| `daml/` | The chain record, the block record and the terms of a Daml action |
| `builder/` | Makes a block, gets it proven, submits it to Canton |
| `explorer/` | A block explorer for Ostia, with a tROME faucet and an in-browser proof check (see [explorer/README.md](explorer/README.md)) |
| `demo/` | The first proof: one good block with a DvP leg, one tampered proof (run on a GPU on 2026-10-04; `results/` holds both runs and the smoke test) |

`PINS` lists the exact versions and image digests everything is built against.

## Running the tests

You need Docker, `bash`, `curl`, `jq`, `openssl` and Python 3. The Canton integration tests require Linux x86-64 and Java 21. The demo rehearsal also needs Python 3.12 or newer and Rust. The Rust tests use the toolchain in `rust-toolchain.toml`. Explorer tests need Node 22.18 or newer. `PINS` separates the prover's Node 20.20.2 (`NODE_VERSION`, for snarkjs) from the explorer's Node 24 image (`EXPLORER_NODE_IMAGE`).

```sh
tests/static.sh                  # pins and genesis agree
tests/refuses_missing_flag.sh    # the reth launch refuses a missing or wrong discovery flag, or a forbidden option
tests/udp_control.sh             # the UDP check fails on a container with a UDP listener (no reth)
tests/discovery.sh               # starts the pinned reth, checks it has no peers, stops it
tests/fixtures.sh                # the recorded proof is consistent (needs no GPU)
tests/network_static.sh          # reth only through launch.sh, the Canton config, the recorded smoke result
tests/network_checks.sh          # the compiler pin check, the DAR's id, the stop on another programVK (no GPU)
tests/canton_network.sh          # the pinned Canton, the real Daml package and one Advance (Linux x86-64, Java 21, Python 3; no GPU)
tests/guest-repro.sh             # the guest build runs in one fixed folder, so the source folder does not change the ELF (stand-ins for the ZisK tools; the same check on real ZisK passed on 2026-10-04, see guest/README.md)
tests/demo_static.sh             # the demo's pins, tamper switch and genesis override, and its recorded results (no GPU)
tests/demo_rehearsal.sh          # the demo and explorer with a stand-in proof (Linux x86-64, Docker, Java 21, Rust, Python 3.12+; no GPU)
tests/demo_explorer_static.sh    # the explorer's images are pinned, and what its container is given (no Docker)
(cd explorer && npm ci && npm test)  # the explorer's tests, against fakes (Node 22.18+; CI uses EXPLORER_NODE_IMAGE in PINS)
(cd guest/rules && cargo test)   # the chain rules and their hash (needs Rust)
```

Settings such as ports and the state folder come from environment variables; see the top of `network/reth/launch.sh`. The Engine JWT secret is generated per run into `state/`, which git ignores.

## Licence

Copyright © 2026 Coin Vesting Inc. d/b/a Rome Protocol. All rights reserved. See [LICENSE](LICENSE): personal, non-commercial use only; any commercial use needs Rome Protocol's written permission. Third-party parts keep their own licences; [NOTICE](NOTICE) lists them.
