// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
//! G1 points as 64-byte big-endian `x || y` strings, and the three curve operations the check needs
//! (add, multiply, pairing), done with arkworks. The all-zero string is the point at infinity.

use crate::field::{geq, limbs_from_be, limbs_to_be, sub_raw, Limbs};
use crate::Error;
use ark_bn254::{Bn254, Fq, Fq2, Fr, G1Affine, G1Projective, G2Affine};
use ark_ec::{pairing::Pairing, AffineRepr, CurveGroup};
use ark_ff::{BigInteger, PrimeField, Zero};

pub type G1 = [u8; 64];

const P: Limbs = limbs_from_be(&crate::vk::P);

/// Both coordinates are below p. Checked here because arkworks would reduce a larger value
/// instead of refusing it.
pub fn coordinates_in_range(p: &G1) -> bool {
    let (xb, yb) = p.split_at(32);
    let (Ok(xb), Ok(yb)) = (<&[u8; 32]>::try_from(xb), <&[u8; 32]>::try_from(yb)) else {
        return false;
    };
    !geq(&limbs_from_be(xb), &P) && !geq(&limbs_from_be(yb), &P)
}

/// -P, for a point whose coordinates are below p: y becomes p - y (0 stays 0).
pub fn neg(p: &G1) -> Result<G1, Error> {
    let mut out = *p;
    let y = <&[u8; 32]>::try_from(&p[32..]).map_err(|_| Error::Malformed)?;
    let y = limbs_from_be(y);
    if geq(&y, &P) {
        return Err(Error::Malformed);
    }
    let ny = if y == [0; 4] { y } else { sub_raw(&P, &y) };
    out[32..].copy_from_slice(&limbs_to_be(&ny));
    Ok(out)
}

fn fq(bytes: &[u8]) -> Result<Fq, Error> {
    let bytes = <&[u8; 32]>::try_from(bytes).map_err(|_| Error::Malformed)?;
    if geq(&limbs_from_be(bytes), &P) {
        return Err(Error::Malformed);
    }
    Ok(Fq::from_be_bytes_mod_order(bytes))
}

/// Reads a point and checks it is on the curve. BN254's G1 has no other subgroup, so that is
/// all a G1 point needs.
fn read(bytes: &[u8]) -> Result<G1Affine, Error> {
    let (x, y) = (fq(&bytes[..32])?, fq(&bytes[32..64])?);
    if x.is_zero() && y.is_zero() {
        return Ok(G1Affine::zero());
    }
    let point = G1Affine::new_unchecked(x, y);
    if point.is_on_curve() {
        Ok(point)
    } else {
        Err(Error::Malformed)
    }
}

fn write(point: G1Projective) -> G1 {
    let mut out = [0u8; 64];
    if let Some((x, y)) = point.into_affine().xy() {
        out[..32].copy_from_slice(&x.into_bigint().to_bytes_be());
        out[32..].copy_from_slice(&y.into_bigint().to_bytes_be());
    }
    out
}

pub fn add(a: &G1, b: &G1) -> Result<G1, Error> {
    Ok(write(read(a)?.into_group() + read(b)?))
}

pub fn mul(p: &G1, scalar: &[u8; 32]) -> Result<G1, Error> {
    Ok(write(read(p)? * Fr::from_be_bytes_mod_order(scalar)))
}

/// A G2 point in the 128-byte encoding `x1 || x0 || y1 || y0` (imaginary part first), where
/// x = x0 + x1 * u. Checked for the curve and for the right subgroup.
fn read_g2(bytes: &[u8]) -> Result<G2Affine, Error> {
    let x = Fq2::new(fq(&bytes[32..64])?, fq(&bytes[..32])?);
    let y = Fq2::new(fq(&bytes[96..128])?, fq(&bytes[64..96])?);
    let point = G2Affine::new_unchecked(x, y);
    if point.is_on_curve() && point.is_in_correct_subgroup_assuming_on_curve() {
        Ok(point)
    } else {
        Err(Error::Malformed)
    }
}

/// The pairing check: true when the product of the pairings in `input` (two pairs of a 64-byte G1
/// point and a 128-byte G2 point, 384 bytes) is 1.
pub fn pairing_is_one(input: &[u8; 384]) -> Result<bool, Error> {
    let (g1s, g2s): (Vec<_>, Vec<_>) = input
        .chunks(192)
        .map(|pair| Ok((read(&pair[..64])?, read_g2(&pair[64..])?)))
        .collect::<Result<Vec<_>, Error>>()?
        .into_iter()
        .unzip();
    Ok(Bn254::multi_pairing(g1s, g2s).is_zero())
}
