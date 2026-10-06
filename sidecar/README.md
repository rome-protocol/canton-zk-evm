# sidecar

Canton calls this Rust service through its external-call extension. One instance runs beside each confirming participant. Its two functions, `verify` and `legs`, depend only on their input; neither uses state, the network or a clock. Every honest confirmer therefore returns the same bytes.

The request and response formats are defined in [daml/README.md](../daml/README.md). This page describes the implementation and tests.

## Running it

Use `programVK` and `rootC` from the successful guest build recorded in `state/net/guest.txt`. The options accept those values with or without `0x`. From the repository root:

```sh
cd sidecar
cargo run --release -- --program-vk <programVK> --root-c <rootC>
```

Replace the placeholders with the two recorded values. The default listen address is `127.0.0.1:8085`; use `--listen <address:port>` to change it.

`--program-vk` and `--root-c` are the pins: the key of the program whose proofs are accepted, and the root of the ZisK release's final circuit (1.3.1). A proof made by anything else is refused.

## What Canton calls

| Request | Answer |
|---|---|
| `GET /api/v1/version` | 200 and a small JSON object |
| `POST /api/v1/external-call` with header `X-Daml-External-Function-Id: verify` or `legs` | 200 and the hex of the answer line. The body is the hex of the input line. |

A function id that is not `verify` or `legs`, a missing id, or a body that is not lowercase hex of text gets 400. An input line that is not in the right shape is not an error of the call: it gets the answer `no malformed input`.

## `verify`

It checks, in this order:

1. the proof is 1,344 bytes and verifies under the ZisK 1.3.1 key (the `verifier/` crate);
2. its program key and root are the pinned ones;
3. its public values have the one valid layout: 64 slots of 8 bytes, each holding a 4-byte word and four zero bytes. Put together, the words are `0x20`, the 32-byte block hash, and zeros;
4. the header's Keccak-256 is that block hash, and the header is written in canonical RLP;
5. the header has no ommers, and no withdrawals if it has a withdrawals root;
6. the transaction list is written in canonical RLP, and its root is the header's transactions root.

The header is the block header's RLP. `txsHex` is the block's transaction list as it sits in the block's own RLP: a list in which a typed transaction is a byte string and an old-style one is a list. It is empty for a block with no transactions (not `c0`). The transactions root is worked out here in `src/trie.rs`.

The reasons after `no` are: `malformed input`, `the proof is not 1,344 bytes`, `the proof does not verify`, `the proof was made by another program or ZisK release`, `the proof does not commit to one block hash`, `the header does not hash to the proven block hash`, `the header is malformed`, `the block has ommers`, `the block has withdrawals`, `the transactions do not match the header's transactions root`.

## `legs`

`legs` checks that the Canton legs attached to a block are exactly the ones the block recorded in the gateway contract. The contract keeps, for each block, one running hash of the legs its transactions asked for (see [gateway/README.md](../gateway/README.md)). The block's proof fixes the chain's state, so it fixes that hash. This function hashes the attached legs the same way and compares the two.

The input is one line, `stateRoot,number,gateway,accountNodes,storageNodes,legs`:

- `stateRoot` is the proven block's state root and `number` its number in decimal. `gateway` is the gateway contract's address. Each is lowercase hex or digits, with no prefix.
- `accountNodes` and `storageNodes` are the gateway's account proof and the storage proof of its entry for `number`, as `eth_getProof` gives them: nodes in hex, joined by `;`. The storage list may be empty.
- `legs` is empty, or the attached legs in order, joined by `|`. Each leg is six fields joined by `/`: `kind/id/token/account/amount/party`.

It does this, in this order:

1. It reads the line. A leg has a `kind` of `deposit`, `withdrawal` or `payment`, an `id` of 64 hex digits, and a `token` and an `account` of 40. The `amount` of a payment is the ERC-20 amount as 64 hex digits. The `amount` of a deposit or a withdrawal is a Canton amount as Daml writes a `Decimal`: digits, a point and one to ten digits, such as `10.0` or `0.0000000001`. It is turned into base units by multiplying it by 10^10, so nothing is rounded; a number that does not fit in 128 bits, which no Daml amount does, is refused. The `party` of a withdrawal is the hex of the receiver's party id, and a deposit or a payment has none.
2. It checks the account proof of the gateway under `stateRoot`. Then it checks the storage proof under that account's storage root, at the key where Solidity keeps entry `number` of a mapping at slot 0: `keccak256(number . 0)`, both as 32 bytes. An entry that was never written counts as zero, and so does an account with nothing stored, which needs no storage nodes. A block in which the gateway recorded no leg has no entry, so "this block needs no legs" is proven in the same way as "this block needs these three".
3. It hashes the legs, starting from 32 zero bytes. Each step is the Keccak-256 of seven 32-byte words: the previous value, the kind (1, 2 or 3), the id, the token, the account, the amount in base units, and the Keccak-256 of the party's bytes. That is the rule in the contract, written again here.
4. It compares the result with the value the proof gave. No legs against no entry is equal, because both are 32 zero bytes.

The answer is `ok stateRoot number gateway count`, where `count` is how many legs were attached, or `no` and one of: `malformed input`, `the account proof does not verify`, `the storage proof does not verify`, `the legs are not the ones the block recorded`. A line that is not in the right shape is refused before its proofs are looked at, and a bad account proof before the storage proof. Like `verify`, it is a pure function of its input line, so both confirmers' sidecars answer with the same bytes.

A missing leg, an extra one, two in another order, or one with any field changed gives another hash and is refused. Beyond what the proof already rests on, this rests on Keccak-256 having no known collisions.

## Tests

From the repository root:

```sh
cd sidecar
cargo test
```

Most tests use real data. Four kinds of test data are built by hand, as listed below.

Real data:

- the proof of block 1, recorded in `prover/fixtures/`, and the verifier crate's six proofs (three blocks, ZisK 1.2.0 and 1.3.1). For every block, the 1.2.0 proof and the 1.3.1 proof must commit to the same block hash;
- a block with one transfer (`block.json`), and the gateway's proofs for four blocks (`legs.json`), taken from this project's own reth by `tests/capture_fixtures.sh`. That reth has the gateway in its genesis, as every run of the chain does, and is started only through `network/reth/launch.sh`, with peer discovery off. The four blocks are block 1, in which the gateway has nothing stored; a block that registers a wrapped token and records no leg, so the gateway has storage but no entry for the block; a block with one deposit; and a block with a deposit, a withdrawal and a payment. Each proof was taken while its block was the newest one, and the legs of each block are read from the gateway's own events and written in the form `legs` takes. A key is made for each capture, kept in a throwaway folder with mode 0600 and deleted. The stored data is in `tests/fixtures/`. CI takes a fresh copy on every run and runs every test against that as well (`SIDECAR_FIXTURES=<folder>`);
- the mpt crate's proofs, for the refusals;

Built by hand:

- **The gateway states written out by hand.** `hand_built` in `tests/common/mod.rs` makes a one-account state: the gateway's account and, in its storage, the entry for one block with a chosen value, or nothing stored at all (a single leaf, written with the crate's own RLP writer). The test chooses the legs and works out their hash itself, with its own copy of the contract's rule (`leg_hash`, in the same file), so that the amounts can be chosen at will: one base unit, a quarter, the largest amount Daml has, a payment of the largest 256-bit number, four legs of every kind in a row. That copy is checked against the real blocks: worked out from the legs reth's events gave, it is the value in reth's storage proof.
- **The stand-in proof.** `abi_for` in `tests/common/mod.rs` makes a 1,344-byte input that has no real proof in it: 768 bytes of zeros where the proof would be, two made-up pins, and public values in the right layout around the hash of the real reth block. It is used only together with a proof check that accepts anything, to test the rest of `verify` (the header, the transaction list, the answer's form) on a real block. The tests of the proof check itself never use it, apart from one that checks the layout of the public values, which has nothing to do with the proof.
- **The transactions-root comparison.** The `triehash` crate is real code, an independent implementation of the transactions root, but the values it is given are generated by the tests. One set is runs of bytes in many counts and sizes, chosen on either side of the places where the keys change shape. The other is a list of a real typed transaction and a made-up old-style one, and a list of the made-up old-style one alone.
- **Made-up transactions and edited headers.** The tests of the canonical encoding use made-up transactions, which were never sent. The old-style transaction has the right nine fields and a fake signature. The typed "transaction" (`02 01 02 03`) and the single byte (`05`) are stand-in byte strings, not real transactions: only the way they are written is under test. Each test then uses the real header with its transactions root changed to match the list. The ommers and withdrawals tests use the real header with one field changed.

A real proof is accepted, and these are refused: a flipped proof byte, a flipped byte in the public values, another program key, another root, another release's proof, public values in another layout, a header that does not hash to the committed value, a transaction list that does not match its root, a header with ommers or withdrawals, a proof under another state root, for another gateway address or for another block's entry, a storage proof from another state, a flipped byte in either proof, a missing proof, and legs that are not the ones recorded.

Legs: for each real block, the legs it recorded are accepted. A leg left out (each in turn), added, repeated, two swapped, the legs of another block, any one of the id, token, account, amount, kind or party changed, are all refused with `the legs are not the ones the block recorded`. A line that is not well formed is refused with `malformed input`: a wrong number of fields, capital letters, a wrong length, an unknown kind, a Canton amount with no point or more than ten digits after it, a payment amount that is not 64 hex digits, a party on a deposit or a payment, and empty legs between separators.

Canonical encoding: `verify` reads the header and the transaction list, writes them again in the one canonical way and refuses them if the result is not the same bytes. That refuses a length written in the long form when the short one fits, a length with a leading zero, a single byte below 0x80 written as a string, an old-style transaction written as a byte string, and `c0` for a block with no transactions (the input is empty then). Each is tested with a header whose transactions root matches the list, so the refusal can only come from the way the list is written. The reasons are the ones above: `the header is malformed` for the header, and `the transactions do not match the header's transactions root` for the list.

The header and transactions of block 1, which the recorded proof covers, were not saved. The proof and block checks in `verify` are therefore tested separately: real proofs for the proof check, and a real block from this project's reth for the block check. A combined test uses the stand-in proof above with a proof check that accepts anything. This replacement requires the `test-proof-check` cargo feature, enabled by the crate's own dev-dependency. The program is built without that feature. It always checks proofs with ZisK 1.3.1, and that check cannot be replaced.

Copyright 2026 Rome Protocol. Licensed under the Apache License 2.0.
