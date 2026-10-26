// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
//! The proof half of `verify`, on real proofs: the session's proof of block 1 of our chain, and the
//! verifier crate's six.

mod common;

use common::*;
use zk_sidecar::{proven_block_hash, Config, Release};

const NOT_VERIFIED: &str = "the proof does not verify";
const OTHER_PROGRAM: &str = "the proof was made by another program or ZisK release";
const NO_HASH: &str = "the proof does not commit to one block hash";

fn session_config() -> (Config, Vec<u8>) {
    let s = session();
    (Config::new(s.program_vk, s.root_c), s.abi)
}

#[test]
fn the_session_proof_is_accepted_and_commits_to_block_1() {
    let (cfg, abi) = session_config();
    assert_eq!(proven_block_hash(&cfg, &abi), Ok(session().block_hash));
}

#[test]
fn the_verifier_crates_proofs_are_accepted_under_their_own_keys() {
    for block in [14, 166, 169] {
        let p = verifier_proof("1.3.1", block);
        let cfg = Config::new(p.program_vk, p.root_c);
        // The two releases proved the same blocks, so each block's 1.2.0 proof must commit to the
        // same hash as its 1.3.1 proof. The hash read from the 1.2.0 proof, which is not checked
        // here, is the expected answer for the 1.3.1 proof, which is.
        let other = verifier_proof("1.2.0", block);
        assert_eq!(
            proven_block_hash(&cfg, &p.abi),
            Ok(committed_hash(&other.abi)),
            "block {block}"
        );
    }
}

#[test]
fn the_other_release_proofs_are_refused() {
    for block in [14, 166, 169] {
        let p = verifier_proof("1.2.0", block);
        let cfg = Config::new(p.program_vk, p.root_c);
        assert_eq!(
            proven_block_hash(&cfg, &p.abi),
            Err(NOT_VERIFIED),
            "block {block}"
        );
    }
}

#[test]
fn a_flipped_proof_byte_is_refused() {
    let (cfg, abi) = session_config();
    for at in [0, 31, 32, 100, 383, 384, 700, 767] {
        let mut bad = abi.clone();
        bad[at] ^= 1;
        assert_eq!(
            proven_block_hash(&cfg, &bad),
            Err(NOT_VERIFIED),
            "byte {at}"
        );
    }
}

#[test]
fn a_flipped_public_value_byte_is_refused() {
    let (cfg, abi) = session_config();
    let mut bad = abi;
    bad[832 + 8] ^= 1; // a bit of the block hash
    assert_eq!(proven_block_hash(&cfg, &bad), Err(NOT_VERIFIED));
}

#[test]
fn a_proof_of_another_length_is_refused() {
    let (cfg, abi) = session_config();
    assert_eq!(
        proven_block_hash(&cfg, &abi[..1343]),
        Err("the proof is not 1,344 bytes")
    );
    assert_eq!(
        proven_block_hash(&cfg, &[]),
        Err("the proof is not 1,344 bytes")
    );
}

#[test]
fn a_proof_under_another_program_key_is_refused() {
    let s = session();
    let mut wrong = s.program_vk;
    wrong[0] ^= 1;
    assert_eq!(
        proven_block_hash(&Config::new(wrong, s.root_c), &s.abi),
        Err(OTHER_PROGRAM)
    );
}

#[test]
fn a_proof_under_another_root_is_refused() {
    let s = session();
    let mut wrong = s.root_c;
    wrong[31] ^= 1;
    assert_eq!(
        proven_block_hash(&Config::new(s.program_vk, wrong), &s.abi),
        Err(OTHER_PROGRAM)
    );
}

#[test]
fn public_values_in_another_layout_are_refused() {
    let cfg = config_accepting_any();
    let good = abi_for(&[7; 32]);
    assert_eq!(proven_block_hash(&cfg, &good), Ok([7; 32]));
    // a bit in the unused half of a slot
    let mut bad = good.clone();
    bad[832 + 4] = 1;
    assert_eq!(proven_block_hash(&cfg, &bad), Err(NO_HASH));
    // a different length byte in front of the hash
    let mut bad = good.clone();
    bad[832] = 0x21;
    assert_eq!(proven_block_hash(&cfg, &bad), Err(NO_HASH));
    // something after the hash
    let mut bad = good;
    bad[832 + 8 * 40] = 1;
    assert_eq!(proven_block_hash(&cfg, &bad), Err(NO_HASH));
}

#[test]
fn the_session_proof_is_accepted_under_the_pins_of_its_release() {
    let s = session();
    let cfg = Config::for_release(s.program_vk, s.root_c, Release::V1_3_2);
    assert_eq!(proven_block_hash(&cfg, &s.abi), Ok(s.block_hash));
}

#[test]
fn each_releases_proofs_are_accepted_under_its_own_release_and_refused_under_the_others_pins() {
    for block in [14, 166, 169] {
        let old = verifier_proof("1.3.1", block);
        let new = verifier_proof("1.3.2", block);
        let old_cfg = Config::for_release(old.program_vk, old.root_c, Release::V1_3_1);
        let new_cfg = Config::for_release(new.program_vk, new.root_c, Release::V1_3_2);
        assert_eq!(
            proven_block_hash(&old_cfg, &old.abi),
            Ok(committed_hash(&old.abi)),
            "1.3.1, block {block}"
        );
        assert_eq!(
            proven_block_hash(&new_cfg, &new.abi),
            Ok(committed_hash(&new.abi)),
            "1.3.2, block {block}"
        );
        // The two releases share one PLONK key, so the pins are what tell them apart.
        assert_eq!(
            proven_block_hash(&new_cfg, &old.abi),
            Err(OTHER_PROGRAM),
            "1.3.1 proof, 1.3.2 pins, block {block}"
        );
        assert_eq!(
            proven_block_hash(&old_cfg, &new.abi),
            Err(OTHER_PROGRAM),
            "1.3.2 proof, 1.3.1 pins, block {block}"
        );
    }
}

#[test]
fn a_chain_without_a_named_release_is_on_1_3_1() {
    let p = verifier_proof("1.3.1", 14);
    assert_eq!(
        Config::new(p.program_vk, p.root_c).keys[0].release,
        Release::V1_3_1
    );
    assert_eq!(Release::default(), Release::V1_3_1);
}

#[test]
fn a_1_3_2_proof_that_is_altered_is_refused_under_the_1_3_2_release() {
    let p = verifier_proof("1.3.2", 166);
    let cfg = Config::for_release(p.program_vk, p.root_c, Release::V1_3_2);
    for at in [0, 100, 383, 700, 767] {
        let mut bad = p.abi.clone();
        bad[at] ^= 1;
        assert_eq!(
            proven_block_hash(&cfg, &bad),
            Err(NOT_VERIFIED),
            "byte {at}"
        );
    }
}

#[test]
fn releases_are_read_by_number_with_or_without_alpha() {
    assert_eq!(Release::parse("1.3.1"), Some(Release::V1_3_1));
    assert_eq!(Release::parse("1.3.2-alpha"), Some(Release::V1_3_2));
    for bad in [
        "",
        "1.2.0",
        "1.3",
        "1.3.2-beta",
        "1.3.2-alpha-alpha",
        "v1.3.2",
        " 1.3.2",
    ] {
        assert_eq!(Release::parse(bad), None, "{bad:?}");
    }
    assert_eq!(Release::V1_3_2.name(), "1.3.2");
    assert_eq!(Release::from_code(0), Some(Release::V1_3_1));
    assert_eq!(Release::from_code(1), Some(Release::V1_3_2));
    assert_eq!(Release::from_code(2), None);
}
