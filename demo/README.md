# demo

The first proof of Ostia, a Canton zkEVM (chain id 770101), run on one machine with a local Canton network. It has two runs.

**Run 1, a good block.** V sends U 10 TKA, a test token on the EVM. On Canton, U has put 10 TKB, a test token of the Canton token standard, aside for V, and U and V have signed terms saying: if U's TKA balance rose by exactly 10 in the proven block, execute that allocation. The builder makes the block, has it proven, attaches the leg and submits one `Advance`. Canton commits the block and moves the 10 TKB from U to V in the same transaction.

**Run 2, a tampered proof.** The same again, with a second transfer and a second allocation, but one byte of the proof is flipped on its way to the builder. `Advance` is refused, nothing moves on Canton, and reth goes back to the parent block.

The demo is limited to these two runs on one local network with one operator, one builder, test tokens and keys made for the run. It is not a live chain. See [docs/DESIGN.md](../docs/DESIGN.md) ("The first proof") for the design.

## What is here

| File | What it is |
|---|---|
| `TKA.sol`, `TKA.bin`, `build-token.sh` | The EVM test token (a plain ERC-20 whose supply goes to V when it is deployed), and its creation code. `build-token.sh` compiles the source with the solc image in `PINS`; CI checks that `TKA.bin` is what it gives. |
| `evm.py` | The EVM side: V's key and U's address, the genesis that funds V, and the transactions V sends. |
| `canton.py` | The Canton side: loads the token standard's factory and the test token, makes U's holding, makes the allocation and the terms, and reads back what is on Canton, including which update made a contract. |
| `prepare.sh` | Run once before `network/up.sh`: Python packages (by hash), the keys, and the funded genesis. |
| `run.sh` | The two runs. It checks every claim and stops at the first one that does not hold, then writes `results/`. |
| `prove-tampered.sh` | The demo-only switch of run 2: a prover command that runs the real prover and then flips one hex digit of the proof. It exists only here; nothing in `network/` or `builder/` knows about it. |
| `results/` | What the runs showed. |

## Running it

Use a Linux x86-64 GPU host with the prerequisites in [network/README.md](../network/README.md#running-it), including ZisK, Docker, Rust and Java 21. Python 3.12 or newer is required; `demo/prepare.sh` stops on an older version. Run these commands from the repository root:

```sh
demo/prepare.sh
CZE_GENESIS_FILE=$PWD/state/demo/genesis.json network/up.sh
CZE_SOURCE_COMMIT=$(git rev-parse HEAD) network/smoke.sh      # optional: one empty block first
CZE_SOURCE_COMMIT=$(git rev-parse HEAD) demo/run.sh
network/down.sh
```

To include the explorer, use this sequence instead. It follows the order in `tests/demo_rehearsal.sh`: prepare the demo genesis, add the faucet's funding to it, start the network, run the demo, then start the explorer.

```sh
demo/prepare.sh
export CZE_GENESIS_FILE="$PWD/state/demo/genesis.json"
explorer/run.sh setup
export CZE_GENESIS_FILE="$PWD/state/faucet/genesis.json"
network/up.sh
CZE_SOURCE_COMMIT=$(git rev-parse HEAD) demo/run.sh
explorer/run.sh start        # open http://127.0.0.1:8088
explorer/run.sh stop         # when finished
network/down.sh
```

The faucet genesis preserves V's funding and adds the faucet's account. In either sequence, for a source export without `.git`, set `CZE_SOURCE_COMMIT` to the full hash of the commit it was built from.

`prepare.sh` makes V's key in `state/demo/v.key` (mode 0600, never printed) and U's address. The genesis it writes is `network/genesis.json` plus 10 ether for V, so that V can pay for gas; the chain settings are the same, and `network/make-state.sh` refuses a genesis whose settings differ. `network/genesis.json` itself stays unfunded.

`run.sh` works from any chain height, so the smoke test before it is not needed. Its blocks, counted from the chain's head when it starts, are:

1. the token deployment: V deploys TKA and receives 1,000 TKA;
2. run 1's block, with V's 10-TKA transfer and the leg;
3. run 2's block, which is built and proven but never committed.

## What the runs check

Run 1: the builder's exit status is 0 and it attached exactly one leg and skipped none; Canton's chain record is at the new block and its hash; the `BlockRecord` holds the proof the prover wrote and the block's hash; the `BlockRecord` and V's new TKB holding were made by the same Canton update (the update id and offset, read on the users participant, are equal; the id is written to `results/run1.txt` as `canton_update`); U's TKB is 90 and V's is 10; U's allocation and the terms are gone; reth's finalized block is the new block; U holds 10 TKA and V 990.

Run 2: the builder's exit status is 2, it skipped no terms, so its terms, visible to the builder, went in as the leg, and Canton's answer is exactly "the sidecar refused the block: no the proof does not verify"; the chain record and the block records are as they were; the TKB holdings are as they were, and U's second allocation and the terms are still active; reth's latest and finalized blocks are run 1's block again; U still holds 10 TKA.

The first thing the sidecar checks is the proof, so flipping a byte of it is refused there, before anything else is looked at.

## How the Canton side is set up

- Everything goes through the participants' JSON Ledger API. The network runs without Ledger API authentication (see [network/README.md](../network/README.md)), so one Ledger API user, `demo`, acts for U, V and the registry, which are all on the same participant. A real wallet would sign for each of them separately.
- U's holding is a `Token` of the Splice reference test token, signed by U and by the registry that issues it. U allocates through the token standard's own factory with the operator as executor and V as receiver; the token registry's rules contract is passed to that call as a disclosed contract, because U is not a stakeholder of it.
- The terms are `DvpTerms` of the Daml package: the chain id, TKA's address, U's EVM address, the position of TKA's balance mapping (slot 0) and the expected rise, 10 TKA as 64 hex digits (the same in run 2: U's balance rises from 10 to 20 in that block).
- The builder runs with `--read-as <operator>`, which lets it see the allocation (its executor is the operator, so the builder, a different party, cannot see it otherwise), and with `--disclosed` pointing at the registry's rules contract. This network does not need the second for the `Advance` itself; it is passed because the builder supports it and a real registry would need it.

## The rehearsal

CI has no GPU, so `tests/demo_rehearsal.sh` runs the same `demo/run.sh` with a stand-in proof. It uses the real reth, Canton, Daml package, token standard and builder. The real sidecar checks balances (`fact`) against reth's storage proofs. A stand-in prover writes one fixed 1,344-byte proof. `tests/demo_sidecar.py` answers the `verify` call, accepting only that proof and otherwise reading the block as the real sidecar does. The rehearsal covers everything except the zero-knowledge proof check, which the sidecar's own tests and the GPU run cover. The rehearsal's results are not recorded.

It also builds the explorer's image and runs it beside the chain (`explorer/run.sh`). Its calls to reth and to Canton go through `tests/demo_call_log.py`, which writes down each request. After the demo the rehearsal checks run 1's block on the explorer's page, that Verify answers no (the proof is a stand-in), that the faucet sends 1 tROME and refuses a second request from the same address, and, from the log, that the explorer asked Canton only for the ledger end and the updates, as the reader party.

## Results

**The recorded GPU runs used an earlier leg rule.** Their condition was a balance the holder had to reach, so run 2's terms expected 20 TKA. The current rule requires the holder's balance to rise by exactly the expected amount in this block. The sidecar's `fact` checks the block's state root and its parent's. Both runs in `run.sh` expect a rise of 10 TKA. The Daml tests and the CI rehearsal with a stand-in proof check this rule; it has not had a GPU run.

In [daml/test/src/Zk/ChainTest.daml](../daml/test/src/Zk/ChainTest.daml), `testAdvanceMovesHoldingAndRecordsBlock` and `testALegSettlesInALaterBlock` check successful settlement with the expected rise. `testRefusesABalanceThatDidNotRise`, `testRefusesARiseOfAnotherAmount` and `testRefusesABalanceThatFell` check refusals. `testALeftoverTermsCannotSettleInALaterBlock` checks that an earlier payment cannot settle a leg in a later block. These tests use stub sidecar answers. [tests/demo_rehearsal.sh](../tests/demo_rehearsal.sh) runs `demo/run.sh` with the real balance-proof check and a stand-in proof, and checks that the confirmer called `fact` during validation.

The demo passed its checks on a GPU on 2026-10-04, using the earlier rule: one machine, one NVIDIA RTX PRO 6000, ZisK 1.3.1-alpha, the pinned Canton and reth. Its source commit was `99b2c17161d099cf9f37ccc2e1c082511d8d6ef1`. That commit is from this code's history before the repository was published, so it is not in this repository. The files in `results/` are what the run wrote, with the versions and source commit. `tests/demo_results.sh` (without `--stand-in`) checks that they are complete and agree with each other. It also checks that `run1-proof.hex` carries the recorded programVK and rootC, and run 1's block hash in its public values. The test only reads those fields out of the proof; it does not verify the proof. The sidecar verified it when Canton committed run 1.

| | Run 1, the good block | Run 2, the tampered proof |
|---|---|---|
| EVM block | 3, `0x35f48db7...bbb7`, one transfer of 10 TKA, 51,698 gas | 4, built as `0x44726e79...ec01`, never committed |
| Proof | made in 6.66 s; 1,344 bytes | made in 6.72 s; byte 100 changed after it was made |
| Canton | `Advance` committed; head 2 to 3; the `BlockRecord` holds the proof; the record and V's TKB holding were made by one update (`canton_update` in `run1.txt`) | `Advance` refused with "the sidecar refused the block: no the proof does not verify"; head stays at 3; no new record |
| TKB (U, V) | 90, 0 before the block; 90, 10 after | 80, 10 before and after |
| TKA (U, V) | 0, 1,000 before; 10, 990 after | 10, 990 after |
| After | allocation and terms gone; reth finalized block 3 | allocation and terms still active; reth's latest and finalized blocks are block 3 |
| Time | 0.74 s from the proof file to the end of the builder's run; 8.08 s for the builder's whole run | 7.60 s for the builder's whole run |

The prover was already running, with program setup completed by the smoke test. It ran the guest built by `prover/build-guest.sh`. The programVK and ELF hash in the results files match `prover/fixtures/session.txt`.

These results cover one run on one machine, with test tokens, one operator and one builder. Both sidecars use this project's implementation and ran on the same machine as Canton. The block contains one transfer. The timings describe this run, not a benchmark. `results/smoke.txt` records the `network/` smoke test run before the demo.
