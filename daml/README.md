# The Daml package

`canton-zk-evm` holds the chain's state on Canton. A block of the EVM chain is one Canton transaction. The block may need Canton actions to happen with it: a Canton token locked so that its wrapped form can be minted on the EVM (a deposit), a Canton token released because the wrapped form was burnt (a withdrawal), or a Canton allocation executed because an EVM payment was made (a payment). The chain's gateway contract on the EVM writes down every such action a block asks for, in its own state. The proof fixes that state, and `Advance` settles exactly those actions or nothing.

| Template | What it is |
|---|---|
| `ChainProposal` | The operator and the gateway propose a chain: its id, genesis hash, the genesis block's state root, the pinned program key (`programVK`), the pinned ZisK release (`rootC`), the rules hash, the gas cap, the builder, the gateway party and the gateway contract's address on the EVM. The confirmer's `Accept` creates the chain. |
| `ZkChain` | The chain's one state contract, signed by the operator, the confirmer and the gateway: the current head (number, block hash and state root) and the pins. `Advance`, exercised by the builder, consumes it and creates the next one. |
| `BlockRecord` | One per block, signed by the operator and the confirmer, seen by the builder and a reader party: number, hash, parent, header, transactions and proof. Enough to replay the chain and re-check every proof. |
| `GatewayTokenProposal`, `GatewayToken` | "This Canton instrument (its admin and id) is what this EVM token wraps, and this is its registry's transfer factory." Signed by the operator, the confirmer and the gateway: the proposal by the operator and the gateway, accepted by the confirmer with `AcceptToken`. Registering a token is a trust decision, because the gateway runs that registry's Daml code with its own authority. |
| `DepositRequest` | Signed by the depositor: the deposit id, the EVM address that will claim the wrapped token, and the depositor's allocation to the gateway. Its `Lock` choice executes the allocation. |
| `WithdrawalAcceptance` | Signed by a party that wants to receive withdrawals. It stands until archived. Its `Receive` choice has the gateway transfer a Canton token from its custody to that party through the registry's own factory, and accepts the transfer as the party in the same transaction. |
| `DvpTerms` | Signed by U and V: "if the gateway records this payment (this id, token, payee and amount), execute this allocation". The payment id is the EVM payment id itself, 64 lowercase hex digits, and it is the SHA-256, in lowercase hex, of the UTF-8 bytes of the text `<U's party id>,<V's party id>,<label>` (`paymentId` in `Chain.daml`), so only terms that U and V both signed can carry it. The amount is never zero. `Settle` executes the allocation. |

## One `Advance`

In one Canton transaction, the builder's `Advance`:

1. calls the sidecar's `verify` with the proof, header and transactions;
2. checks the answer: the block was proven under the pinned `programVK` and `rootC`; its parent is the current head; its number is the head's plus one; its gas limit and gas used are within the cap;
3. builds one line for each attached leg (a deposit, a withdrawal or a payment), from the Canton contracts that the leg names, and calls the sidecar's `legs` with those lines and the gateway's proofs. The sidecar hashes the lines as the gateway contract does and compares the result with the value the proven block recorded. Daml requires the exact answer. A block that recorded no legs is checked in the same way, with no lines: that is how it is proven that it needs none;
4. settles every leg, in order: `Lock` for a deposit, `Receive` for a withdrawal, `Settle` for a payment;
5. creates the `BlockRecord` and the next `ZkChain`, whose head state root is this block's.

If any step fails, nothing changes. A missing leg, an extra one, two in another order, or one with any field changed (another recipient, amount, id, token or party) gives another hash, so `Advance` is refused. Daml checks no proofs and hashes no blocks or legs; it compares the text the sidecar answers. The one hash it takes is a payment's id (`paymentId`, see `DvpTerms` above), which only names a set of terms.

What Daml checks before it writes a leg's line:

- every contract of a leg names this chain's id, operator and confirmer, and where it has one, the chain's gateway. The builder is a controller of `Advance`, so authority alone would not stop a contract that names the builder in one of those roles;
- a deposit's allocation is of the instrument that the `GatewayToken` names, and its amount is more than zero; its line carries that amount. `Lock` then checks that the allocation goes from the depositor to the gateway, with the operator as executor;
- a withdrawal's amount is more than zero, its id is 64 lowercase hex digits and its burner 40. The receiver is the party of the acceptance, so the line carries exactly that party;
- a payment's line is written from the terms alone. `Settle` checks that the allocation goes from U to V, with the operator as executor.

Daml writes the line of a deposit and of a payment from the contracts, never from text that the builder sends. No Canton contract holds a withdrawal's id, burner or amount, so the builder sends those three as text. The proven hash binds them, with the rest, to what the block recorded.

Who provides the authority: `Advance` runs with the authority of the signatories of `ZkChain` (the operator, the confirmer and the gateway) and of its controller, the builder. Each settlement choice adds the signer of its own contract.

| Leg | Choice | Authority inside it |
|---|---|---|
| Deposit | `DepositRequest.Lock` | the depositor, the operator, the confirmer and the gateway |
| Withdrawal | `WithdrawalAcceptance.Receive` | the receiver, the operator, the confirmer and the gateway |
| Payment | `DvpTerms.Settle` | U and V, the operator and the confirmer |

`Lock` and `Receive` need the operator, the confirmer and the gateway together, and `Settle` the operator and the confirmer together. As the signatories of `ZkChain`, they provide that authority inside `Advance`; the design provides it nowhere else. None of them can settle alone, and the builder cannot settle at all. The operator, the confirmer and the gateway can settle together by design. They are the chain's root of trust.

A withdrawal goes through the registry's own transfer factory, and the factory is told the instrument's admin as the one it must belong to. With the reference test token, a transfer to another party is first an offer that the receiver must accept, which is why `Receive` accepts it in the same transaction. A registry that completes a transfer at once is fine too. Any other answer aborts.

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

### `legs`

Input: `stateRoot,number,gateway,accountNodes,storageNodes,legs`.

- `stateRoot` is the proven block's state root, from the answer of `verify`, and `number` the block's number in decimal. `gateway` is the gateway contract's address, from the chain record.
- `accountNodes` and `storageNodes` are the gateway's account proof and the storage proof of its `legs[number]` slot, as `eth_getProof` gives them: nodes in hex, joined by `;`. The storage list may be empty.
- `legs` is empty, or the attached legs in order, joined by `|`. Each leg is six fields joined by `/`: `kind/id/token/account/amount/party`.
  - `kind` is `deposit`, `withdrawal` or `payment`. `id` is 64 hex digits, `token` and `account` are 40.
  - `amount`: for a deposit or a withdrawal, the Canton amount as Daml writes a `Decimal` (`10.0`, `0.25`); for a payment, the ERC-20 amount as 64 hex digits.
  - `party`: for a withdrawal, the hex of the receiver's party id (`Zk.Hex.toHex`); empty otherwise, so a deposit's or a payment's leg ends with a `/`.

What the sidecar does:

1. It checks the account proof under `stateRoot`, and the storage proof under the account's storage root. An absent key, or an account with nothing stored, counts as zero.
2. It turns each Canton amount into base units: digits, a point and one to ten digits, times 10^10. Anything else is malformed. A wrapped token has 10 decimals, so nothing is ever rounded.
3. It hashes the legs in order as the gateway contract does, starting from 32 zero bytes: each step is the Keccak-256 of the previous value, the kind (1 for a deposit, 2 for a withdrawal, 3 for a payment), the id, the token and the account (each as a 32-byte word), the amount in base units (a 32-byte word) and the Keccak-256 of the party's bytes. The party's bytes are empty for a deposit and a payment.
4. It compares the result with the proven value.

Answer, if they are equal:

```
ok stateRoot number gateway count
```

`count` is the number of legs, which Daml compares with the number it sent. Otherwise `no` and one of `malformed input`, `the account proof does not verify`, `the storage proof does not verify` or `the legs are not the ones the block recorded`. Daml requires the answer to be exactly the `ok` line it expects: another root, number, gateway or count is refused.

## Left out on purpose

This version has these limits:

- `BlockRecord` does not carry the state root, the timestamp or the legs settled in the block; the header it holds has the first two.
- There is no `DvpProposal` step: the two parties sign `DvpTerms` directly.
- There is no chainRef (a name for the chain) on any contract; the chain id is the only link to a chain.
- There is no `pins` verb. The pins are the chain contract's own fields. The confirmer is expected to compare them with its own sidecar and build before accepting, including the gateway contract's code in the genesis. On the one-machine network, `network/up.sh` starts the sidecars with the same values it proposes, and `network/canton/propose.py` accepts at once.
- The gateway party holds the locked Canton tokens. Under the Daml rules, custody leaves only through `Receive`, inside `Advance`, for a withdrawal that the proven block recorded. But whoever runs the participant that hosts the gateway party can move the custody outside those rules, as a Canton party can always act through its own participant.
- The builder needs read access to the contracts of the legs it settles. The Daml tests grant this with `readAs`; the demo uses the builder's `--read-as` option. A deployment must grant access to the relevant contracts.
- A registry's own rule can refuse a settlement after the builder has checked everything it can see. `Advance` is then refused and nothing moves.

## How the external call is tested

`DA.ExternalCall` is not in the released Daml SDK. It is in builds of Canton 3.6 that carry the external-call extension, and Daml Script's test ledger cannot make an external call in any case. So `Zk.Sidecar`, the one module that makes the call, has two forms in `sidecar/`:

- `external.daml` is the form used with a real Canton: two one-line functions, `verifyCall` and `legsCall`, each `fromHex <$> externalCall "canton-zk-evm" <verb> "" (toHex input)`.
- `stub.daml` is the test form: the same two functions, going through the same hex helpers, answering in the same format from a small table. Its package is named `canton-zk-evm-stub`, so it cannot be mistaken for the real one. For `verify`, the header field of the call picks the scenario, so a test names a block and gets a well-formed answer for a good block, a block on the wrong parent, one that skips a number, one over the gas cap, one proven under another program or another ZisK release, and a failing proof. For `legs`, the stub cannot hash, so it treats the storage proof as the text of the legs the block recorded, in hex, and the account proof as a tag that picks a failure. A test writes down the legs its block "recorded" in the exact line format above, so the tests also pin that format.

Both forms share all other source code, including every check that `Advance` and the settlement choices make on an answer. Only the answer's source is stubbed. CI runs tests against the stub form. The external form needs a toolchain with `DA.ExternalCall`, which no released SDK has yet. Digital Asset's published 3.6 snapshots include it. `PINS` names the snapshot, `network/canton/fetch.sh` installs it, and `network/canton/build-dar.sh` builds the external form. `SDK_VERSION` selects the snapshot's SDK version. `build.sh external` defaults to `--target=2.4`, the first Daml-LF version with the external call. The network workflow builds this form and loads it into a real Canton. The smoke test in `network/` exercises the real call with the real sidecar.

## Versions and dependencies

- **Daml SDK 3.5.12**, the version in `daml.yaml`, the latest 3.5 release when this was written. It compiles to LF 2.1, which Canton 3.5 and 3.6 both load. Canton 3.6 is the target network; no released 3.6 SDK exists yet, so the tests use the 3.5 SDK, and the DAR needs no change for 3.6 except the `external` form's toolchain.
- **Token standard (CIP-0056) API packages**, from the Splice 0.8.3 release, unchanged and pinned by `dars/SHA256SUMS`. The package builds against the metadata, holding, allocation and transfer-instruction packages. `dars/README.md` says where they come from. The reference token the tests use is Splice's own test token from the same release.

## Build and test

Install `dpm` and Daml SDK 3.5.12 using the pinned installation procedure in [.github/workflows/daml.yml](../.github/workflows/daml.yml). From the repository root:

```sh
cd daml
./build.sh stub        # dist/canton-zk-evm-stub.dar
./test.sh              # builds the stub form and runs the Daml Script tests
```

CI (`.github/workflows/daml.yml`) does both on a GitHub runner. It downloads the release bundle for the SDK version in `daml.yaml`, checks it against the publisher's SHA256 for that file (pinned in the workflow, so a new SDK version needs a new hash), unpacks it and installs it with `dpm bootstrap`.
