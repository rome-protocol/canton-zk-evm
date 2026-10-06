// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
//! A bounded Ethereum Merkle-Patricia (MPT) proof checker. [`verify_account`] proves an account's fields
//! against a state root; [`verify_storage`] proves a storage slot's value, or that the slot was never
//! written, against an account's storage root. Both take the node lists that `eth_getProof` returns.
//!
//! ## What this crate does not check
//! It assumes the state root (or storage root) is one the caller already trusts. It only proves that
//! `nodes` is a valid Merkle-Patricia path from that root to the claimed value, or to a provable
//! absence. Where the root came from is the caller's job.
//!
//! ## Bounds (checked before any hashing or decoding)
//! [`MAX_NODES`] (64) and [`MAX_NODE_BYTES`] (532, a branch node's worst case: 16 hash slots of 33 bytes
//! plus a short value slot and RLP overhead) bound every proof this crate accepts. [`check_bounds`] runs
//! first in both [`verify_account`] and [`verify_storage`], before the first node is hashed.
//!
//! ## Inclusion and absence
//! [`verify_account`] has no absence outcome: a path that diverges from the claimed address is refused
//! ([`MptError::PathMismatch`]). [`verify_storage`] is the opposite: [`StorageValue::Absent`] is a
//! distinct, explicit outcome, never mixed up with `Present([0u8; 32])`. A slot whose value is zero and a
//! slot that was never written are different facts, and the type keeps a caller from confusing them.
//!
//! ## Hashing
//! Every hash is Keccak-256, from the `sha3` crate, through the one helper [`keccak256`].

#![forbid(unsafe_code)]

mod nibbles;
mod rlp;
mod walk;

#[cfg(test)]
mod tests;

use sha3::{Digest, Keccak256};

/// Keccak-256 of the parts, one after another.
pub(crate) fn keccak256(parts: &[&[u8]]) -> [u8; 32] {
    let mut hasher = Keccak256::new();
    for part in parts {
        hasher.update(part);
    }
    hasher.finalize().into()
}

/// A trie node's encoded byte length may not exceed this — a branch node's worst case is 16 × (1 header
/// byte + 32-byte hash) + up to 2 bytes of value slot + a handful of RLP list-header bytes; 532 covers it
/// with headroom.
pub const MAX_NODE_BYTES: usize = 532;

/// A single account or storage proof may not carry more than this many nodes — the deepest a real
/// Ethereum trie ever gets in practice is well under this; a proof claiming more is refused outright,
/// never merely truncated.
pub const MAX_NODES: usize = 64;

/// Every way this crate refuses a proof, by name — never a silent `Ok` on a claim that does not hold.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MptError {
    /// `nodes.len()` exceeded [`MAX_NODES`].
    TooManyNodes { got: usize },
    /// `nodes[index].len()` exceeded [`MAX_NODE_BYTES`].
    NodeTooLarge { index: usize, len: usize },
    /// `keccak256(nodes[0])` did not equal the root this proof was checked against.
    RootMismatch,
    /// `keccak256(nodes[index])` did not equal the hash the previous node referenced it by.
    HashMismatch { index: usize },
    /// The claimed key's nibble path disagreed with a leaf's stored path or an extension's stored prefix,
    /// in a context where that disagreement is refused rather than reported as absence (account proofs
    /// only; see the module doc).
    PathMismatch,
    /// `nodes[index]` (or an embedded child inside it) is not well-formed RLP, or not the shape a trie
    /// node/child-reference is allowed to take.
    BadRlp { index: usize },
    /// `nodes[index]` decoded as an RLP list, but with neither 2 (leaf/extension) nor 17 (branch) items.
    BadNodeShape { index: usize, items: usize },
    /// The proof supplied more nodes than the walk from the root to the claimed key ever consumed.
    TrailingNodes,
    /// The value bytes at the end of a walk did not decode as the shape the caller needed: for
    /// [`verify_account`], the 4-item `[nonce, balance, storage_root, code_hash]` account RLP list; for
    /// [`verify_storage`], the double-RLP-wrapped scalar (see [`decode_storage_value`]'s doc) not itself
    /// being a well-formed RLP string. Unreachable against any real `eth_getProof` output (both shapes are
    /// exactly what go-ethereum always writes) — a defensive bound, not a case any committed fixture hits.
    BadAccountRlp,
    /// A decoded integer (an account's `nonce`/`balance`, or a storage value) used more bytes than its
    /// type allows (8 for `nonce`, 32 for `balance`/a storage value).
    ValueTooLong,
}

/// The four fields an Ethereum account's trie leaf commits, decoded from its RLP value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Account {
    pub nonce: u64,
    /// Big-endian, left-padded to 32 bytes.
    pub balance: [u8; 32],
    pub storage_root: [u8; 32],
    pub code_hash: [u8; 32],
}

/// The outcome of a storage-slot proof: a slot that was never written is [`StorageValue::Absent`], never
/// [`StorageValue::Present`] with a zero value — the two are different facts about the trie and this
/// type keeps a caller from conflating them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StorageValue {
    /// Big-endian, left-padded to 32 bytes.
    Present([u8; 32]),
    Absent,
}

/// Checks `nodes` against [`MAX_NODES`]/[`MAX_NODE_BYTES`] — run before any hashing or RLP decoding, in
/// both [`verify_account`] and [`verify_storage`].
fn check_bounds(nodes: &[Vec<u8>]) -> Result<(), MptError> {
    if nodes.len() > MAX_NODES {
        return Err(MptError::TooManyNodes { got: nodes.len() });
    }
    for (index, n) in nodes.iter().enumerate() {
        if n.len() > MAX_NODE_BYTES {
            return Err(MptError::NodeTooLarge {
                index,
                len: n.len(),
            });
        }
    }
    Ok(())
}

/// Proves `address`'s account fields against `state_root`: `nodes` must be a Merkle-Patricia path from
/// `state_root` to the leaf at `keccak256(address)`. There is no exclusion outcome — see the module doc.
pub fn verify_account(
    state_root: &[u8; 32],
    address: &[u8; 20],
    nodes: &[Vec<u8>],
) -> Result<Account, MptError> {
    check_bounds(nodes)?;
    let key = keccak256(&[address.as_slice()]);
    let key_nibbles = nibbles::to_nibbles(&key);
    let (outcome, consumed) = walk::walk(*state_root, &key_nibbles, nodes)?;
    if consumed != nodes.len() {
        return Err(MptError::TrailingNodes);
    }
    match outcome {
        walk::WalkOutcome::Found(value) => decode_account_rlp(value),
        walk::WalkOutcome::Diverged => Err(MptError::PathMismatch),
    }
}

/// Proves (or disproves) `slot`'s value in the storage trie rooted at `storage_root`: `nodes` must be a
/// Merkle-Patricia path from `storage_root` toward the leaf at `keccak256(slot)`. Unlike
/// [`verify_account`], a path that diverges from the trie is a legitimate, distinct outcome
/// ([`StorageValue::Absent`]), not an error — an exclusion proof and a malformed proof are different
/// things, and only the caller who asked "is this slot set" can tell them apart from an inclusion proof.
pub fn verify_storage(
    storage_root: &[u8; 32],
    slot: &[u8; 32],
    nodes: &[Vec<u8>],
) -> Result<StorageValue, MptError> {
    check_bounds(nodes)?;
    let key = keccak256(&[slot.as_slice()]);
    let key_nibbles = nibbles::to_nibbles(&key);
    let (outcome, consumed) = walk::walk(*storage_root, &key_nibbles, nodes)?;
    if consumed != nodes.len() {
        return Err(MptError::TrailingNodes);
    }
    match outcome {
        walk::WalkOutcome::Found(value) => Ok(StorageValue::Present(decode_storage_value(value)?)),
        walk::WalkOutcome::Diverged => Ok(StorageValue::Absent),
    }
}

/// Decodes a leaf/branch value slot's bytes as the account RLP shape: a 4-item list `[nonce, balance,
/// storage_root, code_hash]`. Go-ethereum writes an account's trie value as `rlp.EncodeToBytes(account)`
/// — that already-list-shaped encoding is what a leaf's own (single) RLP-string wrap unwraps to, so this
/// decodes the list directly with no further unwrap (contrast [`decode_storage_value`], which needs one).
fn decode_account_rlp(bytes: &[u8]) -> Result<Account, MptError> {
    let items = rlp::decode_top_level_list(bytes).map_err(|_| MptError::BadAccountRlp)?;
    let [nonce_item, balance_item, root_item, code_item] = items.as_slice() else {
        return Err(MptError::BadAccountRlp);
    };
    let rlp::Item::Str(nonce_bytes) = *nonce_item else {
        return Err(MptError::BadAccountRlp);
    };
    let rlp::Item::Str(balance_bytes) = *balance_item else {
        return Err(MptError::BadAccountRlp);
    };
    let rlp::Item::Str(storage_root_bytes) = *root_item else {
        return Err(MptError::BadAccountRlp);
    };
    let rlp::Item::Str(code_hash_bytes) = *code_item else {
        return Err(MptError::BadAccountRlp);
    };

    if nonce_bytes.len() > 8 {
        return Err(MptError::ValueTooLong);
    }
    let mut nonce_buf = [0u8; 8];
    nonce_buf[8 - nonce_bytes.len()..].copy_from_slice(nonce_bytes);

    if balance_bytes.len() > 32 {
        return Err(MptError::ValueTooLong);
    }
    let mut balance = [0u8; 32];
    balance[32 - balance_bytes.len()..].copy_from_slice(balance_bytes);

    if storage_root_bytes.len() != 32 || code_hash_bytes.len() != 32 {
        return Err(MptError::BadAccountRlp);
    }
    let mut storage_root = [0u8; 32];
    storage_root.copy_from_slice(storage_root_bytes);
    let mut code_hash = [0u8; 32];
    code_hash.copy_from_slice(code_hash_bytes);

    Ok(Account {
        nonce: u64::from_be_bytes(nonce_buf),
        balance,
        storage_root,
        code_hash,
    })
}

/// Decodes a leaf/branch value slot's bytes as a storage scalar. Go-ethereum writes a storage value as
/// `rlp.EncodeToBytes(trimmedBigEndianBytes)` **before** ever calling `trie.Update` — so the bytes a
/// leaf's own RLP-string wrap unwraps to (`bytes` here) are *themselves* one more RLP string encoding the
/// real integer, not the integer's bytes directly (contrast [`decode_account_rlp`], whose value is
/// already list-shaped after one unwrap). This is the well-known double-RLP-encoding of storage trie
/// values; skipping the second unwrap silently misreads any value whose trimmed bytes start `>= 0x80`
/// (anything from 128 up) while happening to look right for the small values (`< 0x80`) a quick test
/// might reach for.
fn decode_storage_value(bytes: &[u8]) -> Result<[u8; 32], MptError> {
    let inner = rlp::decode_top_level_string(bytes).map_err(|_| MptError::BadAccountRlp)?;
    if inner.len() > 32 {
        return Err(MptError::ValueTooLong);
    }
    let mut out = [0u8; 32];
    out[32 - inner.len()..].copy_from_slice(inner);
    Ok(out)
}
