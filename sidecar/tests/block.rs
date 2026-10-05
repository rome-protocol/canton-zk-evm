//! The block half of `verify`: the header and the transactions against the hash the proof commits
//! to, on a real block from our reth, and the transactions root against an independent
//! implementation.

mod common;

use common::*;
use keccak_hasher::KeccakHasher;
use zk_sidecar::{block, rlp, trie};

const NOT_HASH: &str = "the header does not hash to the proven block hash";
const BAD_TXS: &str = "the transactions do not match the header's transactions root";
const BAD_HEADER: &str = "the header is malformed";

fn replace_once(haystack: &[u8], needle: &[u8], with: &[u8]) -> Vec<u8> {
    let at = haystack
        .windows(needle.len())
        .position(|w| w == needle)
        .expect("not in the header");
    [&haystack[..at], with, &haystack[at + needle.len()..]].concat()
}

#[test]
fn the_real_block_is_accepted_and_read() {
    let b = reth_block();
    assert_eq!(b.tx_count, 1, "the test block holds one transfer");
    let got = block::check(&b.hash, &b.header, &b.txs).unwrap();
    assert_eq!(got.parent, b.parent);
    assert_eq!(got.number, b.number);
    assert_eq!(got.state_root, b.state_root);
    assert_eq!(got.timestamp, b.timestamp);
    assert_eq!(got.gas_limit, b.gas_limit);
    assert_eq!(got.gas_used, b.gas_used);
    assert_eq!(got.tx_count, b.tx_count);
}

#[test]
fn a_header_that_does_not_hash_to_the_committed_value_is_refused() {
    let b = reth_block();
    let mut header = b.header.clone();
    *header.last_mut().unwrap() ^= 1;
    assert_eq!(
        block::check(&b.hash, &header, &b.txs).unwrap_err(),
        NOT_HASH
    );
    let mut hash = b.hash;
    hash[0] ^= 1;
    assert_eq!(
        block::check(&hash, &b.header, &b.txs).unwrap_err(),
        NOT_HASH
    );
}

#[test]
fn a_transaction_list_that_does_not_match_the_root_is_refused() {
    let b = reth_block();
    let mut changed = b.txs.clone();
    *changed.last_mut().unwrap() ^= 1;
    assert_eq!(
        block::check(&b.hash, &b.header, &changed).unwrap_err(),
        BAD_TXS
    );
    assert_eq!(block::check(&b.hash, &b.header, &[]).unwrap_err(), BAD_TXS);
    let twice = rlp::list_of(
        &[
            rlp::list(&b.txs).unwrap()[0].raw,
            rlp::list(&b.txs).unwrap()[0].raw,
        ]
        .concat(),
    );
    assert_eq!(
        block::check(&b.hash, &b.header, &twice).unwrap_err(),
        BAD_TXS
    );
    assert_eq!(
        block::check(&b.hash, &b.header, &b.txs[..b.txs.len() - 1]).unwrap_err(),
        BAD_TXS
    );
}

#[test]
fn a_block_with_ommers_or_withdrawals_is_refused() {
    let b = reth_block();
    // The hash the proof would commit to is the changed header's own, so the later checks are reached.
    let no_ommers = keccak(&[0xc0]);
    let header = replace_once(&b.header, &no_ommers, &[0x11; 32]);
    assert_eq!(
        block::check(&keccak(&header), &header, &b.txs).unwrap_err(),
        "the block has ommers"
    );
    let empty_root = keccak(&[0x80]);
    let header = replace_once(&b.header, &empty_root, &[0x22; 32]);
    assert_eq!(
        block::check(&keccak(&header), &header, &b.txs).unwrap_err(),
        "the block has withdrawals"
    );
}

#[test]
fn something_that_is_not_a_header_is_refused() {
    let real = reth_block().header;
    for junk in [
        vec![],
        vec![0xc0],
        vec![0x80],
        rlp::list_of(&[0x80; 14]),
        [real, vec![0]].concat(),
    ] {
        assert_eq!(
            block::check(&keccak(&junk), &junk, &[]).unwrap_err(),
            "the header is malformed"
        );
    }
}

#[test]
fn the_empty_transaction_root_is_the_known_one() {
    assert_eq!(
        hex(&trie::ordered_root(&[])),
        "56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421"
    );
}

#[test]
fn the_transactions_root_agrees_with_an_independent_implementation() {
    // Counts either side of the places where the keys change shape (1, 128), with values short
    // enough to sit inside their parent node and long enough to be hashed.
    for count in [1usize, 2, 3, 15, 16, 17, 100, 127, 128, 129, 200, 300] {
        for size in [1usize, 20, 31, 32, 33, 200] {
            let values: Vec<Vec<u8>> = (0..count)
                .map(|i| (0..size).map(|j| (i * 31 + j * 7 + size) as u8).collect())
                .collect();
            let refs: Vec<&[u8]> = values.iter().map(|v| v.as_slice()).collect();
            let expected = triehash::ordered_trie_root::<KeccakHasher, _>(values.iter());
            assert_eq!(
                trie::ordered_root(&refs),
                expected,
                "{count} values of {size} bytes"
            );
        }
    }
}

// Canonical RLP. A header or a transaction list is read, written again in the one canonical way and
// compared with the input; anything that comes out different is refused. In these tests the
// header's transactions root is that of the canonical list, so that a refusal can only come from
// the way the list is written, never from a root that does not match.

/// The real header with its transactions root replaced, and that header's hash.
fn header_with_root(root: &[u8; 32]) -> ([u8; 32], Vec<u8>) {
    let real = reth_block();
    let old = rlp::list(&real.header).unwrap()[4].payload.to_vec();
    let header = replace_once(&real.header, &old, root);
    (keccak(&header), header)
}

fn root_of(values: &[&[u8]]) -> [u8; 32] {
    triehash::ordered_trie_root::<KeccakHasher, _>(values.iter())
}

/// A made-up typed transaction: its type byte and three bytes, nothing like a real one, which is
/// fine because only the way it is written is under test.
const TYPED: [u8; 4] = [0x02, 1, 2, 3];

#[test]
fn a_typed_transaction_written_canonically_is_accepted() {
    let (hash, header) = header_with_root(&root_of(&[&TYPED]));
    let txs = rlp::list_of(&rlp::string(&TYPED));
    assert_eq!(block::check(&hash, &header, &txs).unwrap().tx_count, 1);
}

#[test]
fn a_length_written_in_the_long_form_when_the_short_one_fits_is_refused() {
    let (hash, header) = header_with_root(&root_of(&[&TYPED]));
    // the string's own length, as 0xb8 0x04 and not 0x84
    let item = [vec![0xb8, 4], TYPED.to_vec()].concat();
    // the list's length, as 0xf8 0x05 and not 0xc5
    let list = [vec![0xf8, 5], rlp::string(&TYPED)].concat();
    for txs in [rlp::list_of(&item), list] {
        assert_eq!(block::check(&hash, &header, &txs).unwrap_err(), BAD_TXS);
    }
    // the first item of the header, the parent hash, with its length in the long form; the list
    // around it is written again with the right length
    let real = reth_block().header;
    let items = rlp::list(&real).unwrap();
    let long = [vec![0xb8, 32], items[0].payload.to_vec()].concat();
    let rest: Vec<u8> = items[1..].iter().flat_map(|i| i.raw.to_vec()).collect();
    let header = rlp::list_of(&[long, rest].concat());
    assert_eq!(
        block::check(&keccak(&header), &header, &reth_block().txs).unwrap_err(),
        BAD_HEADER
    );
}

#[test]
fn a_length_with_a_leading_zero_is_refused() {
    let (hash, header) = header_with_root(&root_of(&[&TYPED]));
    let item = [vec![0xb9, 0, 4], TYPED.to_vec()].concat();
    let list = [vec![0xf9, 0, 5], rlp::string(&TYPED)].concat();
    for txs in [rlp::list_of(&item), list] {
        assert_eq!(block::check(&hash, &header, &txs).unwrap_err(), BAD_TXS);
    }
    // the header's own length, written with a leading zero
    let real = reth_block().header;
    let header = [vec![0xfa, 0], real[1..].to_vec()].concat();
    assert_eq!(
        block::check(&keccak(&header), &header, &reth_block().txs).unwrap_err(),
        BAD_HEADER
    );
}

#[test]
fn a_single_byte_below_0x80_written_as_a_string_is_refused() {
    // a typed transaction cannot be one byte, so the single byte stands in for any byte string
    let (hash, header) = header_with_root(&root_of(&[&[5]]));
    assert_eq!(
        block::check(&hash, &header, &rlp::list_of(&[5]))
            .unwrap()
            .tx_count,
        1
    );
    assert_eq!(
        block::check(&hash, &header, &rlp::list_of(&[0x81, 5])).unwrap_err(),
        BAD_TXS
    );
}

/// A made-up old-style transaction (nine fields), written as a list.
fn legacy() -> Vec<u8> {
    legacy_with_first_field(&[7])
}

/// The same, with the first field's encoding given as it is, so that a test can write it badly.
fn legacy_with_first_field(first: &[u8]) -> Vec<u8> {
    let field = |b: &[u8]| rlp::string(b);
    rlp::list_of(
        &[
            first.to_vec(),
            field(&[0x3b, 0x9a, 0xca, 0x00]),
            field(&[0x52, 0x08]),
            field(&[0x44; 20]),
            field(&[1]),
            field(&[]),
            field(&[0x1b]),
            field(&[0x55; 32]),
            field(&[0x66; 32]),
        ]
        .concat(),
    )
}

#[test]
fn an_old_style_transaction_is_accepted_and_its_root_agrees_with_triehash() {
    let real = reth_block();
    let typed = rlp::list(&real.txs).unwrap()[0].payload.to_vec();
    let old_style = legacy();
    // A real typed transaction and one old-style one. The trie holds the typed one's contents and
    // the old-style one's whole encoding.
    let expected = triehash::ordered_trie_root::<KeccakHasher, _>([&typed, &old_style]);
    let (hash, header) = header_with_root(&expected);
    let txs = rlp::list_of(&[rlp::string(&typed), old_style.clone()].concat());
    let got = block::check(&hash, &header, &txs).unwrap();
    assert_eq!(got.tx_count, 2);
    // and a list of the old-style one alone
    let expected = triehash::ordered_trie_root::<KeccakHasher, _>([&old_style]);
    let (hash, header) = header_with_root(&expected);
    assert_eq!(
        block::check(&hash, &header, &rlp::list_of(&old_style))
            .unwrap()
            .tx_count,
        1
    );
}

#[test]
fn an_old_style_transaction_written_as_a_byte_string_is_refused() {
    // Its trie value is the same either way, so the root cannot tell the two apart.
    let old_style = legacy();
    let (hash, header) = header_with_root(&root_of(&[&old_style]));
    let as_string = rlp::list_of(&rlp::string(&old_style));
    assert_eq!(
        block::check(&hash, &header, &as_string).unwrap_err(),
        BAD_TXS
    );
    // and one that is not itself canonical: its first field, the byte 7, written as a string
    let loose = legacy_with_first_field(&[0x81, 7]);
    let (hash, header) = header_with_root(&root_of(&[&loose]));
    assert_eq!(
        block::check(&hash, &header, &rlp::list_of(&loose)).unwrap_err(),
        BAD_TXS
    );
}

#[test]
fn an_empty_list_and_an_empty_input_are_not_the_same() {
    // The interface says the input is empty for a block with no transactions. The block's own
    // encoding of no transactions, 0xc0, is a different input and is refused.
    let (hash, header) = header_with_root(&root_of(&[]));
    assert_eq!(block::check(&hash, &header, &[]).unwrap().tx_count, 0);
    assert_eq!(block::check(&hash, &header, &[0xc0]).unwrap_err(), BAD_TXS);
}
