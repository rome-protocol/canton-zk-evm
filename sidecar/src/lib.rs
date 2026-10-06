// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
//! The service Canton calls through its external-call extension, one beside each confirming
//! participant. Two functions, each a pure function of its input line (no state, no network, no
//! clock): `verify` checks a proven block, `legs` checks that the Canton legs attached to a block are
//! exactly the ones the block recorded in the gateway contract. The lines and the answers are those
//! of `daml/README.md`.

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

/// The legs hash the gateway contract keeps for block `number`, in the state `state_root`, from the
/// two proofs; zero when the proofs show there is none.
fn recorded_in(
    state_root: &[u8; 32],
    gateway: &[u8; 20],
    number: u64,
    account_nodes: &[Vec<u8>],
    storage_nodes: &[Vec<u8>],
) -> Result<[u8; 32], &'static str> {
    let account = zk_mpt::verify_account(state_root, gateway, account_nodes)
        .map_err(|_| "the account proof does not verify")?;
    if storage_nodes.is_empty() && account.storage_root == keccak(&[0x80]) {
        // Nothing is stored in the account at all, which the account proof shows.
        return Ok([0; 32]);
    }
    // Where a Solidity mapping at slot 0 keeps the entry of `number`: keccak256(number . 0), both as 32 bytes.
    let mut slot = [0u8; 64];
    slot[24..32].copy_from_slice(&number.to_be_bytes());
    match zk_mpt::verify_storage(&account.storage_root, &keccak(&slot), storage_nodes)
        .map_err(|_| "the storage proof does not verify")?
    {
        zk_mpt::StorageValue::Present(v) => Ok(v),
        zk_mpt::StorageValue::Absent => Ok([0; 32]),
    }
}

/// A Canton amount as Daml writes a `Decimal` (digits, a point, one to ten digits) in base units, as
/// the 32-byte word the gateway hashes: the amount times 10^10. Nothing is ever rounded. Daml's
/// numbers have 28 digits before the point and 10 after, so every one of them fits in 128 bits.
fn canton_amount(text: &str) -> Result<[u8; 32], &'static str> {
    let (whole, fraction) = text.split_once('.').ok_or(MALFORMED)?;
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit());
    (digits(whole) && digits(fraction) && fraction.len() <= 10)
        .then_some(())
        .ok_or(MALFORMED)?;
    let whole: u128 = whole.parse().map_err(|_| MALFORMED)?;
    let fraction: u128 = format!("{fraction:0<10}").parse().map_err(|_| MALFORMED)?;
    let units = whole
        .checked_mul(10_000_000_000)
        .and_then(|w| w.checked_add(fraction))
        .ok_or(MALFORMED)?;
    let mut word = [0u8; 32];
    word[16..].copy_from_slice(&units.to_be_bytes());
    Ok(word)
}

/// One attached leg, `kind/id/token/account/amount/party`, folded into the running hash the way the
/// gateway contract does: the Keccak-256 of seven 32-byte words.
fn add_leg(running: [u8; 32], leg: &str) -> Result<[u8; 32], &'static str> {
    let [kind, id, token, account, amount, party] = leg.split('/').collect::<Vec<_>>()[..] else {
        return Err(MALFORMED);
    };
    let kind_number: u8 = match kind {
        "deposit" => 1,
        "withdrawal" => 2,
        "payment" => 3,
        _ => return Err(MALFORMED),
    };
    let (id, token, account): ([u8; 32], [u8; 20], [u8; 20]) =
        (fixed(id)?, fixed(token)?, fixed(account)?);
    // A payment's amount is the ERC-20 amount, as it is; the other two are Canton amounts.
    let amount: [u8; 32] = if kind_number == 3 {
        fixed(amount)?
    } else {
        canton_amount(amount)?
    };
    // Only a withdrawal names a party: the hex of the receiver's party id.
    let party = unhex(party).ok_or(MALFORMED)?;
    if kind_number != 2 && !party.is_empty() {
        return Err(MALFORMED);
    }
    let mut preimage = Vec::with_capacity(7 * 32);
    preimage.extend_from_slice(&running);
    preimage.extend_from_slice(&[0u8; 31]);
    preimage.push(kind_number);
    preimage.extend_from_slice(&id);
    preimage.extend_from_slice(&[0u8; 12]);
    preimage.extend_from_slice(&token);
    preimage.extend_from_slice(&[0u8; 12]);
    preimage.extend_from_slice(&account);
    preimage.extend_from_slice(&amount);
    preimage.extend_from_slice(&keccak(&party));
    Ok(keccak(&preimage))
}

fn legs_line(line: &str) -> Result<String, &'static str> {
    let [root, number, gateway, account_nodes, storage_nodes, attached] =
        line.split(',').collect::<Vec<_>>()[..]
    else {
        return Err(MALFORMED);
    };
    let (state_root, gateway_address): ([u8; 32], [u8; 20]) = (fixed(root)?, fixed(gateway)?);
    let number: u64 = number
        .bytes()
        .all(|c| c.is_ascii_digit())
        .then(|| number.parse().ok())
        .flatten()
        .ok_or(MALFORMED)?;
    let (account_nodes, storage_nodes) = (nodes(account_nodes)?, nodes(storage_nodes)?);
    let attached: Vec<&str> = if attached.is_empty() {
        vec![]
    } else {
        attached.split('|').collect()
    };
    let hash = attached
        .iter()
        .try_fold([0u8; 32], |h, leg| add_leg(h, leg))?;

    let recorded = recorded_in(
        &state_root,
        &gateway_address,
        number,
        &account_nodes,
        &storage_nodes,
    )?;
    if hash != recorded {
        return Err("the legs are not the ones the block recorded");
    }
    Ok(format!("ok {root} {number} {gateway} {}", attached.len()))
}

/// `legs`: the line is `stateRoot,number,gateway,accountNodes,storageNodes,legs`. `stateRoot` is the
/// proven block's, `number` its number in decimal, `gateway` the gateway contract's address. The two
/// node lists are `eth_getProof`'s account proof of the gateway and its storage proof of the entry
/// for `number` (the second may be empty). `legs` is empty, or the attached legs joined by `|`, each
/// `kind/id/token/account/amount/party`. The answer is `ok stateRoot number gateway count` when the
/// legs, hashed as the gateway hashes them, are exactly the value the block recorded, or
/// `no <reason>`.
pub fn legs(line: &str) -> String {
    legs_line(line).unwrap_or_else(|reason| format!("no {reason}"))
}
