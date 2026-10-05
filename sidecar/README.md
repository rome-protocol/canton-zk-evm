# sidecar

Canton calls this Rust service through its external-call extension. One instance runs beside each confirming participant. Its two functions depend only on their input; neither uses state, the network or a clock. Every honest confirmer therefore returns the same bytes.

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
| `POST /api/v1/external-call` with header `X-Daml-External-Function-Id: verify` or `fact` | 200 and the hex of the answer line. The body is the hex of the input line. |

A function id that is not `verify` or `fact`, a missing id, or a body that is not lowercase hex of text gets 400. An input line that is not in the right shape is not an error of the call: it gets the answer `no malformed input`.

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

## `fact`

`fact` verifies the holder's balance at the parent and current state roots, then returns the increase as a 256-bit hex value. It rejects invalid proofs and decreases. The token's account must exist in both states; the `mpt/` crate does not prove account absence.

For each state, it checks the account proof of `token`, then the storage proof of the balance under that account's storage root. The balance of `holder` sits at `keccak256(holder, slot)`, each as 32 bytes, as Solidity lays out a mapping. An absent storage slot counts as zero. Empty account storage also proves zero and needs no storage nodes. The answer is the current balance minus the parent balance, as 64 hex digits. An unchanged balance gives 64 zeros.

The reasons are `malformed input`, `the account proof does not verify`, `the storage proof does not verify` (for any of the four proofs) and `the balance fell`.

## Tests

From the repository root:

```sh
cd sidecar
cargo test
```

Most tests use real data. Five kinds of test data are built by hand, as listed below.

Real data:

- the proof of block 1, recorded in `prover/fixtures/`, and the verifier crate's six proofs (three blocks, ZisK 1.2.0 and 1.3.1). For every block, the 1.2.0 proof and the 1.3.1 proof must commit to the same block hash;
- a block with one transfer, and a token's balance proofs, taken from this project's own reth by `tests/capture_fixtures.sh`. They are the new-block side of the two-root tests, because the stored data has one state only (the parent side is hand-built, below). They are stored in `tests/fixtures/`. CI takes a fresh copy on every run and runs every test against that as well (`SIDECAR_FIXTURES=<folder>`);
- the mpt crate's proofs, for the refusals;

Built by hand:

- **The parent state and the rises.** A one-account state with a chosen balance in the token's storage (a single leaf, written with the crate's own RLP writer), or with nothing stored. It is the parent in the tests of the real balance, and both states in the tests of the difference: a rise, a rise from nothing, a borrow through every byte (1 to 2^255), a fall, and each of the four proofs and both roots checked.
- **The state with nothing stored.** The test that a token with an empty storage proves every balance zero uses a one-account state written out in the test, because the chain's own state has no such token. The account is built with the crate's own RLP writer.
- **The stand-in proof.** `abi_for` in `tests/common/mod.rs` makes a 1,344-byte input that has no real proof in it: 768 bytes of zeros where the proof would be, two made-up pins, and public values in the right layout around the hash of the real reth block. It is used only together with a proof check that accepts anything, to test the rest of `verify` (the header, the transaction list, the answer's form) on a real block. The tests of the proof check itself never use it, apart from one that checks the layout of the public values, which has nothing to do with the proof.
- **The transactions-root comparison.** The `triehash` crate is real code, an independent implementation of the transactions root, but the values it is given are generated by the tests. One set is runs of bytes in many counts and sizes, chosen on either side of the places where the keys change shape. The other is a list of a real typed transaction and a made-up old-style one, and a list of the made-up old-style one alone.
- **Made-up transactions and edited headers.** The tests of the canonical encoding use made-up transactions, which were never sent. The old-style transaction has the right nine fields and a fake signature. The typed "transaction" (`02 01 02 03`) and the single byte (`05`) are stand-in byte strings, not real transactions: only the way they are written is under test. Each test then uses the real header with its transactions root changed to match the list. The ommers and withdrawals tests use the real header with one field changed.

A real proof is accepted, and these are refused: a flipped proof byte, a flipped byte in the public values, another program key, another root, another release's proof, public values in another layout, a header that does not hash to the committed value, a transaction list that does not match its root, a header with ommers or withdrawals, a balance proof under another state root or for another token, flipped bytes in any of the four proofs, proofs under the other side's root, and a balance that fell.

Canonical encoding: `verify` reads the header and the transaction list, writes them again in the one canonical way and refuses them if the result is not the same bytes. That refuses a length written in the long form when the short one fits, a length with a leading zero, a single byte below 0x80 written as a string, an old-style transaction written as a byte string, and `c0` for a block with no transactions (the input is empty then). Each is tested with a header whose transactions root matches the list, so the refusal can only come from the way the list is written. The reasons are the ones above: `the header is malformed` for the header, and `the transactions do not match the header's transactions root` for the list.

The header and transactions of block 1, which the recorded proof covers, were not saved. The proof and block checks in `verify` are therefore tested separately: real proofs for the proof check, and a real block from this project's reth for the block check. A combined test uses the stand-in proof above with a proof check that accepts anything. This replacement requires the `test-proof-check` cargo feature, enabled by the crate's own dev-dependency. The program is built without that feature. It always checks proofs with ZisK 1.3.1, and that check cannot be replaced.

Originally written by Rome Protocol.
