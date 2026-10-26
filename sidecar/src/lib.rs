// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
//! The service Canton calls through its external-call extension, one beside each confirming
//! participant. Three functions, each a pure function of its input line (no state, no network, no
//! clock): `verify` and `verify2` check a proven block (`verify2` takes it with length prefixes
//! and a hash), `legs` checks that the Canton legs attached to a block are exactly the ones the
//! block recorded in the gateway contract. The lines and the answers are those of
//! `daml/README.md` (`verify2`: see `sidecar/README.md` until it gains the line).

pub mod block;
pub mod http;
pub mod rlp;
pub mod trie;

use sha2::Sha256;
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

/// The ZisK release a chain's proofs were made with. It picks the verifying key the proof is
/// checked under. A chain that was set up before releases were named is on 1.3.1, so that is the
/// default.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Release {
    #[default]
    V1_3_1,
    V1_3_2,
}

impl Release {
    /// A release by its number: `1.3.1` or `1.3.2`, with or without the `-alpha` that ZisK's own
    /// tags carry.
    pub fn parse(s: &str) -> Option<Release> {
        match s.strip_suffix("-alpha").unwrap_or(s) {
            "1.3.1" => Some(Release::V1_3_1),
            "1.3.2" => Some(Release::V1_3_2),
            _ => None,
        }
    }

    /// The release's number.
    pub fn name(self) -> &'static str {
        match self {
            Release::V1_3_1 => "1.3.1",
            Release::V1_3_2 => "1.3.2",
        }
    }

    /// The verifying key of the release's final circuit.
    pub fn key(self) -> &'static zk_verifier::vk::VerifyingKey {
        match self {
            Release::V1_3_1 => &zk_verifier::vk::ZISK_1_3_1,
            Release::V1_3_2 => &zk_verifier::vk::ZISK_1_3_2,
        }
    }

    /// The release for a byte of the WebAssembly interface (0 is 1.3.1, 1 is 1.3.2).
    pub fn from_code(code: u8) -> Option<Release> {
        match code {
            0 => Some(Release::V1_3_1),
            1 => Some(Release::V1_3_2),
            _ => None,
        }
    }
}

/// A proof check: whether the 1,344 bytes verify.
type ProofCheck = fn(&[u8]) -> Result<bool, zk_verifier::Error>;

/// The most keys one sidecar lists.
pub const MAX_KEYS: usize = 4;

/// One program the sidecar accepts proofs of: its key, the root of the ZisK release's final
/// circuit, and the release. The release picks the PLONK key the proof is checked under; the other
/// two are the pins the proof must carry.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Key {
    /// The key of the program whose proofs are accepted.
    pub program_vk: [u8; 32],
    /// The root of the ZisK release's final circuit.
    pub root_c: [u8; 32],
    /// The ZisK release the proofs are made with.
    pub release: Release,
}

impl Key {
    pub fn new(program_vk: [u8; 32], root_c: [u8; 32], release: Release) -> Key {
        Key {
            program_vk,
            root_c,
            release,
        }
    }

    /// A key from `<programVK>:<rootC>[:<release>]`: 64 lowercase hex digits each (with or without
    /// a `0x`), and a release number; without one the release is 1.3.1.
    pub fn parse(s: &str) -> Result<Key, String> {
        let parts: Vec<&str> = s.split(':').collect();
        if !(2..=3).contains(&parts.len()) {
            return Err(format!("{s:?} is not <programVK>:<rootC>[:<release>]"));
        }
        let hex32 = |v: &str| -> Result<[u8; 32], String> {
            unhex(v.strip_prefix("0x").unwrap_or(v))
                .and_then(|b| b.try_into().ok())
                .ok_or_else(|| format!("{v:?} is not 64 lowercase hex digits"))
        };
        let release = match parts.get(2) {
            None => Release::default(),
            Some(r) => Release::parse(r).ok_or_else(|| {
                format!("{r} is not a ZisK release this sidecar knows (1.3.1 or 1.3.2)")
            })?,
        };
        Ok(Key::new(hex32(parts[0])?, hex32(parts[1])?, release))
    }
}

/// What `verify` pins, and how it checks a proof: a short list of keys. A proof is accepted when
/// it verifies under the PLONK key of one entry's release and carries that entry's own program key
/// and root.
#[derive(Clone)]
pub struct Config {
    /// The keys whose proofs are accepted, at most `MAX_KEYS`, no program key twice.
    pub keys: Vec<Key>,
    /// A replacement for the release's proof check, for this crate's own tests (see
    /// `with_proof_check`). It is private so that no caller can replace it.
    check_override: Option<ProofCheck>,
}

impl Config {
    /// The pins of a chain on ZisK 1.3.1, which is what a chain is on when its release is not named.
    pub fn new(program_vk: [u8; 32], root_c: [u8; 32]) -> Config {
        Config::for_release(program_vk, root_c, Release::V1_3_1)
    }

    /// The pins of a chain whose proofs are made with `release`.
    pub fn for_release(program_vk: [u8; 32], root_c: [u8; 32], release: Release) -> Config {
        Config {
            keys: vec![Key::new(program_vk, root_c, release)],
            check_override: None,
        }
    }

    /// A list of keys. It is refused when empty, longer than `MAX_KEYS`, or when two entries have
    /// the same program key.
    pub fn with_keys(keys: Vec<Key>) -> Result<Config, String> {
        if keys.is_empty() {
            return Err("no key given".to_string());
        }
        if keys.len() > MAX_KEYS {
            return Err(format!("{} keys given, at most {MAX_KEYS}", keys.len()));
        }
        for (i, k) in keys.iter().enumerate() {
            if keys[..i].iter().any(|o| o.program_vk == k.program_vk) {
                return Err(format!(
                    "program key {} is listed twice",
                    hex(&k.program_vk)
                ));
            }
        }
        Ok(Config {
            keys,
            check_override: None,
        })
    }

    fn check(&self, release: Release, abi: &[u8]) -> Result<bool, zk_verifier::Error> {
        match self.check_override {
            Some(f) => f(abi),
            None => zk_verifier::verify(release.key(), abi),
        }
    }

    /// Replaces the proof check, for the tests only (the `test-proof-check` feature). It lets the
    /// tests check the rest of `verify` with a block that has no proof of its own. The feature is
    /// switched on by this crate's own dev-dependency, so the program and any crate that depends
    /// on this one get no way to turn the proof check off unless they enable the feature by name.
    #[cfg(feature = "test-proof-check")]
    pub fn with_proof_check(self, check: ProofCheck) -> Config {
        Config {
            check_override: Some(check),
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

/// Checks the 1,344-byte proof and returns the key it was accepted under and the block hash it
/// commits to. The proof is checked once per release among the keys, and is accepted under the
/// key of a release it verifies under whose program key and root it carries. A proof that
/// verifies but carries no listed key's pins is refused, even if its pins are one entry's program
/// key and another's root.
pub fn proven_block(cfg: &Config, abi: &[u8]) -> Result<(Key, [u8; 32]), &'static str> {
    if abi.len() != zk_verifier::ABI_LEN {
        return Err("the proof is not 1,344 bytes");
    }
    let mut verified = [None; 2];
    let mut other_pins = false;
    for key in &cfg.keys {
        let slot = &mut verified[key.release as usize];
        if !*slot.get_or_insert_with(|| matches!(cfg.check(key.release, abi), Ok(true))) {
            continue;
        }
        if abi[768..800] == key.program_vk && abi[800..832] == key.root_c {
            let hash =
                committed_hash(&abi[832..]).ok_or("the proof does not commit to one block hash")?;
            return Ok((*key, hash));
        }
        other_pins = true;
    }
    Err(if other_pins {
        "the proof was made by another program or ZisK release"
    } else {
        "the proof does not verify"
    })
}

/// Checks the 1,344-byte proof under the pins and returns the block hash it commits to.
pub fn proven_block_hash(cfg: &Config, abi: &[u8]) -> Result<[u8; 32], &'static str> {
    proven_block(cfg, abi).map(|(_, hash)| hash)
}

const MALFORMED: &str = "malformed input";

fn verify_line(cfg: &Config, line: &str) -> Result<String, &'static str> {
    let [proof, header, txs] = line.split(',').collect::<Vec<_>>()[..] else {
        return Err(MALFORMED);
    };
    check_fields(
        cfg,
        unhex(proof).ok_or(MALFORMED)?,
        unhex(header).ok_or(MALFORMED)?,
        unhex(txs).ok_or(MALFORMED)?,
    )
}

/// The proof and block checks, and the answer line, for the three decoded fields.
fn check_fields(
    cfg: &Config,
    proof: Vec<u8>,
    header: Vec<u8>,
    txs: Vec<u8>,
) -> Result<String, &'static str> {
    let (key, hash) = proven_block(cfg, &proof)?;
    let b = block::check(&hash, &header, &txs)?;
    Ok(format!(
        "ok {} {} {} {} {} {} {} {} {} {}",
        hex(&key.program_vk),
        hex(&key.root_c),
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

/// Characters in the hash at the front of a `verify2` line: SHA-256, as lowercase hex.
const HASH_LEN: usize = 64;
/// Decimal digits in a length field of a `verify2` line.
const LENGTH_DIGITS: usize = 10;

/// Takes one length-prefixed field off the front of `rest`: 10 decimal digits, then that many
/// characters. The field must fit in what is left; whole bytes are checked by `unhex`.
fn length_prefixed(rest: &str) -> Result<(&str, &str), &'static str> {
    let digits = rest.get(..LENGTH_DIGITS).ok_or(MALFORMED)?;
    digits
        .bytes()
        .all(|c| c.is_ascii_digit())
        .then_some(())
        .ok_or(MALFORMED)?;
    let n: usize = digits.parse().map_err(|_| MALFORMED)?;
    let rest = &rest[LENGTH_DIGITS..];
    Ok((rest.get(..n).ok_or(MALFORMED)?, &rest[n..]))
}

fn verify2_line(cfg: &Config, line: &str) -> Result<String, &'static str> {
    let (hash, body) = (line.get(..HASH_LEN).ok_or(MALFORMED)?, &line[HASH_LEN..]);
    // The hash is of the text as received (the caller's runtime lowercases it on the way), so a
    // capital letter in a field that was kept as written elsewhere makes the two differ.
    (hex(&Sha256::digest(body.as_bytes())) == hash)
        .then_some(())
        .ok_or(MALFORMED)?;
    let (proof, rest) = length_prefixed(body)?;
    let (header, txs) = length_prefixed(rest)?;
    check_fields(
        cfg,
        unhex(proof).ok_or(MALFORMED)?,
        unhex(header).ok_or(MALFORMED)?,
        unhex(txs).ok_or(MALFORMED)?,
    )
}

/// `verify2`: the line is `H` + `B`, where `B` is `lp(proofHex) lp(headerHex) txsHex`, `lp(f)` is
/// the length of `f` in characters as 10 decimal digits, then `f`, and `H` is the SHA-256 of `B` as
/// 64 lowercase hex digits. The answer is `verify`'s: `ok ...` or `no <reason>`.
pub fn verify2(cfg: &Config, line: &str) -> String {
    verify2_line(cfg, line).unwrap_or_else(|reason| format!("no {reason}"))
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
