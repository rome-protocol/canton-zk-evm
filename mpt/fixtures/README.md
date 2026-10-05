# Test data

Real `eth_getProof` answers, taken from a local Foundry `anvil` (v1.3.6) running a small test contract. The contract keeps a yes/no flag per entry in a mapping at storage slot 0; a flag set to yes stores the value 1. The answers are public data and nothing in them is secret.

| Files | What is in them |
|---|---|
| `single_proof.json`, `single_root.json` | One entry set. The account proof (3 nodes) and the storage proof of the set slot, which holds 1. `single_root.json` has the block's state root. |
| `single_absent.json` | The same contract, asked about a slot that was never written: the value is 0 and the storage proof ends where the key leaves the trie. |
| `many_proof.json`, `many_root.json` | 20 entries set. Two slots in one answer: one set, one never written. |
| `deep_proof.json`, `deep_root.json` | 500 entries set, which is deep enough to produce real extension nodes. Two slots in one answer: one whose proof passes through an extension node, and one whose proof ends at one. |

The test contract and the commands that captured these answers are not included. No test uses the `block_hash` field of the `*_root.json` files.

The tests also use a proof from this project's own reth, which is made in CI and not stored here: see `tests/capture_proof.sh` in the repository root.
