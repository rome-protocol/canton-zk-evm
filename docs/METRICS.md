# What was measured, and on what

This page records test results, hardware and software versions for Ostia, a Canton zkEVM (chain id 770101). Every number comes from a file in this repository, from the benchmark run named below, from the notes of the 2026-10-25 runs (their logs are not in this repository), from the reference-machine measurement described under "The indexer on a real chain (W1)", or from the CI run or laptop measurement named beside it. Missing information is marked "not recorded".

Five sets of measurements are reported:

- **The prover benchmark** (2026-10-03). ZisK 1.3.1-alpha proving blocks of three sizes. It used the unmodified reth guest that ships with zisk-eth-client v0.13.1, not this repository's guest, which adds a check of the chain's rules. Its raw logs are not in this repository.
- **The largest block the prover was given** (2026-10-25). Blocks of plain transfers up to 62,500 transfers, on a temporary benchmark machine, with this repository's guest at v0.1.0. None of these blocks was committed to Canton. The raw logs are not in this repository.
- **DevNet throughput** (2026-10-25). Plain-transfer and mixed load on Ostia DevNet, before and after Daml package 0.2.0 and the change to how the builder fills a block, with one block in flight and one prover. The raw logs and driver output are not in this repository; the figures come from the notes of those runs.
- **DevNet throughput** (2026-10-26 and 27). Plain-transfer bursts and sustained load on Ostia DevNet with pipelining depth 3 on two GPU provers, at the 30,000,000 and 60,000,000 gas caps.
- **The runs on this chain** (2026-10-05). This repository's own guest, on the local Canton network, with the gateway: a smoke test, a setup block and five runs, from the files in [`demo/results/`](../demo/results/). The one-transfer proof of 2026-10-04 is in [`prover/fixtures/session.txt`](../prover/fixtures/session.txt).

## The machine

The 2026-10-03 benchmark and the 2026-10-05 runs used one NVIDIA RTX PRO 6000 GPU (the benchmark's machine is described below; for the runs only the GPU and driver were recorded); the 2026-10-25 benchmark machine has its own section, the DevNet runs of 2026-10-25 used one prover on one RTX PRO 6000, and those of 2026-10-26 and 27 used two spot GPU provers (see "DevNet throughput, 2026-10-26 and 27").

| | Prover benchmark, 2026-10-03 | Runs on this chain, 2026-10-05 |
|---|---|---|
| CPU | AMD EPYC 9B45, 48 vCPUs (1 socket, 2 threads per core) | not recorded |
| RAM | 176 GiB as the machine reported it | not recorded |
| GPU | 1 x NVIDIA RTX PRO 6000 Blackwell Server Edition, 97,887 MiB (96 GB), PCIe gen 5 x16 | NVIDIA RTX PRO 6000 Blackwell Server Edition (the 96 GB figure is not in the results files) |
| Driver | 580.178.04 | 580.178.04 |
| CUDA | 13.0, at the driver level; ZisK's prebuilt GPU binaries were used and no CUDA toolkit was installed | not recorded |
| Operating system | Ubuntu 22.04.5, 500 GB boot disk | not recorded |
| Also installed | Node 20.18.0 and snarkjs 0.7.6 (ZisK's verify command runs snarkjs to check the wrapped proof) | not recorded |

The GPU and driver are written into the results files of the runs. Nothing else about their hardware was recorded. The indexer's reference machine, used for W1's budgets, is another host; its hardware was not recorded either.

Everything else in this repository's tests runs on GitHub-hosted runners with no GPU, except the reference-machine measurement of W1 (see "The indexer on a real chain (W1)"). See "What CI runs" below.

## Software versions

The scripts read most of these versions from [`PINS`](../PINS), and CI checks them. The last column says where each row comes from. The results files record `canton`, `daml_sdk`, `zisk` and `reth` versions that match `PINS`.

| What | Version | Source |
|---|---|---|
| ZisK | 1.3.1-alpha, commit `306a9c934ba4947b1d586d69b67120f8b4c41466` (the release the benchmark and the 2026-10-25 runs used; `PINS` now pins 1.3.2-alpha, commit `1e22630bb7e143c30705a1603ed87cfd3da8c6ec`, and DevNet has proved under it since block 15573 on 2026-10-27 at 12:02 UTC; the proof times of 18 to 22 s per full 60,000,000-gas block in "DevNet throughput, 2026-10-26 and 27" are under 1.3.2-alpha, and the benchmark itself was not run again on it) | `PINS` at the time |
| zisk-eth-client (the source of the guest) | 0.13.1, commit `edf8adcda75c015f4225abe3aabb3bed03e21beb` | `PINS` |
| reth | 2.5.2 | `PINS` |
| Canton | 3.6.3, the open-source release of 2026-10-20, as pinned for the local network and CI (the recorded runs used the snapshot 3.6.0-snapshot.20260930.20337.0.ve610bc8f). DevNet's validator runs Splice 0.9.4 with Canton 3.6.4 | `PINS`; DevNet |
| Daml SDK | 3.6.0, the release of 2026-10-08 (the recorded runs used 3.5.13-snapshot.20261001.145.0.v852bdd82) | `PINS` |
| Daml compiler | 3.6.2, building to Daml-LF 2.4 (the recorded runs used 3.6.0-snapshot.20260915.14804.0.v53478765) | `PINS` |
| Daml SDK (Daml Script tests) | 3.5.12, building the stub form to Daml-LF 2.1 | `daml/daml.yaml`; `.github/workflows/daml.yml` |
| Java | 21 | `PINS` (`JAVA_MAJOR`) |
| Rust | 1.94.1 | `rust-toolchain.toml` |
| Python | 3.12 or newer for the builder and the demo | [`demo/README.md`](../demo/README.md); `demo/prepare.sh` stops on an older one |
| Prover Node, snarkjs | 20.20.2 and 0.7.6. The benchmark machine had Node 20.18.0 | `PINS` (`NODE_VERSION`, `SNARKJS_VERSION`); the benchmark for 20.18.0 |
| Explorer Node | 22.18 or newer locally; the container and CI use Node 24 | `explorer/package.json`; `PINS` (`EXPLORER_NODE_IMAGE`) |
| solc (the demo's test token) | 0.8.28 | `PINS` |
| Chain id | 770101 | `PINS` |

The guest has this ELF SHA-256: `44f76af2c17311b41fab46f6c6af4af0af6c767a8da81f7a9554aa7bb848bfbf`. Its programVK is `0xdb79251d9e962ee45fbc28cc6431a7fb894106f06d6664e623189f28c24f6d3f`, and its rootC is `0xc3f12b9f8707c6a1e96df2bf6702c2ebdfbafedabeac654644a380befe091ac4`. They are the same as in the one-transfer proof of 2026-10-04: adding the gateway did not change the proven program. That is the guest that stopped at Prague; the guest that runs Osaka from genesis has another ELF and programVK, recorded in `prover/fixtures/session.txt`. The results files were written on 2026-10-05 from commit `6b445073163832e9023850f53678617d90dfc808` of this repository (6b44507). The DAR hash in them is `870324fdc31122b5a14340bbc3e92be934bf29fd0814f83b0d3aa8a56e2280c7` and the package id `ccd743bc3d2c8e0f59dc418d1180fa73e6c942314e6bc4245ab5e5b13ae42a10`; they identify the Daml package built from that commit. `network/up.sh` checks each guest build against the recorded programVK, rootC and rules hash before starting the network.

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

## The largest block the prover was given

**Date:** 2026-10-25, 03:35 to 04:35 UTC. **This is a benchmark machine, not Ostia DevNet.** A temporary spot machine with one NVIDIA RTX PRO 6000 Blackwell Server Edition GPU (96 GB, driver 580.178.04), an AMD EPYC 9B45 with 48 vCPUs and 176 GiB of RAM. It ran for one hour and was deleted. **Prover:** ZisK 1.3.1-alpha with the PLONK wrap, kept running, with this repository's guest at v0.1.0. **Blocks:** plain value transfers (21,000 gas and about 115 bytes each) on a throwaway reth with peer discovery off, whose gas limit was raised in that copy only. Every successful proof was checked with `cargo-zisk verify`. None of these blocks was committed to Canton: the last column is the size of the data a commit would carry.

| Transfers in the block | Gas | Proof time | Verified | Prover memory (host) at peak | `Advance` argument |
|---|---|---|---|---|---|
| 1,000 | 21 M | 9.3 s (three runs: 9.30, 9.32, 9.35) | yes | 49 GB | 237 KB |
| 5,000 | 105 M | 25.3 s | yes | 55 GB | 1.16 MB |
| 10,000 | 210 M | 44.0 s | yes | 63 GB | 2.31 MB |
| 20,000 | 420 M | 86.2 s | yes | 76 GB | 4.61 MB |
| 45,557 | 957 M | 206.8 s | yes | 110 GB | 10.49 MB |
| 50,000 | 1.05 G | 228.4 s | yes | 108 GB | 11.5 MB |
| 62,500 | 1.31 G | 283.8 s | yes | 122 GB | 14.4 MB |
| 75,000 | 1.58 G | failed | - | - | 17.3 MB |
| 100,000 | 2.1 G | failed | - | - | 23.0 MB |

- The 62,500-transfer block, 1.31 billion gas, was the largest that proved. DevNet's gas cap was 30,000,000 on 2026-10-25 and has been 60,000,000 since 2026-10-27, so DevNet blocks are still far smaller than these.
- The two failures were the ZisK coordinator's own limit ("Phase Contributions timed out (300s > 300s)"), not memory. Neither block was retried with a longer timeout, so whether it would prove is unknown.
- The cost per added transfer was about 4.5 ms on one GPU (9.3 s at 1,000 transfers, 283.8 s at 62,500), or about 220 transfers a second of proving at large sizes. GPU memory stayed near 95 GB at every size, because the keys are preloaded; host memory grew with the block.
- The `Advance` argument is about 230 bytes a transfer (the block's transactions in hex, about twice their raw size). Under a request limit of 10 MiB, which is Canton's default (the limit on DevNet's synchronizer was not read), the request size alone would allow at most 45,557 transfers. That is arithmetic from the sizes above, not a commit. The participant's Daml work would stop such a block first: at about 3 to 5 ms per KB per pass under package 0.2.0, a 10.49 MB argument is roughly 60 to 105 s of work over the two passes (an extrapolation from blocks of up to about 330 KB), well past the 20 s JSON API timeout. So that size has not been committed to Canton, and could not be on DevNet as it is set up today.

## DevNet throughput, 2026-10-25

These runs were on Ostia DevNet itself, on 25 October 2026, with one participant (Rome's), one builder and one prover, at a gas cap of 30,000,000, with one block in flight. The DevNet prover then was one NVIDIA RTX PRO 6000 GPU. By 27 October DevNet ran depth 3 on two GPU provers at a higher cap; those runs are in the next section. The raw logs and driver output are not in this repository. Every transaction sent in these runs became final, and none that was meant to succeed reverted (in the morning's burst of 20,000 plain transfers, four were lost from reth's transaction pool and were sent again). The chain was not reset.

**Before package 0.2.0, 08:11 to 08:45 UTC.** The builder had just been changed to fill a block by the gas its transactions use, with a cap of 65,536 raw transaction bytes a block (the old builder counted the gas each transaction declared). The byte cap was then raised to 131,072 and 196,608 in the runs below, and to 393,216 on 2026-10-27; the builder's code default is still 65,536.

| Load | Old builder (02:30 UTC) | New builder at saturation | What bound it |
|---|---|---|---|
| Mixed: 17 kinds of transaction, about 254 raw bytes each | about 7.5 tx/s | about 10.9 tx/s (10.1 over the whole busy window) | the 65,536-byte cap (65,480 bytes used), not gas (17 M of 30 M) |
| Plain transfers: 21,000 gas, 110 raw bytes each | not measured | about 26 tx/s (595 per block, a block about every 23 s) | the same cap; 12.5 M of 30 M gas used |

On the mixed load the new builder kept up at 10 tx/s sent and fell behind at 15 tx/s sent; the backlog then drained in about two minutes. This mixed-load figure has not been measured again since package 0.2.0.

**After package 0.2.0, 11:36 to 11:46 UTC.** Package 0.2.0 (see [the Daml README](../daml/README.md#package-020-is-an-upgrade-of-010)) went live at block 1453 (11:29 UTC). The morning's run at the 65,536-byte cap, above, is the baseline: 595 transfers a block and 26 tx/s. Two bursts of 9,000 plain transfers each, sent from one account in about 25 seconds, with a separate driver sending 3 tx/s in the background. "Steady" runs from the cut of the first full block to the final of the last full block; "whole burst" runs from the first send to the final of the last block.

| Cap on raw bytes per block | Transfers per block | Raw bytes per block | Proof | Commit (submit to answer) p50 / p95 | Block cut to final, p50 | Steady | Whole burst |
|---|---|---|---|---|---|---|---|
| 131,072 | 1,191 | 130,992 to 130,999 | 12.1 s | 6.7 s / 7.7 s | 20.2 s | 59 tx/s | 46 tx/s |
| 196,608 | 1,428 | about 157,000 | 13.3 s | 7.8 s / 8.6 s | 22.4 s | 64 tx/s | 48 tx/s |

- With the cap at 196,608 the byte cap is not reached: the 30,000,000 gas cap binds first, at 1,428 plain transfers (29,988,000 gas). Raising the cap past about 157 KB changes nothing for plain transfers. Going from 131,072 to 196,608 added only 8% (59 to 64 tx/s): the block grew 20%, but the proof (12.1 s to 13.3 s) and the commit took longer too.
- A block takes about 20 to 23 seconds from cut to final, and in that time the proof and the Canton commit run one after the other. On 2026-10-25 DevNet kept one block in flight; by 2026-10-27 it ran depth 3 with two provers (next section).
- The participant's Daml time per KB of the `Advance` argument, per pass (there are two, submission and check), fell from about 23 and 22 ms under package 0.1.0 to a fitted 4.7 to 4.8 ms and 3.4 to 4.1 ms under 0.2.0, with about 3 ms on a typical block. A block of 270 to 330 KB of argument took 1.5 to 3.9 s of participant work, both passes together, under 0.2.0. On ordinary blocks of 35 to 54 transactions, `Advance` took a median of 3.9 s under 0.2.0 (blocks 1453 to 1457) against 6.4 s under 0.1.0 (blocks 1440 to 1452).
- No block's outcome was unknown, and no JSON API timeout occurred, in either burst.

What these numbers do not show: plain transfers are the cheapest transaction there is, so 64 tx/s is not a figure for contract-heavy traffic; one burst was run at each cap, so there is no spread; and they come from DevNet's setup (one participant, one builder, one confirmer), so they say nothing about more confirmers or builders.

## DevNet throughput, 2026-10-26 and 27

**Setup.** These runs were on Ostia DevNet itself, with the builder at pipelining depth 3 (`--max-in-flight 3`; at most one more than the number of provers) on two spot GPU provers, one proof on each GPU, and with the pre-check on (every block is run in ziskemu with a budget of 120 s before it is proven). Blocks are still submitted to Canton in order. The 10-25 runs above were at depth 1 with one prover. The gas cap was 30,000,000 until 2026-10-27 and is 60,000,000 since then (`SetGasCap` at 07:20 UTC; the new limit was reached at 09:06 UTC), and the builder's byte cap went from 196,608 to 393,216 raw transaction bytes a block. The 60,000,000 proofs were made under ZisK 1.3.2-alpha, which DevNet has used since block 15573 (12:02 UTC on 2026-10-27). The figures come from the notes of the runs; the raw logs are not in this repository.

| Cap | Load | Result |
|---|---|---|
| 30,000,000 gas | a burst of plain transfers on two GPUs (2026-10-26 and 27) | 158 tx/s over 74 s |
| 60,000,000 gas | a burst of 9,000 plain transfers (2026-10-27) | 79 s from the send to the last block final, at about 200 tx/s of pipeline cadence: one block of 2,857 transfers about every 14 s, and a proof of 18 to 22 s for each full block |
| 60,000,000 gas | the sustained rate at which fees stayed stable, found by an adaptive ramp of 2 hours | about 93 tx/s |
| 30,000,000 gas | the same, fee-stable sustained rate | about 75 tx/s |
| either | the soak lane (a standing load that follows the number of live provers) | 70 tx/s with two provers, 45 tx/s with one |

- A full block at 60,000,000 gas holds 2,857 plain transfers, twice the 1,428 of the 30,000,000 cap. The proof of such a block took 18 to 22 s while a block was cut about every 14 s, with two provers working on blocks at once.
- Each figure is one run or one ramp, so there is no spread.
- As on 2026-10-25, plain transfers are the cheapest transaction there is, so these are not figures for contract-heavy traffic, and they say nothing about more confirmers or builders. DevNet still has one confirmer.

## The runs on this chain

These results come from [`demo/results/`](../demo/results/). Each test ran once on 2026-10-05, from commit `6b445073163832e9023850f53678617d90dfc808`, on the local Canton network, with the prover already running. These are individual test results, not a benchmark. The runs use the gateway: a block's Canton legs are the ones the gateway recorded in the proven state. [demo/README.md](../demo/README.md#results) has what each run did and the balances it left.

| | Smoke test | Setup | Run 1, a deposit | Run 2, a payment | Run 3, a withdrawal | Run 4, an allocation taken back | Run 5, the tampered proof |
|---|---|---|---|---|---|---|---|
| Source | `smoke.txt` | `setup.txt` | `run1.txt` | `run2.txt` | `run3.txt` | `run4.txt` | `run5.txt` |
| Time of the record (UTC) | 13:38:44 | 13:39:02 | 13:39:12 | 13:39:23 | 13:39:32 | 13:39:53 | 13:40:03 |
| Block | 1, empty | 2, two transactions, no legs | 3, one transaction, one deposit leg | 4, three transactions, one payment leg | 5, one transaction, one withdrawal leg | 6, refused; then built again and committed with one transaction and no leg | 7, built and proven but not committed |
| Gas used | 0 | not recorded | 122,308 | 185,307 | 90,345 | not recorded | not recorded |
| Proof time | 6.31 s | 6.71 s | 6.72 s | 6.72 s | 6.72 s | 6.75 s (first build); the second build's proof is not timed on its own | 6.74 s |
| Proof size | 1,344 bytes | 1,344 bytes (`setup-proof.hex`) | 1,344 bytes (`run1-proof.hex`) | 1,344 bytes (`run2-proof.hex`) | 1,344 bytes (`run3-proof.hex`) | 1,344 bytes (`run4-proof.hex`) | 1,344 bytes, then one hex digit (byte 100) changed |
| From the finished proof file to the end of the builder's run | 0.49 s | not recorded | 0.66 s | 0.42 s | 0.58 s | refused; not timed | refused; not timed |
| The builder's whole run | 155.20 s | 8.00 s | 8.14 s | 7.87 s | 8.02 s | 8.09 s (refused), then 8.04 s (committed) | 7.57 s |
| Outcome | Canton head 1; the block record was seen by the reader; reth marked the block final | committed; head 2 | committed; head 3, in the same update as the gateway's new TKB holding | committed; head 4, in the same update as V's new TKB holding | committed; head 5, in the same update as U's new TKB holding | `Advance` refused with `CONTRACT_NOT_FOUND`; head stayed at 5; the block, sent again without its leg, was refused too; the next build committed and moved the head to 6 | `Advance` refused with "the sidecar refused the block: no the proof does not verify"; head stayed at 6 |

The time "from the finished proof file to the end of the builder's run" includes fetching the gateway's account and storage proofs from reth (one `eth_getProof` call), the `Advance` call with the sidecar's `legs` check, its commit on both confirmers, and reth marking the block final. It is therefore more than Canton's commit alone. The builder matches the legs to Canton contracts before it proves the block, so that work is not in it. The smoke test's full builder run also includes the witness, the input and the prover's one-time program setup, and, if the machine had not built the input tool before, that build as well. Separate times for these steps are not recorded.

The six proof times that the runs recorded are 6.71 to 6.75 s, for blocks of one to three transactions; the empty block's was 6.31 s. The runs do not show how the time grows with the block. The benchmark above does, for plain transfers.

After the runs, the explorer was opened in a browser on block 3. Its Verify button answered "Passed.". The check ran in the browser in 13 ms, and about 0.35 s passed from the click to the answer. It is not a benchmark and is not recorded in `demo/results/`.

**The first proof of a transfer** ([`session.txt`](../prover/fixtures/session.txt), recorded 2026-10-26, for the guest that runs Osaka from genesis): one plain transfer of 21,000 gas as block 1 on a temporary copy of the genesis, 418,430 steps. The proof times were 6.81, 6.79 and 6.74 s. The first proof of 2026-10-04, for the guest that stopped at Prague, took 385,277 steps and 6.33, 6.75 and 6.69 s. It was checked with ZisK's own verifier (`cargo-zisk`) and with the verifier crate in this repository. The same input with the chain id changed to 1 was refused by the guest with "Chain config is not this chain's", and the prover returned no proof.

**Setup times:**

- Building the guest with `prover/build-guest.sh` from an empty build folder, dependency download included: 136 s (`session.txt`). For the Prague guest, two fresh checkouts gave 133 s and 126 s ([`guest/README.md`](../guest/README.md)), with the same ELF and the same programVK.
- The prover's first setup of the program: 41 s (`session.txt`). This is a one-time cost on a prover.

The step count of 418,430 here is for this repository's guest and its own temporary genesis. It should not be compared with the benchmark's step counts, which are for the upstream guest and different blocks.

## The indexer on a real chain (W1)

Measured in CI, in the demo's rehearsal job (`tests/demo_rehearsal.sh`, test `explorer/server/indexer/real-reth.test.ts`), on a GitHub-hosted `ubuntu-latest` runner, and on the reference machine, the explorer's DevNet host, for the budgets (see "B1 and B2 on the reference machine and on the runner" below). The figures in this section are from the runner unless marked otherwise (the laptop figures of `tokens-load.test.ts` are marked); the reference-machine figures are in that subsection. The chain is the rehearsal's own: the real reth (through `network/reth/launch.sh`, discovery off), the real Canton and the real builder, with the stand-in proof (the test takes its pins from the first proof, which is all the stand-in changes). The indexer then indexes every block of the chain into a PostgreSQL started for the run (the pinned image), once with stage 2 `inline` and once `behind`.

The worst-case block is made by `explorer/test/fixtures/Stress.sol`: 15 transactions, each a call chain 14 deep with 10 logs and a contract creation at every level. It is 21.8 Mgas of the 30 Mgas cap: 15 transactions, 435 internal calls, 2,250 logs. (The 15-call block was measured under gas-limit packing, when the builder counted each transaction's gas limit, 2 Mgas, against the cap and these use about 1.45 Mgas. The builder now fills a block by gas used, and the cap holds about 20 such calls, about 29 Mgas, so this is no longer the worst case the builder can make: the indexer's worst case is to be re-measured on a block of about 20 calls. The rehearsal now makes that block on the real reth: 21 calls that declare 2 Mgas each go in as 20 calls using 29,048,300 gas of the 30 Mgas cap, and the 21st goes into the next block. The indexer's times on it have not been measured yet.) One run, one runner; the figures below are from one run, with the block as intended, and runs differ by a few milliseconds.

| What | Time |
|---|---|
| Stage 1's reads from reth, `inline` (block, receipts, `trace_replayBlockTransactions`) | 37 ms |
| Stage 1's reads from reth, `behind` (block, receipts) | 34 ms |
| Stage 1's write, `inline` / `behind` | 59 ms / 57 ms |
| Stage 2's trace read, `behind` | 9 ms |
| Stage 2's write | 2 ms |
| All three reads again, on a warm reth; the trace read alone | 44 ms; 9 ms |

Both shapes finish the block through both stages in under 100 ms, against B1's 1.0 s for stage 1 and B2's 3.0 s for both stages. That first run held no token traffic, so it did not set `INDEX_DERIVE`: the run below, with all of stage 2, does. It does not set B2's final number either: the block is below the cap, the machine is not the reference machine, and stage 2 here is only the call count and revert data.

**W1 again, with the costliest token block the cap allowed under gas-limit packing (to be re-measured, see above)** (tokens, transfers, balances and owners, the proxies, the contracts and the counters; the background check of balances runs behind its own cursor and is not in stage 2's time). Same job and runner type, with the token traffic of the Flood fixture added to the block. The ERC-1155 part is the costliest log the indexer decodes: a `TransferBatch` whose `ids` and `values` are one array (both offsets 0x40), which `decodeTransfers` reads, 4,096 ids in 131,168 bytes. That is half the bytes of a log with two arrays, so a log costs about 1.06 Mgas (measured on anvil, Prague) and the cap holds about 28 of them, 115k transfers. The logs are sent from a holder that already holds the ids, to holders no block has seen, so each id has two legs: `Multi.mint` gives 4,096 ids to the contract in a block of its own, and `Multi.batches` then sends 18 such logs in one call of 19.6 Mgas (19.26 Mgas used). W1 is that call beside 2 Stress calls, 1 call of ERC-20 transfers to new holders and 1 call that makes 9 new tokens, a third of them `Burner` tokens whose reads spend all the gas they get; the five calls' gas limits add up to 27.6 Mgas (the builder keeps a margin). The block (from the rehearsal of 2026-10-22): 5 transactions, 67 internal calls, 1,027 logs and 24.3 Mgas of the 30 Mgas cap, which hold 74,437 transfers (73,728 of them ERC-1155 transfers: 18 logs of the same 4,096 ids, 147,456 legs) to 701 accounts and 10 new tokens, 6 of them with their metadata read and 4 failed (the 3 Burners and the Flood contract itself, which answers none of the reads). Four runs of the rehearsal, each on a new chain (the runner's speed varies by up to twice from run to run: the third and fourth runs failed the budgets set from the earlier ones, so the budgets below come from the slowest):

| What | `inline`, run 1 | `inline`, run 2 | `inline`, run 3 | `inline`, run 4 | `behind`, run 1 | `behind`, run 2 | `behind`, run 3 | `behind`, run 4 |
|---|---|---|---|---|---|---|---|---|
| Stage 1's reads from reth | 70 ms (block, receipts, traces) | 92 ms (block, receipts, traces) | 82 ms (block, receipts, traces) | 148 ms (block, receipts, traces) | 70 ms (block, receipts) | 95 ms (block, receipts) | 99 ms (block, receipts) | 129 ms (block, receipts) |
| Stage 1's write | 1,052 ms | 1,039 ms | 1,782 ms | 2,021 ms | 1,092 ms | 997 ms | 1,746 ms | 2,057 ms |
| Stage 2's reads | 0 ms | 0 ms | 0 ms | 0 ms | 5 ms | 4 ms | 6 ms | 14 ms |
| Stage 2's write | 4,697 ms | 4,504 ms | 5,629 ms | 7,836 ms | 4,702 ms | 4,387 ms | 5,677 ms | 7,988 ms |

`behind` takes 1,162, 1,092, 1,845 and 2,186 ms for stage 1, and 4,707, 4,391, 5,683 and 8,002 ms for stage 2, so 5,869, 5,483, 7,528 and 10,188 ms for both stages. `inline` takes about the same for both stages in one go (5.8 s to 10.0 s), so it is over any B1: `INDEX_DERIVE` stays `behind`. A hostile block like this one costs a few seconds of explorer lag, and the data is right: every holder is counted and every balance is the sum of its legs (see the load test below). Stage 1's write is mostly the `insert into logs` of the 2.4 MB of log data, and stage 2's write mostly the upsert of the derived balances (147,456 legs in one statement); no speed-up is chased here, since a few seconds are accepted.

**B1 and B2 are re-set from this block** (the budgets are set from the measured costliest block, and W1 is that block; see Budgets in [DESIGN.md](DESIGN.md#the-explorer)). They are provisional, and re-set from W1 on 2026-10-22 to the slowest of the four runs of `behind` with 25% headroom: B1 (stage 1) 2,186 ms x 1.25 = 2,733 ms, set at **2,750 ms**; B2 (both stages) 10,188 ms x 1.25 = 12,735 ms, set at **12,750 ms**. B1 and B2 live in `explorer/test/budgets.ts`. They were set from CI runs, but they are the budgets of the reference machine, where W1 measured far faster than on the runner (see "B1 and B2 on the reference machine and on the runner" below); on the runner the W1 test is held to a tolerance above B2. The earlier budgets of 1.0 s and 3.0 s were set before the block was measured. **L3's budget on the runner.** On a shared GitHub runner, L3's index lag (ledger to served from the database) is held to this W1-derived provisional B1 of 2.75 s. The 1.0 s for a block of up to 1,428 transactions is the budget on the reference machine, where L3 is still to be measured. L1, which indexes into the pinned PostgreSQL with no chain, keeps the design's 1.0 s (up to 1,428 transactions) and 3 s (above) for stage 1, because it finishes a 1,428-transaction block in about 110 ms.

The worst shapes for the balances are in `tokens-load.test.ts`, on the pinned PostgreSQL: one block of 5,000 distinct-holder ERC-20 transfers, one block in which 5,000 holders empty their balance (a sweep), one in which 1,250 ERC-1155 holders of four ids each empty one id, and one of six shared-array 4,096-id `TransferBatch` logs from a holder of the ids to six new holders (49,152 legs, the shape of W1 sized down for the CI runner; the real W1 sends 18, and on a laptop with the pinned PostgreSQL 18 logs took stage 1 1,156 ms and stage 2 2,221 ms, 25 logs 1,580 ms and 2,988 ms, 6 logs 432 ms and 739 ms). Stage 2 for the first three took 150, 180 and 65 ms on a laptop, and the reindex's rebuild of the same keys is held to B1 as well. These ordinary shapes are held to the design's 1.0 s (one stage) and 3.0 s (both) on the reference machine; on the shared runner they are measured against a tolerance of 1.25 x the budget, 1,250 and 3,750 ms (`LOAD_B1_RUNNER_MS`, `LOAD_B2_RUNNER_MS` in `explorer/test/budgets.ts`, tied by `budgets.test.ts`), as W1's B2 is, because a stage 2 of 1,013 ms was seen there against the 1,000 ms limit; a run over the budget prints both. The budgets are not loosened. The time follows the number of keys: every look-up is by the primary key and no set is joined back to itself.

The tests assert the budgets of the default mode, `behind`, so a regression fails the job and does not stay a line in a log: the rehearsal's W1 must come in with stage 1's reads and write under B1 (2,750 ms) and both stages together under the runner tolerance of B2 (16,000 ms; B2 itself is 12,750 ms, and its reference-machine figure is provisional, see below). `tokens-load.test.ts` asserts the six-log version of the same shape against B1 (2,750 ms) and against B2 itself (12,750 ms), not the runner tolerance. The `inline` run of W1 is measured and printed, not asserted. The Burners' reads, which run out of the 100,000 gas each read is given (`READ_CALL_GAS`), answer with an error that counts as no answer, so those tokens are `failed` and stage 2 goes on; the rehearsal asserts that too. The limit is 100,000 gas, not the block's 30 Mgas: memory expansion bounds what reth builds for a call, and honest name, symbol, decimals, total supply and balance reads cost a few thousand gas (tens of thousands behind a proxy). An answer longer than 4 KB of data is treated the same way, before any decoding, so a token that returns a hundred kilobytes costs one short read. The FatReturn token of the flood returns 170 KB, which every read's gas can pay for, the 36-byte `balanceOf` read too (the 21,000 intrinsic gas, the calldata and the memory expansion for 170,000 bytes, about 71,000 gas, come to about 92,500 of the 100,000; at 180 KB `balanceOf` ran out of gas, and at 700,000 bytes, about 1 Mgas, every read did, so the 4 KB bound was never met; `explorer/server/indexer/fat-return.test.ts` checks the sum for both reads).

### B1 and B2 on the reference machine and on the runner

**The thresholds.** B2 is 12,750 ms and B1 is 2,750 ms. The reference-machine measurement below is under both, but it is provisional. The W1 test on the shared runner holds both stages together to **16,000 ms** (`B2_RUNNER_MS`, 1.25 x B2 rounded to 250 ms; `explorer/test/budgets.test.ts` keeps the two tied) and stage 1 to B1's 2,750 ms. B1 has no runner tolerance. The test prints B1, B2, the runner tolerance and the measured time, so a reader sees how far the run is from each. The thresholds are also recorded under Budgets in [DESIGN.md](DESIGN.md#the-explorer). `tokens-load.test.ts` runs on the same runner and asserts B1 (2,750 ms) and B2 (12,750 ms) for its six-log shape.

**On the reference machine**, W1 (rehearsal block 10: 5 transactions, 1,028 logs, 24,360,904 gas) was measured on 2026-10-23 over 5 runs: B1 p50 **806 ms** (802 to 810 ms) and B2 p50 **3,998 ms** (3,972 to 4,072 ms). B1 is stage 1's reads and write and B2 adds stage 2's reads and write, the two sums the W1 test prints. The commit the runs were made at, the command and the machine's hardware were not recorded, so this measurement is provisional until it is reproduced with a recorded commit, command, environment and raw results. These figures belong to the code as it was on that day. To reproduce it, run the W1 test in `tests/demo_rehearsal.sh` on the reference machine and record the commit, the machine's specification and the printed B1 and B2 lines. That has not been done yet. (Block 10 was found under gas-limit packing; the cap now holds about 20 Stress calls, so the W1 worst case is to be re-measured.)

**On the shared runner** the same block took B2 11.4 to 13.0 s in five runs on 2026-10-23: two runs failed the earlier 12,750 ms line at 13,026 ms and 12,755 ms, a third failed at 12,756 ms, and two passed at 11,410 ms and 12,367 ms. A later rehearsal run (run 39986286932, 2026-10-23, 16:31 UTC) printed B1 2,116 ms and B2 10,914 ms, so across the six runs B2 ran from 10.9 to 13.0 s. The runner's B2 varied by 2.1 s on the same block. The 16,000 ms threshold allows for that variation. It is a single elapsed-time check, so a regression that stays under 16,000 ms passes it, and a run under enough runner contention can still fail it. B1 had 23% to spare in the later run (2,116 ms of 2,750 ms).

### The health rows the indexer writes

Alerts and the overall status read these ids by name, so they are fixed here. A stop writes the id `down` and the indexer stops; the row goes back to `ok` when the indexer next passes that check. `degraded` rows do not stop the indexer.

| Id | Class | When |
|---|---|---|
| `C1`, `C2`, `C3`, `C7` | down | a block fails the check: hash, order and parent, transactions and receipts, the proof's pins |
| `pins` | down | the database was made for other pins or another chain than the indexer is set to |
| `participant` | down | the reader's cursor belongs to another participant than the one now answering, and offsets are local to a participant |
| `record` | down | a record's signatories are not its operator and confirmer |
| `derive` | down | stage 2 is given a block out of order, or reth's traces are not those of the block's transactions |
| `C10` | degraded | a Leg event of the gateway cannot be decoded; it names the block, which is stored with the legs that decode and a `legs_count` of all the gateway wrote |
| `C6` | degraded | the audit: 20 random indexed blocks (every 10 minutes), and the whole previous 24 hours (nightly, after 03:00 UTC), fetched again from reth, differ in hash, transaction count, gas used or log count; it names the blocks, looks at them again in every run, and is `ok` again when they agree. A reth that cannot be read for the audit is `degraded` with the error |
| `reth_reads` | degraded | reth keeps answering a read with an error or a timeout, or has not had the block Canton names for longer than `INDEX_RETH_BEHIND_MS`; back to `ok` when every loop that reported it reads cleanly again |

The same run answers the design's main open question about revert data: `trace_replayBlockTransactions` does carry the `output` of a failed transaction, for `Error(string)`, `Panic(uint256)` and a custom error (`Reverts.sol`, one failing call to each, in one block). The `debug_traceBlockByNumber` fallback is not needed.

## The API at scale (L2)

L2 is the acceptance test of the health, limits and load budgets (the budgets B3, B4, B6 and B7, under Budgets in [DESIGN.md](DESIGN.md#the-explorer)). It seeds a database through the indexer's own write path, then sends the mixed load of the design (60% single objects, 20% address pages, 10% lists, 5% search, and 5% `getLogs`) at 200 requests a second while the indexer keeps writing blocks of 1,428 transactions every 3 s, 2,000 live-stream clients stay open, and `/api/health` is asked throughout. The server is the deployed one: the pages' routes, the live stream, and the health route read from a pool of its own, with the instance's checks running on a timer in the background. The load runs in a process of its own and is open loop (a request's time runs from when it was due). The test is `explorer/test/l2/l2.test.ts`; the numbers below are the `l2-results` file of the CI job.

**`getLogs` now goes through its route.** L2 sends its 5% share to `/api?module=logs&action=getLogs`: the last 10,000 blocks, one address, 1,000 logs a page, through the server in front of the API, so its limits are in the path, and each request comes from a client of its own so that the per-client limit of Etherscan's `/api` is not what is measured. Its answers are counted in the `getLogs` line and no longer in the server's p97.5 line (the stream is left out of that line in the same way). **`txlist` is measured too (B3 names it).** L2 also asks `/api?module=account&action=txlist&address=<the address with a million transactions>` through the same server, from clients of their own: a page of 100 newest first (`page=1&offset=100&sort=desc`) at 1% of the rate, held to B3's 300 ms, and the default request, which returns the first 10,000 rows with their input (several MB of JSON), 20 times one after another once the load has ended (alone, so that its weight is not in the other routes' figures). The default request is a heavy one and not what B3 sizes (an address page), so its p95 has a budget of its own, 1,000 ms. Each has its own p95 line in the `txlist` object of the `l2-results` file, and neither is in the server's p97.5 line, as `getLogs` is not. The first CI run with the 10,000-row request in the mix at 1% of the rate (2 a second) took the server's other routes past B3 (one block, transaction or address, 177 ms), which is why it is now measured alone. The 3,000,000 column of the row below is the first green run of this version (run 39867267519 on `297cf7c`: a page of 100 took 73 ms at p95, and the 10,000-row request 163 ms alone); the 10,000,000 column is filled in when that size is next run, and says so until then. The figures in the columns below for `getLogs` are of the earlier version of this test, which sent the same query straight to the database, so they say how fast the query was; the first runs of the route replace them, and the p95 of the route is in the `getLogs` object of the `l2-results` file of each job.

Measured in CI on a GitHub-hosted `ubuntu-latest` runner, with the pinned PostgreSQL (`shared_buffers` 1 GB), on the same machine as the server and the load. It is not the reference machine: the design's run on the reference machine (the explorer's DevNet host) is still to be made, with `L2_TRANSACTIONS=10000000 L2_SECONDS=600` (and `L2_KEEP_DATABASE=1` to keep the seeded database for a look at plans). The 10,000,000-transaction column was run once in CI, on this branch, by setting those two values in the job; the seed took 33 minutes, the database is 12.5 GB, and the runner had 85 GB free. Every pull request runs the 3,000,000 column, which takes about a quarter of an hour.

| | Budget | 3,000,000 transactions, 120 s (every pull request) | 10,000,000 transactions, 600 s (the design's size, run once) |
|---|---|---|---|
| Database | | 3,058,776 transactions, 2,142 blocks; the one address sends 1,000,076 of them | 10,287,312 transactions, 7,204 blocks; the one address sends 1,001,429 of them |
| B3 one block, transaction or address (p97.5) | p95 ≤ 100 ms | 22 ms | 40 ms |
| B3 an address's page of transactions, the one with a million (p97.5) | ≤ 300 ms | 18 ms | 34 ms |
| B3 a list page (p97.5) | ≤ 200 ms | 14 ms | 30 ms |
| B3 search (p97.5) | ≤ 100 ms | 7 ms | 18 ms |
| B3 `getLogs` (p95; the figures are of the query alone, before the route) | ≤ 500 ms | 12 ms | 19 ms |
| B3 Etherscan `txlist` page of 100 of the address with a million (p95; the default 10,000-row request has its own budget, 1,000 ms) | ≤ 300 ms | 73 ms (the default 10,000-row request, alone: 163 ms) | not yet measured |
| B4 a new final block to 2,000 stream clients (p95) | ≤ 500 ms | 63 ms | 100 ms |
| B6 size per million transactions | ≤ 2.5 GB | 1.24 GB | 1.22 GB |
| B7 `/api/health` (p97.5), answers other than 200 | ≤ 50 ms | 5 ms, none | 22 ms, none |
| Ingestion of a 1,428-transaction block, while the load runs | | 239 to 378 ms | 319 to 481 ms |

The load tool reports p97.5, which is stricter than the p95 the budgets name, so p97.5 is what is held to them.

**Which runs the columns are.** The 3,000,000 column is run 39805018389 on commit `40259a9`, and the 10,000,000 column is run 39806988358 on commit `723b131` (the job there was set to the design's size; the commit differs from the one that set it, `3138350`, by documentation only). Both are `l2` jobs of the `explorer` workflow, and their logs hold every number above. The same 3,000,000 job has since been green on four more commits, run 39817239570 on `ad4f74d`, run 39817459040 on `cd97c23`, run 39823085438 on `074456a` and run 39825656578 on `b1c1dda`, and it moves with the runner it lands on: across the five, one block, transaction or address (p97.5) took 22 to 44 ms, an address's page 18 to 34 ms, a list page 14 to 38 ms, search 7 to 32 ms, `getLogs` 12 to 24 ms (p95), a block to the 2,000 stream clients 53 to 99 ms (p95), `/api/health` 3 to 41 ms with no answer other than 200, size 1.24 to 1.27 GB per million transactions, and ingestion of a block 239 to 471 ms. Every figure of every run is inside its budget.

### What was wrong at 3,000,000 transactions

An earlier run at this size failed every budget: an address's page took seconds, the load backed up behind it, and ingestion took 26 s a block. The cause was one query. An address's page reads three keys, the transactions it sent, received and created, each newest first. The index on `created_contract` held the address alone, with no order, so the planner walked the primary key backwards and filtered on the address: for an address that created nothing, it read all 3,000,000 rows, 5 to 8 s on a database that is warm. Migration `0026_address_page_created_contract_index.sql` (the index is `transactions_created_contract_place_idx`) replaces it with an index in the page's own order, as the other two keys have, and the page costs 0.3 ms. `explorer/server/rest/paging-plans.test.ts` fails without it. `/api/health` used to refresh this instance's checks inside the request (5 s for a reth that hangs); it now only reads the table.

## The nightly load test

`.github/workflows/explorer-nightly.yml` runs every night (02:17 UTC) and by hand (`workflow_dispatch`, with the sizes as inputs). It never runs on a pull request, except for a pull request that changes the nightly's own files, which runs a short version of everything so that a change is seen to run before it is merged. Each job writes its numbers to an artifact (`l1-results`, `l2-results`, `chain-results`) and a short table to the run's summary. A broken budget fails the job.

| Part | What it does | Limit |
|---|---|---|
| L1 | Blocks of 0, 100, 1,428 and 5,000 transactions through both stages of the indexer, on the pinned PostgreSQL, and then the 5,000-transaction block re-indexed with `reindexRange`, timed. | B1, B2 (the write times; the re-index at 2,500 transactions a second or more) |
| W1 | The worst-case block the 30 Mgas cap allows (to be re-measured: it was found under gas-limit packing, and the cap now holds about 20 Stress calls; DevNet's cap is 60 Mgas since 2026-10-27, so by arithmetic a DevNet block could hold about twice as many, and W1 has not been re-run at that size), on the rehearsal's real chain (reth, Canton, the real builder, a stand-in prover), indexed into a database of its own. It is the rehearsal's own step; the log is kept as `w1.log`. | B1 (2.75 s); B2 held to the runner tolerance, 16 s (`explorer/test/budgets.ts`; B2 is 12.75 s on the reference machine) |
| L2 | The API at scale: a seeded database, the mixed load of the design at 200 requests a second, 2,000 live-stream clients, ingestion running. Section "The API at scale (L2)" has the method. | B3, B4, B6, B7 |
| L3 | A flood of blocks of 1,428 plain transfers (a full block at the 30 Mgas cap; at DevNet's 60 Mgas cap since 2026-10-27 a full block is about 2,857, and L3 has not been run at that size), cut one after another through the real builder for 30 minutes (the rehearsal's builder runs with `--max-block-tx-bytes 1048576`: the builder's default of 64 KiB of raw transactions, set for our participant's cost per KB of the Advance argument, would cut 1,428 transfers, about 160 KB, into three blocks, and L3 measures the explorer on a block as big as the gas cap allows; the sender counts V's nonces itself, because a read of the pending nonce while the builder moves reth back answers an old one); the next batch is sent while the builder cuts the block before it. The clock of a block starts when the reader's participant can read its update: the update is found by its id in `canton_updates`, and the ledger end of that participant, polled every 20 ms, reaches the update's offset there. A block is served at the first 20 ms tick of a `psql` session at which its row is visible in the explorer's PostgreSQL (what the API serves from); the time from the clock's start to that tick is the index lag. The API is asked too: a client polls `/api/block/N` every 60 ms (the REST routes allow 20 requests a second to a client), and the delay of its first answer from the database (status final, with its Canton record; reth's "unindexed" or "proving" answer does not count) after the block was served is reported beside the lag as `api_answer_after_served_s`, not held. The time from the block's Canton record time (`canton_updates.record_time`) to served is reported as an observed number too (`record_time_to_served`, p50 and p95), not held. One live-stream client reads the `block` events, and every block must reach it. The database's growth is read from the explorer's PostgreSQL. Blocks per minute are reported. | B1 index lag p95 at most 2.75 s (B1 as `explorer/test/budgets.ts` sets it since W1 re-set it; a test keeps the two equal), B4 stream p95 at most 0.5 s and every block received, B6 at most 2.5 GB per million transactions; at least 5,000 transactions must have been added |
| L4 | Home, Block, Transaction, Address and Contract, each opened cold (a fresh browser context) 5 times in the pinned Playwright image, with the network throttled to 10 Mbit/s and 100 ms of round trip. It records the largest contentful paint, the gzipped script of the first route and the API calls before the first paint. | B5 for Home, Block and Transaction: LCP at most 2.0 s, at most 200 KB of gzipped script, at most 3 API calls before the first paint |
| L5 | What developers' tools ask of the explorer's Etherscan-compatible API, three Counter contracts deployed on the chain. Whether the API is there is read from `/api/openapi.json` (`paths['/api'].get['x-modules']`), never from a live call. Proxy module: block number, account balance, code, a transaction and its receipt, `eth_call`, each against reth. Contract module: `forge verify-contract` in both formats, `cast source`, `cast interface`, `hardhat verify` and `getabi`. | every check of every module of the API, the contract module included; an `/api` entry without its `x-modules` is a failure, and a description with no `/api` entry at all is a failure too |

**What L4 holds.** L4 holds Home, Block and Transaction to B5, which is what the design's B5 holds. Address and Contract (the Address page, and the Contract page at `/contract/<address>`) are measured and reported with the same numbers and are not held; the results file says so for each. L5 is complete: the Etherscan-compatible API is in the explorer with the account, contract, transaction, block, logs, token, stats, proxy and gastracker modules, and every check of the proxy, account and contract modules runs against it and fails the job if it fails (the run below passed all nine). `l5.sh probe` reads the API from `/api/openapi.json`: a description with an `/api` entry and its modules is a run. An entry without its `x-modules`, a description with no `/api` entry, and a description that cannot be read are failures. `tests/test_demo_nightly_l5_probe.py` tests this script, and runs the branch of the nightly that handles a description with no `/api` entry (it must fail the job).

**The sizes against the design's.** L1, L2 and L4 run at the design's sizes (L2 at 10,000,000 transactions and 600 s; the run of this size in CI took about 50 minutes and 13 GB of disk, see the L2 section). L3 floods for the design's 30 minutes. L3's chain is a rehearsal chain on one hosted runner with no GPU and a stand-in proof, so its time to final is not measured: the flood goes straight to reth, `tx_lifecycle` has no `accepted_at` for it, and a stand-in proof is no wait (L3's results say so in `final_note`). The builder, reth, Canton and the explorer share the runner's cores with the load, so L3's numbers are those of a loaded small machine, not the reference machine, and are not the design's reference numbers.

**The latest run.** A workflow can be dispatched by name only once it is on the default branch (`gh workflow run` answers 404 before that), so the full-size nightly has not run yet. The short version that a pull request to the nightly's own files runs has: L2 at 300,000 transactions and 30 s, L3 for 3 minutes, L4 twice per page, L5 in full. The numbers below are from run 39939349126 of `explorer-nightly` on commit `68a4883` (pull request 36). Every job of that run passed, including L1, W1 and L2. Earlier runs of that pull request are not used as results. Run 39933494875 on `9291b22` ran before migration 0030's two log indexes. Runs 39922649590 (`329ddd5`) and 39920635117 (`a28e8e5`) timed L3 to the API's answer, and run 39862718686 (`b8c1224`) started L3's clock when the watcher saw the block and counted reth's own answer as served; neither method measures the index lag. Run 39920635117 and run 39933494875 appear below only for W1's comparison.

**The index-lag limit on a shared runner.** On a shared GitHub runner, L3's index lag (from the ledger to the row in PostgreSQL) is held to the W1-derived provisional B1 of 2.75 s (`explorer/test/budgets.ts`). The 1.0 s for a block of up to 1,428 transactions is the budget on the reference machine, where L3 is still to be measured.

- **L3**, 3 minutes: 9 blocks (12,852 transactions, the largest 1,428), **2.94 blocks a minute** (the sender sends the next batch while the builder cuts the block before it; the 30-minute flood is the design's length). Every block's clock started from the ledger end (`t0_from` is `ledger` for all 9: a block with the fallback clock fails the job; 7,114 ledger-end polls, none unanswered). **Index lag p50 0.45 s, p95 0.55 s**, against B1's 2.75 s. The figure is an upper bound: it is over by at most 0.29 s, the ledger poll gap (p95 31 ms, max 232 ms) plus the database tick gap (p95 21 ms, max 60 ms). **B4:** the stream's delay after the block was served is 18 ms at p50 and 35 ms at p95 (budget 0.5 s), and all 9 blocks reached the stream client. **Beside the lag, not held:** the API's first answer from the database came 0.69 to 0.90 s after the block was served (`api_answer_after_served_s`; run 39933494875: 0.75 to 0.94 s), so the lag is not the time from the ledger to the API's answer, which is the lag plus that delay. The Canton record time to served (`record_time_to_served`) was p50 9.81 s and p95 11.72 s; the reader's participant could read the update about 8 to 11 s after its record time, before the index lag's clock starts, and the run does not say why. The earlier runs on the runner (`a28e8e5` and `329ddd5`: 1.85 s and 1.20 s) timed the API's answer, a different method, and are not comparable with these. Time to final is not measured (see above).
- **L3's growth is 1.71 GB per million transactions** (budget 2.5 GB; 21.9 MB added for 12,852 transactions), beside the earlier estimate of about 1.0 GB per million for plain transfers and L2's 1.22 GB per million from its mixed seed at full size (a run before migration 0030's two log indexes; the short L2 now shows 1.68). L3 is above both. Per million: the transaction table 441 MB, `addresses` 331 MB, `token_balances` 249 MB, `tx_lifecycle` 241 MB and `tx_hashes` 164 MB. Each transfer goes to a new address, which writes an address row and balance rows for each, where L2's seed reuses addresses; and a 3-minute run starts from a small database (135 MB), so it carries more of the first allocations per transaction than a long one. The 30-minute flood will say whether the figure falls (the 3-minute runs of `329ddd5` and `9291b22` measured 1.96 GB and 1.46 GB).
- **L4** (10 Mbit/s, 100 ms, medians of 2): Home LCP 844 ms, Block 998 ms, Transaction 808 ms, all with 165,448 bytes of gzipped script (165 KB; budget 200 KB) and 2 API calls before the first paint (budget 3; Block makes 8 before the largest paint, 2 before the first). Address (818 ms, 2 calls before the first paint) and Contract (822 ms, 3 calls; its own page at `/contract/<address>`) are measured and not held, because B5 holds Home, Block and Transaction only.
- **L5**: **passed**. The API was read from `/api/openapi.json` with the modules account, contract, transaction, block, logs, token, stats, proxy and gastracker. All nine checks passed: the proxy module (block number and balance, code, a transaction and its receipt with an `eth_call`), and the contract module's `forge verify-contract` in standard JSON input (5.3 s) and in the single-file `--flatten` format (5.2 s), `cast source`, `cast interface`, `hardhat verify` (4.4 s) and `getabi`, on three Counters of three different runtime codes. Nothing was downloaded from the Solidity servers: forge and Hardhat compiled with the run's pinned solc 0.8.28, mounted from the image in `PINS`, and the chain job's log has no "Downloading compiler" line.
- **L1** (the indexer on the pinned PostgreSQL, no chain): a block of 0, 100, 1,428 and 5,000 transactions passes B1 and B2 (1,428 transactions: stage 1 177 ms, stage 2 87 ms; 5,000: 550 ms and 246 ms), and the re-index of the 5,000-transaction block (664 ms) ran at **7,530 transactions a second** against the budget of 2,500. It is slower than before migration 0030's two log indexes (12,234 a second), and the margin is now about three times.
- **W1** (the worst-case block, on the real chain): block 10, 5 transactions, 1,028 logs, 74,438 token transfers, 24.4 Mgas. `behind`: stage 1 reads 120 ms and write 2,119 ms, against B1's 2,750 ms; stage 2 reads 10 ms and write 10,056 ms; both stages, reads included, 12,305 ms against B2's 12,750 ms. `inline`: stage 1 reads 106 ms and write 2,014 ms, stage 2 write 10,161 ms, 12,281 ms in all. It passed. B1's margin is 511 ms, about 19% (stage 1 took 2,239 ms with its reads). Those 12,305 ms were against the 12,750 ms that B2 then was on the runner; since 2026-10-23 the runner is held to 16,000 ms instead (see "B1 and B2 on the reference machine and on the runner"). Run 39920635117 on `a28e8e5` and run 39933494875 on `9291b22`, both before migration 0030's log indexes and with the same indexing path apart from a small change to proxy reads, took 12.2 s (`behind`; 12.4 s `inline`, within 341 ms of B2) and 9.0 s (`behind`) for both stages, reads included. The runner varies, and before that a slow runner day could fail B2 without a regression. (Block 10 was found under gas-limit packing; the cap now holds about 20 Stress calls, so the W1 worst case is to be re-measured.)
- **L2** (short version: 317,016 transactions seeded, 200 requests a second for 30 s, 2,000 live-stream clients): 6,508 requests, none outside 2xx; server p50 4.2 ms, p97.5 43 ms, max 133 ms; `getLogs` p95 149 ms; the `txlist` page of 100 p95 171 ms and its default 10,000-row request, alone, p95 539 ms; the stream's p95 93 ms to all 2,000 clients (11 blocks); health p97.5 24 ms; the database 531.5 MB for 317,016 transactions, **1.68 GB per million transactions**. It passed. The margins of B3, B4, B6 and B7 all hold. B6 is the thinnest (1.68 of 2.5 GB, about a third to spare). Next come B3's single-object route (p97.5 57 of 100 ms) and the `txlist` page of 100 (p95 171 of 300 ms); every other route uses at most about half its budget. The full-size figures are in the L2 section; its 1.22 GB per million predates migration 0030 and the short run now shows 1.68, so the next full-size run will say where B6 stands.
What the run found about the harness, and what was fixed: after L3 a block of the next cut held the transfers L3 had sent and not cut, so L5's three contract deployments were in a later block; L5 now cuts until all three have receipts.

## What CI runs

CI runs on GitHub-hosted `ubuntu-latest` runners. They have no GPU, so no proof is made or timed in CI. The WebAssembly tests print verification timings. The jobs are:

- **Secrets:** a gitleaks scan of the whole history.
- **Static checks:** shellcheck on the scripts; the pins and the genesis agree (`tests/static.sh`); the recorded smoke result and the demo results are complete and agree with each other.
- **reth:** the launch refuses a missing or wrong discovery flag; the pinned reth starts with no peers; the UDP check works.
- **Gateway:** `.github/workflows/gateway.yml` checks that the committed gateway code is what the pinned solc makes of `Gateway.sol`, and runs the contract on a real reth (started only through `network/reth/launch.sh`, peer discovery off): every function, every refusal, and each block's leg hash worked out in Python and compared with the storage proof.
- **Rust:** `cargo fmt`, `clippy` and `cargo test` for the verifier, `mpt/` and the sidecar; the chain rules' tests; a real proof taken from the project's own reth is checked by `mpt/`; the sidecar's tests run again on a fresh block, with legs, and fresh gateway proofs from a reth whose genesis holds the gateway.
- **The recorded proof:** `tests/fixtures.sh` checks that the recorded 1,344-byte proof is consistent with its facts. It does not make a proof.
- **The guest build:** `tests/guest-repro.sh` runs the real build script against stand-ins for the ZisK tools, to show that the build happens in one fixed folder. It does not show that a real ZisK build gives the same ELF; the run on 2026-10-04 did that once (see `guest/README.md`).
- **Daml:** `.github/workflows/daml.yml` checks the token-standard packages against their hashes. It builds the stub form with Daml SDK 3.5.12 from `daml/daml.yaml` and runs the Daml Script tests.
- **Canton:** the Canton job in `.github/workflows/network.yml` builds the external form with the pinned released 3.6 compiler. It starts the pinned Canton with that package. One `Advance` is committed and one refused, against a stand-in for the sidecars.
- **Builder:** its tests, on Python 3.12.
- **Explorer:** `.github/workflows/explorer.yml` runs type-checks, tests against fakes and the pages' build in `EXPLORER_NODE_IMAGE`. Its `l2` job runs the scaled L2 (3,000,000 transactions, 120 s) on every pull request. Its `ledger-api` job checks the explorer's requests against the pinned Canton's OpenAPI document. Its `verify-wasm` job checks shared crate versions against the sidecar's lockfile, runs Rust formatting, lint and tests, and builds the Verify module for WebAssembly. It tests the built module through the loader and panel in Node and checks that the pages' build serves it.
- **The explorer's database and indexer:** the `database` job in `.github/workflows/explorer.yml` starts the pinned PostgreSQL and runs the database tests and the indexer's tests against it with `EXPLORER_TEST_REQUIRE_DATABASE=1`, so a missing database fails the job instead of skipping the tests. That includes the replay, kill-mid-block, reth-behind, gap, C1, C2, C3 and C7 tests, and L1: blocks of 0, 100, 1,428 and 5,000 transactions through both stages, each inside B1 and B2.
- **Demo checks:** the `checks` job in `.github/workflows/demo.yml` runs shellcheck, `tests/demo_static.sh` and `tests/demo_explorer_static.sh`. It tests the EVM side against a fake reth, the Canton helpers, the sidecar stand-in and the request logger. The `token` job checks that the pinned solc rebuilds `demo/TKA.bin` from `demo/TKA.sol`.
- **The demo's rehearsal:** the whole demo without a GPU, using a stand-in for the proof. It runs the real reth, Canton, token standard, builder and the sidecar's `legs` check, and runs the explorer beside the chain. It checks the block page, Verify's rejection of the stand-in proof, the tROME faucet and the explorer's requests. It does not prove a block or check a real proof.
- **The nightly load test:** `.github/workflows/explorer-nightly.yml` runs L1, L2 at the design's size, and, on the rehearsal chain, W1, L3, L4 and L5 (section "The nightly load test"). It runs on a schedule and by hand; a pull request that changes its files runs a short version. L5 fails the job when `/api/openapi.json` has no Etherscan-compatible `/api` endpoint, and when a module is missing or a check fails.

## What is not measured yet

- **A systematic benchmark of contract calls or precompiles.** The benchmark blocks are plain transfers. The demo records ERC-20 transfers, an approval, and calls to the gateway. The cost per gas depends on the mix of work, so the plain-transfer figures do not establish the cost of contract calls.
- **Blocks above 105 Mgas on the upstream guest.** The 2026-10-03 benchmark used the upstream guest. The 2026-10-25 benchmark of large blocks used this repository's guest, up to 1.31 Ggas, on a benchmark machine; no block that large was committed to Canton.
- **More than one block in flight in the prover benchmark.** The benchmark sent one request at a time to a free GPU. DevNet's blocks in flight are measured in "DevNet throughput, 2026-10-26 and 27" (depth 3).
- **One proof across two GPUs.** A two-GPU prover was tried on a benchmark machine, where proof times were 25 to 39% shorter (one proof using both GPUs) and every proof verified; those runs are not recorded here, and DevNet does not use it. DevNet uses two spot GPU provers, one proof on each GPU, with blocks pipelined across them; its numbers are in "DevNet throughput, 2026-10-26 and 27".
- **Building the witness from the chain.** The benchmark's "input to proof" starts from a witness file that already exists. On this chain, building the witness on a warm machine has not been timed on its own.
- **The sidecar's proof check run natively.** Native verification latency has not been measured. The WebAssembly build took 8 to 32 ms in Node on CI runners for verifying the proof and rejecting a mismatched header. That is not a successful full-block check or a browser measurement; see [explorer/verify/README.md](../explorer/verify/README.md).
- **Canton's commit of a block with contract-heavy traffic at its largest.** The demo's commits are for an empty block and blocks of one to three transactions, with at most one leg. On DevNet the largest commits measured are blocks of 1,428 plain transfers, in the section "DevNet throughput, 2026-10-25", and, since the cap went to 60,000,000, blocks of about 2,857 plain transfers, in "DevNet throughput, 2026-10-26 and 27".
- **Repeat runs on this chain.** Each run was done once, on one machine, with one operator and one builder. There is no spread to report.
- **The rest of the runs' machine.** Its CPU model, RAM, operating system and Node version were not recorded; only the GPU and driver were.
- **ZisK's hints build.** The build did not complete, so no performance measurements are available. The cause has not been established.
- **Another machine or user building the guest.** Whether they get the same ELF is only confirmed by reproducing the recorded programVK there.
