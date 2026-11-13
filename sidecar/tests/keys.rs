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
    // The session proof is a ZisK 1.4.0 proof: the 1.3.x PLONK key of the listed entry does not accept it at all.
    assert_eq!(proven_block_hash(&cfg, &s.abi), Err(NOT_VERIFIED));
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
    let one = Config::with_keys(vec![Key::new(s.program_vk, s.root_c, Release::V1_4_0)]).unwrap();
    let old = Config::for_release(s.program_vk, s.root_c, Release::V1_4_0);
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
    let k = Key::parse(&format!("{a}:{b}:1.3.1")).unwrap();
    assert_eq!(k, Key::new([0x11; 32], [0x22; 32], Release::V1_3_1));
    let k = Key::parse(&format!("0x{a}:{b}:1.3.2")).unwrap();
    assert_eq!(k, Key::new([0x11; 32], [0x22; 32], Release::V1_3_2));
    let k = Key::parse(&format!("{a}:{b}:1.4.0-alpha")).unwrap();
    assert_eq!(k, Key::new([0x11; 32], [0x22; 32], Release::V1_4_0));
    for bad in [
        String::new(),
        a.clone(),
        // a key with no release is refused: there is no default release
        format!("{a}:{b}"),
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

// ---- a program switch at a block: the old key before it, the new one from it ----

const KEY_B: ([u8; 32], [u8; 32]) = ([0x11; 32], [0x22; 32]);
const KEY_C: ([u8; 32], [u8; 32]) = ([0xaa; 32], [0xbb; 32]);
const NOT_THIS_BLOCK: &str = "no the proof's key is not valid for this block number";

/// The 1,344-byte input for `hash` that carries the pins `key`.
fn abi_pinned(hash: &[u8; 32], key: ([u8; 32], [u8; 32])) -> Vec<u8> {
    let mut abi = abi_for(hash);
    abi[768..800].copy_from_slice(&key.0);
    abi[800..832].copy_from_slice(&key.1);
    abi
}

/// Key B (ZisK 1.3.2) for the blocks before `switch` and key C (ZisK 1.4.0) from it, with the proof
/// check switched off so that the block is the one of `reth_block`.
fn switch_config(switch: u64) -> Config {
    Config::with_keys(vec![
        Key::new(KEY_B.0, KEY_B.1, Release::V1_3_2).before_block(switch),
        Key::new(KEY_C.0, KEY_C.1, Release::V1_4_0).from_block(switch),
    ])
    .unwrap()
    .with_proof_check(accept_any)
}

fn answer_for(cfg: &Config, key: ([u8; 32], [u8; 32])) -> String {
    let b = reth_block();
    let line = format!(
        "{},{},{}",
        hex(&abi_pinned(&b.hash, key)),
        hex(&b.header),
        hex(&b.txs)
    );
    verify(cfg, &line)
}

#[test]
fn the_block_before_the_switch_is_accepted_under_key_b_and_refused_under_key_c() {
    let b = reth_block();
    let cfg = switch_config(b.number + 1);
    let ok = answer_for(&cfg, KEY_B);
    assert!(
        ok.starts_with(&format!("ok {} {} ", hex(&KEY_B.0), hex(&KEY_B.1))),
        "{ok}"
    );
    assert_eq!(answer_for(&cfg, KEY_C), NOT_THIS_BLOCK);
}

#[test]
fn the_switch_block_is_accepted_under_key_c_and_refused_under_key_b() {
    let b = reth_block();
    let cfg = switch_config(b.number);
    let ok = answer_for(&cfg, KEY_C);
    assert!(
        ok.starts_with(&format!("ok {} {} ", hex(&KEY_C.0), hex(&KEY_C.1))),
        "{ok}"
    );
    assert_eq!(answer_for(&cfg, KEY_B), NOT_THIS_BLOCK);
}

#[test]
fn blocks_long_after_the_switch_stay_on_key_c_and_long_before_it_on_key_b() {
    let b = reth_block();
    // The switch is far ahead of this block: B only. The switch is behind it: C only.
    let ahead = switch_config(b.number + 1_000_000);
    assert!(answer_for(&ahead, KEY_B).starts_with("ok "));
    assert_eq!(answer_for(&ahead, KEY_C), NOT_THIS_BLOCK);
    if b.number > 0 {
        let behind = switch_config(b.number - 1);
        assert!(answer_for(&behind, KEY_C).starts_with("ok "));
        assert_eq!(answer_for(&behind, KEY_B), NOT_THIS_BLOCK);
    }
}

#[test]
fn a_key_with_no_range_is_valid_for_every_block() {
    let k = Key::new([1; 32], [2; 32], Release::V1_3_2);
    for n in [0, 1, 15572, u64::MAX] {
        assert!(k.covers(n), "{n}");
    }
}

#[test]
fn a_range_covers_its_first_block_and_stops_before_its_last() {
    let k = Key::new([1; 32], [2; 32], Release::V1_4_0)
        .from_block(10)
        .before_block(20);
    assert!(!k.covers(9));
    assert!(k.covers(10));
    assert!(k.covers(19));
    assert!(!k.covers(20));
    let open = Key::new([1; 32], [2; 32], Release::V1_4_0).from_block(10);
    assert!(!open.covers(9) && open.covers(10) && open.covers(u64::MAX));
    let ended = Key::new([1; 32], [2; 32], Release::V1_3_2).before_block(10);
    assert!(ended.covers(0) && ended.covers(9) && !ended.covers(10));
}

#[test]
fn a_key_is_parsed_with_its_block_range() {
    let (a, b) = ("11".repeat(32), "22".repeat(32));
    let key = |rel: &str, range: &str| Key::parse(&format!("{a}:{b}:{rel}{range}"));
    let base = |r| Key::new([0x11; 32], [0x22; 32], r);
    assert_eq!(
        key("1.3.2", "@..5000"),
        Ok(base(Release::V1_3_2).before_block(5000))
    );
    assert_eq!(
        key("1.4.0", "@5000.."),
        Ok(base(Release::V1_4_0).from_block(5000))
    );
    assert_eq!(
        key("1.4.0-alpha", "@5000..6000"),
        Ok(base(Release::V1_4_0).from_block(5000).before_block(6000))
    );
    for bad in [
        "@", "@..", "@5", "@5..5", "@6..5", "@x..", "@..x", "@-1..", "@ 5..", "@5...6", "@1..2@3",
        "@5..6..",
    ] {
        assert!(key("1.4.0", bad).is_err(), "{bad:?}");
    }
}

#[test]
fn a_real_1_3_2_proof_and_a_real_1_4_0_proof_are_each_accepted_under_their_own_entry() {
    let old = verifier_proof("1.3.2", 14);
    let s = session();
    let (kb, kc) = (
        key_of(&old, Release::V1_3_2),
        Key::new(s.program_vk, s.root_c, Release::V1_4_0),
    );
    for keys in [vec![kb, kc], vec![kc, kb]] {
        let cfg = Config::with_keys(keys).unwrap();
        assert_eq!(
            proven_block(&cfg, &old.abi),
            Ok((kb, committed_hash(&old.abi)))
        );
        assert_eq!(proven_block(&cfg, &s.abi), Ok((kc, s.block_hash)));
    }
    // Each is refused when only the other's entry is listed: the PLONK key of the release is not the proof's.
    let only_c = Config::with_keys(vec![kc]).unwrap();
    assert_eq!(proven_block_hash(&only_c, &old.abi), Err(NOT_VERIFIED));
    let only_b = Config::with_keys(vec![kb]).unwrap();
    assert_eq!(proven_block_hash(&only_b, &s.abi), Err(NOT_VERIFIED));
}
