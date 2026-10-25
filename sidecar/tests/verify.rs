// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
//! `verify` as a whole: the proof half (real proofs) and the block half (a real block) together,
//! and the answer's format.

mod common;

use common::*;
use sha2::{Digest, Sha256};
use zk_sidecar::{verify, verify2, Config};

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

/// The sidecar does not rely on Daml to check that the proof, header and transactions are lowercase hex:
/// it refuses a capital letter in any one field itself, so the rule holds even when the caller does not
/// check it.
#[test]
fn a_capital_letter_in_any_one_verify_field_is_refused() {
    let b = reth_block();
    let cfg = config_accepting_any();
    let (abi, header, txs) = (hex(&abi_for(&b.hash)), hex(&b.header), hex(&b.txs));
    let capitalised = |s: &str| {
        // one capital letter in the first hex letter, which every field has
        let at = s
            .find(|c: char| matches!(c, 'a'..='f'))
            .expect("a hex letter");
        let mut out = s.to_string();
        out.replace_range(at..=at, &s[at..=at].to_uppercase());
        assert_ne!(out, s);
        out
    };
    let good = format!("{abi},{header},{txs}");
    assert!(
        !verify(&cfg, &good).starts_with("no malformed"),
        "the good line is well formed"
    );
    for (name, line) in [
        ("proof", format!("{},{header},{txs}", capitalised(&abi))),
        ("header", format!("{abi},{},{txs}", capitalised(&header))),
        ("txs", format!("{abi},{header},{}", capitalised(&txs))),
    ] {
        assert_eq!(verify(&cfg, &line), "no malformed input", "{name}");
    }
}

// `verify2`: the same checks on a line with length prefixes and the SHA-256 of the rest in front.

/// A field's length in characters, as 10 decimal digits.
fn length_field(s: &str) -> String {
    format!("{:010}", s.len())
}

/// The part of a `verify2` line after the hash.
fn body2(proof: &str, header: &str, txs: &str) -> String {
    format!(
        "{}{proof}{}{header}{txs}",
        length_field(proof),
        length_field(header)
    )
}

/// The hash a `verify2` line carries for `body`.
fn sha256_hex(body: &str) -> String {
    hex(&Sha256::digest(body.as_bytes()))
}

/// A well-formed `verify2` line: the hash of `body`, then `body`.
fn line2_of(body: &str) -> String {
    format!("{}{body}", sha256_hex(body))
}

fn fields() -> (String, String, String) {
    let b = reth_block();
    (hex(&abi_for(&b.hash)), hex(&b.header), hex(&b.txs))
}

#[test]
fn a_good_verify2_line_gets_the_answer_verify_gives() {
    let cfg = config_accepting_any();
    let (abi, header, txs) = fields();
    let answer = verify2(&cfg, &line2_of(&body2(&abi, &header, &txs)));
    assert!(answer.starts_with("ok "), "{answer}");
    assert_eq!(answer, verify(&cfg, &format!("{abi},{header},{txs}")));
}

#[test]
fn verify2_gives_verifys_refusals_for_the_same_fields() {
    let cfg = config_accepting_any();
    let (abi, header, txs) = fields();
    // each of these is refused by the block check, not by the shape of the line
    for (h, t) in [
        (header.clone(), String::new()),
        (txs.clone(), header.clone()),
    ] {
        let one = verify(&cfg, &format!("{abi},{h},{t}"));
        assert!(
            one.starts_with("no ") && one != "no malformed input",
            "{one}"
        );
        assert_eq!(verify2(&cfg, &line2_of(&body2(&abi, &h, &t))), one);
    }
    // and the proof check's: a proof of the wrong size
    let short = &abi[..abi.len() - 2];
    let one = verify(&cfg, &format!("{short},{header},{txs}"));
    assert_eq!(one, "no the proof is not 1,344 bytes");
    assert_eq!(verify2(&cfg, &line2_of(&body2(short, &header, &txs))), one);
}

#[test]
fn a_verify2_line_with_an_empty_transaction_field_is_read_to_the_end() {
    let cfg = config_accepting_any();
    let (abi, header, _) = fields();
    assert_eq!(
        verify2(&cfg, &line2_of(&body2(&abi, &header, ""))),
        verify(&cfg, &format!("{abi},{header},"))
    );
}

#[test]
fn a_verify2_hash_that_differs_is_refused() {
    let cfg = config_accepting_any();
    let (abi, header, txs) = fields();
    let body = body2(&abi, &header, &txs);
    let good = line2_of(&body);
    // one digit of the hash changed
    let first = if good.starts_with('0') { "1" } else { "0" };
    let bad = format!("{first}{}", &good[1..]);
    // a hash of other text, the hash in capitals, and no hash value at all
    let other = format!("{}{body}", sha256_hex("00"));
    let capitals = format!("{}{body}", sha256_hex(&body).to_uppercase());
    let zeros = format!("{}{body}", "0".repeat(64));
    for (name, line) in [
        ("one digit", bad),
        ("other text", other),
        ("capitals", capitals),
        ("zeros", zeros),
        (
            "the body changed after hashing",
            format!(
                "{}{}",
                &good[..64],
                body2(&abi, &header, &format!("{txs}00"))
            ),
        ),
    ] {
        assert_eq!(verify2(&cfg, &line), "no malformed input", "{name}");
    }
}

#[test]
fn a_verify2_line_shorter_than_the_hash_is_refused() {
    let cfg = config_accepting_any();
    let good = line2_of(&body2("00", "00", ""));
    for line in [
        String::new(),
        "0".into(),
        good[..63].to_string(),
        "0".repeat(64),
    ] {
        assert_eq!(verify2(&cfg, &line), "no malformed input", "{line:?}");
    }
    // a hash alone is the hash of an empty body, and an empty body has no length fields
    assert_eq!(verify2(&cfg, &sha256_hex("")), "no malformed input");
    // text that is not ASCII, so the cut at 64 characters could fall inside a character
    assert_eq!(verify2(&cfg, &"é".repeat(40)), "no malformed input");
}

/// The sidecar cannot see what Daml held. The runtime lowercases the line on the way, so a capital
/// letter in a field that Daml hashed as written makes the two hashes differ.
#[test]
fn a_capital_letter_in_any_one_verify2_field_is_refused() {
    let cfg = config_accepting_any();
    let (abi, header, txs) = fields();
    let capitalised = |s: &str| {
        let at = s
            .find(|c: char| matches!(c, 'a'..='f'))
            .expect("a hex letter");
        let mut out = s.to_string();
        out.replace_range(at..=at, &s[at..=at].to_uppercase());
        assert_ne!(out, s);
        out
    };
    assert!(verify2(&cfg, &line2_of(&body2(&abi, &header, &txs))).starts_with("ok "));
    for (name, body) in [
        ("proof", body2(&capitalised(&abi), &header, &txs)),
        ("header", body2(&abi, &capitalised(&header), &txs)),
        ("txs", body2(&abi, &header, &capitalised(&txs))),
    ] {
        // as the stdlib sends it: hashed as written, lowercased in transit
        let in_transit = format!("{}{}", sha256_hex(&body), body.to_lowercase());
        assert_eq!(verify2(&cfg, &in_transit), "no malformed input", "{name}");
        // and when nothing lowercases it, the strict hex rule still refuses it
        assert_eq!(
            verify2(&cfg, &line2_of(&body)),
            "no malformed input",
            "{name}"
        );
    }
}

#[test]
fn a_verify2_line_with_a_bad_length_field_is_refused() {
    let cfg = config_accepting_any();
    let (abi, header, txs) = fields();
    let (lp, lh) = (length_field(&abi), length_field(&header));
    let rest = format!("{abi}{lh}{header}{txs}");
    let line = |lp: &str, rest: &str| line2_of(&format!("{lp}{rest}"));
    assert!(verify2(&cfg, &line(&lp, &rest)).starts_with("ok "));
    let odd = format!("{:010}", abi.len() - 1);
    let past_end = format!("{:010}", abi.len() + header.len() + txs.len() + 20);
    let shifted = format!("{:010}", abi.len() + 2);
    for (name, l) in [
        ("non-digit", format!("{}x", &lp[..9])),
        ("a sign", format!("+{}", &lp[1..])),
        ("a space", format!(" {}", &lp[1..])),
        ("capital hex", "000000000A".to_string()),
        ("odd", odd),
        ("past the end", past_end),
        ("shifted into the header", shifted),
        ("too short", lp[..9].to_string()),
    ] {
        assert_eq!(
            verify2(&cfg, &line(&l, &rest)),
            "no malformed input",
            "first {name}"
        );
    }
    // the same for the second length field
    let second_bad = |l: &str| line2_of(&format!("{lp}{abi}{l}{header}{txs}"));
    let odd = format!("{:010}", header.len() - 1);
    let past_end = format!("{:010}", header.len() + txs.len() + 20);
    for (name, l) in [
        ("non-digit", format!("{}x", &lh[..9])),
        ("odd", odd),
        ("past the end", past_end),
    ] {
        assert_eq!(
            verify2(&cfg, &second_bad(&l)),
            "no malformed input",
            "second {name}"
        );
    }
    // a line that stops inside the second length field, or right after the first field
    for cut in [format!("{lp}{abi}"), format!("{lp}{abi}{}", &lh[..5])] {
        assert_eq!(verify2(&cfg, &line2_of(&cut)), "no malformed input");
    }
    // a split moved by two characters changes what is checked, so the proof is not 1,344 bytes
    let moved = format!(
        "{:010}{}{:010}{}{txs}",
        abi.len() + 2,
        &format!("{abi}{}", &header[..2]),
        header.len() - 2,
        &header[2..]
    );
    assert_eq!(
        verify2(&cfg, &line2_of(&moved)),
        "no the proof is not 1,344 bytes"
    );
}

#[test]
fn verify2_refuses_a_field_that_is_not_whole_hex_bytes() {
    let cfg = config_accepting_any();
    let (abi, header, txs) = fields();
    for (name, body) in [
        (
            "g in the header",
            body2(&abi, &format!("g{}", &header[1..]), &txs),
        ),
        ("odd transactions", body2(&abi, &header, &format!("{txs}0"))),
        ("a comma", body2(&abi, &header, &format!("{txs},"))),
    ] {
        assert_eq!(
            verify2(&cfg, &line2_of(&body)),
            "no malformed input",
            "{name}"
        );
    }
}
