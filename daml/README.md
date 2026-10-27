# The Daml package

`canton-zk-evm` holds the chain's state on Canton. A block of the EVM chain is one Canton transaction. The block may need Canton actions to happen with it: a Canton token locked so that its wrapped form can be minted on the EVM (a deposit), a Canton token released because the wrapped form was burnt (a withdrawal), or a Canton allocation executed because an EVM payment was made (a payment). The chain's gateway contract on the EVM writes down every such action a block asks for, in its own state. The proof fixes that state, and `Advance` settles exactly those actions or nothing.

| Template | What it is |
|---|---|
| `ChainProposal` | The operator and the gateway propose a chain: its id, genesis hash, the genesis block's state root, the pinned program key (`programVK`), the pinned ZisK release (`rootC`), the rules hash, the gas cap, the builder, the gateway party and the gateway contract's address on the EVM. The confirmer's `Accept` creates the chain. |
| `ZkChain` | The chain's one state contract, signed by the operator, the confirmer and the gateway: the current head (number, block hash and state root) and the pins. `Advance`, exercised by the builder, consumes it and creates the next one. `SetGasCap` (from package 0.3.0), exercised by the operator and the confirmer together, raises its gas cap. `SetProgram` (from package 0.3.0), exercised by the operator, the confirmer and the gateway together, replaces the program key, ZisK release and rules hash; see `ProgramProposal`. From package 0.3.0 it also holds `changeDelay` (an optional time, last in the record; `None` is no wait): a gas-cap or program change is accepted only that long after it was proposed. The proposals are made by `ProposeGasCap` (the operator), `ProposeProgram` and `ProposeChangeDelay` (the operator and the gateway), nonconsuming choices of `ZkChain`, and `SetChangeDelay` (all three) sets the delay; see `ChangeDelayProposal`. From package 0.3.0 it also holds the limits on the legs, all optional and after `changeDelay`: `pauseMax`, `pausedUntil`, `pauseCooldownUntil`, `pauseStartedAt`, `withdrawalQuota`, `quotaWindow` and `withdrawn`. `PauseLegs` and `UnpauseLegs` (the confirmer alone) and `RenewPause` (the operator and the confirmer, through `ProposeRenewPause` by the operator, a nonconsuming choice of `ZkChain`) pause the legs and lift the pause; `SetLegLimits` (the operator and the confirmer) sets the quota, its window and `pauseMax`, through `ProposeLegLimits` (the operator), a nonconsuming choice of `ZkChain`; see `LegLimitsProposal`, `RenewPauseProposal` and the sections on the pause and the quota below. |
| `GasCapProposal` | From package 0.3.0. Made by `ZkChain.ProposeGasCap`, which records the ledger time as `proposedAt` and adds the confirmer's signature, so it cannot be created by itself or backdated beyond Canton's ledger-time tolerance. Signed by the operator and the confirmer, and observed by the reader, which sees a pending change and when it was proposed (`proposedAt`; the wait is the chain's `changeDelay`, which only the chain's signatories and the builder see): "raise this chain's gas cap to this value". The confirmer's `AcceptGasCap`, refused before `proposedAt` plus the chain's `changeDelay` (the message says when), given the chain's current contract, exercises `SetGasCap` with both parties' authority (the operator's from the proposal, the confirmer's as the controller) and creates the chain contract again with the new cap and every other field unchanged. It is refused on another chain's contract. The two parties are normally acted for by separate users, so the proposal is how they decide together. |
| `ProgramProposal` | From package 0.3.0. Made by `ZkChain.ProposeProgram` (stamped with `proposedAt`, as `GasCapProposal`). Signed by the operator and the gateway (the operator's Ledger API user acts for both) and the confirmer: "set this chain's program key, ZisK release and rules hash to these values". The confirmer's `AcceptProgram`, refused before `proposedAt` plus the chain's `changeDelay`, given the chain's current contract, exercises `SetProgram` with all three parties' authority and creates the chain contract again with the three new values and every other field unchanged. Each of the three values is 64 lowercase hex digits. It is refused on another chain's contract, or when it names another gateway than the chain's. `Advance` keeps refusing a block proven under any other program key or ZisK release than the contract's, so the switch takes effect at the next block; setting the old values back is the same two steps. The reader observes it. |
| `ChangeDelayProposal` | From package 0.3.0. Made by `ZkChain.ProposeChangeDelay`, like `ProgramProposal`: "set the chain's change delay to this value, or to none", between zero and 30 days. The confirmer's `AcceptChangeDelay` is itself refused before `proposedAt` plus the delay in force, so a delay cannot be cut short. There is no emergency bypass. The reader observes it. The wait binds the propose and accept path between separate users; a submission acting for the operator and the confirmer together (and the gateway, for the program and the delay) can call `SetGasCap`, `SetProgram` and `SetChangeDelay` directly. |
| `LegLimitsProposal` | From package 0.3.0. Made by `ZkChain.ProposeLegLimits` (stamped with `proposedAt`, as `GasCapProposal`): "set the withdrawal quota, its window and the longest pause to these values" (the quota and its window together or neither). The confirmer's `AcceptLegLimits`, refused before `proposedAt` plus the chain's `changeDelay`, given the chain's current contract, exercises `SetLegLimits` and creates the chain contract again with the new values and every other field unchanged. The reader observes it. A submission acting for the operator and the confirmer together can call `SetLegLimits` directly, with no wait. |
| `RenewPauseProposal` | From package 0.3.0. Made by `ZkChain.ProposeRenewPause`: "pause the legs for this long from the accept". The confirmer's `AcceptRenewPause` exercises `RenewPause` on the chain's current contract, with no change delay (a pause protects and ends on its own), but is refused when the proposal is more than an hour old, so an old proposal cannot let the confirmer alone start or renew a pause later. A submission acting for the operator and the confirmer together can call `RenewPause` directly. The reader observes it. |
| `WithdrawGasCap`, `RejectGasCap`, `WithdrawProgram`, `RejectProgram`, `WithdrawChangeDelay`, `RejectChangeDelay`, `WithdrawLegLimits`, `RejectLegLimits`, `WithdrawRenewPause`, `RejectRenewPause` | One pair on each of the five proposals. The operator alone withdraws a pending proposal and the confirmer alone rejects it (the built-in Archive needs every signatory, so without these a pending proposal could only be cleared by accepting it). Nobody else can do either. Only a pause renewal expires (after an hour); the others never do, so withdraw or reject one that is no longer wanted. |
| `BlockRecord` | One per block, signed by the operator and the confirmer, seen by the builder and a reader party: number, hash, parent, header, transactions and proof. Enough to replay the chain and re-check every proof. |
| `GatewayTokenProposal`, `GatewayToken` | "This Canton instrument (its admin and id) is what this EVM token wraps, and this is its registry's transfer factory." Signed by the operator, the confirmer and the gateway: the proposal by the operator and the gateway, accepted by the confirmer with `AcceptToken`. Registering a token is a trust decision, because the gateway runs that registry's Daml code with its own authority. |
| `DepositRequest` | Signed by the depositor: the deposit id, the EVM address that will claim the wrapped token, and the depositor's allocation to the gateway. Its `Lock` choice executes the allocation. |
| `WithdrawalAcceptance` | Signed by a party that wants to receive withdrawals. It stands until archived. Its `Receive` choice has the gateway transfer a Canton token from its custody to that party through the registry's own factory, and accepts the transfer as the party in the same transaction. |
| `DvpTerms` | Signed by U and V: "if the gateway records this payment (this id, token, payee and amount), execute this allocation". The payment id is the EVM payment id itself, 64 lowercase hex digits, and it is the SHA-256, in lowercase hex, of the UTF-8 bytes of the text `<U's party id>,<V's party id>,<label>` (`paymentId` in `Chain.daml`), so only terms that U and V both signed can carry it. The amount is never zero. `Settle` executes the allocation. |
| `VenueTrade` | From package 0.4.0. Signed by a venue, a Canton party that runs trades of its own, and by the seller (`sender`), whose holding the allocation locks: "if the gateway records this payment (this id, token, payee and amount), execute this allocation, which goes to the gateway, and make a funded claim for this EVM address". The payment id is `venueTradeId venue label` and the claim id `venueClaimId payId` (see "A venue's trade" below). Its `SettleTrade` choice executes the allocation and creates the `FundedClaim`; it needs the operator, the confirmer and the gateway together, whom `Advance` brings. Those three can also settle a trade together outside `Advance`, with no EVM payment, by design: they are the chain's root of trust, as for `Lock` and `Settle`. |
| `FundedClaim` | From package 0.4.0. Signed by the operator, the confirmer and the gateway: "the gateway holds this amount of the Canton token, and this EVM address may claim its wrapped form with the deposit line of this claim id". Its `Redeem` choice archives it, and is what a claim leg does. It names the `GatewayToken` contract by its contract id, and a claim leg needs exactly that contract: a registered `GatewayToken` must stay active while any `FundedClaim` names it, and a token for a new factory is registered beside the old one, never in its place. |

## One `Advance`

In one Canton transaction, the builder's `Advance`:

1. calls the sidecar's `verify2` (from package 0.3.0; `verify` before) with the proof, header and transactions;
2. checks the answer: the block was proven under the pinned `programVK` and `rootC`; its parent is the current head; its number is the head's plus one; its gas limit and gas used are within the cap;
3. builds one line for each attached leg (a deposit, a withdrawal, a payment, or from package 0.4.0 a trade or a claim), from the Canton contracts that the leg names, and calls the sidecar's `legs` with those lines and the gateway's proofs. The sidecar hashes the lines as the gateway contract does and compares the result with the value the proven block recorded. Daml requires the exact answer. A block that recorded no legs is checked in the same way, with no lines: that is how it is proven that it needs none;
4. settles every leg, in order: `Lock` for a deposit, `Receive` for a withdrawal, `Settle` for a payment, `SettleTrade` for a trade and `Redeem` for a claim;
5. creates the `BlockRecord` and the next `ZkChain`, whose head state root is this block's.

If any step fails, nothing changes. A missing leg, an extra one, two in another order, or one with any field changed (another recipient, amount, id, token or party) gives another hash, so `Advance` is refused. Daml checks no proofs and hashes no blocks or legs; it compares the text the sidecar answers. The only hashes it takes are ids that name things and prove nothing: a payment's id (`paymentId`, see `DvpTerms` above), a venue trade's payment id (`venueTradeId`) and the id of the claim it makes (`venueClaimId`, see "A venue's trade" below).

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
| Trade (0.4.0) | `VenueTrade.SettleTrade` | the venue, the seller, the operator, the confirmer and the gateway |
| Claim (0.4.0) | `FundedClaim.Redeem` | the operator, the confirmer and the gateway |

`Lock` and `Receive` need the operator, the confirmer and the gateway together, and `Settle` the operator and the confirmer together. As the signatories of `ZkChain`, they provide that authority inside `Advance`; the design provides it nowhere else. None of them can settle alone, and the builder cannot settle at all. The operator, the confirmer and the gateway can settle together by design. They are the chain's root of trust.

A withdrawal goes through the registry's own transfer factory, and the factory is told the instrument's admin as the one it must belong to. With the reference test token, a transfer to another party is first an offer that the receiver must accept, which is why `Receive` accepts it in the same transaction. A registry that completes a transfer at once is fine too. Any other answer aborts.

## A venue's trade (from package 0.4.0)

A Canton venue can settle a trade against a payment made on the EVM, with no change to the gateway contract, the sidecar or the proven program: the two new legs reuse the sidecar's `payment` and `deposit` lines. The seller on Canton allocates the Canton token to the gateway, with the venue as executor. The buyer on the EVM pays the ERC-20 amount through the gateway's `pay`, against the trade's `payId`. The block that records that payment carries a **trade leg**: `Advance` writes the `payment` line from the `VenueTrade` alone (id `payId`, then `token`, `payee`, `amount`), and once the sidecar has confirmed it `SettleTrade` executes the allocation, so the gateway holds the Canton token, and creates a `FundedClaim` of that amount. The buyer then claims the wrapped token on the EVM with the gateway's `claim`, against the claim's id; the block that records it carries a **claim leg**, whose line is exactly the `deposit` line of that id (`deposit/claimId/evmToken/recipient/amount/`), and `Redeem` archives the claim. Both legs are refused while the legs are paused, like every leg. Neither is a withdrawal, so neither counts against the withdrawal quota.

What Daml checks:

- the trade and the claim name this chain's id, operator, confirmer and gateway, a claim leg's token is the one the claim names, and the token a trade names (`gatewayToken`) is a token of this chain, so the claim a settled trade makes can always be redeemed;
- `SettleTrade` checks that the allocation's executor is the venue, that its sender is the trade's `sender` (the token standard's `Allocation_ExecuteTransfer` needs its executor, sender and receiver together, so the seller signs the trade), that it goes to the gateway, that it is of the instrument the trade's `GatewayToken` names and that its amount is more than zero. The claim's amount is the allocation's;
- a trade's `ensure` checks that `payId` is `venueTradeId venue label`, that `claimId` is `venueClaimId payId`, that `token`, `payee` and `recipient` are 40 lowercase hex digits, that the amount is 64 and not zero, and that the chain id is more than zero.

**Why the payment id has a domain tag.** `venueTradeId venue label` is the SHA-256 of `venue-trade,<venue party id>,<label>`. A `DvpTerms` payment id is the SHA-256 of two party ids and a label (`paymentId`). The tag "venue-trade" is not a party id, so a trade's id can never equal the id of any `DvpTerms`: a payment that the gateway recorded for one cannot settle the other. The claim id is the SHA-256 of `claim,` and the payment id, so one payment has one claim.

**`allocationDisclosed`.** The allocation belongs to the seller and the registry, and the builder, who submits `Advance`, is neither. The venue can put the allocation here as a disclosed contract in the JSON Ledger API v2 form (a JSON object, as text), and the builder adds it to the `disclosedContracts` of the `Advance` that settles the trade, next to the static `--disclosed` list, only when it cannot see the allocation itself, which it accepts only for a venue it was told to trust with `--venue`. Its `contractId` must be the trade's `allocation`. The builder cannot read a disclosed contract, so it takes such an allocation on trust, when it is not otherwise visible to it, only for a venue that it was told to trust (`--venue <party>`, repeatable; for any other venue the allocation must be visible to it and is checked), and leaves the judging to `SettleTrade`, which refuses the block if the allocation is not what the trade says. With the reference test token the allocation is itself the sender's locked holding, so disclosing it is enough; another registry's token may also need its other contracts disclosed, through the static `--disclosed` list. It is optional: with `None` the builder relies on the allocation being visible to it, or on the static list it is given with `--disclosed`. A trade stays active until someone archives it, and a disclosed allocation is not checked by the builder, so the venue must archive a trade whose allocation was withdrawn or whose settle-before time has passed.

## What the sidecar answers

The sidecar is a service each confirming participant runs beside it. Daml calls it through Canton's external call, extension `canton-zk-evm`, with the verb as the function name. Every verb is a pure function of its input, so every honest confirmer answers with the same bytes; Canton rejects the transaction if two answers differ. The input is one line of fields separated by commas; the answer is one line of fields separated by single spaces. The request and the response bodies of the external call are the hex of that ASCII line (lowercase, two digits a character), with no newline at the end of either, except that the request body of `verify2` is the length-prefixed line itself (see `verify2`); `Zk.Hex` has the two helpers, `toHex` and `fromHex`. Inside the line, hashes, keys, addresses and proofs are lowercase hex, with no `0x`. Numbers are decimal.

### `verify`

Input: `proofHex,headerHex,txsHex`. Each field is lowercase hex. `txsHex` is empty for a block with no transactions. The sidecar refuses a line that does not have exactly three such fields. `Advance` does not check the hex itself (from package 0.2.0; the check walked the block one character at a time and was most of the time Advance took): the sidecar of every confirmer accepts only lowercase, whole-byte hex in those three fields and in every gateway node of a non-empty list (an empty node is refused too) and answers `malformed input` otherwise, which aborts `Advance`. The lists are joined with `;` before the call, so a list holding one empty string reads as no nodes, the same as `[]`, and a node that holds a `;` reads as two. The test form answers the same way.

Answer, if the block checks out:

```
ok programVK rootC blockHash parentHash number stateRoot timestamp gasLimit gasUsed txCount
```

`ok` means: the proof verifies; it commits to `blockHash` in the one valid layout; the header hashes to `blockHash`; the transactions hash to the header's transactions root; the block has no ommers and no withdrawals. `programVK` and `rootC` are the keys the proof was checked under. The other fields are read from the header.

Otherwise: `no` followed by a reason in plain words, for example `no the proof does not verify`.

### `verify2`

The same checks and the same answer as `verify`, for a line that carries the block once. From package 0.3.0 `Advance` calls this one. The line is a hash followed by a body:

- the body is the proof, the header and the transactions, as lowercase hex, with the length of the proof and the length of the header (in characters, each written as 10 decimal digits) in front of them: `lengthField proofHex`, `proofHex`, `lengthField headerHex`, `headerHex`, `txsHex`. The transactions are the rest of the line, and empty for a block with no transactions. The prefixes fix where each field ends, so bytes cannot be moved from one field to the next;
- the hash is the SHA-256 of the body, as 64 lowercase hex digits (`T.sha256`).

The line is sent as it is, not hexed again, which halves what Canton records and replays for the call. The runtime lowercases the text it sends, so a capital letter that `Advance` holds would arrive as a small letter and pass; the hash is of the text as `Advance` holds it, so it no longer matches and the sidecar answers `malformed input`. The record and the argument therefore hold only lowercase hex, as under `verify`. The sidecar also answers `malformed input` for a line shorter than the hash, a prefix that is not 10 digits or reaches past the end, and a field that is not whole lowercase bytes.

### `legs`

Input: `stateRoot,number,gateway,accountNodes,storageNodes,legs`.

- `stateRoot` is the proven block's state root, from the answer of the block check (`verify2`, the same line as `verify`), and `number` the block's number in decimal. `gateway` is the gateway contract's address, from the chain record.
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

`DA.ExternalCall` is not in the Daml 3.5 SDK. It is in the released Daml 3.6 SDK and in Canton 3.6, and Daml Script's test ledger cannot make an external call in any case. So `Zk.Sidecar`, the one module that makes the call, has two forms in `sidecar/`:

- `external.daml` is the form used with a real Canton: two one-line functions. `verifyBlockCall` is `fromHex <$> externalCall "canton-zk-evm" "verify2" "" (verify2Line proofHex headerHex txsHex)`, and `legsCall` is the same for `legs` with `(toHex input)`.
- `stub.daml` is the test form: the same two functions, going through the same hex helpers, answering in the same format from a small table. For `verify2` it lowercases the line (`T.asciiToLower`) as the runtime does, then reads it as the sidecar does: the hash, the two prefixes, and the same refusals. Its package is named `canton-zk-evm-stub`, so it cannot be mistaken for the real one. For `verify2`, the header field of the call picks the scenario, so a test names a block and gets a well-formed answer for a good block, a block on the wrong parent, one that skips a number, one over the gas cap, one proven under another program or another ZisK release, and a failing proof. Four more scenarios cover the 60M cap: the limit is 60M (header `07`), the limit is 60,000,001 (`08`), the limit is 60M and the gas used 60,000,001 (`09`), and the limit is 60M and the gas used exactly 60M (`0a`). For `legs`, the stub cannot hash, so it treats the storage proof as the text of the legs the block recorded, in hex, and the account proof as a tag that picks a failure. A test writes down the legs its block "recorded" in the exact line format above, so the tests also pin that format.

Both forms share all other source code, including every check that `Advance` and the settlement choices make on an answer. Only the answer's source is stubbed. CI runs tests against the stub form. The external form needs a toolchain with `DA.ExternalCall`, which the released Daml 3.6 SDK has. `PINS` names that SDK, `network/canton/fetch.sh` installs it, and `network/canton/build-dar.sh` builds the external form. `SDK_VERSION` selects the SDK version. `build.sh external` defaults to `--target=2.4`, the first Daml-LF version with the external call. The network workflow builds this form and loads it into a real Canton. The smoke test in `network/` exercises the real call with the real sidecar.

## Versions and dependencies

- **Daml SDK 3.5.12**, the version in `daml.yaml`, the latest 3.5 release when this was written. It compiles to LF 2.1, which Canton 3.5 and 3.6 both load. Canton 3.6 is the target network; the tests of the stub form run on the 3.5 SDK (the `test` job) and on the pinned 3.6.0 / LF 2.4 toolchain (the `upgrade` job), and the DAR needs no change for 3.6 except the `external` form's toolchain, the released Daml 3.6 SDK.
- **Token standard (CIP-0056) API packages**, from the Splice 0.8.3 release, unchanged and pinned by `dars/SHA256SUMS`. DevNet's validator runs Splice 0.9.4 (2026-10-27); whether the API packages of 0.9.4 are byte for byte those of 0.8.3 has not been checked here, and the package is built against the 0.8.3 ones. The legs and the OTC swap ran on DevNet under 0.9.4. The package builds against the metadata, holding, allocation and transfer-instruction packages. `dars/README.md` says where they come from. The reference token the tests use is Splice's own test token from the same release.

## Build and test

Install `dpm` and Daml SDK 3.5.12 using the pinned installation procedure in [.github/workflows/daml.yml](../.github/workflows/daml.yml). From the repository root:

```sh
cd daml
./build.sh stub        # dist/canton-zk-evm-stub.dar
./test.sh              # builds the stub form and runs the Daml Script tests
```

CI (`.github/workflows/daml.yml`) does both on a GitHub runner. It downloads the release bundle for the SDK version in `daml.yaml`, checks it against the publisher's SHA256 for that file (pinned in the workflow, so a new SDK version needs a new hash), unpacks it and installs it with `dpm bootstrap`.

### Package 0.2.0 is an upgrade of 0.1.0

Both versions have the same package name, the same templates and types; only the bodies of choices and helpers differ, which Canton accepts as an upgrade. A running chain keeps its contracts: the first `Advance` under 0.2.0 consumes the 0.1.0 `ZkChain` and creates a 0.2.0 one. The `upgrade` job of the same workflow checks this on every change under `daml/`: it rebuilds 0.1.0 from the tag `v0.1.0` and requires its package id to be `ea89dbabb095e49f05b3d23b22916592f6ab65a2f3ad98400c6a68262495bb08`, builds the current source, and runs `dpm upgrade-check --both` on the two DARs (Canton's own upgrade validator). Both are the `external` form, built with the toolchain pinned in `PINS` through `network/canton/build-dar.sh`, which is the toolchain the network runs.

### Package 0.3.0 is an upgrade of 0.2.0 and of 0.1.0

0.3.0 adds choices (`SetGasCap`, `SetProgram`, `SetChangeDelay`, `ProposeGasCap`, `ProposeProgram`, `ProposeChangeDelay`) to `ZkChain`, adds three templates (`GasCapProposal`, `ProgramProposal`, `ChangeDelayProposal`), adds the optional field `changeDelay` at the end of `ZkChain`, and changes the body of `Advance` and the helper modules. No choice signature changes and the new field is optional and last, so a `ZkChain` made by 0.3.0 with no delay has the fields of 0.2.0's and 0.2.0 can consume it (one that holds a delay cannot be consumed by 0.2.0 code: take the delay away before a downgrade); after a downgrade a raised cap stays, and so does a replaced program (the old program can be put back only under 0.3.0). The `upgrade` job rebuilds 0.1.0 and 0.2.0 from the tags `v0.1.0` and `v0.2.0` and requires their package ids to be `ea89dbabb095e49f05b3d23b22916592f6ab65a2f3ad98400c6a68262495bb08` and `a07a2e4d5fc10ba0ef486164dfadce6af066cb92879425ff1e0ec7629c43da7e`, builds the current source, and runs `dpm upgrade-check --both` for 0.2.0 to 0.3.0 and for 0.1.0 to 0.3.0.

0.3.0 also adds the pause of the legs and the withdrawal quota (below). They add the choices `PauseLegs`, `UnpauseLegs`, `RenewPause`, `SetLegLimits`, `ProposeLegLimits` and `ProposeRenewPause` to `ZkChain`, the templates `LegLimitsProposal` and `RenewPauseProposal`, and the optional fields `pauseMax`, `pausedUntil`, `pauseCooldownUntil`, `pauseStartedAt`, `withdrawalQuota`, `quotaWindow` and `withdrawn` after `changeDelay`. A chain made before them has none of these set, which is no pause, no quota and a longest pause of 3 days, so it behaves as it did. Once a pause has been made, or any leg limit (quota or longest pause) set, the chain holds values that 0.2.0 code cannot read (`pauseCooldownUntil` stays set after a pause, `withdrawn` after a quota, and `pauseMax` once it is set), so such a chain cannot go back to 0.2.0.

### Package 0.4.0 is an upgrade of 0.3.0, 0.2.0 and 0.1.0

0.4.0 is additive: it adds two templates (`VenueTrade`, `FundedClaim`) and two constructors at the end of `Leg` (`TradeLeg`, `ClaimLeg`), and changes the bodies of `Advance`'s helpers (`legLine`, `settle`). No existing template, field or choice changes, so a chain made by 0.3.0 goes on under 0.4.0 and a block with no trade or claim leg behaves as before. The CI job `upgrade` rebuilds 0.1.0, 0.2.0 and 0.3.0 from their tags, checks their package ids and runs `dpm upgrade-check --both` against this source.

On DevNet, 0.4.0 (package id `4f57b2ae83bf65b23d90f90aca64bab42ba4269a16c77a0236aa0d1a295d75f`) has been pinned since 2026-10-27 at 15:44 UTC. 0.3.0 (id `4b72df65...`) was pinned from 2026-10-26 at 22:01 UTC, and 0.2.0 from block 1453 on 2026-10-25.

### The gas cap

`SetGasCap` only raises the cap: the new value must be above the current one, at most double it, and at most `maxGasCap` (300,000,000). It does not lower it, because `Advance` already holds every committed header to the cap and the chain contract does not keep the head's gas limit. `Advance`'s own check, that a block's gas limit and gas used are within the cap, is unchanged. The builder reads the chain contract before every block, so a new cap needs no change on its side. The accept consumes the contract that every `Advance` consumes, so the producer is stopped while the cap changes.

### The pause of the legs

While a pause is in force, `Advance` refuses a block that carries a leg (a deposit, a withdrawal or a payment); a block with no leg is still committed. The gateway contract on the EVM side has no pause or admin key of its own, so the pause is on the Canton side alone: a block in which the gateway recorded a leg has to carry that leg, so Canton refuses such a block while the pause is in force.

The builder reads `pausedUntil`, `withdrawalQuota`, `quotaWindow` and `withdrawn` from the chain contract it cuts the block on, and leaves the leg transactions out of the block while the pause or the quota would refuse them, with the reasons listed in [builder/README.md](../builder/README.md). Nothing is proven for them: they stay in the pool and go in once the pause has ended or enough of the quota has run out, and the blocks with no leg go on. Nothing moves on Canton for those legs meanwhile, and a deposit whose allocation expires (`settleBefore`) during the pause can no longer settle and has to be made again. The pause bounds what a forged or faulty block can take through `Advance`; it does not bound the participant that hosts the gateway (see docs/DESIGN.md, 'Custody').

| Choice | Who | What it does |
|---|---|---|
| `PauseLegs` | the confirmer alone, the emergency brake | Pauses the legs for the longest a pause may run (`pauseMax`, 3 days when the chain has none). Refused while the legs are paused and before `pauseCooldownUntil`. |
| `UnpauseLegs` | the confirmer alone | Lifts the pause early. Legs work again at once; the cooldown then runs from now. |
| `RenewPause` (through `ProposeRenewPause` and `AcceptRenewPause`) | the operator and the confirmer together | Pauses the legs, or renews a pause that runs, for a chosen time from the moment of the accept, up to `pauseMax`. Not held to the cooldown. There is no wait before it: a pause protects. |

A pause always ends by itself at `pausedUntil`: legs work again from that ledger time with nothing done. After it ends or is lifted, the confirmer alone may start the next pause only once as long has passed as the pause ran (`pauseCooldownUntil`, from `pauseStartedAt`), so a lone confirmer cannot keep the legs paused for more than half the time, and a false alarm lifted after five minutes locks the brake out for five minutes only. A pause that ran its full `pauseMax` leaves a cooldown of `pauseMax`. The only way to keep them paused longer is for the operator and the confirmer to renew it together, and every renewal is itself at most `pauseMax` from its own accept, and a renewal proposal can be accepted for an hour only. `pauseMax` is a setting of the chain (1 second up to 14 days) that changes with the quota, through `ProposeLegLimits` and the change delay.

### The withdrawal quota

A chain can limit what `Advance` settles out of custody: at most `withdrawalQuota` units of each Canton instrument (by its admin and id: the custody that a withdrawal draws on) in any `quotaWindow` (1 second up to 30 days). Both are optional; with neither set a chain has no quota, as before. `Advance` adds up the withdrawals of the block it commits, per instrument, to those still counted from earlier blocks, and is refused if an instrument is over the quota, with a message naming the instrument, the amount the block would add, what it would make in the window and the quota. A block that reaches the quota exactly is accepted. Counting by instrument and not by EVM token means that wrapped tokens registered for one instrument (`GatewayToken`, by the operator, the gateway and the confirmer) share one quota. One quota applies to every instrument whatever its value, so it has to suit the most valuable one. A single withdrawal above the quota can never be committed, so the quota must be above the largest single withdrawal expected; the builder leaves such a withdrawal out of the blocks, with the reason 'the withdrawal is over the whole withdrawal quota of <instrument>' (see [builder/README.md](../builder/README.md)), until the limits change. The pause and the quota bound what a forged or faulty block can take through `Advance`; they do not bound the participant that hosts the gateway, which can still move custody outside `Advance` (see docs/DESIGN.md, 'Custody').

The window rolls. The chain keeps the withdrawals in `withdrawn`, in buckets of a 24th of the window (at least a second): a withdrawal counts from its block until the end of its bucket plus one window, so no more than the quota leaves in any window, and a withdrawal may count a little longer than the window. An entry keeps the expiry it was made with, so changing the window never frees or holds earlier withdrawals. About 25 entries per instrument are live at most, so the contract stays small.

The quota, its window and `pauseMax` are replaced together by `LegLimitsProposal` (the operator proposes through `ProposeLegLimits`, the confirmer accepts with `AcceptLegLimits`), and the accept waits out the chain's change delay, as a gas-cap change does. A change may loosen the quota or tighten it, and the quota and its window are set together or neither is.

### Custody and the wrapped supply

`Advance` does not compare the custody with the wrapped supply, because Daml sees only one side of it. A block's legs carry the amounts of the deposits and withdrawals in it, and the sidecar's hash binds those amounts to what the gateway contract recorded, so the change that a block makes to custody and to supply is the same by construction; a check of that change would hold whatever the contracts were. What matters is the absolute figures: what the gateway holds in total, which `Advance` never reads (it sees only the contracts of the legs it settles), and the EVM `totalSupply()` of each wrapped token. No leg carries that, and although it could be proven by a storage proof against the proven state root, as the gateway's leg storage is, under a forged proof that root is itself forged, so the check would only catch a mint bug of the gateway contract and not the attack that the custody must withstand. The explorer's custody read compares the two figures, each `CUSTODY_MS` (30 seconds by default), at the newest indexed block, and shows the difference on the token page (see its README); nothing alerts on it yet. The withdrawal quota above bounds how much `Advance` settles out in a window while a difference is looked at (not what the hosting participant can move).

The check is per instrument: the instrument's custody must be at least the sum of the `totalSupply()` of every `GatewayToken` of that instrument (several wrapped tokens may be registered for one instrument), and the difference gauge and the alert are to be computed that way. Today's explorer read compares per token (one row per `GatewayToken`, the instrument's whole custody against that one token's supply), so it is right only while each instrument has one wrapped token.
