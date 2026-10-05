//! Checks the wrapped ZisK proof: a PLONK proof over BN254, in plain Rust.
//!
//! The input is 1,344 bytes: the proof (768), the program key (32), the root of the final
//! circuit (32) and the public values (512). The proof's one public signal is not sent; it is
//! worked out from the other three as `sha256(programVK || publicValues || rootC) mod r`.
//!
//! Each ZisK release has its own verifying key (see [`vk`]), so the caller says which release a
//! proof must come from by choosing the key.
//!
//! Originally written by Rome Protocol.

use field::Fr;
use sha2::{Digest, Sha256};

mod field;
mod g1;
mod verify;
pub mod vk;

pub use vk::VerifyingKey;

/// Length of the input to [`verify`]: proof, programVK, rootC, publicValues.
pub const ABI_LEN: usize = 1344;

/// Why an input is not a proof at all. A well-formed proof that fails the check is not an error;
/// [`verify`] returns `Ok(false)` for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    /// The input is not exactly [`ABI_LEN`] bytes.
    WrongLength,
    /// A number is out of range or a point is not on the curve.
    Malformed,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::WrongLength => write!(f, "the input is not {ABI_LEN} bytes"),
            Error::Malformed => write!(
                f,
                "the proof has a number out of range or a point off the curve"
            ),
        }
    }
}

impl std::error::Error for Error {}

/// Checks a proof under `key`. `Ok(true)` accepts it, `Ok(false)` rejects it, and an error means
/// the input is not a proof.
pub fn verify(key: &VerifyingKey, abi: &[u8]) -> Result<bool, Error> {
    if abi.len() != ABI_LEN {
        return Err(Error::WrongLength);
    }
    let signal = public_signal(&abi[768..800], &abi[832..1344], &abi[800..832]);
    verify::run(key, &abi[..768], &signal)
}

/// The proof's public signal: SHA-256 of `programVK || publicValues || rootC`, reduced mod r, as
/// a 32-byte big-endian number. It hashes what it is given and cannot fail.
pub fn public_signal(program_vk: &[u8], public_values: &[u8], root_c: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(program_vk);
    hasher.update(public_values);
    hasher.update(root_c);
    Fr::reduce_be_bytes(&hasher.finalize().into()).to_be_bytes()
}
