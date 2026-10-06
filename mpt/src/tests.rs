// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
//! The tests: real `eth_getProof` answers from a local node (`fixtures/`), hand-built tries for the
//! shapes real nodes rarely produce, and one proof taken from the project's own reth in CI.

use super::*;
use serde::Deserialize;

fn hex32(s: &str) -> [u8; 32] {
    let v = hex::decode(s.trim_start_matches("0x")).unwrap();
    v.try_into().unwrap()
}

fn hex20(s: &str) -> [u8; 20] {
    let v = hex::decode(s.trim_start_matches("0x")).unwrap();
    v.try_into().unwrap()
}

fn hex_bytes(s: &str) -> Vec<u8> {
    hex::decode(s.trim_start_matches("0x")).unwrap()
}

#[derive(Deserialize)]
struct StorageProof {
    key: String,
    value: String,
    proof: Vec<String>,
}

#[derive(Deserialize)]
struct GetProof {
    address: String,
    #[serde(rename = "accountProof")]
    account_proof: Vec<String>,
    #[serde(rename = "storageProof")]
    storage_proof: Vec<StorageProof>,
}

#[derive(Deserialize)]
struct StateRoot {
    state_root: String,
}

fn nodes_from_hex(hexes: &[String]) -> Vec<Vec<u8>> {
    hexes.iter().map(|h| hex_bytes(h)).collect()
}

const SINGLE_PROOF: &str = include_str!("../fixtures/single_proof.json");
const SINGLE_ABSENT: &str = include_str!("../fixtures/single_absent.json");
const SINGLE_ROOT: &str = include_str!("../fixtures/single_root.json");

/// The proof, the state root it is checked against, and the contract's address.
fn anvil_fixture() -> (GetProof, [u8; 32], [u8; 20]) {
    let proof: GetProof = serde_json::from_str(SINGLE_PROOF).unwrap();
    let root: StateRoot = serde_json::from_str(SINGLE_ROOT).unwrap();
    let address = hex20(&proof.address);
    (proof, hex32(&root.state_root), address)
}

#[test]
fn anvil_fixture_verifies() {
    let (proof, state_root, contract) = anvil_fixture();
    let account_nodes = nodes_from_hex(&proof.account_proof);
    let account = verify_account(&state_root, &contract, &account_nodes).unwrap();

    let storage_nodes = nodes_from_hex(&proof.storage_proof[0].proof);
    let slot = hex32(&proof.storage_proof[0].key);
    let value = verify_storage(&account.storage_root, &slot, &storage_nodes).unwrap();
    assert_eq!(proof.storage_proof[0].value, "0x1");
    assert_eq!(
        value,
        StorageValue::Present({
            let mut b = [0u8; 32];
            b[31] = 1;
            b
        })
    );
}

#[test]
fn exclusion_proof_is_not_inclusion() {
    let (proof, state_root, contract) = anvil_fixture();
    let account_nodes = nodes_from_hex(&proof.account_proof);
    let account = verify_account(&state_root, &contract, &account_nodes).unwrap();

    let unset: GetProof = serde_json::from_str(SINGLE_ABSENT).unwrap();
    assert_eq!(unset.storage_proof[0].value, "0x0");
    let storage_nodes = nodes_from_hex(&unset.storage_proof[0].proof);
    let slot = hex32(&unset.storage_proof[0].key);
    let value = verify_storage(&account.storage_root, &slot, &storage_nodes).unwrap();
    assert_eq!(value, StorageValue::Absent);
}

#[test]
fn flipped_node_byte_is_refused() {
    let (proof, state_root, contract) = anvil_fixture();
    let account_nodes = nodes_from_hex(&proof.account_proof);
    for i in 0..account_nodes.len() {
        let mut mutated = account_nodes.clone();
        let last = mutated[i].len() - 1;
        mutated[i][last] ^= 0xff;
        assert!(
            verify_account(&state_root, &contract, &mutated).is_err(),
            "flipping account_nodes[{i}]'s last byte must be refused"
        );
    }

    let account = verify_account(&state_root, &contract, &account_nodes).unwrap();
    let storage_nodes = nodes_from_hex(&proof.storage_proof[0].proof);
    let slot = hex32(&proof.storage_proof[0].key);
    for i in 0..storage_nodes.len() {
        let mut mutated = storage_nodes.clone();
        let last = mutated[i].len() - 1;
        mutated[i][last] ^= 0xff;
        assert!(
            verify_storage(&account.storage_root, &slot, &mutated).is_err(),
            "flipping storage_nodes[{i}]'s last byte must be refused"
        );
    }
}

#[test]
fn proof_against_other_state_root_is_refused() {
    let (proof, _state_root, contract) = anvil_fixture();
    let account_nodes = nodes_from_hex(&proof.account_proof);
    let wrong_root = [0x42u8; 32];
    assert_eq!(
        verify_account(&wrong_root, &contract, &account_nodes).unwrap_err(),
        MptError::RootMismatch
    );
}

#[test]
fn proof_for_other_address_is_refused() {
    let (proof, state_root, _contract) = anvil_fixture();
    let account_nodes = nodes_from_hex(&proof.account_proof);
    // Ground-truth account tries have more than one populated branch slot (anvil's genesis funds ten
    // dev accounts), so an *arbitrary* wrong address usually diverges at a branch (`HashMismatch`),
    // not at the leaf — both are still refusals, but the test asks for `PathMismatch` specifically: the
    // leaf-comparison refusal, reached when the wrong address's key nibbles agree with the real
    // address's for exactly as many nibbles as the two branch nodes in this proof consume (2 nibbles
    // = the key's first byte), diverging only once the walk reaches the leaf itself. Ground-truthed by
    // grinding candidate 20-byte addresses for one whose `keccak256` shares the real contract key's
    // first byte (found at candidate 415 = 0x19f, off-line, not reproduced at test time).
    let other_address: [u8; 20] = hex20("0x000000000000000000000000000000000000019f");
    assert_eq!(
        verify_account(&state_root, &other_address, &account_nodes).unwrap_err(),
        MptError::PathMismatch
    );
}

#[test]
fn node_over_532_bytes_refused() {
    let (proof, state_root, contract) = anvil_fixture();
    let mut account_nodes = nodes_from_hex(&proof.account_proof);
    account_nodes[0].resize(MAX_NODE_BYTES + 1, 0);
    assert_eq!(
        verify_account(&state_root, &contract, &account_nodes).unwrap_err(),
        MptError::NodeTooLarge {
            index: 0,
            len: MAX_NODE_BYTES + 1
        }
    );
}

#[test]
fn more_than_64_nodes_refused() {
    let (proof, state_root, contract) = anvil_fixture();
    let mut account_nodes = nodes_from_hex(&proof.account_proof);
    while account_nodes.len() <= MAX_NODES {
        account_nodes.push(vec![0u8; 1]);
    }
    let got = account_nodes.len();
    assert_eq!(
        verify_account(&state_root, &contract, &account_nodes).unwrap_err(),
        MptError::TooManyNodes { got }
    );
}

#[test]
fn trailing_node_refused() {
    let (proof, state_root, contract) = anvil_fixture();
    let mut account_nodes = nodes_from_hex(&proof.account_proof);
    account_nodes.push(vec![0x80]); // a well-formed but wholly unnecessary extra node
    assert_eq!(
        verify_account(&state_root, &contract, &account_nodes).unwrap_err(),
        MptError::TrailingNodes
    );
}

/// A hand-built two-node trie whose child is embedded inline (its own RLP encoding is under 32
/// bytes): a root branch node with exactly one populated slot, referencing a leaf node directly by
/// its raw list bytes rather than by a 32-byte keccak hash. Deterministic and independent of whatever
/// a real 20-entry anvil trie happens to produce (`multi_fixture_node_kinds_are_measured_not_assumed`
/// measures that separately) — this proves the inline-child code path itself, byte for byte.
#[test]
fn inline_child_is_followed() {
    // Leaf: hex-prefix path (leaf, even) = 0x20, then one path byte 0xcd -> nibbles [c, d]; value
    // "hi" (2-byte string). RLP: c1-list-header, 0x82 path-len, 0x20 0xcd, 0x82 'h' 'i'.
    let leaf: Vec<u8> = {
        let path = [0x20u8, 0xcd]; // RLP short string, len 2
        let value = b"hi";
        let mut payload = Vec::new();
        payload.push(0x80 + path.len() as u8);
        payload.extend_from_slice(&path);
        payload.push(0x80 + value.len() as u8);
        payload.extend_from_slice(value);
        let mut out = Vec::new();
        out.push(0xc0 + payload.len() as u8);
        out.extend_from_slice(&payload);
        out
    };
    assert!(
        leaf.len() < 32,
        "the leaf must be small enough to embed inline"
    );

    // Root branch: 17 items, slot 5 = the leaf embedded as a nested list, everything else empty.
    let mut branch_payload = Vec::new();
    for i in 0..17u8 {
        if i == 5 {
            branch_payload.extend_from_slice(&leaf);
        } else {
            branch_payload.push(0x80); // empty string
        }
    }
    let mut root_node = Vec::new();
    assert!(branch_payload.len() < 56);
    root_node.push(0xc0 + branch_payload.len() as u8);
    root_node.extend_from_slice(&branch_payload);

    let root_hash = keccak256(&[root_node.as_slice()]);
    let nodes = vec![root_node];

    // Key nibbles: first nibble 5 (selects the inline slot), then [c, d] (the leaf's own path).
    let mut key_nibbles = vec![5u8, 0xc, 0xd];
    // walk() needs a full byte-derived key in real callers, but it only ever consumes `key_nibbles`
    // directly, so a hand-built nibble sequence (bypassing the address/slot keccak step) exercises
    // exactly the traversal logic under test, deterministically.
    let (outcome, consumed) = super::walk::walk(root_hash, &key_nibbles, &nodes).unwrap();
    assert_eq!(
        consumed, 1,
        "the inline child must not consume a second array entry"
    );
    match outcome {
        walk::WalkOutcome::Found(v) => assert_eq!(v, b"hi"),
        walk::WalkOutcome::Diverged => panic!("expected the inline leaf to be found"),
    }

    // A wrong final nibble diverges at the inline leaf, proving the inline node's own path really is
    // checked (not merely "present -> accept").
    key_nibbles[2] = 0xe;
    let (outcome, _) = super::walk::walk(root_hash, &key_nibbles, &nodes).unwrap();
    assert!(matches!(outcome, walk::WalkOutcome::Diverged));
}

const MANY_PROOF: &str = include_str!("../fixtures/many_proof.json");
const MANY_ROOT: &str = include_str!("../fixtures/many_root.json");

/// A node's shape, classified the same way `crate::walk` itself distinguishes them — independent of
/// `crate::rlp`, so a bug in this crate's own decoder could not also fool this classification.
#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
enum NodeKind {
    Branch,
    Leaf,
    Extension,
}

fn classify_node(node: &[u8]) -> NodeKind {
    // Minimal, independent RLP walk: decode the outer list's item count and, for a 2-item node, the
    // hex-prefix terminator flag on its first item.
    fn decode_list(data: &[u8]) -> Vec<&[u8]> {
        let b0 = data[0];
        let (mut p, end) = if b0 <= 0xf7 {
            (1usize, 1 + (b0 - 0xc0) as usize)
        } else {
            let ll = (b0 - 0xf7) as usize;
            let mut len = 0usize;
            for &b in &data[1..1 + ll] {
                len = (len << 8) | b as usize;
            }
            (1 + ll, 1 + ll + len)
        };
        let mut items = Vec::new();
        while p < end {
            let ib0 = data[p];
            let (istart, ilen, iconsumed) = if ib0 < 0x80 {
                (p, 1, 1)
            } else if ib0 <= 0xb7 {
                let l = (ib0 - 0x80) as usize;
                (p + 1, l, 1 + l)
            } else if ib0 <= 0xbf {
                let ll = (ib0 - 0xb7) as usize;
                let mut l = 0usize;
                for &b in &data[p + 1..p + 1 + ll] {
                    l = (l << 8) | b as usize;
                }
                (p + 1 + ll, l, 1 + ll + l)
            } else if ib0 <= 0xf7 {
                let l = (ib0 - 0xc0) as usize;
                (p, 1 + l, 1 + l)
            } else {
                let ll = (ib0 - 0xf7) as usize;
                let mut l = 0usize;
                for &b in &data[p + 1..p + 1 + ll] {
                    l = (l << 8) | b as usize;
                }
                (p, 1 + ll + l, 1 + ll + l)
            };
            items.push(&data[istart..istart + ilen.min(data.len() - istart)]);
            p += iconsumed;
        }
        items
    }
    let items = decode_list(node);
    match items.len() {
        17 => NodeKind::Branch,
        2 => {
            if items[0].first().is_some_and(|b| b & 0x20 != 0) {
                NodeKind::Leaf
            } else {
                NodeKind::Extension
            }
        }
        n => panic!("unexpected node shape ({n} items) in a real getProof fixture"),
    }
}

/// Looks at which kinds of trie node the 20-entry fixture's proofs really contain, instead of
/// assuming. They contain branch nodes and leaf nodes and no extension node, which is what
/// a trie with only 20 keys tends to look like. The test asserts exactly that, then checks
/// that the fixture's proofs still verify. The extension-node case is covered by the larger
/// 500-entry fixture below. The inline-child case is covered by `inline_child_is_followed`, which
/// uses a hand-built node.
#[test]
fn multi_fixture_node_kinds_are_measured_not_assumed() {
    let proof: GetProof = serde_json::from_str(MANY_PROOF).unwrap();
    let root: StateRoot = serde_json::from_str(MANY_ROOT).unwrap();

    let mut kinds = std::collections::BTreeSet::new();
    for n in &proof.account_proof {
        kinds.insert(classify_node(&hex_bytes(n)));
    }
    for sp in &proof.storage_proof {
        for n in &sp.proof {
            kinds.insert(classify_node(&hex_bytes(n)));
        }
    }
    assert!(
        kinds.contains(&NodeKind::Branch),
        "expected at least one branch node"
    );
    assert!(
        kinds.contains(&NodeKind::Leaf),
        "expected at least one leaf node"
    );
    assert!(
        !kinds.contains(&NodeKind::Extension),
        "measured fact, not an assumption: this 20-key trie has no extension node"
    );

    // End-to-end: the fixture still verifies correctly regardless of which node kinds it contains.
    let state_root = hex32(&root.state_root);
    let contract = hex20(&proof.address);
    let account_nodes = nodes_from_hex(&proof.account_proof);
    let account = verify_account(&state_root, &contract, &account_nodes).unwrap();

    let entry7_slot = hex32(&proof.storage_proof[0].key);
    let entry7_storage_nodes = nodes_from_hex(&proof.storage_proof[0].proof);
    assert_eq!(proof.storage_proof[0].value, "0x1");
    assert_eq!(
        verify_storage(&account.storage_root, &entry7_slot, &entry7_storage_nodes).unwrap(),
        StorageValue::Present({
            let mut b = [0u8; 32];
            b[31] = 1;
            b
        })
    );

    let never_set_slot = hex32(&proof.storage_proof[1].key);
    let never_set_storage_nodes = nodes_from_hex(&proof.storage_proof[1].proof);
    assert_eq!(proof.storage_proof[1].value, "0x0");
    assert_eq!(
        verify_storage(
            &account.storage_root,
            &never_set_slot,
            &never_set_storage_nodes
        )
        .unwrap(),
        StorageValue::Absent
    );
}

const DEEP_PROOF: &str = include_str!("../fixtures/deep_proof.json");
const DEEP_ROOT: &str = include_str!("../fixtures/deep_root.json");

/// Checks that the 500-entry fixture really contains at least one extension node, so the tests that
/// walk extension nodes (including a forged proof whose path skips an extension's shared nibbles) run
/// against a real one. `fixtures/README.md` says how the fixture was made. The 20-entry fixture has no
/// extension node, which is why this larger one is used.
#[test]
fn ext_fixture_has_an_extension_node() {
    let proof: GetProof = serde_json::from_str(DEEP_PROOF).unwrap();
    let mut kinds = std::collections::BTreeSet::new();
    for n in &proof.account_proof {
        kinds.insert(classify_node(&hex_bytes(n)));
    }
    for sp in &proof.storage_proof {
        for n in &sp.proof {
            kinds.insert(classify_node(&hex_bytes(n)));
        }
    }
    assert!(
        kinds.contains(&NodeKind::Extension),
        "the ext fixture must contain at least one real Extension node"
    );
}

/// The fixture's first slot (entry 21) is the first of 500 whose storage proof actually traverses a
/// real Extension node before reaching its leaf (Branch, Branch, Extension, Branch, Leaf). The walk
/// has to skip the nibbles the extension node covers; if it did not, the next branch step would read
/// the wrong nibble and this proof would no longer verify to `Present(1)`.
#[test]
fn inclusion_through_extension_verifies() {
    let proof: GetProof = serde_json::from_str(DEEP_PROOF).unwrap();
    let root: StateRoot = serde_json::from_str(DEEP_ROOT).unwrap();
    let state_root = hex32(&root.state_root);
    let contract = hex20(&proof.address);
    let account_nodes = nodes_from_hex(&proof.account_proof);
    let account = verify_account(&state_root, &contract, &account_nodes).unwrap();

    let set = &proof.storage_proof[0];
    let set_kinds: Vec<NodeKind> = set
        .proof
        .iter()
        .map(|n| classify_node(&hex_bytes(n)))
        .collect();
    assert!(
            set_kinds.contains(&NodeKind::Extension),
            "fixture drift: the first slot's proof no longer traverses an Extension node ({set_kinds:?})"
        );
    assert_eq!(set.value, "0x1");

    let slot = hex32(&set.key);
    let storage_nodes = nodes_from_hex(&set.proof);
    assert_eq!(
        verify_storage(&account.storage_root, &slot, &storage_nodes).unwrap(),
        StorageValue::Present({
            let mut b = [0u8; 32];
            b[31] = 1;
            b
        })
    );
}

/// The fixture's never-set slot (entry 516) is the first of 250 candidates whose exclusion proof
/// terminates (diverges) AT a real Extension node — the walk needs no further node once it finds the
/// extension's own single nibble does not match the key, proving the extension arm's divergence path
/// (not just its consume-and-continue path) refuses cleanly rather than defaulting to some other
/// outcome.
#[test]
fn exclusion_diverging_inside_extension_is_absent() {
    let proof: GetProof = serde_json::from_str(DEEP_PROOF).unwrap();
    let root: StateRoot = serde_json::from_str(DEEP_ROOT).unwrap();
    let state_root = hex32(&root.state_root);
    let contract = hex20(&proof.address);
    let account_nodes = nodes_from_hex(&proof.account_proof);
    let account = verify_account(&state_root, &contract, &account_nodes).unwrap();

    let unset = &proof.storage_proof[1];
    let unset_kinds: Vec<NodeKind> = unset
        .proof
        .iter()
        .map(|n| classify_node(&hex_bytes(n)))
        .collect();
    assert_eq!(
            unset_kinds.last(),
            Some(&NodeKind::Extension),
            "fixture drift: the second slot's proof no longer diverges at an Extension node ({unset_kinds:?})"
        );
    assert_eq!(unset.value, "0x0");

    let slot = hex32(&unset.key);
    let storage_nodes = nodes_from_hex(&unset.proof);
    let value = verify_storage(&account.storage_root, &slot, &storage_nodes).unwrap();
    assert_eq!(value, StorageValue::Absent);
}

/// Minimal canonical RLP string/list encoders, mirroring `crate::rlp`'s own short/long-form rules
/// (short form for a payload ≤ 55 bytes, long form with a trimmed big-endian length-of-length
/// otherwise) — used only to hand-build hash-consistent single-node trie fixtures below, never
/// exercising `crate::rlp` itself (these tests must stay independent of the decoder under test).
fn rlp_string(payload: &[u8]) -> Vec<u8> {
    if payload.len() == 1 && payload[0] < 0x80 {
        return payload.to_vec();
    }
    let mut out = Vec::new();
    if payload.len() <= 55 {
        out.push(0x80 + payload.len() as u8);
    } else {
        let mut len_bytes = payload.len().to_be_bytes().to_vec();
        while len_bytes.len() > 1 && len_bytes[0] == 0 {
            len_bytes.remove(0);
        }
        out.push(0xb7 + len_bytes.len() as u8);
        out.extend_from_slice(&len_bytes);
    }
    out.extend_from_slice(payload);
    out
}

fn rlp_list(items: &[Vec<u8>]) -> Vec<u8> {
    let payload: Vec<u8> = items.iter().flatten().copied().collect();
    let mut out = Vec::new();
    if payload.len() <= 55 {
        out.push(0xc0 + payload.len() as u8);
    } else {
        let mut len_bytes = payload.len().to_be_bytes().to_vec();
        while len_bytes.len() > 1 && len_bytes[0] == 0 {
            len_bytes.remove(0);
        }
        out.push(0xf7 + len_bytes.len() as u8);
        out.extend_from_slice(&len_bytes);
    }
    out.extend_from_slice(&payload);
    out
}

/// Hand-built, hash-consistent 3-nibble extension node (no fixture needed): covers three shapes the real
/// 500-entry fixture's own single-nibble extensions cannot exercise on their own. Path nibbles `[1,2,3]` (odd
/// count, so the hex-prefix flag byte folds nibble `1` in: `0x11`, then `0x23` for the remaining pair), child a
/// 32-byte hash reference the `nodes` array never actually carries.
#[test]
fn hand_built_extension_divergence_and_missing_child() {
    let path_bytes = [0x11u8, 0x23u8];
    let child_hash = [0x77u8; 32];
    let node = rlp_list(&[rlp_string(&path_bytes), rlp_string(&child_hash)]);
    let root = keccak256(&[node.as_slice()]);
    let nodes = vec![node];

    // Divergence strictly inside the path (middle nibble 9 != 2).
    let (outcome, consumed) = super::walk::walk(root, &[1u8, 9, 3], &nodes).unwrap();
    assert_eq!(consumed, 1);
    assert!(matches!(outcome, walk::WalkOutcome::Diverged));

    // The key ends inside the path (remaining shorter than the path) — must be refused (Diverged),
    // never panic on an out-of-bounds slice (proves the length guard runs before the byte compare).
    let (outcome, consumed) = super::walk::walk(root, &[1u8, 2], &nodes).unwrap();
    assert_eq!(consumed, 1);
    assert!(matches!(outcome, walk::WalkOutcome::Diverged));

    // A full match into a child the proof does not carry: BadRlp{index:1}, not a panic, not a false
    // Found. (Matched by hand, not `.unwrap_err()`: `WalkOutcome` has no `Debug` impl and this test
    // must not add one to `walk.rs`.)
    match super::walk::walk(root, &[1u8, 2, 3], &nodes) {
        Err(e) => assert_eq!(e, MptError::BadRlp { index: 1 }),
        Ok(_) => panic!("expected BadRlp{{index:1}} (a full match into an uncarried child)"),
    }
}

/// Checks the storage-value length guard in `decode_storage_value` (`inner.len() > 32`): a hand-built
/// single-leaf storage trie whose double-RLP-wrapped value is 33 bytes must be refused.
#[test]
fn storage_value_over_32_bytes_is_refused() {
    let slot = [0u8; 32];
    let key = keccak256(&[slot.as_slice()]);
    let mut path_bytes = vec![0x20u8]; // leaf, even, zero padding
    path_bytes.extend_from_slice(&key);

    // Double-RLP: the inner RLP string (go-ethereum's own pre-store encoding) wraps a 33-byte
    // payload — one byte over the 32-byte scalar this crate accepts.
    let inner_encoded = rlp_string(&[0xABu8; 33]);
    let leaf = rlp_list(&[rlp_string(&path_bytes), rlp_string(&inner_encoded)]);
    let root = keccak256(&[leaf.as_slice()]);
    let nodes = vec![leaf];

    assert_eq!(
        verify_storage(&root, &slot, &nodes).unwrap_err(),
        MptError::ValueTooLong
    );
}

/// A non-canonical leading-zero storage value (`0x00 01`) must still decode to the correct left-padded
/// `Present(1)` — a caller's `== 1` compare relies on this.
#[test]
fn leading_zero_storage_value_decodes_to_one() {
    let slot = [0x11u8; 32];
    let key = keccak256(&[slot.as_slice()]);
    let mut path_bytes = vec![0x20u8];
    path_bytes.extend_from_slice(&key);

    let inner_encoded = rlp_string(&[0x00u8, 0x01u8]);
    let leaf = rlp_list(&[rlp_string(&path_bytes), rlp_string(&inner_encoded)]);
    let root = keccak256(&[leaf.as_slice()]);
    let nodes = vec![leaf];

    assert_eq!(
        verify_storage(&root, &slot, &nodes).unwrap(),
        StorageValue::Present({
            let mut b = [0u8; 32];
            b[31] = 1;
            b
        })
    );
}

/// `decode_account_rlp`'s defensive shape/length guards, hand-built one adversarial case at a time (each its
/// own hash-consistent single-leaf trie) — every one refused by name.
#[test]
fn account_rlp_adversarial_refused() {
    let address = [0x22u8; 20];
    let key = keccak256(&[address.as_slice()]);
    let mut path_bytes = vec![0x20u8];
    path_bytes.extend_from_slice(&key);
    let path_item = rlp_string(&path_bytes);

    let valid_storage_root = [0xAAu8; 32];
    let valid_code_hash = [0xBBu8; 32];

    let verify = |account_rlp: Vec<u8>| -> MptError {
        let leaf = rlp_list(&[path_item.clone(), rlp_string(&account_rlp)]);
        let root = keccak256(&[leaf.as_slice()]);
        let nodes = vec![leaf];
        verify_account(&root, &address, &nodes).unwrap_err()
    };

    // nonce > 8 bytes.
    let nonce_too_long = rlp_list(&[
        rlp_string(&[0xAAu8; 9]),
        rlp_string(&[0x01]),
        rlp_string(&valid_storage_root),
        rlp_string(&valid_code_hash),
    ]);
    assert_eq!(verify(nonce_too_long), MptError::ValueTooLong);

    // balance > 32 bytes.
    let balance_too_long = rlp_list(&[
        rlp_string(&[0x01]),
        rlp_string(&[0xAAu8; 33]),
        rlp_string(&valid_storage_root),
        rlp_string(&valid_code_hash),
    ]);
    assert_eq!(verify(balance_too_long), MptError::ValueTooLong);

    // storage_root not exactly 32 bytes.
    let bad_storage_root = rlp_list(&[
        rlp_string(&[0x01]),
        rlp_string(&[0x01]),
        rlp_string(&[0xAAu8; 31]),
        rlp_string(&valid_code_hash),
    ]);
    assert_eq!(verify(bad_storage_root), MptError::BadAccountRlp);

    // a 3-item list (missing code_hash).
    let three_items = rlp_list(&[
        rlp_string(&[0x01]),
        rlp_string(&[0x01]),
        rlp_string(&valid_storage_root),
    ]);
    assert_eq!(verify(three_items), MptError::BadAccountRlp);

    // a nested scalar: balance is itself a (empty) list, not a string.
    let nested_scalar = rlp_list(&[
        rlp_string(&[0x01]),
        rlp_list(&[]),
        rlp_string(&valid_storage_root),
        rlp_string(&valid_code_hash),
    ]);
    assert_eq!(verify(nested_scalar), MptError::BadAccountRlp);
}

/// A non-canonical even-path hex-prefix byte (padding nibble nonzero) must be refused, not silently accepted
/// with the padding discarded. Before the `nibbles::decode_compact_path` guard this leaf verified to
/// `Present(1)` anyway — HP byte `0x2f` (even/leaf flag `0x2`, nonzero low nibble `0xf`) instead of the
/// canonical `0x20`.
#[test]
fn non_canonical_even_hp_padding_is_refused() {
    let slot = [0x33u8; 32];
    let key = keccak256(&[slot.as_slice()]);
    let mut path_bytes = vec![0x2fu8]; // non-canonical: even/leaf flag, but a nonzero padding nibble
    path_bytes.extend_from_slice(&key);

    let leaf = rlp_list(&[rlp_string(&path_bytes), rlp_string(&[0x01])]);
    let root = keccak256(&[leaf.as_slice()]);
    let nodes = vec![leaf];

    assert!(
        verify_storage(&root, &slot, &nodes).is_err(),
        "a non-canonical even-path HP padding nibble must be refused, not accepted as Present"
    );
}

// ---- A proof from the project's own reth ----

/// What `eth_getProof` returns for one account with two storage slots, as reth gives it.
#[derive(Deserialize)]
struct RethProof {
    address: String,
    nonce: String,
    #[serde(rename = "codeHash")]
    code_hash: String,
    #[serde(rename = "storageHash")]
    storage_hash: String,
    #[serde(rename = "accountProof")]
    account_proof: Vec<String>,
    #[serde(rename = "storageProof")]
    storage_proof: Vec<StorageProof>,
}

#[derive(Deserialize)]
struct RethBlock {
    #[serde(rename = "stateRoot")]
    state_root: String,
}

/// A real proof from the project's own reth, checked against that reth's own state root.
///
/// What it proves: the genesis file puts a contract in the chain with one storage slot already
/// filled (slot 0 holds 2^256 - 1). `tests/capture_proof.sh` starts reth through
/// `network/reth/launch.sh`, asks it for `eth_getProof` of that contract with two slots (the filled
/// one and one that was never written), and saves the answers. This test then checks the account
/// against the block's state root, the filled slot as `Present(0xff..ff)` and the other as `Absent`.
///
/// It needs those saved files, so it is skipped in a plain `cargo test`. The workflow runs it with
/// `ZK_MPT_RETH_PROOF=<folder> cargo test -- --ignored`.
#[test]
#[ignore = "needs the files tests/capture_proof.sh writes; run with ZK_MPT_RETH_PROOF set"]
fn proof_from_the_projects_own_reth() {
    let dir = std::env::var("ZK_MPT_RETH_PROOF")
        .expect("set ZK_MPT_RETH_PROOF to the folder tests/capture_proof.sh wrote");
    let read = |name: &str| std::fs::read_to_string(std::path::Path::new(&dir).join(name)).unwrap();
    let proof: RethProof = serde_json::from_str(&read("getproof.json")).unwrap();
    let block: RethBlock = serde_json::from_str(&read("block.json")).unwrap();

    let state_root = hex32(&block.state_root);
    let account = verify_account(
        &state_root,
        &hex20(&proof.address),
        &nodes_from_hex(&proof.account_proof),
    )
    .unwrap();
    assert_eq!(
        account.nonce,
        u64::from_str_radix(proof.nonce.trim_start_matches("0x"), 16).unwrap()
    );
    assert_eq!(account.storage_root, hex32(&proof.storage_hash));
    assert_eq!(account.code_hash, hex32(&proof.code_hash));

    let [filled, empty] = proof.storage_proof.as_slice() else {
        panic!("the capture script asks for two slots");
    };
    assert_eq!(
        verify_storage(
            &account.storage_root,
            &hex32(&filled.key),
            &nodes_from_hex(&filled.proof)
        ),
        Ok(StorageValue::Present([0xff; 32]))
    );
    assert_eq!(
        verify_storage(
            &account.storage_root,
            &hex32(&empty.key),
            &nodes_from_hex(&empty.proof)
        ),
        Ok(StorageValue::Absent)
    );

    // The same proof against a different root is refused.
    let wrong = [0x42u8; 32];
    assert_eq!(
        verify_account(
            &wrong,
            &hex20(&proof.address),
            &nodes_from_hex(&proof.account_proof)
        ),
        Err(MptError::RootMismatch)
    );
}
