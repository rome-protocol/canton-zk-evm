# builder

Makes one block, gets it proven and submits it to Canton. Only Canton's commit can finalize the block and determine its order. See [docs/DESIGN.md](../docs/DESIGN.md) ("One block") for the flow. The builder follows the Daml interface in [daml/README.md](../daml/README.md).

## What one run does

```sh
python3 builder/builder.py once [--exclude <tx hash>]... [--read-as <party>]... [--disclosed <file>]
```

1. **Read Canton's head.** It asks the JSON Ledger API v2 for the chain's one active `ZkChain` contract whose `builder` is this builder's party (a chain built by another party, seen through `--read-as`, is not counted): head number, head hash, gas cap. It then moves reth's head, safe and finalized block to that head, so a run after a crash starts clean.
2. **Choose and build.** It reads reth's pending pool (`txpool_content`, on the builder-only WebSocket port) and takes transactions best price first, each sender's in nonce order, while their gas limits fit under the lower of the chain's gas cap and the parent's gas limit. A transaction that does not fit, or is named with `--exclude`, ends its sender's turn, because the sender's later ones could not run without it. It fetches each chosen transaction's raw bytes and calls `testing_buildBlockV1` on Canton's head with that list. The list is always explicit; an empty block is `[]`, never null, because a null makes reth fill the block from its pool. The attributes are Prague's: a timestamp from the builder's clock and later than the parent's, the fee recipient, zero `prevRandao` and `parentBeaconBlockRoot`, and `withdrawals: []`.
3. **Make it reth's head.** `engine_newPayloadV4`, then `engine_forkchoiceUpdatedV3` with head = the new block and safe = finalized = Canton's head. Every Engine call carries an HS256 token (`iat` = now) signed with the per-run secret in `jwt.hex`.
4. **Prove it.** It saves the block and reth's execution witness, runs `make-input.sh` on them, then the prover command on the input. Before proving it removes any `wrapped-proof.hex` an earlier run left for this block number, so an old proof is never taken for this one; it then reads the 1,344-byte wrapped proof the prover leaves, and fails if there is none.
5. **Legs.** For each `DvpTerms` of this chain that the builder can see, a leg is attached only if all of these hold, checked after the proof is made and just before the submit:
   - the terms name the chain's own operator and confirmer (a terms contract of this chain with another operator or confirmer is skipped);
   - the terms' allocation is still active and visible to the builder, and the participant shows its view (it asks the Ledger API for the active contracts of the token standard's `Allocation` interface, with the interface view, and looks for the id);
   - the allocation's settle-before time has not passed, by the builder's clock;
   - the allocation's executor is the chain's operator, its sender is the terms' `u` and its receiver is the terms' `v`;
   - the holder's balance rose by exactly the amount the terms expect in this block. It asks reth for `eth_getProof` of the token's account and of the holder's balance slot at the new block and at its parent (Canton's head), and compares the difference of the two storage values with `expected` as numbers. A balance that was already there, one that rose by another amount and one that fell are all skipped, and so are terms whose token has no code in the parent block (it did not exist there, so no balance can be proven in that state). The slot's key is `keccak256(holder, slot)` as Solidity lays out a mapping;
   - no other terms in this block point at the same allocation, which can be executed once. When two do, both are left out; the builder does not choose between them;
   - no earlier terms in this block name the same token and holder: one payment settles one terms, and Daml refuses a block with two. The builder keeps the first it reads from Canton and skips the others with that reason; they can wait for a payment of their own. Terms left out for the allocation rule above do not take the place.

   Terms that fail a check are omitted from this block. The block lands without those legs, and the run's JSON line lists their terms ids and reasons in `skippedTerms`. A later block can carry them. An allocation withdrawn after the check can still make Canton refuse the block. The next run sees that allocation is gone and skips it.
6. **Submit.** One `Advance` on the `ZkChain` contract, as the builder party, with `headerHex`, `txsHex`, `proofHex` and the legs (each with the balance's proofs at the block and at its parent), in the formats of `daml/README.md`; `txsHex` is empty (`""`) for a block with no transactions. The header and the transaction list are cut from reth's raw block (`debug_getRawBlock`) as they sit there; the builder checks the header hashes to the block hash.
7. **After Canton answers.** If it committed, `engine_forkchoiceUpdated` with finalized = the new block. If it refused, reth goes back to Canton's head (head = safe = finalized), and the run reports the reason and the hashes of the transactions it chose. A reply that is lost (the connection dropped, a timeout, an answer that is not HTTP or not JSON) is not taken for a refusal: the builder reads the head again, and counts the block as committed if Canton's head is now this block. If the head cannot be read either, the outcome is not known: the run prints `{"committed": null, "reason": "...", ...}`, exits 2 and leaves reth where it is, because moving it back could undo a block Canton committed. The next run starts from Canton's head, whichever it is.

Any other failure after reth moved also moves reth back to Canton's head.

Exit status: 0 committed, 2 refused by Canton or not known (`"committed": null`), 1 any other failure. Every run prints exactly one JSON line on stdout, failures included (a missing setting, an unreadable secret, no `ZkChain` contract or two of them, a reply that is not JSON, a failing prover): `{"committed": false, "error": "..."}` and exit 1.

## What the builder can see

These two options affect visibility only when supplied:

- `--read-as <party>` (repeatable) adds that party to every Ledger API read and to `readAs` of `Advance`. The builder still acts only as itself. This is how a builder hosted by the operator sees the allocations whose executor is the operator.
- `--disclosed <file>` is a JSON list of disclosed contracts, each as the Ledger API takes it (`templateId`, `contractId`, `createdEventBlob`, `synchronizerId`). The list is passed with `Advance` as `disclosedContracts`, for example the contracts of the token registry. A file that is missing or is not a JSON list of objects fails the run before anything moves.

## What reth needs

Start reth only with `network/reth/launch.sh`, with discovery off as it always is. The builder relies on these flags, which `launch.sh` passes and checks:

| Flag | Why |
|---|---|
| `--engine.always-process-payload-attributes-on-canonical-head` and `--engine.allow-unwind-canonical-header` | Needed together. Both let reth move its head back to Canton's head on a forkchoice update (reth 2.5.2, `apply_chain_update`), which the builder does at the start of every run and after a block Canton refused. `testing_buildBlockV1` builds on the parent it is given. |
| `--builder.gaslimit <cap>` | Set to the chain's gas cap (`GAS_CAP` in `PINS`, equal to the genesis gas limit), so a block reth builds is never over the cap. |
| `--rpc.eth-proof-window 1` | Lets `eth_getProof` answer for the block before the newest one. A leg needs the balance's proof at the new block and at its parent, and reth's default (0) refuses the parent with "distance to target block exceeds maximum proof window". |

Without them the builder's builds or its move back can fail.

## Settings

All from the environment.

| Variable | Meaning |
|---|---|
| `CZE_LEDGER_USER`, `CZE_BUILDER_PARTY`, `CZE_FEE_RECIPIENT` | Required: the Ledger API user, the builder party, the address that gets the block's fees. |
| `CZE_LEDGER_URL` | JSON Ledger API, default `http://127.0.0.1:7575`. |
| `CZE_LEDGER_TOKEN` | Bearer token for the Ledger API, if the participant wants one. |
| `RETH_WS_PORT`, `RETH_ENGINE_PORT` | Ports of the reth that `network/reth/launch.sh` started, as there (8546 and 8551). |
| `CZE_STATE_DIR` | Where `jwt.hex` is, as for `launch.sh` (default `./state`). Work files go to `$CZE_STATE_DIR/builder` unless `CZE_WORK_DIR` says otherwise. |
| `CZE_GENESIS` | The genesis file given to `make-input.sh` (default `network/genesis.json`). |
| `CZE_MAKE_INPUT_CMD` | Default `prover/make-input.sh`. Called with `<block.json> <witness.json> <genesis.json> <out.bin>`. |
| `CZE_PROVE_CMD` | Default `prover/prove-one.sh`. Called with `<input.bin> <out-folder>`; it must leave `<out-folder>/wrapped-proof.hex`. |

The prover is whatever `CZE_PROVE_CMD` runs. By default that is `prove-one.sh`, which sends the input to the prover through ZisK's own remote client, so `ZISK_COORDINATOR_URL` says which prover host. `prove-one.sh` also runs `cargo-zisk verify` on the proof; that check is not made under the pinned keys (`programVK`, `rootC`). The check under the pinned keys is the sidecar's, in Canton's confirmers. Any other command with the same two arguments works, for example a script that copies the input to the prover host over SSH and brings the proof back.

## Tests

```sh
pip install --require-hashes -r builder/requirements.txt    # the WebSocket client, pinned
python3 -m unittest discover -s builder/tests
```

Python 3.12, standard library plus `websockets`. The tests use only fakes in `builder/tests/`: reth's WebSocket and Engine ports, the Ledger API, and shell scripts for the prover and input tool. The fake Engine port checks the token as reth does. Tests cover a good block end to end, a refusal and the move back, a failing prover, the token, the explicit transaction list and the gas cap. Leg checks cover a withdrawn allocation, a rise of another amount, a balance that was already there, a balance that fell, a token missing in the parent, two terms for one token and holder, a passed settle-before time, another executor, sender or receiver, and two terms for one allocation. In each case the block lands without the leg and reports it. Visibility tests cover `--read-as` and `--disclosed`, including unchanged behavior when omitted. Recovery tests cover a lost reply, a connection dropped after commit, a reply that is not HTTP, and a lost reply with Canton's head unreadable (`committed: null`, exit 2, reth left where it is, the next run re-anchors). Tests also check an empty block's `txsHex`, that an old proof is never used, one JSON line and the exit status on every failure, and Keccak-256 against a real header. The fakes follow reth and Ledger API documentation. The end-to-end run uses the real services.

## Not here

- No check of the proof under the pinned keys before submitting it; the builder checks only its size and form. Canton's confirmers check it.
- No step cap before proving. A block the prover cannot finish stops the run at the prover.
- One block per run. No loop, and no choosing between terms beyond the tests in step 5: every `DvpTerms` of the chain that the builder can see and that passes them becomes a leg, except that of several terms for one token and holder the first wins.
- The builder needs read access to the allocations it settles. This repository uses `--read-as` to give it the view of a party that can see them. A deployment must grant that access; an allocation the builder cannot see causes it to skip the terms.
