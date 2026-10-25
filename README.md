# canton-zk-evm

Ostia, a Canton zkEVM (chain id 770101), is an EVM chain whose blocks are ordered by Canton and proven by a zero-knowledge virtual machine, so that an EVM block and the Canton actions it needs settle together in one Canton transaction.

Every EVM block becomes one Canton transaction, and only once it is proven. That transaction carries the block, its proof and the Canton actions the block asked for. Canton's confirmers check the proof. Daml checks that the block follows the chain's current head. The block and its actions commit together, or neither does.

What a block asks of Canton is written down on the EVM by one contract, the gateway, which is part of the chain from its first block. Each request is called a leg, and there are three kinds:

- a deposit: a Canton token is locked with the gateway, and its wrapped form is minted on the EVM;
- a withdrawal: the wrapped form is burnt, and the gateway releases the Canton token to a Canton party;
- a payment: an ERC-20 payment made through the gateway executes a Canton allocation that the payer and the payee agreed to for that payment and no other.

The proof fixes the gateway's state, so it fixes the legs. `Advance` settles exactly the legs the proven block recorded, or the whole transaction fails and the block does not commit. A block cannot land without its legs, and a leg cannot settle without its block. Before it proves a block, the builder reads the block's legs, and if one cannot settle (an allocation is gone, or a receiver has not agreed to receive), it leaves out the transaction that asked for it. If the allocation is taken back after that check, Canton refuses the submission, nothing moves, and reth goes back to the last committed block. On DevNet the builder runs all the time (`builder.py run`) and cuts a block whenever transactions wait, one block at a time, and makes an empty block when a minute passes with none; `builder.py once` makes a single block, as the local network and the demo do. It fills a block by the gas its transactions use, and normally offers reth no more than a cap on their raw bytes. There are no throughput targets yet. See [docs/DESIGN.md](docs/DESIGN.md) for the design and [docs/METRICS.md](docs/METRICS.md) for measurements, hardware and versions.

## Status

Ostia opened on Canton Network DevNet on 22 October 2026. The chain id is 770101, the RPC is `https://ostia.devnet.romeprotocol.xyz/rpc`, the explorer is `https://ostia.devnet.romeprotocol.xyz` and the faucet is `https://ostia.devnet.romeprotocol.xyz/faucet`. [docs/TRY-OSTIA.md](docs/TRY-OSTIA.md) has connection and deployment examples, and the docs site has the rest: <https://docs.rome.builders/canton-zk-evm/canton-zk-evm>. To run Ostia yourself, this repository starts a local Canton network that keeps no state between runs unless you ask it to.

The three legs are live on DevNet. A Canton test token, TKB (Splice's reference test token), is registered with the gateway, and its wrapped form, wTKB, is at `0x294d3049874526910a69f6b61da14d10a8b1b3af` on Ostia. A deposit, a payment and a withdrawal first ran on 25 October 2026 between 08:08 and 08:10 UTC (blocks 780, 783 and 784), and again from 11:31 to 11:34 UTC under Daml package 0.2.0 (blocks 1465, 1471 and 1473). After the second run the wTKB supply was 12, which anyone can read on Ostia. Rome's run checked that the gateway then held 12 TKB on Canton, equal to the wTKB supply of 12; the explorer will show custody against supply once its custody read is enabled. The parties in these runs, U and V, are test parties that Rome runs on its own participant, and Rome ran the legs. Anyone can watch them on the explorer (`/legs`), but outside users cannot make their own yet, because self-serve Canton accounts are not built.

Since 25 October 2026 the builder fills a block by the gas its transactions use instead of the gas they declare, and limits the raw transaction bytes it offers for a block (196,608 on DevNet; an oversized first transaction is still offered, so it does not wait for ever). DevNet has run Daml package 0.2.0, the fast block check, from block 1453. On 25 October, plain transfers ran at 64 a second in steady state, and the 30,000,000 gas cap binds at 1,428 per block; [docs/METRICS.md](docs/METRICS.md) has the numbers and what they do not show.

It is a DevNet, and it can be reset. tROME is a test coin with no value. This code and ZisK 1.3.1-alpha are not yet audited. Rome runs the one participant that hosts every Ostia party, so its one sidecar is the only confirmer and Rome can act for every Ostia party, the gateway party included. Rome also runs the builder, the prover, the RPC, the explorer and the faucet. [docs/DESIGN.md](docs/DESIGN.md) and [network/README.md](network/README.md#running-on-an-existing-participant-the-canton-network) explain this. Do not use Ostia for anything of value.

The repository also has a settlement demo that runs on the local network, and the block explorer (with its tROME faucet and in-browser proof check) that serves DevNet. The demo (`demo/`) ran on a GPU on 2026-10-05, from commit `6b445073163832e9023850f53678617d90dfc808` of this repository (6b44507). A rehearsal also runs in CI without a GPU.

The guest and prover proved the first block on a GPU: one plain transfer on this chain. ZisK's own verifier and the verifier crate both checked the proof.

Network: on one machine with a GPU, the builder made one empty block, the prover proved it in 6.31 s, `Advance` committed it on a local Canton with the real external call, the chain's head moved to 1 and reth marked the block final. The facts are in [demo/results/smoke.txt](demo/results/smoke.txt). The recorded run ran after `up.sh` had checked that the guest it built has the recorded program key. It used 3.6 snapshots of Canton and the Daml compiler. The repository now pins the released open-source Canton 3.6.3 (the version the Canton Network's DevNet runs) and the compiler of the released Daml SDK 3.6.0; [network/README.md](network/README.md) says which, and how they are pinned.

The demo passed all its checks on the same machine, with one NVIDIA RTX PRO 6000 GPU, in a setup block and five runs. Two test tokens are used: TKA lives on the EVM, and TKB on Canton; wTKB is TKB's form on the EVM. In run 1, a deposit, U's 10 TKB went into the gateway's custody and U's address was minted 10 wTKB, in one Canton update with the block record. In run 2, V paid U 10 TKA through the gateway and U's 10 TKB went to V in one Canton update; a plain 1-TKA transfer in the same block moved on the EVM but made no leg, and did not get in the way. In run 3, a withdrawal, U's address burnt 4 wTKB and the gateway paid 4 TKB to U, again in one update. In run 4, U took its allocation back after the proof was made: Canton refused the block, nothing moved, and the next builder run left the payment out and committed. In run 5, one hex digit of the proof was flipped, and Canton refused `Advance` with the sidecar's answer "no the proof does not verify". The six proof times the runs recorded are 6.71 to 6.75 s. This used one local network, one operator, test tokens and keys made for the run. The same three legs ran on DevNet on 25 October 2026, as described above. The numbers are in [demo/README.md](demo/README.md#results); the results, proofs and versions are in [demo/results/](demo/results/). They replace the results of an earlier version of the demo, which had a different rule for a leg; [demo/README.md](demo/README.md#results) says where those are.

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
| `gateway/` | The gateway contract that records each block's legs, and its tests |
| `sidecar/` | The service beside each Canton confirmer |
| `daml/` | The chain record, the block record, and the Daml side of deposits, withdrawals and payments |
| `builder/` | Makes a block, gets it proven, submits it to Canton |
| `explorer/` | A block explorer for Ostia, with a tROME faucet and an in-browser proof check (see [explorer/README.md](explorer/README.md)) |
| `load/` | The mixed load kit (tokens, NFTs, ERC-3643, Uniswap V2, a RedStone price consumer, TACEO's Merces contracts with client-side proofs only) and what one DevNet run measured |
| `demo/` | A deposit, a payment, a withdrawal, a payment whose allocation is taken back, and a tampered proof (run on a GPU on 2026-10-05; `results/` holds the runs and the smoke test) |

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
gateway/build.sh --check         # the checked-in gateway code is what Gateway.sol compiles to (Docker)
gateway/tests/run.sh             # the gateway on a real reth, started with peer discovery off (Docker, curl, jq, Python 3 with the packages in demo/requirements.txt)
tests/guest-repro.sh             # the guest build runs in one fixed folder, so the source folder does not change the ELF (stand-ins for the ZisK tools; the same check on real ZisK passed on 2026-10-04, see guest/README.md)
tests/demo_static.sh             # the demo's pins, tamper switch and genesis override, and its recorded results (no GPU)
tests/demo_rehearsal.sh          # the demo and explorer with a stand-in proof (Linux x86-64, Docker, Java 21, Rust, Python 3.12+; no GPU)
tests/demo_explorer_static.sh    # the explorer's images are pinned, and what its container is given (no Docker)
(cd explorer && npm ci && npm test)  # the explorer's tests, against fakes (Node 22.18+; CI uses EXPLORER_NODE_IMAGE in PINS)
(cd guest/rules && cargo test)   # the chain rules and their hash (needs Rust)
```

Settings such as ports and the state folder come from environment variables; see the top of `network/reth/launch.sh`. The Engine JWT secret is generated per run into `state/`, which git ignores.

## Licence

Ostia is licensed under the [Apache License 2.0](LICENSE). Copyright 2026 Rome Protocol. [NOTICE](NOTICE) lists the third-party parts, which keep their own licences.

Rome, Rome Protocol and Ostia, and the Rome logo, are trademarks of Rome Protocol. The licence grants no right to use them.

## Contributing

Contributions are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) says how to build and test, how to sign your commits (we use the Developer Certificate of Origin) and how pull requests are reviewed. Please read the [Code of Conduct](CODE_OF_CONDUCT.md). To report a security problem, follow [SECURITY.md](SECURITY.md).
