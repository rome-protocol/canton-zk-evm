//! The service Canton calls through its external-call extension, one beside each confirming
//! participant. Two functions, each a pure function of its input line (no state, no network, no
//! clock): `verify` checks a proven block, `fact` checks how far a balance rose in it. The lines and the
//! answers are those of `daml/README.md`.
//!
//! Originally written by Rome Protocol.

pub mod block;
pub mod http;
pub mod rlp;
pub mod trie;

use sha3::{Digest, Keccak256};

pub(crate) fn keccak(b: &[u8]) -> [u8; 32] {
    Keccak256::digest(b).into()
}

/// Lowercase hex to bytes; `None` for anything else (an odd length, a capital letter).
pub fn unhex(s: &str) -> Option<Vec<u8>> {
    let digit = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        _ => None,
    };
    let s = s.as_bytes();
    s.len().is_multiple_of(2).then_some(())?;
    s.chunks(2)
        .map(|p| Some(digit(p[0])? << 4 | digit(p[1])?))
        .collect()
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// What `verify` pins, and how it checks a proof.
#[derive(Clone)]
pub struct Config {
    /// The key of the program whose proofs are accepted.
    pub program_vk: [u8; 32],
    /// The root of the ZisK release's final circuit.
    pub root_c: [u8; 32],
    /// The proof check: always ZisK 1.3.1's, except in this crate's own tests (see
    /// `with_proof_check`). It is private so that no caller can replace it.
    check_proof: fn(&[u8]) -> Result<bool, zk_verifier::Error>,
}

impl Config {
    pub fn new(program_vk: [u8; 32], root_c: [u8; 32]) -> Config {
        Config {
            program_vk,
            root_c,
            check_proof: |abi| zk_verifier::verify(&zk_verifier::vk::ZISK_1_3_1, abi),
        }
    }

    /// Replaces the proof check, for the tests only (the `test-proof-check` feature). It lets the
    /// tests check the rest of `verify` with a block that has no proof of its own. The feature is
    /// switched on by this crate's own dev-dependency, so the program and any crate that depends
    /// on this one get no way to turn the proof check off unless they enable the feature by name.
    #[cfg(feature = "test-proof-check")]
    pub fn with_proof_check(self, check: fn(&[u8]) -> Result<bool, zk_verifier::Error>) -> Config {
        Config {
            check_proof: check,
            ..self
        }
    }
}

/// The block hash a proof's public values commit to, if they have the one valid layout: 64 slots
/// of 8 bytes, each a 4-byte word and 4 zero bytes, the words together being 0x20, the 32-byte
/// hash, and zeros.
fn committed_hash(public_values: &[u8]) -> Option<[u8; 32]> {
    let mut words = Vec::with_capacity(256);
    for slot in public_values.chunks(8) {
        (slot[4..] == [0; 4]).then_some(())?;
        words.extend_from_slice(&slot[..4]);
    }
    (words.len() == 256 && words[0] == 0x20 && words[33..].iter().all(|&x| x == 0))
        .then(|| words[1..33].try_into().unwrap())
}

/// Checks the 1,344-byte proof under the pins and returns the block hash it commits to.
pub fn proven_block_hash(cfg: &Config, abi: &[u8]) -> Result<[u8; 32], &'static str> {
    if abi.len() != zk_verifier::ABI_LEN {
        return Err("the proof is not 1,344 bytes");
    }
    if !matches!((cfg.check_proof)(abi), Ok(true)) {
        return Err("the proof does not verify");
    }
    if abi[768..800] != cfg.program_vk || abi[800..832] != cfg.root_c {
        return Err("the proof was made by another program or ZisK release");
    }
    committed_hash(&abi[832..]).ok_or("the proof does not commit to one block hash")
}

const MALFORMED: &str = "malformed input";

fn verify_line(cfg: &Config, line: &str) -> Result<String, &'static str> {
    let [proof, header, txs] = line.split(',').collect::<Vec<_>>()[..] else {
        return Err(MALFORMED);
    };
    let (proof, header, txs) = (
        unhex(proof).ok_or(MALFORMED)?,
        unhex(header).ok_or(MALFORMED)?,
        unhex(txs).ok_or(MALFORMED)?,
    );
    let hash = proven_block_hash(cfg, &proof)?;
    let b = block::check(&hash, &header, &txs)?;
    Ok(format!(
        "ok {} {} {} {} {} {} {} {} {} {}",
        hex(&cfg.program_vk),
        hex(&cfg.root_c),
        hex(&hash),
        hex(&b.parent),
        b.number,
        hex(&b.state_root),
        b.timestamp,
        b.gas_limit,
        b.gas_used,
        b.tx_count
    ))
}

/// `verify`: the line is `proofHex,headerHex,txsHex`; the answer is `ok ...` or `no <reason>`.
pub fn verify(cfg: &Config, line: &str) -> String {
    verify_line(cfg, line).unwrap_or_else(|reason| format!("no {reason}"))
}

/// `n` bytes of lowercase hex, as an array.
fn fixed<const N: usize>(s: &str) -> Result<[u8; N], &'static str> {
    unhex(s).and_then(|b| b.try_into().ok()).ok_or(MALFORMED)
}

/// The nodes of a proof: hex nodes joined by `;`, or nothing.
fn nodes(s: &str) -> Result<Vec<Vec<u8>>, &'static str> {
    if s.is_empty() {
        return Ok(vec![]);
    }
    s.split(';')
        .map(|n| unhex(n).filter(|b| !b.is_empty()).ok_or(MALFORMED))
        .collect()
}

/// The holder's balance in the state `state_root`, from the two proofs; zero when the proofs show
/// there is none.
fn balance_in(
    state_root: &[u8; 32],
    token: &[u8; 20],
    holder: &[u8; 20],
    slot: u64,
    account_nodes: &[Vec<u8>],
    storage_nodes: &[Vec<u8>],
) -> Result<[u8; 32], &'static str> {
    let account = zk_mpt::verify_account(state_root, token, account_nodes)
        .map_err(|_| "the account proof does not verify")?;
    // Where a Solidity mapping keeps the entry of `holder`: keccak256(holder . slot), both as 32 bytes.
    let mut preimage = [0u8; 64];
    preimage[12..32].copy_from_slice(holder);
    preimage[56..].copy_from_slice(&slot.to_be_bytes());
    if storage_nodes.is_empty() && account.storage_root == keccak(&[0x80]) {
        // Nothing is stored in the account at all, which the account proof shows.
        return Ok([0; 32]);
    }
    match zk_mpt::verify_storage(&account.storage_root, &keccak(&preimage), storage_nodes)
        .map_err(|_| "the storage proof does not verify")?
    {
        zk_mpt::StorageValue::Present(v) => Ok(v),
        zk_mpt::StorageValue::Absent => Ok([0; 32]),
    }
}

/// `after - before` as 256-bit numbers; `None` if `after` is the smaller.
fn rise(before: &[u8; 32], after: &[u8; 32]) -> Option<[u8; 32]> {
    let mut out = [0u8; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let d = after[i] as i16 - before[i] as i16 - borrow;
        out[i] = d.rem_euclid(256) as u8;
        borrow = (d < 0) as i16;
    }
    (borrow == 0).then_some(out)
}

fn fact_line(line: &str) -> Result<String, &'static str> {
    let [root, parent_root, token, holder, slot, account_nodes, storage_nodes, parent_account_nodes, parent_storage_nodes] =
        line.split(',').collect::<Vec<_>>()[..]
    else {
        return Err(MALFORMED);
    };
    let (state_root, parent_state_root, token_address, holder_address): (
        [u8; 32],
        [u8; 32],
        [u8; 20],
        [u8; 20],
    ) = (
        fixed(root)?,
        fixed(parent_root)?,
        fixed(token)?,
        fixed(holder)?,
    );
    let slot: u64 = slot
        .bytes()
        .all(|c| c.is_ascii_digit())
        .then(|| slot.parse().ok())
        .flatten()
        .ok_or(MALFORMED)?;
    let (account_nodes, storage_nodes) = (nodes(account_nodes)?, nodes(storage_nodes)?);
    let (parent_account_nodes, parent_storage_nodes) =
        (nodes(parent_account_nodes)?, nodes(parent_storage_nodes)?);

    let after = balance_in(
        &state_root,
        &token_address,
        &holder_address,
        slot,
        &account_nodes,
        &storage_nodes,
    )?;
    let before = balance_in(
        &parent_state_root,
        &token_address,
        &holder_address,
        slot,
        &parent_account_nodes,
        &parent_storage_nodes,
    )?;
    let rise = rise(&before, &after).ok_or("the balance fell")?;
    Ok(format!(
        "ok {root} {parent_root} {token} {holder} {slot} {}",
        hex(&rise)
    ))
}

/// `fact`: the line is
/// `stateRoot,parentStateRoot,token,holder,slot,accountNodes,storageNodes,parentAccountNodes,parentStorageNodes`:
/// the balance proofs at the block's state root and at its parent's. The answer is
/// `ok stateRoot parentStateRoot token holder slot rise`, where `rise` is the balance at the block's
/// root minus the balance at the parent's, as 64 hex digits (all zeros for no change), or
/// `no <reason>`, among them `no the balance fell`.
pub fn fact(line: &str) -> String {
    fact_line(line).unwrap_or_else(|reason| format!("no {reason}"))
}
