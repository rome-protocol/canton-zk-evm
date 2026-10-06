// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
//! The block half of `verify`: a header and a transaction list against the hash a proof commits to.

use crate::{keccak, rlp, trie};

/// What `verify` reads from a checked header.
#[derive(Debug)]
pub struct Block {
    pub parent: [u8; 32],
    pub number: u64,
    pub state_root: [u8; 32],
    pub timestamp: u64,
    pub gas_limit: u64,
    pub gas_used: u64,
    pub tx_count: usize,
}

const MALFORMED: &str = "the header is malformed";

fn word(item: &rlp::Item) -> Option<[u8; 32]> {
    item.payload.try_into().ok().filter(|_| !item.is_list)
}

fn number(item: &rlp::Item) -> Option<u64> {
    let p = item.payload;
    let plain = !item.is_list && p.len() <= 8 && p.first() != Some(&0);
    plain.then(|| p.iter().fold(0, |n, &x| (n << 8) | u64::from(x)))
}

/// How a transaction with this trie value is written in the block's list: an old-style one (a list,
/// so its encoding starts at 0xc0 or above) as itself, anything else as a byte string. `None` when
/// the old-style one is not itself canonical.
fn canonical_transaction(value: &[u8]) -> Option<Vec<u8>> {
    if value.first().is_some_and(|&b| b >= 0xc0) {
        rlp::is_canonical(value).then(|| value.to_vec())
    } else {
        Some(rlp::string(value))
    }
}

/// Checks that `header` hashes to `hash`, has no ommers and no withdrawals, and that `txs` is the
/// block's transaction list (the list as it sits in the block's own encoding, or nothing for no
/// transactions) whose root is the header's. The header and the transaction list must both be
/// written in canonical RLP; otherwise they are refused.
pub fn check(hash: &[u8; 32], header: &[u8], txs: &[u8]) -> Result<Block, &'static str> {
    if keccak(header) != *hash {
        return Err("the header does not hash to the proven block hash");
    }
    // The header must be written in the one canonical way: read again and written again, it has
    // to come out as the same bytes.
    let items = rlp::is_canonical(header)
        .then(|| rlp::list(header))
        .flatten()
        .filter(|i| i.len() >= 15)
        .ok_or(MALFORMED)?;
    // parent, ommers, coinbase, state root, transactions root, receipts root, bloom, difficulty,
    // number, gas limit, gas used, timestamp, ... and from Shanghai on, the withdrawals root at 16
    let (ommers, tx_root) = (
        word(&items[1]).ok_or(MALFORMED)?,
        word(&items[4]).ok_or(MALFORMED)?,
    );
    if ommers != keccak(&[0xc0]) {
        return Err("the block has ommers");
    }
    if let Some(withdrawals) = items.get(16) {
        if word(withdrawals).ok_or(MALFORMED)? != keccak(&[0x80]) {
            return Err("the block has withdrawals");
        }
    }
    let block = Block {
        parent: word(&items[0]).ok_or(MALFORMED)?,
        state_root: word(&items[3]).ok_or(MALFORMED)?,
        number: number(&items[8]).ok_or(MALFORMED)?,
        gas_limit: number(&items[9]).ok_or(MALFORMED)?,
        gas_used: number(&items[10]).ok_or(MALFORMED)?,
        timestamp: number(&items[11]).ok_or(MALFORMED)?,
        tx_count: 0,
    };
    let no_match = "the transactions do not match the header's transactions root";
    // The input is empty for a block with no transactions, and otherwise the list as it sits in the
    // block's own encoding. The list is read again and written again in the one canonical way,
    // and must come out as the same bytes; so there is one input for each block, not several.
    let list = if txs.is_empty() {
        vec![]
    } else {
        rlp::list(txs).filter(|l| !l.is_empty()).ok_or(no_match)?
    };
    // A typed transaction sits in the list as a byte string holding its encoding; an old-style one
    // as a list. The trie holds the string's contents and the list's own encoding.
    let values: Vec<&[u8]> = list
        .iter()
        .map(|t| if t.is_list { t.raw } else { t.payload })
        .collect();
    let again: Option<Vec<Vec<u8>>> = values.iter().map(|v| canonical_transaction(v)).collect();
    let again = again.ok_or(no_match)?;
    if !txs.is_empty() && rlp::list_of(&again.concat()) != txs {
        return Err(no_match);
    }
    if trie::ordered_root(&values) != tx_root {
        return Err(no_match);
    }
    Ok(Block {
        tx_count: values.len(),
        ..block
    })
}
