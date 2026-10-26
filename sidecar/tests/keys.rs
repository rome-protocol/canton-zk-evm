// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
//! A sidecar that lists several keys: a proof is accepted under the entry whose program key and
//! root it carries, on real proofs of both ZisK releases, and refused otherwise.

mod common;

use common::*;
use zk_sidecar::{hex, proven_block, proven_block_hash, verify, Config, Key, Release, MAX_KEYS};

const NOT_VERIFIED: &str = "the proof does not verify";
const OTHER_PROGRAM: &str = "the proof was made by another program or ZisK release";

fn key_of(p: &VerifierProof, release: Release) -> Key {
    Key::new(p.program_vk, p.root_c, release)
}

#[test]
fn a_proof_under_each_listed_key_is_accepted_and_says_which_key() {
    for block in [14, 166, 169] {
        let old = verifier_proof("1.3.1", block);
        let new = verifier_proof("1.3.2", block);
        let (ko, kn) = (key_of(&old, Release::V1_3_1), key_of(&new, Release::V1_3_2));
        for keys in [vec![ko, kn], vec![kn, ko]] {
            let cfg = Config::with_keys(keys).unwrap();
            assert_eq!(
                proven_block(&cfg, &old.abi),
                Ok((ko, committed_hash(&old.abi))),
                "1.3.1, block {block}"
            );
            assert_eq!(
                proven_block(&cfg, &new.abi),
                Ok((kn, committed_hash(&new.abi))),
                "1.3.2, block {block}"
            );
        }
    }
}

#[test]
fn a_proof_under_a_key_that_is_not_listed_is_refused() {
    let old = verifier_proof("1.3.1", 14);
    let new = verifier_proof("1.3.2", 14);
    let s = session();
    let cfg = Config::with_keys(vec![key_of(&old, Release::V1_3_1)]).unwrap();
    assert_eq!(proven_block_hash(&cfg, &new.abi), Err(OTHER_PROGRAM));
    assert_eq!(proven_block_hash(&cfg, &s.abi), Err(OTHER_PROGRAM));
    // The list has the right release but another program's pins.
    let mut other = key_of(&old, Release::V1_3_1);
    other.program_vk[0] ^= 1;
    let cfg = Config::with_keys(vec![other, key_of(&new, Release::V1_3_2)]).unwrap();
    assert_eq!(proven_block_hash(&cfg, &old.abi), Err(OTHER_PROGRAM));
}

#[test]
fn pins_that_are_one_entrys_program_key_and_anothers_root_are_refused() {
    let old = verifier_proof("1.3.1", 14);
    let new = verifier_proof("1.3.2", 14);
    let list = vec![key_of(&old, Release::V1_3_1), key_of(&new, Release::V1_3_2)];
    // With the real proof check: the pins are part of what the proof commits to, so a changed
    // pin does not verify.
    let cfg = Config::with_keys(list.clone()).unwrap();
    let mut crossed = old.abi.clone();
    crossed[800..832].copy_from_slice(&new.root_c);
    assert_eq!(proven_block_hash(&cfg, &crossed), Err(NOT_VERIFIED));
    // With the proof check switched off, so that only the pins are looked at.
    assert_ne!(old.root_c, new.root_c, "the two releases' roots differ");
    let cfg = Config::with_keys(list)
        .unwrap()
        .with_proof_check(accept_any);
    assert_eq!(
        proven_block_hash(&cfg, &old.abi),
        Ok(committed_hash(&old.abi))
    );
    assert_eq!(proven_block_hash(&cfg, &crossed), Err(OTHER_PROGRAM));
    let mut crossed = new.abi.clone();
    crossed[768..800].copy_from_slice(&old.program_vk);
    assert_eq!(proven_block_hash(&cfg, &crossed), Err(OTHER_PROGRAM));
}

#[test]
fn a_flipped_proof_byte_is_refused_under_a_list() {
    let old = verifier_proof("1.3.1", 14);
    let new = verifier_proof("1.3.2", 14);
    let cfg = Config::with_keys(vec![
        key_of(&old, Release::V1_3_1),
        key_of(&new, Release::V1_3_2),
    ])
    .unwrap();
    let mut bad = new.abi.clone();
    bad[10] ^= 1;
    assert_eq!(proven_block_hash(&cfg, &bad), Err(NOT_VERIFIED));
}

#[test]
fn a_list_of_one_is_the_single_key_config() {
    let s = session();
    let one = Config::with_keys(vec![Key::new(s.program_vk, s.root_c, Release::V1_3_1)]).unwrap();
    let old = Config::new(s.program_vk, s.root_c);
    assert_eq!(one.keys(), old.keys());
    assert_eq!(
        proven_block_hash(&one, &s.abi),
        proven_block_hash(&old, &s.abi)
    );
}

#[test]
fn the_list_is_refused_when_empty_too_long_or_has_a_program_key_twice() {
    let key = |n: u8| Key::new([n; 32], [0xcc; 32], Release::V1_3_1);
    assert!(Config::with_keys(vec![]).is_err());
    let four: Vec<Key> = (1..=MAX_KEYS as u8).map(key).collect();
    assert!(Config::with_keys(four).is_ok());
    let five: Vec<Key> = (1..=MAX_KEYS as u8 + 1).map(key).collect();
    assert!(Config::with_keys(five).err().unwrap().contains("at most 4"));
    // Same program key, a different root or release: still a duplicate.
    let dup = Key::new([1; 32], [0xdd; 32], Release::V1_3_2);
    assert!(Config::with_keys(vec![key(1), dup])
        .err()
        .unwrap()
        .contains("twice"));
}

#[test]
fn a_key_is_parsed_from_program_key_root_and_release() {
    let (a, b) = ("11".repeat(32), "22".repeat(32));
    let k = Key::parse(&format!("{a}:{b}")).unwrap();
    assert_eq!(k, Key::new([0x11; 32], [0x22; 32], Release::V1_3_1));
    let k = Key::parse(&format!("0x{a}:{b}:1.3.2")).unwrap();
    assert_eq!(k, Key::new([0x11; 32], [0x22; 32], Release::V1_3_2));
    for bad in [
        String::new(),
        a.clone(),
        format!("{a}:{b}:1.3.3"),
        format!("{a}:{b}:1.3.2:x"),
        format!("{}:{b}", "AA".repeat(32)),
        format!("{}:{b}", "11".repeat(31)),
        format!("zz:{b}"),
    ] {
        assert!(Key::parse(&bad).is_err(), "{bad:?}");
    }
}

#[test]
fn the_ok_answer_carries_the_pins_of_the_key_that_accepted_the_proof() {
    let b = reth_block();
    let keys = vec![
        Key::new([0x11; 32], [0x22; 32], Release::V1_3_1),
        Key::new([0xaa; 32], [0xbb; 32], Release::V1_3_2),
    ];
    let cfg = Config::with_keys(keys)
        .unwrap()
        .with_proof_check(accept_any);
    // `abi_for` carries the pins 0xaa and 0xbb: the second entry's.
    let abi = abi_for(&b.hash);
    let line = format!("{},{},{}", hex(&abi), hex(&b.header), hex(&b.txs));
    let answer = verify(&cfg, &line);
    assert!(
        answer.starts_with(&format!("ok {} {} ", "aa".repeat(32), "bb".repeat(32))),
        "{answer}"
    );
}

/// A proof check that accepts only a proof under the 1.3.2 PLONK key.
fn accept_only_1_3_2(release: Release, _: &[u8]) -> Result<bool, zk_verifier::Error> {
    Ok(release == Release::V1_3_2)
}

#[test]
fn the_plonk_key_is_the_one_of_the_entrys_own_release() {
    let b = reth_block();
    let (k1, r1) = ([0x11; 32], [0x22; 32]);
    let (k2, r2) = ([0xaa; 32], [0xbb; 32]);
    let abi_with = |vk: [u8; 32], rc: [u8; 32]| {
        let mut abi = abi_for(&b.hash);
        abi[768..800].copy_from_slice(&vk);
        abi[800..832].copy_from_slice(&rc);
        abi
    };
    for keys in [
        vec![
            Key::new(k1, r1, Release::V1_3_1),
            Key::new(k2, r2, Release::V1_3_2),
        ],
        vec![
            Key::new(k2, r2, Release::V1_3_2),
            Key::new(k1, r1, Release::V1_3_1),
        ],
    ] {
        let cfg = Config::with_keys(keys)
            .unwrap()
            .with_proof_check(accept_only_1_3_2);
        // The 1.3.1 entry's pins: the proof does not verify under its release.
        assert_eq!(
            proven_block_hash(&cfg, &abi_with(k1, r1)),
            Err(OTHER_PROGRAM)
        );
        // The 1.3.2 entry's pins: accepted.
        assert_eq!(proven_block_hash(&cfg, &abi_with(k2, r2)), Ok(b.hash));
    }
}
