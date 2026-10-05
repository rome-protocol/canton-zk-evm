//! `verify` as a whole: the proof half (real proofs) and the block half (a real block) together,
//! and the answer's format.

mod common;

use common::*;
use zk_sidecar::{verify, Config};

fn line(abi: &[u8], header: &[u8], txs: &[u8]) -> String {
    format!("{},{},{}", hex(abi), hex(header), hex(txs))
}

#[test]
fn a_proven_block_is_answered_in_the_readmes_form() {
    let b = reth_block();
    let cfg = config_accepting_any();
    let answer = verify(&cfg, &line(&abi_for(&b.hash), &b.header, &b.txs));
    let expected = format!(
        "ok {} {} {} {} {} {} {} {} {} {}",
        hex(&[0xaa; 32]),
        hex(&[0xbb; 32]),
        hex(&b.hash),
        hex(&b.parent),
        b.number,
        hex(&b.state_root),
        b.timestamp,
        b.gas_limit,
        b.gas_used,
        b.tx_count
    );
    assert_eq!(answer, expected);
}

#[test]
fn the_session_proof_with_a_header_that_is_not_its_block_is_refused() {
    let s = session();
    let b = reth_block();
    let cfg = Config::new(s.program_vk, s.root_c);
    assert_eq!(
        verify(&cfg, &line(&s.abi, &b.header, &b.txs)),
        "no the header does not hash to the proven block hash"
    );
}

#[test]
fn a_flipped_proof_byte_is_refused_before_anything_else() {
    let s = session();
    let b = reth_block();
    let mut abi = s.abi.clone();
    abi[10] ^= 1;
    let cfg = Config::new(s.program_vk, s.root_c);
    assert_eq!(
        verify(&cfg, &line(&abi, &b.header, &b.txs)),
        "no the proof does not verify"
    );
}

#[test]
fn a_wrong_header_or_transaction_list_under_a_good_proof_is_refused() {
    let b = reth_block();
    let cfg = config_accepting_any();
    let abi = abi_for(&b.hash);
    let mut header = b.header.clone();
    header[40] ^= 1;
    assert_eq!(
        verify(&cfg, &line(&abi, &header, &b.txs)),
        "no the header does not hash to the proven block hash"
    );
    assert_eq!(
        verify(&cfg, &line(&abi, &b.header, &[])),
        "no the transactions do not match the header's transactions root"
    );
}

#[test]
fn lines_that_are_not_well_formed_are_refused_with_the_exact_reason() {
    let b = reth_block();
    let cfg = config_accepting_any();
    let abi = hex(&abi_for(&b.hash));
    let (header, txs) = (hex(&b.header), hex(&b.txs));
    let good = format!("{abi},{header},{txs}");
    let cases = [
        // the wrong number of fields
        (String::new(), "no malformed input"),
        (good.replacen(',', "", 1), "no malformed input"),
        (format!("{good},"), "no malformed input"),
        // not lowercase hex of whole bytes
        (good.to_uppercase(), "no malformed input"),
        (good.replacen("aa", "zz", 1), "no malformed input"),
        (
            format!("{},{header},{txs}", &abi[1..]),
            "no malformed input",
        ),
        (
            format!("{abi},{},{txs}", &header[1..]),
            "no malformed input",
        ),
        (
            format!("{abi},{header},{}", &txs[1..]),
            "no malformed input",
        ),
        // three fields, each well-formed hex, but empty: the first check to fail is the proof's length
        (",,".to_string(), "no the proof is not 1,344 bytes"),
        // a proof that is hex of the wrong length
        (
            format!("{},{header},{txs}", &abi[2..]),
            "no the proof is not 1,344 bytes",
        ),
        // an empty header under a good proof
        (
            format!("{abi},,{txs}"),
            "no the header does not hash to the proven block hash",
        ),
    ];
    for (line, expected) in cases {
        assert_eq!(verify(&cfg, &line), expected, "{line:.60}");
    }
}
