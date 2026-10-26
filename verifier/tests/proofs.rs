// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
//! The real proofs: three test blocks proven with ZisK 1.2.0, the same three with ZisK 1.3.1 and
//! the same three with ZisK 1.3.2. Releases 1.3.1 and 1.3.2 share one PLONK key (see `vk.rs`), so
//! what tells their proofs apart is the program key and the root of the final circuit that a
//! proof carries and the caller pins; a proof is refused when its own program key or root is
//! swapped for the other release's.

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
fn zisk_1_3_2_proofs_are_accepted_under_the_1_3_x_key() {
    for (block, abi) in all("1.3.2") {
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
fn the_1_2_0_key_is_not_the_1_3_x_key() {
    assert_ne!(vk::ZISK_1_2_0.commitments(), vk::ZISK_1_3_1.commitments());
}

#[test]
fn zisk_1_2_0_proofs_are_refused_under_the_1_3_x_key_for_every_release_of_it() {
    for (block, abi) in all("1.2.0") {
        assert_eq!(verify(&vk::ZISK_1_3_1, &abi), Ok(false), "block {block}");
    }
    for release in ["1.3.1", "1.3.2"] {
        for (block, abi) in all(release) {
            assert_eq!(
                verify(&vk::ZISK_1_2_0, &abi),
                Ok(false),
                "{release} block {block}"
            );
        }
    }
}

#[test]
fn the_releases_carry_their_own_program_key_and_root_but_the_same_public_values() {
    for block in BLOCKS {
        let (a, b) = (load("1.3.1", block), load("1.3.2", block));
        assert_ne!(a.program_vk, b.program_vk, "block {block}: programVK");
        assert_ne!(a.root_c, b.root_c, "block {block}: rootC");
        // The same guest source on the same input says the same thing about the block.
        assert_eq!(
            a.public_values, b.public_values,
            "block {block}: public values"
        );
        assert_ne!(a.proof, b.proof, "block {block}: proof");
    }
    // The pins a caller holds for each release, one program key and one root for all three blocks.
    for release in ["1.3.1", "1.3.2"] {
        let first = load(release, BLOCKS[0]);
        for block in BLOCKS {
            let f = load(release, block);
            assert_eq!(f.program_vk, first.program_vk, "{release} block {block}");
            assert_eq!(f.root_c, first.root_c, "{release} block {block}");
        }
    }
}

/// `proof`'s own bytes with the program key and root of `other` in place of its own.
fn with_pins_of(proof: &Fixture, other: &Fixture) -> Vec<u8> {
    [
        &proof.proof,
        &other.program_vk,
        &other.root_c,
        &proof.public_values,
    ]
    .iter()
    .flat_map(|part| part.iter().copied())
    .collect()
}

#[test]
fn a_proof_is_refused_under_the_other_1_3_releases_program_key_and_root() {
    for block in BLOCKS {
        let (old, new) = (load("1.3.1", block), load("1.3.2", block));
        assert_eq!(
            verify(&vk::ZISK_1_3_1, &with_pins_of(&old, &new)),
            Ok(false),
            "1.3.1 proof, block {block}"
        );
        assert_eq!(
            verify(&vk::ZISK_1_3_1, &with_pins_of(&new, &old)),
            Ok(false),
            "1.3.2 proof, block {block}"
        );
        // Only the root, or only the program key, swapped: refused as well.
        let mut abi = old.abi();
        abi[800..832].copy_from_slice(&new.root_c);
        assert_eq!(
            verify(&vk::ZISK_1_3_1, &abi),
            Ok(false),
            "1.3.1 proof, 1.3.2 root, block {block}"
        );
        let mut abi = new.abi();
        abi[768..800].copy_from_slice(&old.program_vk);
        assert_eq!(
            verify(&vk::ZISK_1_3_1, &abi),
            Ok(false),
            "1.3.2 proof, 1.3.1 program key, block {block}"
        );
    }
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

/// Runs `verify` on block 166's proof of each 1.3 release after `change` has altered it, and
/// gives the answer if the two releases agree (they must: the same key, the same rules).
fn verify_changed(change: impl Fn(&mut Vec<u8>)) -> Result<bool, Error> {
    let answer = |release: &str| {
        let mut abi = load(release, 166).abi();
        change(&mut abi);
        verify(&vk::ZISK_1_3_1, &abi)
    };
    let (old, new) = (answer("1.3.1"), answer("1.3.2"));
    assert_eq!(
        old, new,
        "1.3.1 and 1.3.2 proofs are not refused the same way"
    );
    new
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
    let abi = load("1.3.2", 166).abi();
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

#[test]
fn a_proof_with_the_parts_of_two_releases_mixed_is_refused() {
    // The public values are hashed with the program key and the root into the one signal the
    // proof is checked against: mixing the parts of two releases' proofs gives nothing.
    for block in BLOCKS {
        let (old, new) = (load("1.3.1", block), load("1.3.2", block));
        let abi: Vec<u8> = [&new.proof, &old.program_vk, &new.root_c, &old.public_values]
            .iter()
            .flat_map(|part| part.iter().copied())
            .collect();
        assert_eq!(verify(&vk::ZISK_1_3_1, &abi), Ok(false), "block {block}");
    }
}

/// The value of `key` in the recorded session of the one-transfer block (`prover/fixtures`).
fn recorded(key: &str) -> String {
    let text = std::fs::read_to_string(format!(
        "{}/../prover/fixtures/session.txt",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    let prefix = format!("{key}=");
    text.lines()
        .find_map(|l| l.strip_prefix(prefix.as_str()))
        .unwrap_or_else(|| panic!("no {key} in session.txt"))
        .to_string()
}

#[test]
fn the_recorded_proof_of_the_one_transfer_block_is_accepted_and_carries_its_pins() {
    let hex_text = std::fs::read_to_string(format!(
        "{}/../prover/fixtures/wrapped-proof.hex",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    let abi = hex::decode(hex_text.trim()).unwrap();
    assert_eq!(verify(&vk::ZISK_1_3_1, &abi), Ok(true));
    assert_eq!(verify(&vk::ZISK_1_2_0, &abi), Ok(false));
    // The program key and the root in the proof are the ones the session recorded for this guest
    // on this release, and not the key of the guest it replaced (previous_programVK) nor the
    // 1.3.1 root.
    assert_eq!(
        format!("0x{}", hex::encode(&abi[768..800])),
        recorded("programVK")
    );
    assert_eq!(
        format!("0x{}", hex::encode(&abi[800..832])),
        recorded("rootC")
    );
    assert_ne!(recorded("programVK"), recorded("previous_programVK"));
    assert_eq!(
        hex::encode(&abi[800..832]),
        hex::encode(&load("1.3.2", 14).root_c)
    );
    assert_ne!(abi[800..832], load("1.3.1", 14).root_c[..]);
    // Swapping in the root of the 1.3.1 release makes it a different statement, which is refused.
    let mut other = abi.clone();
    other[800..832].copy_from_slice(&load("1.3.1", 14).root_c);
    assert_eq!(verify(&vk::ZISK_1_3_1, &other), Ok(false));
}
