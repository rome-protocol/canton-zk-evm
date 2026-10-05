# network

Runs Ostia, a Canton zkEVM (chain id 770101), on one machine: reth, two sidecars, the prover and a local Canton network. `up.sh` starts the services, `smoke.sh` runs the end-to-end check, and `down.sh` stops them. See [docs/DESIGN.md](../docs/DESIGN.md) for the design.

| File | What it is |
|---|---|
| `genesis.json`, `make-state.sh` | The chain's genesis, and the per-run state (the Engine secret) |
| `reth/` | `launch.sh` is the only way reth is started. Peer discovery is always off. `check.sh` proves it is off, `stop.sh` stops it |
| `canton/canton.conf` | One synchronizer and three participants, all in memory, all on localhost |
| `canton/bootstrap.canton` | Starts the nodes, connects the participants, creates the parties and Ledger API users, uploads and vets the Daml package |
| `canton/propose.py` | The operator proposes the chain and the confirmer accepts it |
| `canton/fetch.sh`, `canton/check-damlc.sh`, `canton/build-dar.sh`, `canton/dar-id.sh` | Install the pinned Canton and Daml tools and check them, build the real form of the Daml package with them, and print the DAR's SHA-256 and package id |
| `check-program-vk.sh` | Stops `up.sh` when the guest it built has a programVK other than the recorded one |
| `up.sh`, `down.sh` | Start and stop everything |
| `smoke.sh`, `prove-timed.sh` | The smoke test, and the prover command it hands the builder (it keeps the prover's output so the proof time can be read) |

## The Canton network

One synchronizer (a sequencer and a mediator) and three participants:

| Participant | Hosts | Sidecar |
|---|---|---|
| `operator` | the operator and the builder | yes, on 8085 |
| `confirmer` | the confirmer | yes, on 8086 |
| `users` | U, V, the test token's registry and the reader | none |

The Daml package calls the extension `canton-zk-evm` (`DA.ExternalCall`). Each confirming participant sends that extension to its own sidecar: the operator's to 8085, the confirmer's to 8086. The users participant has no extension, because it is never asked to run the call: it only receives the block record, as an observer. Everything is in memory, so a restart is a new network, and everything listens on 127.0.0.1. The network runs without Ledger API authentication; it is for one machine and one run.

The JSON Ledger API of each participant is on 7575 (operator, the one the builder uses), 7576 (confirmer) and 7577 (users).

### Which Canton, and why a snapshot

The external call requires Canton 3.6 and Daml-LF 2.4. Neither is released yet: the latest Canton release is 3.5, and Daml 3.5 has no `DA.ExternalCall`. This repository uses snapshots that Digital Asset publishes in its public registry. `PINS` records the exact versions and SHA-256 hashes of the Canton jar, the `dpm` program and the SDK manifest. The SDK manifest names every other component, including the compiler, by exact version. Snapshot version tags can be replaced with different contents. `PINS` therefore also records the compiler's registry manifest SHA-256 (`DAMLC_LINUX_AMD64_MANIFEST_SHA256`). That manifest lists every compiler file by SHA-256, which `dpm` checks on download. `canton/fetch.sh` checks all these pins and refuses changed snapshots. It uses `canton/check-damlc.sh` to check the compiler before and after installation. `smoke.txt` records the built DAR's SHA-256 and main package id.

The network uses the open-source Canton jar. The snapshot compiler builds the Daml package to LF 2.4 (`daml/build.sh external` defaults to that target) with the real external call. Both snapshots are intended only for this first proof. The pins will move to Canton 3.6 and Daml 3.6 when those releases are available.

## Running it

You need a Linux x86-64 machine with an NVIDIA GPU and its driver installed, Docker, Rust, Python 3.12 or newer, `jq`, `curl` and `openssl`. The builder needs Python 3.12 or newer to read Canton's times. Install ZisK with `prover/install.sh`. That installer needs `sudo`, `apt` (Debian or Ubuntu) and about 100 GB of free disk. It installs system packages and changes the memory-lock limits. `canton/fetch.sh` installs Java 21 if it is missing.

The recorded runs used one NVIDIA RTX PRO 6000. The benchmark recorded about 28 GiB of GPU memory for the PLONK wrap alone and 22.9 GiB of shared memory for the emulator. The minimum GPU memory for the whole prover is not established here. See [docs/METRICS.md](../docs/METRICS.md#the-machine) for the tested hardware and memory measurements.

```sh
network/up.sh       # tools, guest build, reth, sidecars, prover, Canton, the chain
CZE_SOURCE_COMMIT=$(git rev-parse HEAD) network/smoke.sh    # one empty block, proven and committed
network/down.sh
```

For a source export without `.git`, set `CZE_SOURCE_COMMIT` to the full hash of the commit it was built from. State, logs and pid files go to `state/` (or `$CZE_STATE_DIR`), which git ignores. The Engine secret and the party ids are made per run.

`up.sh` also builds the guest. ZisK's root key, the chain rules' hash and the program key (`programVK`) must all be the ones recorded in `prover/fixtures/session.txt`, or it stops before it starts anything, and says which key it built and which is recorded. The sidecars and the chain are pinned to that key. The program key is that of the ELF. The guest build does not depend on the folder it is run from (`prover/build-guest.sh`; two fresh checkouts gave the same key on real ZisK on 2026-10-04, see `guest/README.md`), but that was shown for one machine and one user, so a build that gives another key is refused rather than run. The chain is proposed with genesis = reth's block 0: its hash and its state root, which is the parent state of the first block.

## The smoke test

`smoke.sh` runs the builder once, with no transactions in the pool. It checks that

- the builder commits block 1, empty;
- Canton's `ZkChain`, read by the operator, is at head 1 with that block's hash;
- the `BlockRecord` for block 1 is visible to the reader, on the participant that has no sidecar;
- reth's finalized block is that block.

It writes the block hash, proof time and Advance time to `demo/results/smoke.txt`, along with versions and source details. `source_commit` is the full source commit hash, passed as `CZE_SOURCE_COMMIT=$(git rev-parse HEAD)` because the machine's checkout may have no `.git`. `dar_sha256` and `package_id` identify the DAR Canton loaded. The file uses `format=2`. The recorded result is from 2026-10-04, on one machine with one RTX PRO 6000, using demo source commit `99b2c17161d099cf9f37ccc2e1c082511d8d6ef1`. That commit is from this code's history before the repository was published, so it is not in this repository. In `network/`, `make-state.sh` accepts another genesis through `CZE_GENESIS_FILE` and rejects chain settings that differ from `network/genesis.json`. `bootstrap.canton` creates a Canton user for the demo. The recorded smoke test used the demo's genesis, which also funds one per-run test account. It committed empty block 1, `0xd69e2bab...11b3`. Proving took 6.34 s with the prover already running; Advance took 0.57 s. The builder's full run took 89.94 s. It includes the witness, the input and the prover's one-time program setup, and, if the machine had not built the input tool before, that build as well. The built guest matched the recorded programVK, `0xdb79251d...6d3f`. Advance time runs from the proof file's creation to the end of the builder's run. It includes assembling the Daml legs (the builder's Ledger reads and, for each leg, an `eth_getProof` call to reth), `Advance`, its commit on both confirmers, and reth marking the block final, so it is more than Canton's commit alone.

## Tests

The Canton side is tested without a GPU:

```sh
tests/network_static.sh      # reth only through launch.sh; the extension only on the two confirming participants; the recorded smoke result
tests/network_checks.sh      # the damlc pin check, the DAR's id, and the stop on a programVK that is not the recorded one
python3 -m unittest discover -s tests -p 'test_propose.py'
tests/canton_network.sh      # the pinned Canton, the real Daml package and one Advance, against a stand-in for the sidecars
```

`canton_network.sh` needs Linux x86-64, Java 21, Python 3 and network access. It checks that the bootstrap, the upload and the vetting work; that a block whose sidecar answer is `no` is refused and changes nothing; that a good one commits; and that Canton asks the operator's sidecar when it receives the block and both sidecars when it validates it.

## Not here

- A block with transactions, a tampered proof and a Daml action (DvP) settling with a block are covered by [demo/](../demo/README.md), which runs on this network. The smoke test here is one empty block.
- Persistence. Everything restarts from nothing.
- Authentication, TLS and more than one machine.
