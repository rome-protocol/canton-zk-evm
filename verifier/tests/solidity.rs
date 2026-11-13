// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
//! The key of ZisK 1.4.0 against the `PlonkVerifier.sol` it was read from. ZisK 1.4.0 publishes no PLONK key, so `vk::ZISK_1_4_0` holds the
//! numbers of the verifier that `prover/build-plonk-key.sh` generates (`provingKeySnark/final/PlonkVerifier.sol`, pinned by
//! `ZISK_PLONK_VERIFIER_SHA256` in `PINS`). That file is a generated GPL-3.0 file and is not kept in this repository, so this test runs only
//! when it is given the file: `ZK_PLONK_VERIFIER_SOL=<path> cargo test --locked --test solidity -- --ignored`. It checks the eight commitments
//! and every other number the check shares across releases (the domain, the coset shifts, the two G2 points), and the file's SHA-256 against
//! `PINS`.

use sha2::{Digest, Sha256};
use zk_verifier::vk;

fn sol() -> String {
    let path = std::env::var("ZK_PLONK_VERIFIER_SOL")
        .expect("set ZK_PLONK_VERIFIER_SOL to the PlonkVerifier.sol of the key");
    std::fs::read_to_string(path).unwrap()
}

/// The value of `uint256 constant <name> = <decimal>;` (any integer width) as 32 big-endian bytes.
fn constant(text: &str, name: &str) -> [u8; 32] {
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| {
            l.strip_prefix("uint")
                .and_then(|r| r.split_once(" constant "))
                .and_then(|(_, r)| r.split_whitespace().next())
                == Some(name)
        })
        .unwrap_or_else(|| panic!("no constant {name}"));
    let digits = line
        .split('=')
        .nth(1)
        .unwrap()
        .trim()
        .trim_end_matches(';')
        .trim();
    assert!(
        !digits.is_empty() && digits.bytes().all(|c| c.is_ascii_digit()),
        "{name}: {digits}"
    );
    // Decimal to big-endian bytes, by repeated multiply-and-add on a byte array.
    let mut out = [0u8; 32];
    for d in digits.bytes() {
        let mut carry = (d - b'0') as u32;
        for b in out.iter_mut().rev() {
            let v = *b as u32 * 10 + carry;
            *b = v as u8;
            carry = v >> 8;
        }
        assert_eq!(carry, 0, "{name} does not fit in 32 bytes");
    }
    out
}

fn small(n: u8) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[31] = n;
    w
}

fn pinned(name: &str) -> String {
    let pins = std::fs::read_to_string(format!("{}/../PINS", env!("CARGO_MANIFEST_DIR"))).unwrap();
    let prefix = format!("{name}=");
    pins.lines()
        .find_map(|l| l.strip_prefix(prefix.as_str()))
        .unwrap_or_else(|| panic!("no {name} in PINS"))
        .to_string()
}

#[test]
#[ignore = "needs ZK_PLONK_VERIFIER_SOL, the PlonkVerifier.sol that prover/build-plonk-key.sh generates"]
fn the_file_is_the_pinned_one() {
    let path = std::env::var("ZK_PLONK_VERIFIER_SOL").unwrap();
    let digest = Sha256::digest(std::fs::read(path).unwrap());
    let digest: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(digest, pinned("ZISK_PLONK_VERIFIER_SHA256"));
}

#[test]
#[ignore = "needs ZK_PLONK_VERIFIER_SOL, the PlonkVerifier.sol that prover/build-plonk-key.sh generates"]
fn the_1_4_0_commitments_are_the_eight_of_our_plonk_verifier() {
    let text = sol();
    let mut want = Vec::with_capacity(512);
    for name in ["Qm", "Ql", "Qr", "Qo", "Qc", "S1", "S2", "S3"] {
        want.extend_from_slice(&constant(&text, &format!("{name}x")));
        want.extend_from_slice(&constant(&text, &format!("{name}y")));
    }
    assert_eq!(&want[..], &vk::ZISK_1_4_0.commitments()[..]);
}

#[test]
#[ignore = "needs ZK_PLONK_VERIFIER_SOL, the PlonkVerifier.sol that prover/build-plonk-key.sh generates"]
fn everything_else_the_check_shares_is_the_same_in_our_plonk_verifier() {
    let text = sol();
    // The domain: n = 2^24 and its generator, with one public signal.
    assert_eq!(constant(&text, "n"), {
        let mut w = [0u8; 32];
        w[28..].copy_from_slice(&(1u32 << vk::POWER).to_be_bytes());
        w
    });
    assert_eq!(constant(&text, "nPublic"), small(1));
    assert_eq!(constant(&text, "w1"), vk::OMEGA);
    assert_eq!(constant(&text, "k1"), small(vk::K1 as u8));
    assert_eq!(constant(&text, "k2"), small(vk::K2 as u8));
    // The fields.
    assert_eq!(constant(&text, "q"), vk::R);
    assert_eq!(constant(&text, "qf"), vk::P);
    // The generator of G1 and the two G2 points: [1]_2 and [x]_2 of the powers of tau.
    assert_eq!(constant(&text, "G1x"), small(1));
    assert_eq!(constant(&text, "G1y"), small(2));
    let g2 =
        |names: [&str; 4]| -> Vec<u8> { names.iter().flat_map(|n| constant(&text, n)).collect() };
    assert_eq!(g2(["G2x2", "G2x1", "G2y2", "G2y1"]), vk::ONE_G2.to_vec());
    assert_eq!(g2(["X2x2", "X2x1", "X2y2", "X2y1"]), vk::X_G2.to_vec());
}
