# builder

Makes one block, gets it proven and submits it to Canton. Only Canton's commit can finalize the block and determine its order. See [docs/DESIGN.md](../docs/DESIGN.md) ("One block") for the flow. The builder follows the Daml interface in [daml/README.md](../daml/README.md).

## What one run does

```sh
python3 builder/builder.py once [--exclude <tx hash>]... [--read-as <party>]... [--disclosed <file>]
```

1. **Read Canton's head.** It asks the JSON Ledger API v2 for the chain's one active `ZkChain` contract whose `builder` is this builder's party (a chain built by another party, seen through `--read-as`, is not counted): head number, head hash, gas cap, the gateway party and the gateway contract's address. It then moves reth's head, safe and finalized block to that head, so a run after a crash starts clean.
2. **Choose and build.** It reads reth's pending pool (`txpool_content`, on the builder-only WebSocket port) and takes transactions best price first, each sender's in nonce order, while their gas limits fit under the lower of the chain's gas cap and the parent's gas limit. A transaction that does not fit, or is named with `--exclude`, ends its sender's turn, because the sender's later ones could not run without it. It fetches each chosen transaction's raw bytes and calls `testing_buildBlockV1` on Canton's head with that list. The list is always explicit; an empty block is `[]`, never null, because a null makes reth fill the block from its pool. The attributes are Prague's: a timestamp from the builder's clock and later than the parent's, the fee recipient, zero `prevRandao` and `parentBeaconBlockRoot`, and `withdrawals: []`.
3. **Make it reth's head.** `engine_newPayloadV4`, then `engine_forkchoiceUpdatedV3` with head = the new block and safe = finalized = Canton's head. Every Engine call carries an HS256 token (`iat` = now) signed with the per-run secret in `jwt.hex`.
4. **Read the block's legs.** The gateway contract writes a `Leg` event for every Canton leg a transaction asks for: a deposit (a claim), a withdrawal or a payment. The builder reads them with `eth_getLogs` for this block, the gateway's address and the `Leg` topic, in log order, which is the order of the gateway's running hash. This is reth's own view. Nothing depends on it being honest: Canton compares what the builder sends with the hash in the proven state.
5. **Find each leg's Canton side.** It looks among the contracts it can see (as the builder, and as every `--read-as` party). Contracts that name another chain, operator, confirmer or gateway are never used.
   - **Deposit:** an active `DepositRequest` with the claim's id and recipient, whose allocation is active and visible, has not passed its settle-before time (by the builder's clock), has the chain's operator as executor, goes from the depositor to the gateway party, is in the instrument of the `GatewayToken` for that EVM token, and is for the amount claimed. Amounts are compared as numbers, in base units: a wrapped token has 10 decimals, as a Canton amount does, so nothing is rounded.
   - **Withdrawal:** a `GatewayToken` for the EVM token, a `WithdrawalAcceptance` of the party named in the withdrawal, and unlocked gateway holdings of the instrument that cover the amount. The holdings used are the largest first, no more than needed; they are the withdrawal's `inputs`. At most one withdrawal of an instrument goes into a block, because a holding made earlier in the same Canton transaction cannot be named in advance.
   - **Payment:** active `DvpTerms` with the payment's id, and its token, payee and amount, whose allocation passes the same checks as a deposit's, going from the terms' `u` to their `v`. The builder does not work out the payment id: it finds the terms by it.
   - An allocation can be executed once. Of two legs that want the same one, the earlier in the block keeps it and the later has no Canton side.
   - If two contracts fit one leg (two requests with one id, say), the first one that passes every check is used.
6. **Build again if a leg has none.** If any leg has no Canton side, the builder leaves out the transaction that recorded it and that sender's later ones, as `--exclude` does, moves reth back to Canton's head and builds again. reth does not return an unwound block's transactions to its pool, so the builder sends them to the pool again after each move back (a transaction the pool already has is no problem) and builds the next block from the list of the last one, less the transactions it leaves out, not from the pool. It repeats until every leg of the block has its Canton side. Nothing has been proven by then. A leg is judged on its own first, and only when every leg passes alone is it checked whether two want the same allocation or holdings, so a transaction that is going to be left out never takes the place of another. A block with no legs needs nothing from Canton beyond the chain contract.
7. **Prove it.** It saves the block and reth's execution witness, runs `make-input.sh` on them, then the prover command on the input. Before proving it removes any `wrapped-proof.hex` an earlier run left for this block number, so an old proof is never taken for this one; it then reads the 1,344-byte wrapped proof the prover leaves, and fails if there is none.
8. **Submit.** One `Advance` on the `ZkChain` contract, as the builder party, in the formats of `daml/README.md`: `headerHex`, `txsHex`, `proofHex`, the gateway's two proofs (`gatewayAccountNodes` and `gatewayStorageNodes`, from `eth_getProof` for the gateway's account and its `legs[number]` slot at the new block) and `legs`, one for each event in the order of the events. A block with no legs is submitted too, with the gateway's proofs and an empty list: that is how it is shown that the block needs none. `txsHex` is empty (`""`) for a block with no transactions. The header and the transaction list are cut from reth's raw block (`debug_getRawBlock`) as they sit there; the builder checks the header hashes to the block hash. The argument is saved first, as `block-<number>/advance.json` in the work folder, exactly as it is sent.
9. **After Canton answers.** If it committed, `engine_forkchoiceUpdated` with finalized = the new block. If it refused, reth goes back to Canton's head (head = safe = finalized), and the run reports the reason, the hashes of the transactions it chose, and which of them recorded legs. The refused block's transactions are sent to reth's pool again, so the next run looks at them again: an allocation that was withdrawn or an acceptance that was archived is no longer there, so that transaction is left out. A reply that is lost (the connection dropped, a timeout, an answer that is not HTTP or not JSON) is not taken for a refusal: the builder reads the head again, and counts the block as committed if Canton's head is now this block. If the head cannot be read either, the outcome is not known: the run prints `{"committed": null, "reason": "...", ...}`, exits 2 and leaves reth where it is, because moving it back could undo a block Canton committed. The next run starts from Canton's head, whichever it is. If Canton had not committed the block, the next run moves reth back without sending that block's transactions to the pool again, so their senders send them again.

Any other failure after reth moved also moves reth back to Canton's head, and the transactions of the block it made are sent to the pool again. A `Leg` event that cannot be read is such a failure.

Exit status: 0 committed, 2 refused by Canton or not known (`"committed": null`), 1 any other failure. Every run prints exactly one JSON line on stdout, failures included (a missing setting, an unreadable secret, no `ZkChain` contract or two of them, a reply that is not JSON, a failing prover): `{"committed": false, "error": "..."}` and exit 1.

### The report

The line a run prints when Canton answered (or may have) has these fields besides `committed`:

| Field | What it holds |
|---|---|
| `number`, `blockHash` | the block |
| `transactions` | the transactions in the block (when it committed) |
| `keptTransactions` | the transactions in the block (when it was refused or the outcome is not known) |
| `legs` | how many legs went with the block (when it committed) |
| `legTransactions` | the hashes of the transactions that recorded legs, in the order of the legs |
| `leftOut` | the transactions left out because a leg of theirs had no Canton side, each as `{"transaction": ..., "reason": ...}`. A transaction named with `--exclude` is not listed. |
| `reason` | why Canton refused, or why the outcome is not known |

A transaction left out is put back in reth's pool, where it waits. It goes into a later block once its leg has a Canton side, and its sender can replace it. A refusal the builder could not see coming, such as a token registry's own rule, still needs `--exclude` on the next run: the builder does not remember anything from one run to the next.

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

`launch.sh` also passes `--rpc.eth-proof-window 1`. The builder no longer needs it: it asks for the gateway's proof at the new block only, which is the newest one. It does no harm.

Without the flags in the table the builder's builds or its move back can fail.

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

Python 3.12, standard library plus `websockets`. The tests use only fakes in `builder/tests/`: reth's WebSocket and Engine ports (with the gateway's `Leg` logs and proofs), the Ledger API, and shell scripts for the prover and input tool. The fake Engine port checks the token as reth does. Tests cover a good block end to end, a refusal and the move back, a failing prover, the token, the explicit transaction list and the gas cap.

Leg tests cover each kind. For a payment: no terms, terms for another id, token, payee or amount, terms naming another chain, operator or confirmer, and every way the allocation can fail (withdrawn, settle-before passed or unreadable, another executor, sender or receiver, no visible view). For a deposit: no request, another id or recipient, a token that is not registered, another instrument, another amount, an allocation to someone other than the gateway. For a withdrawal: no acceptance, an acceptance of another party, holdings that are locked, someone else's, of another instrument or too small, the choice of holdings, and one withdrawal of an instrument per block. They also cover two legs that want one allocation, legs in the order of the events within and across transactions, a sender's later transactions following a left-out one, building again until the block is stable, the report, and the `advance.json` file. Event tests check the topic against the contract's source, the encoding of an event both ways and every kind of malformed event, and the conversion of amounts. Visibility tests cover `--read-as` and `--disclosed`, including unchanged behavior when omitted. Recovery tests cover a lost reply, a connection dropped after commit, a reply that is not HTTP, and a lost reply with Canton's head unreadable (`committed: null`, exit 2, reth left where it is, the next run re-anchors). Tests also check an empty block's `txsHex`, that an old proof is never used, one JSON line and the exit status on every failure, and Keccak-256 against a real header. The fakes follow reth and Ledger API documentation. The end-to-end run uses the real services.

## Not here

- No check of the proof under the pinned keys before submitting it; the builder checks only its size and form. Canton's confirmers check it.
- No step cap before proving. A block the prover cannot finish stops the run at the prover.
- One block per run. No loop over blocks.
- No memory from one run to the next. A refusal for a reason the builder cannot see (a registry's own rule) is handled by hand, with `--exclude`.
- The builder cannot see everything about a leg. It judges the settle-before time by its own clock, and an allocation can be withdrawn between its check and the commit. Then Canton refuses the block, nothing moves, and the next run sees the allocation is gone.
- The builder needs read access to the contracts of the legs it settles: the requests, tokens, acceptances, terms, allocations and the gateway's holdings. This repository uses `--read-as` to give it the view of the parties that hold them. A deployment must grant that access; a leg whose contracts the builder cannot see has no Canton side, and its transaction is left out.
