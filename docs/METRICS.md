# What was measured, and on what

This page records test results, hardware and software versions for Ostia, a Canton zkEVM (chain id 770101). Every number comes from a file in this repository or from the benchmark run named below. Missing information is marked "not recorded".

Two sets of measurements are reported:

- **The prover benchmark** (2026-10-03). ZisK 1.3.1-alpha proving blocks of three sizes. It used the unmodified reth guest that ships with zisk-eth-client v0.13.1, not this repository's guest, which adds a check of the chain's rules. Its raw logs are not in this repository.
- **The first proof on this chain** (2026-10-04). This repository's own guest, on the local Canton network, from the files in [`demo/results/`](../demo/results/) and [`prover/fixtures/session.txt`](../prover/fixtures/session.txt).

## The machine

Both sets ran on a machine with one NVIDIA RTX PRO 6000 GPU. The benchmark's machine is described below; for the first proof only the GPU and the driver were recorded.

| | Prover benchmark, 2026-10-03 | First proof on this chain, 2026-10-04 |
|---|---|---|
| CPU | AMD EPYC 9B45, 48 vCPUs (1 socket, 2 threads per core) | not recorded |
| RAM | 176 GiB as the machine reported it | not recorded |
| GPU | 1 x NVIDIA RTX PRO 6000 Blackwell Server Edition, 97,887 MiB (96 GB), PCIe gen 5 x16 | NVIDIA RTX PRO 6000 Blackwell Server Edition (the 96 GB figure is not in the results files) |
| Driver | 580.178.04 | 580.178.04 |
| CUDA | 13.0, at the driver level; ZisK's prebuilt GPU binaries were used and no CUDA toolkit was installed | not recorded |
| Operating system | Ubuntu 22.04.5, 500 GB boot disk | not recorded |
| Also installed | Node 20.18.0 and snarkjs 0.7.6 (ZisK's verify command runs snarkjs to check the wrapped proof) | not recorded |

The GPU and driver are written into every results file of the first proof. Nothing else about its hardware was recorded.

Everything else in this repository's tests runs on GitHub-hosted runners with no GPU. See "What CI runs" below.

## Software versions

The scripts read most of these versions from [`PINS`](../PINS), and CI checks them. The last column says where each row comes from. The first-proof results files record `canton`, `daml_sdk`, `zisk` and `reth` versions that match `PINS`.

| What | Version | Source |
|---|---|---|
| ZisK | 1.3.1-alpha, commit `306a9c934ba4947b1d586d69b67120f8b4c41466` | `PINS` |
| zisk-eth-client (the source of the guest) | 0.13.1, commit `edf8adcda75c015f4225abe3aabb3bed03e21beb` | `PINS` |
| reth | 2.5.2 | `PINS` |
| Canton | 3.6.0-snapshot.20260930.20337.0.ve610bc8f (a snapshot; no release has the external call yet) | `PINS` |
| Daml SDK | 3.5.13-snapshot.20261001.145.0.v852bdd82, from the weekly snapshot `weekly-snapshot-3.6.0-snapshot.20261001` | `PINS` |
| Daml compiler | 3.6.0-snapshot.20260915.14804.0.v53478765, building to Daml-LF 2.4 | `PINS` |
| Daml SDK (Daml Script tests) | 3.5.12, building the stub form to Daml-LF 2.1 | `daml/daml.yaml`; `.github/workflows/daml.yml` |
| Java | 21 | `PINS` (`JAVA_MAJOR`) |
| Rust | 1.94.1 | `rust-toolchain.toml` |
| Python | 3.12 or newer for the builder and the demo | [`demo/README.md`](../demo/README.md); `demo/prepare.sh` stops on an older one |
| Prover Node, snarkjs | 20.20.2 and 0.7.6. The benchmark machine had Node 20.18.0 | `PINS` (`NODE_VERSION`, `SNARKJS_VERSION`); the benchmark for 20.18.0 |
| Explorer Node | 22.18 or newer locally; the container and CI use Node 24 | `explorer/package.json`; `PINS` (`EXPLORER_NODE_IMAGE`) |
| solc (the demo's test token) | 0.8.28 | `PINS` |
| Chain id | 770101 | `PINS` |

The guest of the first proof has this ELF SHA-256: `44f76af2c17311b41fab46f6c6af4af0af6c767a8da81f7a9554aa7bb848bfbf`. Its programVK is `0xdb79251d9e962ee45fbc28cc6431a7fb894106f06d6664e623189f28c24f6d3f`. The results files were written from source commit `99b2c17161d099cf9f37ccc2e1c082511d8d6ef1`. That commit is from this code's history before the repository was published, so it is not in this repository.

The recorded GPU runs used an earlier version whose leg condition was a balance the holder had to reach. The current rule requires the holder's balance to rise by exactly the expected amount in this block. The Daml tests and the CI rehearsal with a stand-in proof check that rule; it has not had a GPU run. See [demo/README.md](../demo/README.md#results) for the tests. The recorded DAR hash and package id describe the earlier Daml package, not a build of the current one. `network/up.sh` checks each guest build against the recorded programVK, rootC and rules hash before starting the network.

## The prover benchmark

**Date:** 2026-10-03. **What was proven:** blocks of plain transfers, in three sizes: 1 transfer (21 kgas), 1,000 transfers (21 Mgas) and 5,000 transfers (105 Mgas). **Prover:** ZisK 1.3.1-alpha on the machine above, with the PLONK wrap, which turns the large proof into the 1,344-byte one that Canton checks. Each time below is the median of three warm runs, in seconds. Every proof was checked with `cargo-zisk verify` afterwards, and every check passed.

Two ways of running the prover were compared:

- **A prover that stays running.** The coordinator and GPU worker start once and keep their keys loaded while serving blocks. This is how this chain runs the prover.
- **A fresh process for every proof.** Each proof includes the time to start and stop the prover.

| Block | Proof without the wrap, fresh process | The wrap alone, fresh process | Proof with the wrap, fresh process | Whole fresh process, start to finish | **Prover that stays running: input to wrapped proof** | Same, with the check (input to verified proof) |
|---|---|---|---|---|---|---|
| 1 transfer (21 kgas) | 4.6 | 2.4 | 7.4 | 21.1 | **6.7** | **7.0** |
| 1,000 transfers (21 Mgas) | 6.9 | 2.4 | 9.6 | 24.5 | **9.0** | **9.3** |
| 5,000 transfers (105 Mgas) | 17.9 | 2.4 | 20.8 | 34.9 | **21.2** | **21.5** |

A fresh process adds about 14 seconds to every proof: starting the prover, starting its emulator services, loading the PLONK key and shutting down. A prover that stays running pays that once.

**Proof size and check time** (the same for every block size):

| | Wrapped (PLONK) | Without the wrap (STARK) |
|---|---|---|
| Proof file | 2,942 to 2,944 bytes | 415,232 to 415,234 bytes |
| Check with `cargo-zisk verify` | 0.29 to 0.30 s | 0.03 s |
| On the wire | 1,344 bytes: proof 768, program key 32, recursion root 32, public values 512 | not measured |

The 0.29 second check includes starting Node, because ZisK's verify command runs snarkjs for the wrapped proof. The sidecar's native check has not been timed. Its WebAssembly build took 8 to 32 ms in Node on CI runners for verifying a proof and rejecting a mismatched header (see "What is not measured yet").

**Where the time goes** for a prover that stays running (worker log, seconds, medians):

| Block | Run the guest | Reload of constant data after the wrap | Commit to the trace | Inner STARK proofs | PLONK wrap | Total |
|---|---|---|---|---|---|---|
| 1 transfer | 0.006 | 0.64 | 0.6 | 3.6 | 1.7 | 6.7 |
| 1,000 transfers | 0.43 | 0.86 | 0.9 | 5.0 | 1.7 | 9.0 |
| 5,000 transfers | 2.1 | 1.37 | 2.8 | 13.1 | 1.7 | 21.2 |

The wrap takes 1.7 s in the running prover. It forces a reload of constant data before the next proof, most likely because the wrap pushes that data out of GPU memory. Including the reload, the wrap takes about 2.3 s of the 6.7 s at one transfer and about 3.1 s of the 21.2 s at 5,000 transfers. The total time is about 6.4 s plus 0.14 s per Mgas (a straight-line fit through the three sizes). Nothing above 105 Mgas was measured.

**Starting up** (ZisK 1.3.1-alpha):

- The very first run, in which only ZisK's cache was deleted and the page cache dropped (the proving key stayed on disk), took 123 s of wall time for the 1-transfer block. The proof itself was 14.5 s of that. 78.9 s went to a one-time setup of the guest, 16.8 s to reading the proving key from disk, and 5.1 s to starting the emulator services.
- A prover that stays running had all its keys loaded 7.0 s after it was launched. Registering the program with it took another 9.5 s, so the first proof could start about 16.5 s after launch. This assumes the guest's compiled cache already existed. The first request took 6.56 s, the same as the later ones.

**Memory** (ZisK 1.3.1-alpha; GiB, as reported by the machine):

| | |
|---|---|
| GPU memory in use, peak by `nvidia-smi` | 93.2 GiB |
| Host RAM, rise over idle, during a fresh-process proof | 27 to 29 GiB, plus 22.9 GiB of shared memory for the emulator |
| Host RAM, rise over idle, while a running prover serves requests | 3 GiB, plus 22.9 GiB of shared memory |
| GPU memory the PLONK wrap needs on its own | 30,054,767,337 bytes (about 28.0 GiB), from the prover's log line `Final snark prover GPU requirement` |

The GPU peak says little about what is required: the prover takes one large buffer sized to the card, so the reading is about the same for a 1-transfer block and a 5,000-transfer block.

**The older release, ZisK 1.2.0-alpha,** was measured as a baseline on the same machine and the same blocks. The guest it used was the one from zisk-eth-client v0.12.0, not v0.13.1. A fresh process took 6.0, 9.2 and 23.8 s for the proof with the wrap, and 18.4, 21.8 and 36.9 s for the whole process, for the three block sizes. A prover that stays running could not produce a wrapped proof at all: each request failed to wrap and returned the 414 KB STARK proof, with the error `Failed to wrap Plonk proof ... Error generating witness for instance id 0 [0:0] of type RecursiveF` in the worker log. 1.3.1-alpha is the release this repository uses. Its authors mark it as still in security and correctness audit.

## The first proof on this chain

These results come from [`demo/results/`](../demo/results/) and [`prover/fixtures/session.txt`](../prover/fixtures/session.txt). Each test ran once on 2026-10-04 on the local Canton network, with the prover already running. These are individual test results, not a benchmark.

The demo used an earlier leg condition: a balance the holder had to reach. It does not validate the current rule that the holder's balance rose by exactly the expected amount in this block. That rule is checked by the Daml tests and the CI rehearsal with a stand-in proof, not yet by a GPU run. [demo/README.md](../demo/README.md#results) names the tests.

| | Smoke test | Run 1, the good block | Run 2, the tampered proof |
|---|---|---|---|
| Source | `smoke.txt` | `run1.txt` | `run2.txt` |
| Time of the record (UTC) | 01:36:46 | 01:37:16 | 01:37:26 |
| Block | 1, empty | 3, one transfer of 10 TKA | 4, one transfer, built and proven but not committed |
| Gas used | 0 | 51,698 | not recorded |
| Proof time | 6.34 s | 6.66 s | 6.72 s |
| Proof size | 1,344 bytes | 1,344 bytes (`run1-proof.hex`) | 1,344 bytes, then one hex digit (byte 100) changed |
| From the finished proof file to the end of the builder's run | 0.57 s | 0.74 s | refused by Canton; not timed |
| The builder's whole run | 89.94 s | 8.08 s | 7.60 s |
| Outcome | Canton head 1; the block record was seen by the reader; reth marked the block final | Canton head 2 to 3 in the same update as V's new TKB holding; reth marked block 3 final | `Advance` refused with "the sidecar refused the block: no the proof does not verify"; head stayed at 3; reth went back to block 3 |

The time "from the finished proof file to the end of the builder's run" includes assembling the Daml legs (the builder's Ledger reads and, for each leg, an `eth_getProof` call to reth), the `Advance` call, its commit on both confirmers, and reth marking the block final. It is therefore more than Canton's commit alone. The smoke test's full builder run also includes the witness, the input and the prover's one-time program setup, and, if the machine had not built the input tool before, that build as well. Separate times for these steps are not recorded.

**The first proof of a transfer** ([`session.txt`](../prover/fixtures/session.txt), recorded 2026-10-04): one plain transfer of 21,000 gas as block 1 on a throwaway copy of the genesis, 385,277 steps. The proof times were 6.33, 6.75 and 6.69 s. It was checked with ZisK's own verifier (`cargo-zisk`) and with the verifier crate in this repository. The same input with the chain id changed to 1 was refused by the guest with "Chain config is not this chain's", and the prover returned no proof.

**Setup times:**

- Building the guest with `prover/build-guest.sh` from an empty build folder, dependency download included: 125 s (`session.txt`). Two fresh checkouts gave 133 s and 126 s ([`guest/README.md`](../guest/README.md)). Both gave the same ELF and the same programVK.
- The prover's first setup of the program: 43 s (`session.txt`). This is a one-time cost on a prover.

The step count of 385,277 here is for this repository's guest and its own throwaway genesis. It should not be compared with the benchmark's step counts, which are for the upstream guest and different blocks.

## What CI runs

CI runs on GitHub-hosted `ubuntu-latest` runners. They have no GPU, so no proof is made or timed in CI. The WebAssembly tests print verification timings. The jobs are:

- **Secrets:** a gitleaks scan of the whole history.
- **Static checks:** shellcheck on the scripts; the pins and the genesis agree (`tests/static.sh`); the recorded smoke result and the demo results are complete and agree with each other.
- **reth:** the launch refuses a missing or wrong discovery flag; the pinned reth starts with no peers; the UDP check works.
- **Rust:** `cargo fmt`, `clippy` and `cargo test` for the verifier, `mpt/` and the sidecar; the chain rules' tests; a real proof taken from the project's own reth is checked by `mpt/`; the sidecar's tests run again on a fresh block and fresh balance proofs from reth.
- **The recorded proof:** `tests/fixtures.sh` checks that the recorded 1,344-byte proof is consistent with its facts. It does not make a proof.
- **The guest build:** `tests/guest-repro.sh` runs the real build script against stand-ins for the ZisK tools, to show that the build happens in one fixed folder. It does not show that a real ZisK build gives the same ELF; the run on 2026-10-04 did that once (see `guest/README.md`).
- **Daml:** `.github/workflows/daml.yml` checks the token-standard packages against their hashes. It builds the stub form with Daml SDK 3.5.12 from `daml/daml.yaml` and runs the Daml Script tests.
- **Canton:** the Canton job in `.github/workflows/network.yml` builds the external form with the pinned 3.6 snapshot compiler. It starts the pinned Canton with that package. One `Advance` is committed and one refused, against a stand-in for the sidecars.
- **Builder:** its tests, on Python 3.12.
- **Explorer:** `.github/workflows/explorer.yml` runs type-checks, tests against fakes and the pages' build in `EXPLORER_NODE_IMAGE`. Its `ledger-api` job checks the explorer's requests against the pinned Canton's OpenAPI document. Its `verify-wasm` job checks shared crate versions against the sidecar's lockfile, runs Rust formatting, lint and tests, and builds the Verify module for WebAssembly. It tests the built module through the loader and panel in Node and checks that the pages' build serves it.
- **Demo checks:** the `checks` job in `.github/workflows/demo.yml` runs shellcheck, `tests/demo_static.sh` and `tests/demo_explorer_static.sh`. It tests the EVM side against a fake reth, the Canton helpers, the sidecar stand-in and the request logger. The `token` job checks that the pinned solc rebuilds `demo/TKA.bin` from `demo/TKA.sol`.
- **The demo's rehearsal:** the whole demo without a GPU, using a stand-in for the proof. It runs the real reth, Canton, token standard, builder and sidecar balance check, and runs the explorer beside the chain. It checks the block page, Verify's rejection of the stand-in proof, the tROME faucet and the explorer's requests. It does not prove a block or check a real proof.

## What is not measured yet

- **A systematic benchmark of contract calls or precompiles.** The benchmark blocks are plain transfers. The demo records one ERC-20 transfer. The cost per gas depends on the mix of work, so the plain-transfer figures do not establish the cost of contract calls.
- **Blocks above 105 Mgas**, or the benchmark's sizes with this repository's guest (the one with the chain-rules check). The benchmark used the upstream guest.
- **More than one block in flight,** and more than one GPU. The benchmark sent one request at a time to a free GPU.
- **Building the witness from the chain.** The benchmark's "input to proof" starts from a witness file that already exists. On this chain, building the witness on a warm machine has not been timed on its own.
- **The sidecar's proof check run natively.** Native verification latency has not been measured. The WebAssembly build took 8 to 32 ms in Node on CI runners for verifying the proof and rejecting a mismatched header. That is not a successful full-block check or a browser measurement; see [explorer/verify/README.md](../explorer/verify/README.md).
- **Canton's commit of a large block.** The commits above are for an empty block and a block with one transfer.
- **Repeat runs of the first proof.** Each run was done once, on one machine, with one operator and one builder. There is no spread to report.
- **The hardware of the first proof's machine beyond the GPU and driver** (CPU model, RAM, operating system), and which Node it used.
- **ZisK's hints build.** The build did not complete, so no performance measurements are available. The cause has not been established.
- **Another machine or user building the guest.** Whether they get the same ELF is only confirmed by reproducing the recorded programVK there.
