# What was measured, and on what

This page records test results, hardware and software versions for Ostia, a Canton zkEVM (chain id 770101). Every number comes from a file in this repository or from the benchmark run named below. Missing information is marked "not recorded".

Two sets of measurements are reported:

- **The prover benchmark** (2026-10-03). ZisK 1.3.1-alpha proving blocks of three sizes. It used the unmodified reth guest that ships with zisk-eth-client v0.13.1, not this repository's guest, which adds a check of the chain's rules. Its raw logs are not in this repository.
- **The runs on this chain** (2026-10-05). This repository's own guest, on the local Canton network, with the gateway: a smoke test, a setup block and five runs, from the files in [`demo/results/`](../demo/results/). The one-transfer proof of 2026-10-04 is in [`prover/fixtures/session.txt`](../prover/fixtures/session.txt).

## The machine

Both sets ran on a machine with one NVIDIA RTX PRO 6000 GPU. The benchmark's machine is described below; for the runs on this chain only the GPU and the driver were recorded.

| | Prover benchmark, 2026-10-03 | Runs on this chain, 2026-10-05 |
|---|---|---|
| CPU | AMD EPYC 9B45, 48 vCPUs (1 socket, 2 threads per core) | not recorded |
| RAM | 176 GiB as the machine reported it | not recorded |
| GPU | 1 x NVIDIA RTX PRO 6000 Blackwell Server Edition, 97,887 MiB (96 GB), PCIe gen 5 x16 | NVIDIA RTX PRO 6000 Blackwell Server Edition (the 96 GB figure is not in the results files) |
| Driver | 580.178.04 | 580.178.04 |
| CUDA | 13.0, at the driver level; ZisK's prebuilt GPU binaries were used and no CUDA toolkit was installed | not recorded |
| Operating system | Ubuntu 22.04.5, 500 GB boot disk | not recorded |
| Also installed | Node 20.18.0 and snarkjs 0.7.6 (ZisK's verify command runs snarkjs to check the wrapped proof) | not recorded |

The GPU and driver are written into the results files of the runs. Nothing else about their hardware was recorded.

Everything else in this repository's tests runs on GitHub-hosted runners with no GPU. See "What CI runs" below.

## Software versions

The scripts read most of these versions from [`PINS`](../PINS), and CI checks them. The last column says where each row comes from. The results files record `canton`, `daml_sdk`, `zisk` and `reth` versions that match `PINS`.

| What | Version | Source |
|---|---|---|
| ZisK | 1.3.1-alpha, commit `306a9c934ba4947b1d586d69b67120f8b4c41466` | `PINS` |
| zisk-eth-client (the source of the guest) | 0.13.1, commit `edf8adcda75c015f4225abe3aabb3bed03e21beb` | `PINS` |
| reth | 2.5.2 | `PINS` |
| Canton | 3.6.3, the open-source release of 2026-10-20 (the recorded runs used the snapshot 3.6.0-snapshot.20260930.20337.0.ve610bc8f) | `PINS` |
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

The guest has this ELF SHA-256: `44f76af2c17311b41fab46f6c6af4af0af6c767a8da81f7a9554aa7bb848bfbf`. Its programVK is `0xdb79251d9e962ee45fbc28cc6431a7fb894106f06d6664e623189f28c24f6d3f`, and its rootC is `0xc3f12b9f8707c6a1e96df2bf6702c2ebdfbafedabeac654644a380befe091ac4`. They are the same as in the one-transfer proof of 2026-10-04: adding the gateway did not change the proven program. The results files were written on 2026-10-05 from commit `6b445073163832e9023850f53678617d90dfc808` of this repository (6b44507). The DAR hash in them is `870324fdc31122b5a14340bbc3e92be934bf29fd0814f83b0d3aa8a56e2280c7` and the package id `ccd743bc3d2c8e0f59dc418d1180fa73e6c942314e6bc4245ab5e5b13ae42a10`; they identify the Daml package built from that commit. `network/up.sh` checks each guest build against the recorded programVK, rootC and rules hash before starting the network.

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

**The first proof of a transfer** ([`session.txt`](../prover/fixtures/session.txt), recorded 2026-10-04): one plain transfer of 21,000 gas as block 1 on a temporary copy of the genesis, 385,277 steps. The proof times were 6.33, 6.75 and 6.69 s. It was checked with ZisK's own verifier (`cargo-zisk`) and with the verifier crate in this repository. The same input with the chain id changed to 1 was refused by the guest with "Chain config is not this chain's", and the prover returned no proof.

**Setup times:**

- Building the guest with `prover/build-guest.sh` from an empty build folder, dependency download included: 125 s (`session.txt`). Two fresh checkouts gave 133 s and 126 s ([`guest/README.md`](../guest/README.md)). Both gave the same ELF and the same programVK.
- The prover's first setup of the program: 43 s (`session.txt`). This is a one-time cost on a prover.

The step count of 385,277 here is for this repository's guest and its own temporary genesis. It should not be compared with the benchmark's step counts, which are for the upstream guest and different blocks.

## The indexer on a real chain (W1)

Measured in CI, in the demo's rehearsal job (`tests/demo_rehearsal.sh`, test `explorer/server/indexer/real-reth.test.ts`), on a GitHub-hosted `ubuntu-latest` runner, not on the reference machine. The chain is the rehearsal's own: the real reth (through `network/reth/launch.sh`, discovery off), the real Canton and the real builder, with the stand-in proof (the test takes its pins from the first proof, which is all the stand-in changes). The indexer then indexes every block of the chain into a PostgreSQL started for the run (the pinned image), once with stage 2 `inline` and once `behind`.

The worst-case block is made by `explorer/test/fixtures/Stress.sol`: 15 transactions, each a call chain 14 deep with 10 logs and a contract creation at every level. It is 21.8 Mgas of the 30 Mgas cap: 15 transactions, 435 internal calls, 2,250 logs. (The builder takes transactions by their gas limit, 2 Mgas each, and these use about 1.45 Mgas.) One run, one runner; the figures below are from one run, with the block as intended, and runs differ by a few milliseconds.

| What | Time |
|---|---|
| Stage 1's reads from reth, `inline` (block, receipts, `trace_replayBlockTransactions`) | 37 ms |
| Stage 1's reads from reth, `behind` (block, receipts) | 34 ms |
| Stage 1's write, `inline` / `behind` | 59 ms / 57 ms |
| Stage 2's trace read, `behind` | 9 ms |
| Stage 2's write | 2 ms |
| All three reads again, on a warm reth; the trace read alone | 44 ms; 9 ms |

Both shapes finish the block through both stages in under 100 ms, against B1's 1.0 s for stage 1 and B2's 3.0 s for both stages. That first run held no token traffic, so it did not set `INDEX_DERIVE`: the run below, with all of stage 2, does. It does not set B2's final number either: the block is below the cap, the machine is not the reference machine, and stage 2 here is only the call count and revert data. W1 runs again in E5b, with all of stage 2.

**W1 again, in E5b, with all of stage 2** (tokens, transfers, balances and owners, the proxies, the contracts and the counters; the background check of balances runs behind its own cursor and is not in stage 2's time). Same job and runner type, with the token traffic of the Flood fixture added to the block. The ERC-1155 part is the costliest the cap allows per log: `Multi.batches` sends five `TransferBatch` logs of 4,096 ids (the most `decodeTransfers` reads), each to a new holder, in one call of 15.7 Mgas (a log costs 2.77 Mgas, plus 1.63 Mgas for the arrays; measured on anvil). Beside them go 2 Stress calls, 2 calls of ERC-20 transfers to new holders and 2 calls that make new tokens. The block (from the run of 2026-10-22): 7 transactions, 70 internal calls, 1,717 logs and 22.3 Mgas of the 30 Mgas cap, which hold 21,892 transfers (20,480 of them ERC-1155 legs) to 1,401 accounts and 14 new tokens, 13 of them with their metadata read. One run:

| What | `inline` | `behind` |
|---|---|---|
| Stage 1's reads from reth | 42 ms (block, receipts, traces) | 37 ms (block, receipts) |
| Stage 1's write | 256 ms | 247 ms |
| Stage 2's reads | 0 ms | 7 ms |
| Stage 2's write | 1,115 ms | 1,055 ms |

Both stages together take about 1,410 ms `inline`, over B1's 1.0 s. Design section 4.3 makes `inline` the default only when both stages of the worst-case block fit B1, so `INDEX_DERIVE` now defaults to `behind` (it was `inline` on the earlier W1, whose ERC-1155 logs carried 4 ids each and so held about a tenth of this traffic). `behind` takes 284 ms for stage 1, inside B1, and about 1,350 ms for both stages, inside B2's 3.0 s. The cap holds more than this block does: a log of 4,096 ids costs about 2.8 Mgas, so a block of nothing else holds about ten of them (about 41k legs). On a laptop with the pinned PostgreSQL, 12 such logs to new holders (49,152 legs) took stage 1 776 ms and stage 2 1,060 ms, and 5 logs 334 and 473 ms, `inline` and `behind` alike; stage 2 grows with the legs. Stage 2's write is the part to watch, and `INDEX_DERIVE=inline` stays available for a chain whose blocks carry little token traffic.

The worst shapes for the balances are in `tokens-load.test.ts`, on the pinned PostgreSQL: one block of 5,000 distinct-holder ERC-20 transfers, one block in which 5,000 holders empty their balance (a sweep), one in which 1,250 ERC-1155 holders of four ids each empty one id, and one of three 4,096-id `TransferBatch` logs to three new holders (12,288 legs, the shape of W1 sized down for the CI runner). Stage 2 for the first three took 150, 180 and 65 ms on a laptop, and the reindex's rebuild of the same keys is held to B1 as well. The time follows the number of keys: every look-up is by the primary key and no set is joined back to itself.

The tests assert the budgets of the default mode, `behind`, so a regression fails the job and does not stay a line in a log: stage 1's reads and write for the W1 block must come in under 1.0 s (B1), and both stages together under 3.0 s (B2, provisional for a block read over the network). The `inline` run of W1 is measured and printed, not asserted, since it is over B1.

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
- **Explorer:** `.github/workflows/explorer.yml` runs type-checks, tests against fakes and the pages' build in `EXPLORER_NODE_IMAGE`. Its `ledger-api` job checks the explorer's requests against the pinned Canton's OpenAPI document. Its `verify-wasm` job checks shared crate versions against the sidecar's lockfile, runs Rust formatting, lint and tests, and builds the Verify module for WebAssembly. It tests the built module through the loader and panel in Node and checks that the pages' build serves it.
- **The explorer's database and indexer:** the `database` job in `.github/workflows/explorer.yml` starts the pinned PostgreSQL and runs the database tests and the indexer's tests against it with `EXPLORER_TEST_REQUIRE_DATABASE=1`, so a missing database fails the job instead of skipping the tests. That includes the replay, kill-mid-block, reth-behind, gap, C1, C2, C3 and C7 tests, and L1: blocks of 0, 100, 1,428 and 5,000 transactions through both stages, each inside B1 and B2.
- **Demo checks:** the `checks` job in `.github/workflows/demo.yml` runs shellcheck, `tests/demo_static.sh` and `tests/demo_explorer_static.sh`. It tests the EVM side against a fake reth, the Canton helpers, the sidecar stand-in and the request logger. The `token` job checks that the pinned solc rebuilds `demo/TKA.bin` from `demo/TKA.sol`.
- **The demo's rehearsal:** the whole demo without a GPU, using a stand-in for the proof. It runs the real reth, Canton, token standard, builder and the sidecar's `legs` check, and runs the explorer beside the chain. It checks the block page, Verify's rejection of the stand-in proof, the tROME faucet and the explorer's requests. It does not prove a block or check a real proof.

## What is not measured yet

- **A systematic benchmark of contract calls or precompiles.** The benchmark blocks are plain transfers. The demo records ERC-20 transfers, an approval, and calls to the gateway. The cost per gas depends on the mix of work, so the plain-transfer figures do not establish the cost of contract calls.
- **Blocks above 105 Mgas**, or the benchmark's sizes with this repository's guest (the one with the chain-rules check). The benchmark used the upstream guest.
- **More than one block in flight,** and more than one GPU. The benchmark sent one request at a time to a free GPU.
- **Building the witness from the chain.** The benchmark's "input to proof" starts from a witness file that already exists. On this chain, building the witness on a warm machine has not been timed on its own.
- **The sidecar's proof check run natively.** Native verification latency has not been measured. The WebAssembly build took 8 to 32 ms in Node on CI runners for verifying the proof and rejecting a mismatched header. That is not a successful full-block check or a browser measurement; see [explorer/verify/README.md](../explorer/verify/README.md).
- **Canton's commit of a large block.** The commits above are for an empty block and blocks of one to three transactions, with at most one leg.
- **Repeat runs on this chain.** Each run was done once, on one machine, with one operator and one builder. There is no spread to report.
- **The rest of the runs' machine.** Its CPU model, RAM, operating system and Node version were not recorded; only the GPU and driver were.
- **ZisK's hints build.** The build did not complete, so no performance measurements are available. The cause has not been established.
- **Another machine or user building the guest.** Whether they get the same ELF is only confirmed by reproducing the recorded programVK there.
