# The Daml package

`canton-zk-evm` holds the chain's state on Canton. It has four templates:

| Template | What it is |
|---|---|
| `ChainProposal` | The operator proposes a chain: its id, genesis hash, the genesis block's state root, the pinned program key (`programVK`), the pinned ZisK release (`rootC`), the rules hash, the gas cap and the builder. The confirmer's `Accept` creates the chain. |
| `ZkChain` | The chain's one state contract, signed by the operator and the confirmer: the current head (number, block hash and state root) and the pins. `Advance`, exercised by the builder, consumes it and creates the next one. |
| `BlockRecord` | One per block, signed by the operator and the confirmer, seen by the builder and a reader party: number, hash, parent, header, transactions and proof. Enough to replay the chain and re-check every proof. |
| `DvpTerms` | A Daml action tied to a block, signed by U and V: "if, in the proven block, this EVM address's balance of this token rose by exactly this amount, execute this allocation". The amount is never zero. `Settle` needs the operator and the confirmer together. |

## One `Advance`

In one Canton transaction, the builder's `Advance`:

1. calls the sidecar's `verify` with the proof, header and transactions;
2. checks the answer: the block was proven under the pinned `programVK` and `rootC`; its parent is the current head; its number is the head's plus one; its gas limit and gas used are within the cap;
3. for each leg, calls the sidecar's `fact` with the block's state root and the head's state root, for the balance the terms name, and settles the leg with the answer: the amount the balance rose by in this block. `Settle` checks it is exactly the expected amount, then executes the token-standard allocation (`Allocation_ExecuteTransfer`) from U to V. A leg's condition is a payment in this block, not a balance that happens to be true: a balance that was already there, or one that fell, does not settle. At most one leg per token and holder may be in one block, so one payment cannot satisfy two terms;
4. creates the `BlockRecord` and the next `ZkChain`, whose head state root is this block's.

If any step fails, nothing changes. Daml does no hashing and no proof checking; it compares the text the sidecar answers.

`Settle` requires both controllers, the operator and the confirmer. As the two signatories of `ZkChain`, they provide that authority inside `Advance`; the design provides it nowhere else. Neither can settle alone, and the builder cannot settle. The operator and confirmer can settle together by design. They are the chain's root of trust.

## What the sidecar answers

The sidecar is a service each confirming participant runs beside it. Daml calls it through Canton's external call, extension `canton-zk-evm`, with the verb as the function name. Every verb is a pure function of its input, so every honest confirmer answers with the same bytes; Canton rejects the transaction if two answers differ. The input is one line of fields separated by commas; the answer is one line of fields separated by single spaces. The request and the response bodies of the external call are the hex of that ASCII line (lowercase, two digits a character), with no newline at the end of either; `Zk.Hex` has the two helpers, `toHex` and `fromHex`. Inside the line, hashes, keys, addresses and proofs are lowercase hex, with no `0x`. Numbers are decimal.

### `verify`

Input: `proofHex,headerHex,txsHex`. Each field is lowercase hex. `txsHex` is empty for a block with no transactions. The sidecar refuses a line that does not have exactly three such fields.

Answer, if the block checks out:

```
ok programVK rootC blockHash parentHash number stateRoot timestamp gasLimit gasUsed txCount
```

`ok` means: the proof verifies; it commits to `blockHash` in the one valid layout; the header hashes to `blockHash`; the transactions hash to the header's transactions root; the block has no ommers and no withdrawals. `programVK` and `rootC` are the keys the proof was checked under. The other fields are read from the header.

Otherwise: `no` followed by a reason in plain words, for example `no the proof does not verify`.

### `fact`

Input: `stateRoot,parentStateRoot,token,holder,slot,accountNodes,storageNodes,parentAccountNodes,parentStorageNodes`. `stateRoot` is the proven block's state root and `parentStateRoot` the state root of the chain's head, the block's parent. `token` and `holder` are 20-byte addresses; `slot` is the decimal position of the token's balance mapping. `accountNodes` and `storageNodes` are the node lists of the account proof and the storage proof under `stateRoot`; `parentAccountNodes` and `parentStorageNodes` are the same two under `parentStateRoot`. Each node is in hex and the nodes are joined by `;`. The sidecar derives the storage key itself from `holder` and `slot`.

Answer, if all four proofs verify:

```
ok stateRoot parentStateRoot token holder slot rise
```

`rise` is the holder's balance under `stateRoot` minus the balance under `parentStateRoot`, as 64 hex digits (256-bit arithmetic). Daml checks that the first five fields are the ones it asked about: another root, token, holder or slot is refused. A holder with no balance at all in a state counts as zero there, and the answer is still `ok`; a balance that did not change gives 64 zeros. `no` and a reason mean a proof failed (`no the account proof does not verify`, `no the storage proof does not verify`) or the balance fell (`no the balance fell`).

## Left out on purpose

The first version has these limits:

- `BlockRecord` does not carry the state root, the timestamp or the legs settled in the block; the header it holds has the first two.
- A leg's condition is the net change of one balance in the block. It does not read receipts or event logs, so it cannot tell which transfer made the balance rise.
- There is no `DvpProposal` step: the two parties sign `DvpTerms` directly.
- There is no chainRef (a name for the chain) on any contract; the chain id is the only link to a chain.
- There is no `pins` verb. The pins are the chain contract's own fields. The confirmer is expected to compare them with its own sidecar and build before accepting. On the one-machine network, `network/up.sh` starts the sidecars with the same values it proposes, and `network/canton/propose.py` accepts at once.
- The builder needs read access to the allocations it settles. The Daml tests grant this with `readAs`; the demo uses the builder's `--read-as` option. A deployment must grant access to the relevant allocations.

## How the external call is tested

`DA.ExternalCall` is not in the released Daml SDK. It is in builds of Canton 3.6 that carry the external-call extension, and Daml Script's test ledger cannot make an external call in any case. So `Zk.Sidecar`, the one module that makes the call, has two forms in `sidecar/`:

- `external.daml` is the production form: two one-line functions, `verifyCall` and `factCall`, each `fromHex <$> externalCall "canton-zk-evm" <verb> "" (toHex input)`.
- `stub.daml` is the test form: the same two functions, going through the same hex helpers, answering in the same format from a small table. Its package is named `canton-zk-evm-stub`, so it cannot be mistaken for the real one. The header field of the call picks the scenario, so a test names a block and gets a well-formed answer for a good block, a block on the wrong parent, one that skips a number, one over the gas cap, one proven under another program or another ZisK release, and a failing proof.

Both forms share all other source code, including every check that `Advance` and `Settle` make on an answer. Only the answer's source is stubbed. CI runs tests against the stub form. The external form needs a toolchain with `DA.ExternalCall`, which no released SDK has yet. Digital Asset's published 3.6 snapshots include it. `PINS` names the snapshot, `network/canton/fetch.sh` installs it, and `network/canton/build-dar.sh` builds the external form. `SDK_VERSION` selects the snapshot's SDK version. `build.sh external` defaults to `--target=2.4`, the first Daml-LF version with the external call. The network workflow builds this form and loads it into a real Canton. The smoke test in `network/` exercises the real call with the real sidecar.

## Versions and dependencies

- **Daml SDK 3.5.12**, the version in `daml.yaml`, the latest 3.5 release when this was written. It compiles to LF 2.1, which Canton 3.5 and 3.6 both load. Canton 3.6 is the target network; no released 3.6 SDK exists yet, so the tests use the 3.5 SDK, and the DAR needs no change for 3.6 except the `external` form's toolchain.
- **Token standard (CIP-0056) API packages**, from the Splice 0.8.3 release, unchanged and pinned by `dars/SHA256SUMS`. `dars/README.md` says where they come from. The reference token the tests use is Splice's own test token from the same release.

## Build and test

Install `dpm` and Daml SDK 3.5.12 using the pinned installation procedure in [.github/workflows/daml.yml](../.github/workflows/daml.yml). From the repository root:

```sh
cd daml
./build.sh stub        # dist/canton-zk-evm-stub.dar
./test.sh              # builds the stub form and runs the Daml Script tests
```

CI (`.github/workflows/daml.yml`) does both on a GitHub runner. It downloads the release bundle for the SDK version in `daml.yaml`, checks it against the publisher's SHA256 for that file (pinned in the workflow, so a new SDK version needs a new hash), unpacks it and installs it with `dpm bootstrap`.
