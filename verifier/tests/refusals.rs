//! Originally written by Rome Protocol.
//!
//! Inputs the verifier must refuse, and what each one must give. Every test changes block 14's
//! ZisK 1.3.1 proof and checks the answer against the rule the change breaks:
//!
//! 1. a coordinate not below p, an evaluation not below r, or a point off the curve is an
//!    error (`Malformed`), whatever else is in the proof;
//! 2. every other change gives `Ok(false)`.
//!
//! The curve test is worked out here with plain arithmetic, not with the point decoder the crate
//! uses.

mod common;

use common::*;
use zk_verifier::{public_signal, verify, vk, Error};

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum Out {
    Accept,
    Reject,
    Malformed,
}

fn classify(result: Result<bool, Error>) -> Out {
    match result {
        Ok(true) => Out::Accept,
        Ok(false) => Out::Reject,
        Err(Error::Malformed) => Out::Malformed,
        Err(Error::WrongLength) => panic!("the input has the wrong length"),
    }
}

fn block14() -> Fixture {
    load("1.3.1", 14)
}

/// The answer for block 14's data with `proof` in place of its own proof.
fn check(f: &Fixture, proof: &[u8; 768]) -> Out {
    let mut abi = f.abi();
    abi[..768].copy_from_slice(proof);
    classify(verify(&vk::ZISK_1_3_1, &abi))
}

/// What the rules give for a changed proof, worked out without the crate: the nine commitments
/// are words 0 to 17 (x then y) and the six evaluations are words 18 to 23.
fn expected(proof: &[u8; 768]) -> Out {
    for i in 0..18 {
        if word(proof, i) >= P {
            return Out::Malformed;
        }
    }
    for k in 0..9 {
        if !on_curve_or_infinity(&proof[64 * k..64 * k + 64]) {
            return Out::Malformed;
        }
    }
    for i in 18..24 {
        if word(proof, i) >= R {
            return Out::Malformed;
        }
    }
    Out::Reject
}

#[test]
fn the_unchanged_proof_is_accepted() {
    let f = block14();
    assert_eq!(check(&f, &f.proof_array()), Out::Accept);
    assert_eq!(expected(&f.proof_array()), Out::Reject);
}

#[test]
fn a_flag_bit_in_a_y_coordinate_is_malformed() {
    let f = block14();
    for k in 0..9 {
        let y = 2 * k + 1;
        for flag in [0x80u8, 0x40u8] {
            let mut proof = f.proof_array();
            proof[32 * y] |= flag;
            assert_eq!(
                check(&f, &proof),
                Out::Malformed,
                "point {k} flag {flag:#x}"
            );
        }
        // The y coordinate plus 2^255, as a number.
        let mut proof = f.proof_array();
        let mut top = [0u8; 32];
        top[0] = 0x80;
        let (sum, _) = add_be(&word(&proof, y), &top);
        set_word(&mut proof, y, &sum);
        assert_eq!(check(&f, &proof), Out::Malformed, "point {k} plus 2^255");
    }
}

#[test]
fn a_coordinate_changed_by_one_bit_leaves_the_curve() {
    let f = block14();
    for i in 0..18 {
        let mut proof = f.proof_array();
        proof[32 * i + 31] ^= 1;
        assert_eq!(expected(&proof), Out::Malformed, "word {i}");
        assert_eq!(check(&f, &proof), Out::Malformed, "word {i}");
    }
}

/// A prover can choose the evaluation a-bar so that the scalar of the permutation commitment
/// [z]_1 is exactly zero (the challenges do not depend on a-bar). A verifier that only decoded a
/// point when its scalar is not zero would let an off-curve [z]_1 through. It must still be
/// refused as malformed.
#[test]
fn an_off_curve_z_commitment_with_a_zero_scalar_is_malformed() {
    let f = block14();
    let signal = public_signal(&f.program_vk, &f.public_values, &f.root_c);

    // [z]_1 is words 6 (x) and 7 (y). Flip the lowest bit of y: the point leaves the curve.
    let mut proof = f.proof_array();
    proof[32 * 7 + 31] ^= 1;
    assert!(!on_curve_or_infinity(&proof[192..256]));
    make_z_coefficient_zero(&mut proof, &signal);
    assert_eq!(z_coefficient(&proof, &signal), [0u8; 32]);
    assert_eq!(expected(&proof), Out::Malformed);
    assert_eq!(check(&f, &proof), Out::Malformed);

    // The same a-bar with [z]_1 left on the curve is well formed, and the proof is refused.
    let mut control = f.proof_array();
    make_z_coefficient_zero(&mut control, &signal);
    assert_eq!(check(&f, &control), Out::Reject);
}

#[test]
fn a_negated_commitment_is_refused() {
    let f = block14();
    for k in 0..9 {
        let mut proof = f.proof_array();
        let y = word(&proof, 2 * k + 1);
        set_word(&mut proof, 2 * k + 1, &neg_y(&y));
        assert_eq!(check(&f, &proof), Out::Reject, "negated point {k}");
    }
}

#[test]
fn a_commitment_at_infinity_is_refused() {
    let f = block14();
    for k in 0..9 {
        let mut proof = f.proof_array();
        proof[64 * k..64 * k + 64].fill(0);
        assert_eq!(check(&f, &proof), Out::Reject, "point {k} at infinity");
    }
}

#[test]
fn a_proof_with_another_blocks_data_is_refused() {
    let blocks: Vec<Fixture> = BLOCKS.iter().map(|&b| load("1.3.1", b)).collect();
    for (i, a) in blocks.iter().enumerate() {
        for (j, b) in blocks.iter().enumerate() {
            if i == j {
                continue;
            }
            let abi: Vec<u8> = [&a.proof, &b.program_vk, &b.root_c, &b.public_values]
                .iter()
                .flat_map(|part| part.iter().copied())
                .collect();
            assert_eq!(
                classify(verify(&vk::ZISK_1_3_1, &abi)),
                Out::Reject,
                "proof of block {} with the data of block {}",
                BLOCKS[i],
                BLOCKS[j]
            );
        }
    }
}

#[test]
fn an_all_zero_proof_is_refused() {
    let f = block14();
    assert_eq!(check(&f, &[0u8; 768]), Out::Reject);
}

/// Every single-bit change of block 14's 768 proof bytes gets the answer the rules give. The
/// totals are exact: 4,608 bits sit in the nine commitments and all of them are malformed (out of
/// range or off the curve); of the 1,536 evaluation bits, 16 push an evaluation to r or above and
/// are malformed, and the other 1,520 are well formed and refused.
#[test]
fn every_single_bit_change_of_the_proof_gets_the_expected_answer() {
    let f = block14();
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
        .min(16);
    let bits: Vec<usize> = (0..768 * 8).collect();
    let chunk = bits.len().div_ceil(threads);
    let (malformed, refused) = std::thread::scope(|s| {
        let handles: Vec<_> = bits
            .chunks(chunk)
            .map(|part| {
                let f = &f;
                s.spawn(move || {
                    let (mut malformed, mut refused) = (0usize, 0usize);
                    for &bit in part {
                        let mut proof = f.proof_array();
                        proof[bit / 8] ^= 1 << (bit % 8);
                        let want = expected(&proof);
                        let got = check(f, &proof);
                        assert_eq!(got, want, "bit {bit}");
                        if got == Out::Malformed {
                            malformed += 1;
                        } else {
                            refused += 1;
                        }
                    }
                    (malformed, refused)
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .fold((0, 0), |a, b| (a.0 + b.0, a.1 + b.1))
    });
    assert_eq!((malformed, refused), (4624, 1520));
}
