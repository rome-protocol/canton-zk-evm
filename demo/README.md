# demo

This demo runs Ostia, a Canton zkEVM (chain id 770101), on one machine with a local Canton network. It has a setup block and five runs. Two test tokens are used: TKA lives on the EVM, and TKB on Canton (a test token of the Canton token standard). wTKB is TKB's form on the EVM, made by the gateway contract.

**Setup.** In one block V deploys TKA and the gateway makes wTKB. On Canton, U gets 100 TKB, wTKB is registered as the EVM form of TKB, and U signs a standing acceptance of withdrawals.

**Run 1, a deposit.** U puts 10 TKB aside for the gateway and signs a deposit request, and U's EVM address claims 10 wTKB. Canton commits the block and moves the 10 TKB into the gateway's custody in one transaction. U holds 10 wTKB, and the supply of wTKB is 10, as is the custody.

**Run 2, a payment.** U puts 10 TKB aside for V, and U and V sign terms for one payment, identified by an id. V pays U 10 TKA through the gateway with that id, and in the same block sends U 1 TKA by a plain transfer. Canton commits the block and moves the 10 TKB to V in the same transaction. The plain transfer is not the payment: it moves 1 TKA on the EVM and settles nothing on Canton, and it does not get in the way.

**Run 3, a withdrawal.** U's address withdraws 4 wTKB to U's Canton party. Canton commits the block, the gateway pays 4 TKB to U in the same transaction, and the supply and the custody fall to 6.

**Run 4, an allocation taken back.** V pays U 10 TKA for a second payment. U also asks to withdraw 1 wTKB to a party that has not accepted withdrawals, so the builder leaves that transaction out before it proves anything. After the proof is made, U takes its allocation back. `Advance` is refused, nothing moves on Canton, and reth goes back to the last block, so V's payment is not final. The same proven block, sent again without its leg, is refused too. The next builder run leaves the payment out and commits what is left, and TKA, TKB and wTKB are all as after run 3.

**Run 5, a tampered proof.** U allocates again for the payment that is still waiting, and one byte of the proof is flipped on its way to the builder. `Advance` is refused, nothing moves on Canton, and reth goes back to the parent block.

The demo is limited to these runs on one local network with one operator, one builder, test tokens and keys made for the run. The five runs do not run on DevNet; each starts a new local network. `live.sh` (below) runs the three legs on a running chain, as on DevNet on 2026-10-25. On DevNet it also runs `live.sh cycle`, a balanced cycle of the three legs every 10 minutes. The OTC swap (`demo/otc.py`, see "The OTC swap" below) ran on DevNet on 2026-10-27 at 15:55 UTC: the buyer's payment was in block 16816, the claim in block 16823, and a short payment was left out of block 16834 (details in [apps/otc/README.md](../apps/otc/README.md)). The gateway party that holds the locked TKB is hosted on the operator's participant, so whoever runs that participant can move the custody; this is a local proof where one party runs everything. See [docs/DESIGN.md](../docs/DESIGN.md) for the design.

## What is here

| File | What it is |
|---|---|
| `TKA.sol`, `TKA.bin`, `build-token.sh` | The EVM test token (a plain ERC-20 whose supply goes to V when it is deployed), and its creation code. `build-token.sh` compiles the source with the solc image in `PINS`; CI checks that `TKA.bin` is what it gives. |
| `evm.py` | The EVM side: the keys of V and U, the genesis that funds both, and the transactions they send, including the gateway's `register`, `claim`, `withdraw` and `pay`. It also reads TKA and wrapped-token balances and a wrapped token's supply. |
| `canton.py` | The Canton side: loads the token standard's factory and the test token, makes U's holding, registers a wrapped token, makes the acceptance, the deposit request, the allocations and the terms, sends a saved block to Canton again without its legs, and reads back what is on Canton, including which update made a contract and what the gateway holds. |
| `otc.py` | The OTC swap: the commands of a seller on Canton, a venue and a buyer on the EVM (offer, accept, allocate, publish, pay, claim, check, close). It reuses `canton.py` and `evm.py`. See "The OTC swap" below. |
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
explorer/run.sh start        # starts the explorer's database, the indexer and the explorer; open http://127.0.0.1:8088
explorer/run.sh stop         # when finished: also removes the explorer's database, because this network is not persistent
network/down.sh              # removes it too if it is still there
```

The explorer's database lives and dies with this network: the network here is not persistent (no `CZE_PERSIST`), so `explorer/run.sh stop` and `network/down.sh` both remove the database `start` made. Without that, the next run's chain, made from the same genesis, would meet the old chain's rows, and the indexer would stop on them. Run `explorer/run.sh stop` before `network/down.sh`, so the indexer is not left running against a database that is going away.

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
| `evm.py replace <u\|v>` | Replaces each transaction of that sender that waits in reth's pool (not in a block) with a transfer of nothing to itself, at twice the fee and the same nonce. A payment the builder leaves out stays in the pool and holds back the sender's later transactions until it is replaced. |
| `evm.py withdraw <u\|v> <token> <amount> <party>` | Burns wrapped tokens; the Canton token goes to the party, written in full. |
| `evm.py wrapped <token> <holder> [latest\|finalized]` | A holder's balance of a wrapped token and its supply, written as Canton writes amounts (`10.0`). Read at `finalized`, the block Canton has committed. |
| `evm.py describe <token> [latest\|finalized]` | A token's `name()` and `symbol()` (`null` where there is no token). `live.sh setup` reads them at `finalized` and stops unless they are `Wrapped TKB` and `wTKB`. |
| `evm.py wrap <u\|v> <token> <amount>` | Wraps that many whole coins of the chain into WtROME (the wrapped coin at `<token>`), so it can be paid through the gateway. |
| `evm.py wait <tx> [seconds]` | Waits until the transaction is in a block at or below reth's finalized block (a block Canton has committed), and prints the receipt. |
| `evm.py legs <block>` | How many of the block's transactions are gateway calls that make a leg (claim, pay, withdraw), and which. |
| `evm.py give <u\|v> <token> <to> <amount>` | The sender sends that many whole tokens of the token at that address to `<to>`, by the token's own transfer. The live cycle uses it to send the WtROME of a payment back to V. |
| `evm.py block <latest\|finalized\|number>`, `evm.py ether <address>`, `evm.py code <address>`, `evm.py chain` | A block's number, hash and gas used; an address's balance of the chain's coin; the size and Keccak-256 of the code at an address; the chain id. |
| `canton.py register-token <address>` | Registers the wrapped token for TKB (runs `network/canton/propose.py token`). A proposal that an earlier run left for the confirmer is accepted, not made again, once reth says the gateway made the token. |
| `canton.py registered <address>` | Whether the wrapped token is registered for TKB, and whether it is proposed and waiting for the confirmer. |
| `canton.py accepted <u\|v>` | Whether that party's own acceptance of withdrawals is there (not another party's on the participant). |
| `canton.py block <block> [u\|v\|gateway]` | The chain's head and the block's `BlockRecord` (hash, proof's SHA-256). With a party, the record is read from the update that made that party's newest TKB holding: one small read, however long the chain. Without, every record is read. |
| `canton.py balances` | `status` without the chain head and the block records. |
| `canton.py accept <u\|v>` | That party signs a standing acceptance of withdrawals. If it has one already, that one is given and no other is made. |
| `canton.py deposit <label> <address> <amount>` | U allocates TKB to the gateway and signs a deposit request for the EVM address. Prints the deposit id that the claim must carry. |
| `canton.py dvp <label> <token> <payee> <amount>` | U allocates 10 TKB to V, and U and V sign the terms. Prints the payment id that the `pay` must carry. |
| `canton.py payment-id <label>` | The payment id of U, V and the label. |
| `canton.py resubmit <advance.json>` | Sends a block that the builder saved (`block-N/advance.json` in its work folder) to Canton again, with its legs taken out. Canton must refuse it. Exits 2 if it does. |
| `canton.py settled <block> [u\|v\|gateway]` | The Canton update that made the block's `BlockRecord` and the one that made that party's newest TKB holding (V's if none is named). The runs check that they are the same update. |
| `canton.py withdraw-allocation <label>` | U takes back its allocation with that label, as the token standard lets its sender do until the block that settles it commits. Run 4 uses it through `prove-then-withdraw.sh`. |
| `canton.py return-tkb <label> <amount>` | V sends U that much TKB by the token standard's plain transfer (the factory is the token's rules; U accepts the offer if the token makes one). The live cycle uses it to give U the 10 TKB that a payment moved to V. |

`canton.py setup` also writes the list of disclosed contracts (`state/demo/disclosed.json`) that holds the token's rules. The builder takes it with `--disclosed`. The rules are the registry's transfer factory, a withdrawal goes through it, and the participant that submits the block does not host the registry.

`demo/live.sh` runs the deposit, the payment (in WtROME) and the withdrawal on a chain that is already running, on an existing participant (`CZE_CANTON=external`, see `network/README.md`): `live.sh setup` once, then `live.sh legs`, which needs U to hold at least 20 TKB (the deposit and the payment put 10 aside each). A command that fails stops the run. Its header lists its settings.

`live.sh cycle` repeats a balanced cycle for as long as it is asked to. A cycle makes the three runs of `legs` (a deposit of 10 TKB, a payment, a withdrawal of the 10 wTKB that the deposit made), then V sends U the 10 TKB the payment moved (`canton.py return-tkb`) and U sends V the WtROME it was paid (`evm.py give`), so U, V, the custody and wTKB's supply are where they were when the cycle began (V wraps `CZE_LIVE_PAY` of the chain's coin into WtROME once, if it holds less). It needs U to hold 20 TKB and no more, however long it runs. A cycle starts every `CZE_LIVE_CYCLE_MINUTES` (default 10; 0 starts the next at once) until the file `CZE_LIVE_STOP_FILE` exists (default `state/demo/cycle.stop`) or `CZE_LIVE_CYCLES` cycles have run (default 0, no limit). Each cycle makes the checks of `legs` (one leg of its kind in its block, a `BlockRecord` with a proof, the block and the holding from one Canton update, the balances, the custody equal to wTKB's supply) and checks that every balance is back at its start. It appends one line to `CZE_LIVE_RESULTS/cycle-<start time>.txt`: `result=pass` with the three blocks, the Canton updates and the balances, or `result=fail` with the reason. A failed check stops the lane. Nothing is retried, and nothing is minted to cover a difference. Stop the lane by making the stop file; it ends between cycles, and a stop file left from an earlier lane is refused at the start (remove it first). A TERM, INT or HUP during a cycle writes a `result=fail` line for it, because the balances may be part-way through the cycle (up to 20 TKB moved); between cycles it writes `end=signal`. `CZE_LIVE_CYCLE_MINUTES` and `CZE_LIVE_CYCLES` are whole numbers without a leading zero.

`canton.py status` also shows the gateway's custody (its TKB holdings), and the number of active deposit requests and acceptances.

## The OTC swap

A seller who holds TKB on Canton and a buyer who holds TKA on the EVM trade through a venue, in one Canton transaction with the block. The app is the Daml package in [`apps/otc`](../apps/otc/README.md) (it depends only on the token standard); `otc.py` is the venue's driver and the two parties' commands. Here the seller is the Canton party U (the EVM key u is paid), the venue is the Canton party V, and the buyer is the EVM key v, who holds TKA and has no Canton party. Before it: the network is up, the Daml package, `canton.py upload-dars` and `canton.py setup` are done, TKA is deployed, and the wrapped token is registered for TKB (`canton.py register-token`). The builder runs with `--venue <V's party id>`, so that it takes the seller's allocation, which it cannot see, as the trade's (the venue's driver discloses it, as the trade's `allocationDisclosed`).

```
apps/otc/build.sh                                     # once: dist/otc-venue.dar
python3 demo/otc.py upload-dar                        # once: the package, into the users participant
python3 demo/otc.py offer swap-1 2.5 <TKA> 2          # the seller: 2.5 TKB for 2 TKA, paid to the seller's EVM address
python3 demo/otc.py accept swap-1                     # the venue: the trade, and the request to allocate
python3 demo/otc.py allocate swap-1                   # the seller allocates, through the token's own factory, with the trade's spec
python3 demo/otc.py publish swap-1                    # the venue's driver: the VenueTrade, with the allocation disclosed
python3 demo/otc.py pay swap-1 "" 600                 # the buyer: approve, then pay through the gateway; wait for the block
python3 demo/otc.py claim swap-1 600                  # the buyer claims the wrapped TKB, in a later block
python3 demo/otc.py check swap-1                      # Canton and EVM balances, and that the funded claim is gone
python3 demo/otc.py close swap-2                      # the venue ends a trade it will not settle: the venue's trade archived, the allocation taken back
```

`pay` without an amount pays the trade's; `pay swap-1 1` is the refused case: the buyer pays less than the trade names, the builder leaves the payment out of the block, and nothing moves on either side: `check` still shows the seller's allocation, the venue's trade and no funded claim. The short payment does not go away, though: it stays pending in reth's pool and holds back every later transaction of the buyer's key, so the buyer must replace it (same nonce, `evm.py replace v`) before sending anything else. `claim` stops with an error until the trade's block is committed on Canton (the funded claim is what it redeems), so it always goes in a block after the trade's. `otc.py` with no arguments prints every command.

The driver checks what the chain does not. The chain ties the Canton side of a trade to nothing but the seller's allocation, so `publish` takes only an allocation that is the trade's own: its settlement (the venue as executor, the label as reference, the times) and its one leg (the seller to the gateway, the trade's instrument and amount) must equal what `allocate` makes from the Trade. An allocation with the same label but another amount, executor or receiver is refused, and so is a trade past its settle-before time. A builder started with `--venue` cannot see a withdrawn allocation, so the venue runs `close` for a trade it will not settle.

Settling on this chain needs the seller's signature on the VenueTrade (it is signed by the venue and the seller), so `publish` submits as both: the seller's party must be hosted where the venue's driver can act as it, or the seller co-submits. In this demo the seller and the venue are on the same participant. The driver therefore has the seller's authority on the Ledger API, which the seller's own allocation does not give it.

## How the Canton side is set up

- Everything goes through the participants' JSON Ledger API. The network runs without Ledger API authentication (see [network/README.md](../network/README.md)), so one Ledger API user, `demo`, acts for U, V and the registry, which are all on the same participant. A real wallet would sign for each of them separately.
- U's holding is a `Token` of the Splice reference test token, signed by U and by the registry that issues it. U allocates through the token standard's own factory with the operator as executor and V as receiver; the token registry's rules contract is passed to that call as a disclosed contract, because U is not a stakeholder of it.
- The terms are `DvpTerms` of the Daml package: the chain id, a label, the payment id, TKA's address, the payee's EVM address, the amount of TKA in base units as 64 hex digits, and the allocation. The payment id is the SHA-256, in lowercase hex, of the UTF-8 bytes of the text `<U's party id>,<V's party id>,<label>`; the template refuses any other id. `canton.py dvp` makes it that way and prints it, and the `pay` that V sends on the EVM (`evm.py pay`) carries that same 32-byte value.
- The builder runs with `--read-as <operator>` and `--read-as <gateway>`, which let it see the allocations (their executor is the operator, so the builder, a different party, cannot see them otherwise) and the gateway's holdings, and with `--disclosed` pointing at the registry's rules contract. A block with a withdrawal needs `--disclosed` (and `--read-as <gateway>` for the gateway's holdings), because the withdrawal goes through the registry's transfer factory.

## The rehearsal

CI has no GPU, so `tests/demo_rehearsal.sh` runs the same `demo/run.sh` with a stand-in proof. It uses the real reth, Canton, Daml package, token standard and builder. The real sidecar checks the gateway's legs against reth's storage proofs. A stand-in prover writes a 1,344-byte proof: fixed bytes, then public values that commit to the block's hash, so the builder's check of the proof's block hash runs as it does for a real one. `tests/demo_sidecar.py` answers the block check (`verify2`; `verify` under 0.1.0 and 0.2.0), accepting only such a proof for the block it is asked about and otherwise reading the block as the real sidecar does. The rehearsal covers everything except the zero-knowledge proof check, which the sidecar's own tests and the GPU run cover. The rehearsal's results are not recorded.

It also builds the explorer's image and runs it beside the chain (`explorer/run.sh`). Its calls to reth and to Canton go through `tests/demo_call_log.py`, which writes down each request. The explorer runs with its own database and its indexer, which `explorer/run.sh start` starts; after the demo the rehearsal waits for the indexer, then checks run 1's block on the explorer's page, that Verify answers no (the proof is a stand-in), that the faucet sends 1 tROME and refuses a second request from the same address, and, from the log, that the explorer and its indexer asked Canton only for the ledger end, the updates and the participant id (the updates as the reader party, for the block record alone).

## Results

The demo passed all its checks on a GPU on 2026-10-05 (on the Canton and compiler snapshots named below; `PINS` now pins the releases), from commit `6b445073163832e9023850f53678617d90dfc808` of this repository (6b44507): one machine, one NVIDIA RTX PRO 6000 Blackwell Server Edition (driver 580.178.04), ZisK 1.3.1-alpha, reth 2.5.2 and Canton 3.6.0-snapshot.20260930.20337.0.ve610bc8f. `network/up.sh` built the guest and found it has the recorded programVK, `0xdb79251d9e962ee45fbc28cc6431a7fb894106f06d6664e623189f28c24f6d3f`. The gateway's code hash is `0xaba3bb1e3a76203fc9a546f93ff08985734ff78ea3c6f79b541acb91d0c08643`. The files in `results/` are what `network/smoke.sh` and `demo/run.sh` wrote, between 13:38:44 UTC (the smoke test) and 13:40:03 UTC (run 5), with the versions and the source commit. `tests/demo_results.sh` checks that they are complete and agree with each other, and `tests/demo_static.sh` runs that check.

| | EVM block | What happened | Proof | From the proof file to the end of the builder's run | The builder's whole run |
|---|---|---|---|---|---|
| Smoke test | 1, empty | `Advance` committed it; the head moved to 1; the block record was seen by the reader; reth marked it final | 6.31 s | 0.49 s | 155.20 s |
| Setup | 2, V's deploy of TKA and the registration of wTKB; no legs | committed; wTKB registered on Canton; U has 100 TKB | 6.71 s | not recorded | 8.00 s |
| Run 1, a deposit | 3, U's claim of 10 wTKB; 122,308 gas | one deposit leg; committed; head 2 to 3; the block record and the gateway's new 10 TKB holding were made by one Canton update | 6.72 s | 0.66 s | 8.14 s |
| Run 2, a payment | 4, V's approval, V's payment of 10 TKA and V's plain transfer of 1 TKA; 185,307 gas | one payment leg; committed; head 3 to 4; the block record and V's new 10 TKB holding were made by one update | 6.72 s | 0.42 s | 7.87 s |
| Run 3, a withdrawal | 5, U's withdrawal of 4 wTKB; 90,345 gas | one withdrawal leg; committed; head 4 to 5; the block record and U's new 4 TKB holding were made by one update | 6.72 s | 0.58 s | 8.02 s |
| Run 4, an allocation taken back | 6, built as `0x11461bde...0622`, refused; then built again and committed as `0x10c492ad...21d5` | the withdrawal to the party without an acceptance was left out before proving. U took its allocation back after the proof: the builder exited with status 2, Canton refused with `CONTRACT_NOT_FOUND` for U's dvp-2 allocation, and the head stayed at 5. The saved block, sent again without its leg, was refused with "the legs are not the ones the block recorded". The next builder run left out the payment and the withdrawal, and committed V's approval alone, with no leg; head 6 | 6.75 s (first build) | refused; not timed | 8.09 s, then 8.04 s |
| Run 5, a tampered proof | 7, built as `0xb6b7ce4a...3612`, never committed | the builder exited with status 2; `Advance` was refused with "the sidecar refused the block: no the proof does not verify"; the head stayed at 6 and the block records at 6; U's new allocation for dvp-2 is still active | 6.74 s; byte 100 changed after it was made | refused; not timed | 7.57 s |

The time "from the proof file to the end of the builder's run" includes fetching the gateway's account and storage proofs from reth (one `eth_getProof` call), the `Advance` call, its commit on both confirmers, and reth marking the block final, so it is more than Canton's commit alone. The builder matches the legs to Canton contracts before it proves the block, so that work is not in it. The proof for the second build in run 4 was made and not timed separately. The smoke test's whole builder run includes the witness, the input and the prover's one-time program setup.

Balances after each run (TKB on Canton, TKA and wTKB on the EVM at the finalized block). Where a run's file does not record a balance, the value is the one the next run recorded before it changed anything:

| After | TKB: U, V, gateway's custody | TKA: U, V | wTKB: U, supply |
|---|---|---|---|
| Setup | 100, 0, 0 | 0, 1,000 | 0, 0 |
| Run 1 | 90, 0, 10 | 0, 1,000 | 10, 10 |
| Run 2 | 80, 10, 10 | 11, 989 | 10, 10 |
| Run 3 | 84, 10, 6 | 11, 989 | 6, 6 |
| Run 4, after the rebuilt block | 84, 10, 6 | 11, 989 | 6, 6 |
| Run 5, nothing committed | 74, 10, not recorded (U's new allocation of 10 TKB is active) | 11, 989 | not recorded |

The prover was already running, and the smoke test had done its one-time program setup. It ran the guest built by `prover/build-guest.sh`; the programVK and the ELF hash in the results files match `prover/fixtures/session.txt`. The `rootC` in the results is `0xc3f12b9f8707c6a1e96df2bf6702c2ebdfbafedabeac654644a380befe091ac4`.

After the runs, the explorer was started on the same chain (`explorer/run.sh start`, with no restart of the network and without the faucet's setup) and opened in a browser. It was healthy, its pins were this run's, and it listed blocks 1 to 6 as Final. On block 3's page, Verify answered "Passed.": the check ran in the browser in 13 ms, and about 0.35 s passed from the click to the answer. The panel says that the proof verifies under ZisK 1.3.1's key, that program `0xdb79...6d3f` and ZisK release `0xc3f1...1ac4` made it, and that it commits to block hash `0x4a1e...3f1d`. The faucet page loaded and said that the faucet was off, because the faucet was not set up for this run. There were no errors in the browser console. This walk is not recorded in `results/`.

These results cover one run on one machine, with test tokens, one operator and one builder. Both sidecars use this project's implementation and ran on the same machine as Canton. The timings describe this run, not a benchmark. Run 4 checks that a block sent again without its leg is refused. The Daml tests check more refusals than the GPU runs do (an extra leg, another chain's contracts, another instrument, an acceptance of another party); the CI rehearsal runs the same steps with a stand-in proof.

The results of an earlier version of the demo, which had two runs and a different rule for a leg (a leg settled when the holder's balance rose by the expected amount in the proven block), are in this repository's history at its first commit, `c6d81619c05ad8efa76cd0345178f01410a3dac9`. They no longer describe how the chain works.
