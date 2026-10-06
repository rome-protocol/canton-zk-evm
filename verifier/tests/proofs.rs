// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
//! The real proofs: three test blocks proven with ZisK 1.2.0 and the same three with ZisK 1.3.1.
//! Each release has its own verifying key, so a proof is accepted under its own key and refused
//! under the other release's key.

mod common;

use common::*;
use zk_verifier::{public_signal, verify, vk, Error, VerifyingKey, ABI_LEN};

fn all(release: &str) -> Vec<(u32, Vec<u8>)> {
    BLOCKS
        .iter()
        .map(|&b| (b, load(release, b).abi()))
        .collect()
}

#[test]
fn zisk_1_2_0_proofs_are_accepted_under_the_1_2_0_key() {
    for (block, abi) in all("1.2.0") {
        assert_eq!(verify(&vk::ZISK_1_2_0, &abi), Ok(true), "block {block}");
    }
}

#[test]
fn zisk_1_3_1_proofs_are_accepted_under_the_1_3_1_key() {
    for (block, abi) in all("1.3.1") {
        assert_eq!(verify(&vk::ZISK_1_3_1, &abi), Ok(true), "block {block}");
    }
}

#[test]
fn zisk_1_2_0_proofs_are_refused_under_the_1_3_1_key() {
    for (block, abi) in all("1.2.0") {
        assert_eq!(verify(&vk::ZISK_1_3_1, &abi), Ok(false), "block {block}");
    }
}

#[test]
fn zisk_1_3_1_proofs_are_refused_under_the_1_2_0_key() {
    for (block, abi) in all("1.3.1") {
        assert_eq!(verify(&vk::ZISK_1_2_0, &abi), Ok(false), "block {block}");
    }
}

#[test]
fn the_two_keys_are_different_keys() {
    assert_ne!(vk::ZISK_1_2_0.commitments(), vk::ZISK_1_3_1.commitments());
}

#[test]
fn the_public_signal_matches_the_one_the_prover_wrote() {
    for block in BLOCKS {
        let f = load("1.2.0", block);
        let want = f.json["publicSignal"]
            .as_str()
            .unwrap()
            .trim_start_matches("0x");
        let got = public_signal(&f.program_vk, &f.public_values, &f.root_c);
        assert_eq!(hex::encode(got), want, "block {block}");
    }
}

/// Runs `verify` on block 166's 1.3.1 proof after `change` has altered it.
fn verify_changed(change: impl Fn(&mut Vec<u8>)) -> Result<bool, Error> {
    let mut abi = load("1.3.1", 166).abi();
    change(&mut abi);
    verify(&vk::ZISK_1_3_1, &abi)
}

#[test]
fn one_flipped_proof_byte_is_refused() {
    // The last byte of the last evaluation: still a valid number, so the proof is well formed
    // and the check itself says no.
    assert_eq!(verify_changed(|a| a[767] ^= 1), Ok(false));
    // A byte inside the first point's y coordinate: the point leaves the curve.
    assert_eq!(verify_changed(|a| a[40] ^= 1), Err(Error::Malformed));
}

#[test]
fn one_flipped_public_value_is_refused() {
    assert_eq!(verify_changed(|a| a[832 + 3] ^= 1), Ok(false));
}

#[test]
fn a_flipped_program_key_or_root_is_refused() {
    assert_eq!(verify_changed(|a| a[768] ^= 1), Ok(false));
    assert_eq!(verify_changed(|a| a[800] ^= 1), Ok(false));
}

#[test]
fn a_coordinate_not_below_p_is_malformed() {
    assert_eq!(
        verify_changed(|a| a[..32].fill(0xff)),
        Err(Error::Malformed)
    );
}

#[test]
fn an_evaluation_not_below_r_is_malformed() {
    assert_eq!(
        verify_changed(|a| a[736..768].fill(0xff)),
        Err(Error::Malformed)
    );
}

#[test]
fn a_point_that_is_not_on_the_curve_is_malformed() {
    // (1, 1) is below p but is not a point of the curve y^2 = x^3 + 3.
    let off_curve = |a: &mut Vec<u8>| {
        a[..64].fill(0);
        a[31] = 1;
        a[63] = 1;
    };
    assert_eq!(verify_changed(off_curve), Err(Error::Malformed));
}

#[test]
fn the_wrong_length_is_an_error() {
    let abi = load("1.3.1", 166).abi();
    for len in [0, 1, 800, ABI_LEN - 1] {
        assert_eq!(
            verify(&vk::ZISK_1_3_1, &abi[..len]),
            Err(Error::WrongLength),
            "length {len}"
        );
    }
    let mut longer = abi.clone();
    longer.push(0);
    assert_eq!(verify(&vk::ZISK_1_3_1, &longer), Err(Error::WrongLength));
}

#[test]
fn a_key_is_a_plain_value() {
    // Callers pin a key by holding it; it is cheap to copy and compare.
    let key: VerifyingKey = vk::ZISK_1_3_1;
    assert_eq!(key, vk::ZISK_1_3_1);
    assert_ne!(key, vk::ZISK_1_2_0);
}
