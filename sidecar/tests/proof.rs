// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
//! The proof half of `verify`, on real proofs: the session's proof of block 1 of our chain, and the
//! verifier crate's six.

mod common;

use common::*;
use zk_sidecar::{proven_block_hash, Config};

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
