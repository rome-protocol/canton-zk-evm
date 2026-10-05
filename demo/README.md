# demo

The first proof of Ostia, a Canton zkEVM (chain id 770101), run on one machine with a local Canton network. It has a setup block and five runs. Two test tokens are used: TKA lives on the EVM, and TKB on Canton (a test token of the Canton token standard). wTKB is TKB's form on the EVM, made by the gateway contract.

**Setup.** In one block V deploys TKA and the gateway makes wTKB. On Canton, U gets 100 TKB, wTKB is registered as the EVM form of TKB, and U signs a standing acceptance of withdrawals.

**Run 1, a deposit.** U puts 10 TKB aside for the gateway and signs a deposit request, and U's EVM address claims 10 wTKB. Canton commits the block and moves the 10 TKB into the gateway's custody in one transaction. U holds 10 wTKB, and the supply of wTKB is 10, as is the custody.

**Run 2, a payment.** U puts 10 TKB aside for V, and U and V sign terms for one payment, identified by an id. V pays U 10 TKA through the gateway with that id, and in the same block sends U 1 TKA by a plain transfer. Canton commits the block and moves the 10 TKB to V in the same transaction. The plain transfer is not the payment, so it settles nothing, and it is no obstacle.

**Run 3, a withdrawal.** U's address withdraws 4 wTKB to U's Canton party. Canton commits the block, the gateway pays 4 TKB to U in the same transaction, and the supply and the custody fall to 6.

**Run 4, the gap is closed.** V pays U 10 TKA for a second payment. U also asks to withdraw 1 wTKB to a party that has not accepted withdrawals, so the builder leaves that transaction out before it proves anything. After the proof is made, U takes its allocation back. `Advance` is refused, nothing moves on Canton, and reth goes back to the last block, so V's payment is not final. The same proven block, sent again without its leg, is refused too. The next builder run leaves the payment out and commits what is left, and TKA, TKB and wTKB are all as after run 3.

**Run 5, a tampered proof.** U allocates again for the payment that is still waiting, and one byte of the proof is flipped on its way to the builder. `Advance` is refused, nothing moves on Canton, and reth goes back to the parent block.

The demo is limited to these runs on one local network with one operator, one builder, test tokens and keys made for the run. Ostia does not yet run as a standing network; each run starts a new one. The gateway party that holds the locked TKB is hosted on the operator's participant, so whoever runs that participant can move the custody; this is a local proof where one party runs everything. See [docs/DESIGN.md](../docs/DESIGN.md) ("The first proof") for the first version of the design.

## What is here

| File | What it is |
|---|---|
| `TKA.sol`, `TKA.bin`, `build-token.sh` | The EVM test token (a plain ERC-20 whose supply goes to V when it is deployed), and its creation code. `build-token.sh` compiles the source with the solc image in `PINS`; CI checks that `TKA.bin` is what it gives. |
| `evm.py` | The EVM side: the keys of V and U, the genesis that funds both, and the transactions they send, including the gateway's `register`, `claim`, `withdraw` and `pay`. It also reads TKA and wrapped-token balances and a wrapped token's supply. |
| `canton.py` | The Canton side: loads the token standard's factory and the test token, makes U's holding, registers a wrapped token, makes the acceptance, the deposit request, the allocations and the terms, sends a saved block to Canton again without its legs, and reads back what is on Canton, including which update made a contract and what the gateway holds. |
| `prepare.sh` | Run once before `network/up.sh`: Python packages (by hash), the two keys, and the funded genesis. |
| `run.sh` | The setup and the five runs. It checks every claim and stops at the first one that does not hold, then writes `results/`. |
| `prove-tampered.sh` | The demo-only switch of run 5: a prover command that runs the real prover and then flips one hex digit of the proof. It exists only here; nothing in `network/` or `builder/` knows about it. |
| `prove-then-withdraw.sh` | The demo-only switch of run 4: a prover command that runs the real prover and then makes U take an allocation back, so the allocation is gone between the proof and the commit. It exists only here, like `prove-tampered.sh`. |
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

`prepare.sh` makes V's key in `state/demo/v.key` and U's in `state/demo/u.key` (both mode 0600, never printed). The genesis it writes is `network/genesis.json` plus 10 ether for each of them, so that both can pay for gas; the chain settings are the same, and `network/make-state.sh` refuses a genesis whose settings differ. `network/genesis.json` itself stays unfunded.

`run.sh` works from any chain height, so the smoke test before it is not needed. Its blocks, counted from the chain's head when it starts, are:

1. the setup block: V deploys TKA (and receives 1,000 TKA) and the gateway makes wTKB, with no legs;
2. run 1's block: U's claim of 10 wTKB and its deposit leg;
3. run 2's block: V's approval, V's payment of 10 TKA and its payment leg, and V's plain transfer of 1 TKA;
4. run 3's block: U's withdrawal of 4 wTKB and its withdrawal leg;
5. run 4's block, built and proven twice over: the first time with V's approval and payment, which Canton refuses; the second time, after the refusal, with the approval alone, which commits;
6. run 5's block, which is built and proven but never committed.

Every proof is made by the prover command, seven in all. `run.sh` also records the gateway's code hash, which `network/up.sh` has already checked against the contract.

## What the runs check

Every run that commits checks that the builder's exit status is 0, that Canton's chain record is at the new block and its hash, that the `BlockRecord` holds the proof the prover wrote and the block's hash, that reth's finalized block is the new block, and that the balances are what the run should leave, read on both chains: TKB of U, of V and of the gateway's custody on Canton, TKA and wTKB on the EVM, and the supply of wTKB. The EVM balances are read at the finalized block, the one Canton has committed. Each run also checks how many legs the builder attached and of which transactions, and which transactions it left out. In runs 1 to 3 the `BlockRecord` and the new TKB holding that the leg made were made by the same Canton update (their update id and offset, read on one participant, are equal; the id is written to `results/` as `canton_update`).

- Run 1: one deposit leg; the gateway's new 10 TKB holding and the block record come from one update; U holds 10 wTKB, and the supply and the custody are 10; U's allocation and the deposit request are gone.
- Run 2: one payment leg, from V's `pay`; V's plain transfer is in the block and made no leg; V's new 10 TKB holding and the block record come from one update; U holds 11 TKA and V 989; U's allocation and the terms are gone.
- Run 3: one withdrawal leg; U's new 4 TKB holding and the block record come from one update; U holds 6 wTKB, and the supply and the custody are 6.
- Run 4: the builder left out the withdrawal to the party without an acceptance, and said why, before it proved anything. After U took the allocation back, the builder's exit status is 2 and Canton refused the block with `CONTRACT_NOT_FOUND` for U's dvp-2 allocation. Canton's chain record and block records are as they were, U has its TKB back, the gateway paid nothing, and reth's latest and finalized blocks are run 3's block again; the EVM balances are as after run 3. The saved block, sent again without its leg, is refused with "the legs are not the ones the block recorded" (exit status 2 of `canton.py resubmit`). The next builder run leaves out the payment and the withdrawal, each with its reason, commits V's approval alone with no leg, and leaves every balance as it was after run 3.
- Run 5: the builder's exit status is 2, the block carried its payment leg, and Canton's answer is exactly "the sidecar refused the block: no the proof does not verify"; the chain record and the block records are as they were; U's new allocation for dvp-2 is still active; reth's latest and finalized blocks are run 4's block again.

The first thing the sidecar checks is the proof, so flipping a byte of it is refused there, before anything else is looked at.

## The helper commands

These are what the demo scripts call. Both programs print one JSON object per command and need the packages in `requirements.txt`.

| Command | What it does |
|---|---|
| `evm.py register <u\|v> <name> <symbol>` | The gateway makes a wrapped token. Prints the transaction and the address the token will have. |
| `evm.py approve <u\|v> <token> <spender> <amount>` | Lets the spender (an address, or the word `gateway`) take that many whole TKA. |
| `evm.py pay <u\|v> <payment id> <token> <to> <amount>` | Pays that many whole TKA through the gateway, against the payment with that id. |
| `evm.py claim <u\|v> <deposit id> <token> <amount>` | Claims a deposit: the gateway mints that many wrapped tokens to the sender. An amount is written as on Canton, such as `10` or `0.5`, with up to 10 decimals. |
| `evm.py withdraw <u\|v> <token> <amount> <party>` | Burns wrapped tokens; the Canton token goes to the party, written in full. |
| `evm.py wrapped <token> <holder> [latest\|finalized]` | A holder's balance of a wrapped token and its supply, written as Canton writes amounts (`10.0`). Read at `finalized`, the block Canton has committed. |
| `canton.py register-token <address>` | Registers the wrapped token for TKB (runs `network/canton/propose.py token`). |
| `canton.py accept <u\|v>` | That party signs a standing acceptance of withdrawals. |
| `canton.py deposit <label> <address> <amount>` | U allocates TKB to the gateway and signs a deposit request for the EVM address. Prints the deposit id that the claim must carry. |
| `canton.py dvp <label> <token> <payee> <amount>` | U allocates 10 TKB to V, and U and V sign the terms. Prints the payment id that the `pay` must carry. |
| `canton.py payment-id <label>` | The payment id of U, V and the label. |
| `canton.py resubmit <advance.json>` | Sends a block that the builder saved (`block-N/advance.json` in its work folder) to Canton again, with its legs taken out. Canton must refuse it. Exits 2 if it does. |
| `canton.py settled <block> [u\|v\|gateway]` | The Canton update that made the block's `BlockRecord` and the one that made that party's newest TKB holding (V's if none is named). The runs check that they are the same update. |
| `canton.py withdraw-allocation <label>` | U takes back its allocation with that label, as the token standard lets its sender do until the block that settles it commits. Run 4 uses it through `prove-then-withdraw.sh`. |

`canton.py setup` also writes the list of disclosed contracts (`state/demo/disclosed.json`) that holds the token's rules. The builder takes it with `--disclosed`. The rules are the registry's transfer factory, a withdrawal goes through it, and the participant that submits the block does not host the registry.

`canton.py status` also shows the gateway's custody (its TKB holdings), and the number of active deposit requests and acceptances.

## How the Canton side is set up

- Everything goes through the participants' JSON Ledger API. The network runs without Ledger API authentication (see [network/README.md](../network/README.md)), so one Ledger API user, `demo`, acts for U, V and the registry, which are all on the same participant. A real wallet would sign for each of them separately.
- U's holding is a `Token` of the Splice reference test token, signed by U and by the registry that issues it. U allocates through the token standard's own factory with the operator as executor and V as receiver; the token registry's rules contract is passed to that call as a disclosed contract, because U is not a stakeholder of it.
- The terms are `DvpTerms` of the Daml package: the chain id, a label, the payment id, TKA's address, the payee's EVM address, the amount of TKA in base units as 64 hex digits, and the allocation. The payment id is the SHA-256, in lowercase hex, of the UTF-8 bytes of the text `<U's party id>,<V's party id>,<label>`; the template refuses any other id. `canton.py dvp` makes it that way and prints it, and the `pay` that V sends on the EVM (`evm.py pay`) carries that same 32-byte value.
- The builder runs with `--read-as <operator>` and `--read-as <gateway>`, which let it see the allocations (their executor is the operator, so the builder, a different party, cannot see them otherwise) and the gateway's holdings, and with `--disclosed` pointing at the registry's rules contract. A block with a withdrawal needs `--disclosed` (and `--read-as <gateway>` for the gateway's holdings), because the withdrawal goes through the registry's transfer factory.

## The rehearsal

CI has no GPU, so `tests/demo_rehearsal.sh` runs the same `demo/run.sh` with a stand-in proof. It uses the real reth, Canton, Daml package, token standard and builder. The real sidecar checks the gateway's legs against reth's storage proofs. A stand-in prover writes one fixed 1,344-byte proof. `tests/demo_sidecar.py` answers the `verify` call, accepting only that proof and otherwise reading the block as the real sidecar does. The rehearsal covers everything except the zero-knowledge proof check, which the sidecar's own tests and the GPU run cover. The rehearsal's results are not recorded.

It also builds the explorer's image and runs it beside the chain (`explorer/run.sh`). Its calls to reth and to Canton go through `tests/demo_call_log.py`, which writes down each request. After the demo the rehearsal checks run 1's block on the explorer's page, that Verify answers no (the proof is a stand-in), that the faucet sends 1 tROME and refuses a second request from the same address, and, from the log, that the explorer asked Canton only for the ledger end and the updates, as the reader party.

## Results

**The recorded results below are those of the first version of the demo.** That version had two runs and a different rule for a leg: it settled when the holder's balance rose by exactly the expected amount in the proven block, checked with the sidecar's `fact`. `run.sh` now runs the setup and five runs described above, and its results (`setup.txt`, `run1.txt` to `run5.txt`, and the proofs of the blocks that committed) replace these when they are recorded on a GPU. Until then the files in `results/` and the table below describe the first version only.

The demo passed its checks on a GPU on 2026-10-04 (run 1's results written at 20:34:01 UTC, run 2's at 20:34:10 UTC): one machine, one NVIDIA RTX PRO 6000, ZisK 1.3.1-alpha, the pinned Canton and reth. It ran from this repository's first commit, `c6d81619c05ad8efa76cd0345178f01410a3dac9`. The results files name that commit `3c17de6e007ccf31b7b4f58c4b13916e849cbd8d`, the id it had before it was published with Rome Protocol as its author. The files are the same: both ids have the tree `fb352451ecdb0b3bfc1118c2cfae9a0e8b38e63e` (`git rev-parse c6d81619c05a^{tree}`). The files in `results/` are what the run wrote, with the versions and source commit. These files are in the first version's format. `tests/demo_results.sh` now checks the present demo's results, and `tests/demo_static.sh` leaves these unchecked until a GPU run replaces them.

| | First version, run 1: the good block | First version, run 2: the tampered proof |
|---|---|---|
| EVM block | 3, `0x7ca88b39...fb14`, one transfer of 10 TKA, 51,698 gas | 4, built as `0x68b498b6...4ece`, never committed |
| Proof | made in 6.76 s; 1,344 bytes | made in 6.66 s; byte 100 changed after it was made |
| Canton | `Advance` committed; head 2 to 3; the `BlockRecord` holds the proof; the record and V's TKB holding were made by one update (`canton_update` in `run1.txt`) | `Advance` refused with "the sidecar refused the block: no the proof does not verify"; head stays at 3; no new record |
| TKB (U, V) | 90, 0 before the block; 90, 10 after | 80, 10 before and after |
| TKA (U, V) | 0, 1,000 before; 10, 990 after | 10, 990 after |
| After | allocation and terms gone; reth finalized block 3 | allocation and terms still active; reth's latest and finalized blocks are block 3 |
| Time | 0.83 s from the proof file to the end of the builder's run; 8.28 s for the builder's whole run | 7.51 s for the builder's whole run |

The prover was already running, with program setup completed by the smoke test. It ran the guest built by `prover/build-guest.sh`. The programVK and ELF hash in the results files match `prover/fixtures/session.txt`.

These results cover one run on one machine, with test tokens, one operator and one builder. Both sidecars use this project's implementation and ran on the same machine as Canton. The block contains one transfer. The timings describe this run, not a benchmark. `results/smoke.txt` records the `network/` smoke test run before the demo.
