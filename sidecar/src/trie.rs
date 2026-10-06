// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
//! The root of an Ethereum "ordered" trie: the one the transactions root is. The key of item `i` is
//! the RLP of `i`; the value is the item's bytes.

use crate::{keccak, rlp};

/// The root of the trie of `values`, in order.
pub fn ordered_root(values: &[&[u8]]) -> [u8; 32] {
    let pairs: Vec<(Vec<u8>, &[u8])> = values
        .iter()
        .enumerate()
        .map(|(i, v)| (nibbles(&rlp::string(&index_bytes(i))), *v))
        .collect();
    if pairs.is_empty() {
        return keccak(&[0x80]);
    }
    keccak(&node(&pairs, 0))
}

fn index_bytes(i: usize) -> Vec<u8> {
    let be = (i as u64).to_be_bytes();
    be[be.iter().position(|&x| x != 0).unwrap_or(8)..].to_vec()
}

fn nibbles(bytes: &[u8]) -> Vec<u8> {
    bytes.iter().flat_map(|b| [b >> 4, b & 15]).collect()
}

/// The hex-prefix form of a path.
fn hex_prefix(path: &[u8], leaf: bool) -> Vec<u8> {
    let flag = if leaf { 2 } else { 0 };
    let mut out = Vec::new();
    let rest = if path.len() % 2 == 1 {
        out.push(((flag | 1) << 4) | path[0]);
        &path[1..]
    } else {
        out.push(flag << 4);
        path
    };
    out.extend(rest.chunks(2).map(|p| (p[0] << 4) | p[1]));
    out
}

/// How a node is referred to by its parent: itself if it is short, its hash otherwise.
fn reference(encoded: Vec<u8>) -> Vec<u8> {
    if encoded.len() < 32 {
        encoded
    } else {
        rlp::string(&keccak(&encoded))
    }
}

/// The encoding of the node for `pairs`, whose keys all agree on the first `depth` nibbles. The
/// keys are the RLP of distinct numbers, so none is the start of another.
fn node(pairs: &[(Vec<u8>, &[u8])], depth: usize) -> Vec<u8> {
    if let [(key, value)] = pairs {
        let leaf = [
            rlp::string(&hex_prefix(&key[depth..], true)),
            rlp::string(value),
        ]
        .concat();
        return rlp::list_of(&leaf);
    }
    let first = &pairs[0].0;
    let shared = (depth..first.len())
        .take_while(|&d| pairs.iter().all(|(k, _)| k[d] == first[d]))
        .count();
    if shared > 0 {
        let path = &first[depth..depth + shared];
        let child = reference(node(pairs, depth + shared));
        return rlp::list_of(&[rlp::string(&hex_prefix(path, false)), child].concat());
    }
    let mut slots = Vec::new();
    for nibble in 0..16 {
        let group: Vec<_> = pairs
            .iter()
            .filter(|(k, _)| k[depth] == nibble)
            .cloned()
            .collect();
        slots.extend(if group.is_empty() {
            vec![0x80]
        } else {
            reference(node(&group, depth + 1))
        });
    }
    slots.push(0x80);
    rlp::list_of(&slots)
}
