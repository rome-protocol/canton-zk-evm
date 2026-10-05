# zk-mpt

Checks Ethereum Merkle-Patricia proofs, as returned by `eth_getProof`, against a state root you already trust.

- `verify_account(state_root, address, nodes)` proves an account's nonce, balance, storage root and code hash.
- `verify_storage(storage_root, slot, nodes)` proves a storage slot's value or its absence from the trie at the supplied storage root (`StorageValue::Absent`, distinct from a stored zero). Absence does not establish whether the slot was written previously.

A proof is refused if it has more than 64 nodes, a node over 532 bytes, a hash that does not match, malformed RLP, or nodes left over. The one hash is Keccak-256.

```sh
cd mpt                  # from the repository root
cargo test
```

`fixtures/README.md` says where the test data comes from. One more test takes a real proof from this project's own reth; CI runs it (see `tests/capture_proof.sh` and `.github/workflows/verifier.yml`).

Originally written by Rome Protocol.
