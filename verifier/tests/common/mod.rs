// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
//! Shared by the test files: the proof fixtures, and plain big-number arithmetic on 32-byte
//! words. The arithmetic is slow on purpose and shares no code with the crate or with arkworks, so
//! the tests can work out for themselves what a changed proof should give.
#![allow(dead_code)]

use sha3::{Digest, Keccak256};
use zk_verifier::{vk, ABI_LEN};

pub type W = [u8; 32];

pub const P: W = vk::P;
pub const R: W = vk::R;

/// The three test blocks that have a proof for each ZisK release.
pub const BLOCKS: [u32; 3] = [14, 166, 169];

pub struct Fixture {
    pub proof: Vec<u8>,
    pub program_vk: Vec<u8>,
    pub root_c: Vec<u8>,
    pub public_values: Vec<u8>,
    pub json: serde_json::Value,
}

impl Fixture {
    /// The 1,344-byte input: proof, programVK, rootC, publicValues.
    pub fn abi(&self) -> Vec<u8> {
        [
            &self.proof,
            &self.program_vk,
            &self.root_c,
            &self.public_values,
        ]
        .iter()
        .flat_map(|part| part.iter().copied())
        .collect()
    }

    /// The 768 proof bytes as a fixed-size array.
    pub fn proof_array(&self) -> [u8; 768] {
        self.proof.as_slice().try_into().unwrap()
    }
}

pub fn load(release: &str, block: u32) -> Fixture {
    let path = format!(
        "{}/fixtures/zisk-{release}/block{block}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let json: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let field = |name: &str| {
        let text = json[name].as_str().unwrap();
        hex::decode(text.trim_start_matches("0x")).unwrap()
    };
    let fixture = Fixture {
        proof: field("proofBytes"),
        program_vk: field("programVK"),
        root_c: field("rootCVadcopFinal"),
        public_values: field("publicValues"),
        json,
    };
    assert_eq!(
        fixture.abi().len(),
        ABI_LEN,
        "fixture {release}/block{block} has the wrong size"
    );
    fixture
}

// ---- 256-bit arithmetic on big-endian words, used to build changed proofs ----

pub fn add_be(a: &W, b: &W) -> (W, bool) {
    let mut out = [0u8; 32];
    let mut carry = 0u16;
    for i in (0..32).rev() {
        let s = a[i] as u16 + b[i] as u16 + carry;
        out[i] = s as u8;
        carry = s >> 8;
    }
    (out, carry != 0)
}

pub fn sub_be(a: &W, b: &W) -> (W, bool) {
    let mut out = [0u8; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let mut d = a[i] as i16 - b[i] as i16 - borrow;
        if d < 0 {
            d += 256;
            borrow = 1;
        } else {
            borrow = 0;
        }
        out[i] = d as u8;
    }
    (out, borrow != 0)
}

pub fn small(n: u8) -> W {
    let mut w = [0u8; 32];
    w[31] = n;
    w
}

pub fn word(buf: &[u8], i: usize) -> W {
    buf[32 * i..32 * i + 32].try_into().unwrap()
}

pub fn set_word(buf: &mut [u8], i: usize, w: &W) {
    buf[32 * i..32 * i + 32].copy_from_slice(w);
}

/// p - y, for a non-zero y below p: the y coordinate of the negated point.
pub fn neg_y(y: &W) -> W {
    sub_be(&P, y).0
}

// ---- modular arithmetic: four little-endian 64-bit limbs, every operand below the modulus ----
// Both moduli are below 2^254, so the sum of two reduced values never overflows 256 bits.

type Limbs = [u64; 4];

fn to_limbs(w: &W) -> Limbs {
    let mut l = [0u64; 4];
    for (i, limb) in l.iter_mut().enumerate() {
        let at = 24 - 8 * i;
        *limb = u64::from_be_bytes(w[at..at + 8].try_into().unwrap());
    }
    l
}

fn from_limbs(l: &Limbs) -> W {
    let mut w = [0u8; 32];
    for (i, limb) in l.iter().enumerate() {
        let at = 24 - 8 * i;
        w[at..at + 8].copy_from_slice(&limb.to_be_bytes());
    }
    w
}

fn limbs_ge(a: &Limbs, b: &Limbs) -> bool {
    for i in (0..4).rev() {
        if a[i] != b[i] {
            return a[i] > b[i];
        }
    }
    true
}

fn limbs_sub(a: &Limbs, b: &Limbs) -> Limbs {
    let mut out = [0u64; 4];
    let mut borrow = false;
    for i in 0..4 {
        let (d1, b1) = a[i].overflowing_sub(b[i]);
        let (d2, b2) = d1.overflowing_sub(borrow as u64);
        out[i] = d2;
        borrow = b1 || b2;
    }
    out
}

fn limbs_add_mod(a: &Limbs, b: &Limbs, m: &Limbs) -> Limbs {
    let mut out = [0u64; 4];
    let mut carry = false;
    for i in 0..4 {
        let (s1, c1) = a[i].overflowing_add(b[i]);
        let (s2, c2) = s1.overflowing_add(carry as u64);
        out[i] = s2;
        carry = c1 || c2;
    }
    assert!(!carry, "the modulus must be below 2^255");
    if limbs_ge(&out, m) {
        out = limbs_sub(&out, m);
    }
    out
}

/// `a` reduced mod `m` by repeated subtraction (a handful of rounds for these moduli).
pub fn reduce_mod(a: &W, m: &W) -> W {
    let (mut l, ml) = (to_limbs(a), to_limbs(m));
    while limbs_ge(&l, &ml) {
        l = limbs_sub(&l, &ml);
    }
    from_limbs(&l)
}

pub fn add_mod(a: &W, b: &W, m: &W) -> W {
    from_limbs(&limbs_add_mod(&to_limbs(a), &to_limbs(b), &to_limbs(m)))
}

pub fn sub_mod(a: &W, b: &W, m: &W) -> W {
    add_mod(a, &neg_mod(b, m), m)
}

pub fn neg_mod(a: &W, m: &W) -> W {
    if *a == [0u8; 32] {
        *a
    } else {
        sub_be(m, a).0
    }
}

pub fn mul_mod(a: &W, b: &W, m: &W) -> W {
    let (a, b, m) = (to_limbs(a), to_limbs(b), to_limbs(m));
    let mut acc = [0u64; 4];
    for bit in (0..256).rev() {
        acc = limbs_add_mod(&acc, &acc, &m);
        if (b[bit / 64] >> (bit % 64)) & 1 == 1 {
            acc = limbs_add_mod(&acc, &a, &m);
        }
    }
    from_limbs(&acc)
}

/// `base^exp mod m`, with `exp` a 256-bit big-endian number.
pub fn pow_mod(base: &W, exp: &W, m: &W) -> W {
    let mut acc = reduce_mod(&small(1), m);
    for bit in (0..256).rev() {
        acc = mul_mod(&acc, &acc, m);
        if (exp[31 - bit / 8] >> (bit % 8)) & 1 == 1 {
            acc = mul_mod(&acc, base, m);
        }
    }
    acc
}

/// The inverse of a non-zero `a` modulo the prime `m`, by Fermat's little theorem.
pub fn inv_mod(a: &W, m: &W) -> W {
    assert_ne!(*a, [0u8; 32], "zero has no inverse");
    pow_mod(a, &sub_be(m, &small(2)).0, m)
}

/// Is `point` (64 bytes, `x || y`) on the curve y^2 = x^3 + 3 over the base field, or the point at
/// infinity (64 zero bytes)? Both coordinates must already be below p; callers check that first.
pub fn on_curve_or_infinity(point: &[u8]) -> bool {
    assert_eq!(point.len(), 64);
    if point.iter().all(|&b| b == 0) {
        return true;
    }
    let x: W = point[..32].try_into().unwrap();
    let y: W = point[32..].try_into().unwrap();
    let x3 = mul_mod(&mul_mod(&x, &x, &P), &x, &P);
    let rhs = add_mod(&x3, &small(3), &P);
    mul_mod(&y, &y, &P) == rhs
}

// ---- the transcript, and the scalar that multiplies the permutation commitment [z]_1 ----

/// The challenges the verifier draws for a proof and its public signal.
pub struct Challenges {
    pub beta: W,
    pub gamma: W,
    pub alpha: W,
    pub zeta: W,
    pub u: W,
}

fn keccak_mod_r(parts: &[&[u8]]) -> W {
    let mut hasher = Keccak256::new();
    for part in parts {
        hasher.update(part);
    }
    reduce_mod(&hasher.finalize().into(), &R)
}

/// The challenges under the ZisK 1.3.1 key (the key every refusal test uses).
pub fn challenges(proof: &[u8; 768], signal: &W) -> Challenges {
    let beta = keccak_mod_r(&[vk::ZISK_1_3_1.commitments(), signal, &proof[0..192]]);
    let gamma = keccak_mod_r(&[&beta]);
    let alpha = keccak_mod_r(&[&beta, &gamma, &proof[192..256]]);
    let zeta = keccak_mod_r(&[&alpha, &proof[256..448]]);
    let u = keccak_mod_r(&[&proof[448..576]]);
    Challenges {
        beta,
        gamma,
        alpha,
        zeta,
        u,
    }
}

/// zeta^n with n = 2^24: 24 squarings.
fn zeta_n(zeta: &W) -> W {
    let mut zn = *zeta;
    for _ in 0..vk::POWER {
        zn = mul_mod(&zn, &zn, &R);
    }
    zn
}

/// L_1(zeta) = (zeta^n - 1) / (n (zeta - 1)), with n = 2^24.
fn lagrange_1(zeta: &W) -> W {
    let zh = sub_mod(&zeta_n(zeta), &small(1), &R);
    let mut n = [0u8; 32];
    n[28..].copy_from_slice(&(1u32 << vk::POWER).to_be_bytes());
    let denom = mul_mod(&n, &sub_mod(zeta, &small(1), &R), &R);
    mul_mod(&zh, &inv_mod(&denom, &R), &R)
}

/// The scalar of [z]_1 in the linearisation commitment, for the evaluations in `proof` (words 18
/// to 23).
pub fn z_coefficient(proof: &[u8; 768], signal: &W) -> W {
    let c = challenges(proof, signal);
    let (a, b, cc) = (word(proof, 18), word(proof, 19), word(proof, 20));
    let bz = mul_mod(&c.beta, &c.zeta, &R);
    let k = |k: u8| mul_mod(&bz, &small(k), &R);
    let f = |e: &W, kz: &W| add_mod(&add_mod(e, kz, &R), &c.gamma, &R);
    let prod = mul_mod(
        &mul_mod(&f(&a, &bz), &f(&b, &k(vk::K1 as u8)), &R),
        &f(&cc, &k(vk::K2 as u8)),
        &R,
    );
    let alpha2 = mul_mod(&c.alpha, &c.alpha, &R);
    let l1_alpha2 = mul_mod(&lagrange_1(&c.zeta), &alpha2, &R);
    add_mod(
        &add_mod(&mul_mod(&prod, &c.alpha, &R), &l1_alpha2, &R),
        &c.u,
        &R,
    )
}

/// Sets proof word 18 (the evaluation a-bar) so that the scalar of [z]_1 is exactly zero. The
/// challenges do not depend on the evaluations, so the equation is linear in a-bar:
/// (a + beta zeta + gamma) F2 F3 alpha = -(L_1 alpha^2 + u).
pub fn make_z_coefficient_zero(proof: &mut [u8; 768], signal: &W) {
    let c = challenges(proof, signal);
    let (b, cc) = (word(proof, 19), word(proof, 20));
    let bz = mul_mod(&c.beta, &c.zeta, &R);
    let f = |e: &W, mult: u8| {
        let kz = mul_mod(&bz, &small(mult), &R);
        add_mod(&add_mod(e, &kz, &R), &c.gamma, &R)
    };
    let f2f3 = mul_mod(&f(&b, vk::K1 as u8), &f(&cc, vk::K2 as u8), &R);
    let denom = mul_mod(&f2f3, &c.alpha, &R);
    assert_ne!(denom, [0u8; 32], "no solution: alpha F2 F3 is zero");
    let alpha2 = mul_mod(&c.alpha, &c.alpha, &R);
    let rhs = neg_mod(
        &add_mod(&mul_mod(&lagrange_1(&c.zeta), &alpha2, &R), &c.u, &R),
        &R,
    );
    let f1 = mul_mod(&rhs, &inv_mod(&denom, &R), &R);
    let a = sub_mod(&sub_mod(&f1, &bz, &R), &c.gamma, &R);
    set_word(proof, 18, &a);
    assert_eq!(z_coefficient(proof, signal), [0u8; 32]);
}
