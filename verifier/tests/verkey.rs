// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
//! The key of ZisK 1.4.0 against the verification key it was read from. ZisK 1.4.0 publishes no PLONK key, so `vk::ZISK_1_4_0` holds the numbers of
//! our own key, which `prover/build-plonk-key.sh` builds; its `provingKeySnark/final/final.verkey.json` (SHA-256 `ZISK_PLONK_FINAL_VK_SHA256` in
//! `PINS`) is kept here as `fixtures/zisk-1.4.0/final.verkey.json`: a few numbers, public data, the snarkjs verification key of the circuit.
//! These tests run in every CI run, with no extra file. They check that the file is the pinned one, and that its eight commitments and the numbers
//! the check shares across releases are the ones in `vk`, so that the key the explorer, the sidecar and the prover are pinned to cannot differ from
//! the key `prove-one.sh` and `install.sh` check on the machine that proves. (`tests/solidity.rs` does the same against `PlonkVerifier.sol`, which is
//! a generated GPL-3.0 file that is not kept here, so it runs only when given the file.)

use sha2::{Digest, Sha256};
use zk_verifier::vk;

fn file() -> Vec<u8> {
    std::fs::read(format!(
        "{}/fixtures/zisk-1.4.0/final.verkey.json",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

fn json() -> serde_json::Value {
    serde_json::from_slice(&file()).unwrap()
}

fn pinned(name: &str) -> String {
    let pins = std::fs::read_to_string(format!("{}/../PINS", env!("CARGO_MANIFEST_DIR"))).unwrap();
    let prefix = format!("{name}=");
    pins.lines()
        .find_map(|l| l.strip_prefix(prefix.as_str()))
        .unwrap_or_else(|| panic!("no {name} in PINS"))
        .to_string()
}

/// A decimal string as 32 big-endian bytes, by repeated multiply-and-add on a byte array.
fn decimal(v: &serde_json::Value) -> [u8; 32] {
    let digits = v.as_str().unwrap_or_else(|| panic!("not a string: {v}"));
    assert!(
        !digits.is_empty() && digits.bytes().all(|c| c.is_ascii_digit()),
        "{digits}"
    );
    let mut out = [0u8; 32];
    for d in digits.bytes() {
        let mut carry = (d - b'0') as u32;
        for b in out.iter_mut().rev() {
            let v = *b as u32 * 10 + carry;
            *b = v as u8;
            carry = v >> 8;
        }
        assert_eq!(carry, 0, "{digits} does not fit in 32 bytes");
    }
    out
}

/// A small number as 32 big-endian bytes, so that all 32 bytes of the file's number are compared, not its last one.
fn small(n: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&n.to_be_bytes());
    out
}

/// A G1 point, `[x, y, "1"]`, as x then y.
fn g1(v: &serde_json::Value) -> Vec<u8> {
    let p = v.as_array().unwrap();
    assert_eq!(p.len(), 3, "{v}");
    assert_eq!(p[2], "1", "the point is not affine: {v}");
    [decimal(&p[0]), decimal(&p[1])].concat()
}

#[test]
fn the_file_is_the_pinned_one() {
    let digest: String = Sha256::digest(file())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(digest, pinned("ZISK_PLONK_FINAL_VK_SHA256"));
}

#[test]
fn the_1_4_0_commitments_are_the_eight_of_the_pinned_verification_key() {
    let j = json();
    let want: Vec<u8> = ["Qm", "Ql", "Qr", "Qo", "Qc", "S1", "S2", "S3"]
        .iter()
        .flat_map(|name| g1(&j[*name]))
        .collect();
    assert_eq!(want.len(), 512);
    assert_eq!(&want[..], &vk::ZISK_1_4_0.commitments()[..]);
}

#[test]
fn everything_else_the_check_shares_is_the_same_in_the_pinned_verification_key() {
    let j = json();
    assert_eq!(j["protocol"], "plonk");
    assert_eq!(j["curve"], "bn128");
    assert_eq!(j["nPublic"], 1);
    assert_eq!(j["power"], vk::POWER);
    assert_eq!(decimal(&j["k1"]), small(vk::K1));
    assert_eq!(decimal(&j["k2"]), small(vk::K2));
    assert_eq!(decimal(&j["w"]), vk::OMEGA);
    // [x]_2 as x1 || x0 || y1 || y0 (the file has each coordinate as [x0, x1]).
    let x2 = &j["X_2"];
    assert_eq!(x2[2], serde_json::json!(["1", "0"]));
    let got: Vec<u8> = [&x2[0][1], &x2[0][0], &x2[1][1], &x2[1][0]]
        .iter()
        .flat_map(|n| decimal(n))
        .collect();
    assert_eq!(got, vk::X_G2.to_vec());
}
