// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
//! Just enough RLP: read one item or one list, and write strings and lists.
//!
//! A block header and a transaction list must be written in canonical RLP: `is_canonical` reads an
//! item and writes it again, and accepts it only if the result is the same bytes.

/// One RLP item: its whole encoding, its payload, and whether it is a list.
pub struct Item<'a> {
    pub raw: &'a [u8],
    pub payload: &'a [u8],
    pub is_list: bool,
}

/// Reads the item at the front of `b`; returns it and what follows it.
pub fn read(b: &[u8]) -> Option<(Item<'_>, &[u8])> {
    let first = *b.first()?;
    let (is_list, header, len) = match first {
        0..=0x7f => (false, 0, 1),
        0x80..=0xb7 => (false, 1, usize::from(first - 0x80)),
        0xc0..=0xf7 => (true, 1, usize::from(first - 0xc0)),
        _ => {
            let long = if first <= 0xbf { 0xb7 } else { 0xf7 };
            let size = usize::from(first - long);
            if size > 8 || b.len() < 1 + size {
                return None;
            }
            let len = b[1..=size]
                .iter()
                .fold(0usize, |n, &x| (n << 8) | usize::from(x));
            (first > 0xbf, 1 + size, len)
        }
    };
    let end = header.checked_add(len).filter(|&end| end <= b.len())?;
    let payload = if header == 0 {
        &b[..1]
    } else {
        &b[header..end]
    };
    Some((
        Item {
            raw: &b[..end],
            payload,
            is_list,
        },
        &b[end..],
    ))
}

/// The items of `b`, which must be exactly one list.
pub fn list(b: &[u8]) -> Option<Vec<Item<'_>>> {
    let (outer, rest) = read(b)?;
    if !outer.is_list || !rest.is_empty() {
        return None;
    }
    let mut items = Vec::new();
    let mut rest = outer.payload;
    while !rest.is_empty() {
        let (item, after) = read(rest)?;
        items.push(item);
        rest = after;
    }
    Some(items)
}

/// How many lists may sit inside one another before `is_canonical` gives up. The header and an
/// old-style transaction are each one list of strings, so real input is one list deep; the limit
/// only bounds the recursion, so that the check cannot be used to exhaust the stack.
const MAX_DEPTH: usize = 8;

fn canonical_item(item: &Item, depth: usize) -> bool {
    if !item.is_list {
        return string(item.payload) == item.raw;
    }
    let mut children = Vec::new();
    let mut rest = item.payload;
    while !rest.is_empty() {
        let Some((child, after)) = read(rest) else {
            return false;
        };
        if depth == 0 || !canonical_item(&child, depth - 1) {
            return false;
        }
        children.extend_from_slice(child.raw);
        rest = after;
    }
    list_of(&children) == item.raw
}

/// Whether `b` is exactly one item and is written in the one canonical way throughout: the shortest
/// form of every length, no leading zero in a length, and a single byte below 0x80 as itself.
/// Items are read again and written again, and the result must equal the input.
pub fn is_canonical(b: &[u8]) -> bool {
    matches!(read(b), Some((item, [])) if canonical_item(&item, MAX_DEPTH))
}

fn with_length(short: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = if payload.len() < 56 {
        vec![short + payload.len() as u8]
    } else {
        let size = (payload.len() as u64).to_be_bytes();
        let size = &size[size.iter().position(|&x| x != 0).unwrap_or(7)..];
        let mut head = vec![short + 55 + size.len() as u8];
        head.extend_from_slice(size);
        head
    };
    out.extend_from_slice(payload);
    out
}

/// The encoding of a byte string.
pub fn string(b: &[u8]) -> Vec<u8> {
    match b {
        [x] if *x < 0x80 => vec![*x],
        _ => with_length(0x80, b),
    }
}

/// The encoding of a list whose items, already encoded, are `items` one after the other.
pub fn list_of(items: &[u8]) -> Vec<u8> {
    with_length(0xc0, items)
}
