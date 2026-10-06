// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
//! Shared by the test files: the stored test data, and small helpers.
//!
//! The stored data in `tests/fixtures/` came from this project's own reth (see
//! `capture_fixtures.sh`). CI also takes a fresh copy and runs every test against it: set
//! `SIDECAR_FIXTURES` to the folder.
#![allow(dead_code)]

use serde_json::Value;
use sha3::{Digest, Keccak256};
use zk_sidecar::{rlp, Config};

pub fn keccak(b: &[u8]) -> [u8; 32] {
    Keccak256::digest(b).into()
}

pub fn unhex(s: &str) -> Vec<u8> {
    assert!(s.len().is_multiple_of(2), "odd hex");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn arr32(s: &str) -> [u8; 32] {
    unhex(s).try_into().unwrap()
}

fn read_json(path: String) -> Value {
    serde_json::from_slice(&std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e}"))).unwrap()
}

fn fixtures(name: &str) -> Value {
    let dir = std::env::var("SIDECAR_FIXTURES")
        .unwrap_or_else(|_| format!("{}/tests/fixtures", env!("CARGO_MANIFEST_DIR")));
    read_json(format!("{dir}/{name}.json"))
}

/// Block 1 of a throwaway copy of the chain, as reth reported it.
pub struct RethBlock {
    pub hash: [u8; 32],
    pub parent: [u8; 32],
    pub state_root: [u8; 32],
    pub number: u64,
    pub timestamp: u64,
    pub gas_limit: u64,
    pub gas_used: u64,
    pub tx_count: usize,
    pub header: Vec<u8>,
    pub txs: Vec<u8>,
}

pub fn reth_block() -> RethBlock {
    let j = fixtures("block");
    let text = |k: &str| j[k].as_str().unwrap().to_string();
    let num = |k: &str| j[k].as_u64().unwrap();
    RethBlock {
        hash: arr32(&text("hash")),
        parent: arr32(&text("parentHash")),
        state_root: arr32(&text("stateRoot")),
        number: num("number"),
        timestamp: num("timestamp"),
        gas_limit: num("gasLimit"),
        gas_used: num("gasUsed"),
        tx_count: num("txCount") as usize,
        header: unhex(&text("header")),
        txs: unhex(&text("txs")),
    }
}

/// One leg a block recorded, in the form the sidecar's `legs` reads: `kind/id/token/account/amount/party`.
#[derive(Clone)]
pub struct Leg {
    pub kind: String,
    pub id: String,
    pub token: String,
    pub account: String,
    pub amount: String,
    pub party: String,
}

impl Leg {
    pub fn text(&self) -> String {
        [
            &self.kind,
            &self.id,
            &self.token,
            &self.account,
            &self.amount,
            &self.party,
        ]
        .map(String::as_str)
        .join("/")
    }
}

/// The gateway's proofs for one block, and the legs the block recorded.
#[derive(Clone)]
pub struct GatewayBlock {
    pub number: u64,
    pub state_root: String,
    pub gateway: String,
    /// What the gateway stores for the block, as 64 hex digits (zeros when it recorded no legs).
    pub value: String,
    pub account_nodes: Vec<String>,
    pub storage_nodes: Vec<String>,
    pub legs: Vec<Leg>,
}

impl GatewayBlock {
    /// The `legs` input line with the legs this block recorded.
    pub fn line(&self) -> String {
        self.line_with(&self.legs)
    }

    /// The `legs` input line with other legs attached.
    pub fn line_with(&self, legs: &[Leg]) -> String {
        self.line_of(&legs.iter().map(Leg::text).collect::<Vec<_>>().join("|"))
    }

    /// The `legs` input line with this text as its last field.
    pub fn line_of(&self, legs: &str) -> String {
        format!(
            "{},{},{},{},{},{}",
            self.state_root,
            self.number,
            self.gateway,
            self.account_nodes.join(";"),
            self.storage_nodes.join(";"),
            legs
        )
    }

    /// The answer when all is well.
    pub fn ok(&self) -> String {
        format!(
            "ok {} {} {} {}",
            self.state_root,
            self.number,
            self.gateway,
            self.legs.len()
        )
    }
}

/// The blocks of `tests/fixtures/legs.json`, taken from this project's reth with the gateway in its
/// genesis: `unused` (block 1: the gateway has nothing stored), `registered` (a token is registered,
/// no leg, but the gateway has storage), `deposit` (one deposit) and `three` (a deposit, a withdrawal
/// and a payment).
pub fn gateway_block(which: &str) -> GatewayBlock {
    let j = fixtures("legs");
    let b = &j["blocks"][which];
    assert!(b.is_object(), "no block {which} in legs.json");
    let text = |v: &Value| v.as_str().unwrap().to_string();
    let list = |k: &str| -> Vec<String> { b[k].as_array().unwrap().iter().map(text).collect() };
    GatewayBlock {
        number: b["number"].as_u64().unwrap(),
        state_root: text(&b["stateRoot"]),
        gateway: text(&j["gateway"]),
        value: text(&b["value"]),
        account_nodes: list("accountNodes"),
        storage_nodes: list("storageNodes"),
        legs: b["legs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| Leg {
                kind: text(&l["kind"]),
                id: text(&l["id"]),
                token: text(&l["token"]),
                account: text(&l["account"]),
                amount: text(&l["amount"]),
                party: text(&l["party"]),
            })
            .collect(),
    }
}

/// A 32-byte word from a number.
pub fn word(v: u128) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[16..].copy_from_slice(&v.to_be_bytes());
    w
}

/// The running hash of a block's legs as the gateway contract makes it, written out here on its own
/// (the test's own copy, not the sidecar's): each step is the Keccak-256 of seven 32-byte words, the
/// previous value, kind, id, token, account, amount and the Keccak-256 of the party's bytes. The
/// amounts are in base units, one 32-byte word for each leg.
pub fn leg_hash(legs: &[Leg], amounts: &[[u8; 32]]) -> [u8; 32] {
    assert_eq!(legs.len(), amounts.len());
    let mut h = [0u8; 32];
    for (l, amount) in legs.iter().zip(amounts) {
        let kind = match l.kind.as_str() {
            "deposit" => 1,
            "withdrawal" => 2,
            "payment" => 3,
            other => panic!("kind {other}"),
        };
        let mut preimage = Vec::new();
        preimage.extend_from_slice(&h);
        preimage.extend_from_slice(&word(kind));
        preimage.extend_from_slice(&unhex(&l.id));
        preimage.extend_from_slice(&[&[0u8; 12][..], &unhex(&l.token)].concat());
        preimage.extend_from_slice(&[&[0u8; 12][..], &unhex(&l.account)].concat());
        preimage.extend_from_slice(amount);
        preimage.extend_from_slice(&keccak(&unhex(&l.party)));
        h = keccak(&preimage);
    }
    h
}

/// A one-account state written out by hand: the gateway's account, and in it the record of block
/// `number` with this value (`None`: nothing is stored in the account at all). Built with the
/// crate's own RLP writer, so the tests can choose the legs and hash them themselves.
pub fn hand_built(
    gateway: &str,
    number: u64,
    value: Option<[u8; 32]>,
    legs: Vec<Leg>,
) -> GatewayBlock {
    let storage_nodes = value.map(|v| {
        // Where a Solidity mapping at slot 0 keeps the entry of `number`: keccak256(number . 0).
        let slot = keccak(&[word(number as u128), word(0)].concat());
        let trimmed: Vec<u8> = v.iter().copied().skip_while(|&b| b == 0).collect();
        // The storage trie's key is the hash of the slot.
        let path = [vec![0x20], keccak(&slot).to_vec()].concat();
        rlp::list_of(&[rlp::string(&path), rlp::string(&rlp::string(&trimmed))].concat())
    });
    let storage_root = keccak(storage_nodes.as_deref().unwrap_or(&[0x80]));
    let account = rlp::list_of(
        &[
            rlp::string(&[1]),
            rlp::string(&[]),
            rlp::string(&storage_root),
            rlp::string(&keccak(&[])),
        ]
        .concat(),
    );
    let path = [vec![0x20], keccak(&unhex(gateway)).to_vec()].concat();
    let leaf = rlp::list_of(&[rlp::string(&path), rlp::string(&account)].concat());
    GatewayBlock {
        number,
        state_root: hex(&keccak(&leaf)),
        gateway: gateway.to_string(),
        value: hex(&value.unwrap_or([0; 32])),
        account_nodes: vec![hex(&leaf)],
        storage_nodes: storage_nodes.iter().map(|n| hex(n)).collect(),
        legs,
    }
}

/// The recorded proof of the one-transfer block, its program key and its root, and the block hash
/// the session recorded for it.
pub struct Session {
    pub abi: Vec<u8>,
    pub program_vk: [u8; 32],
    pub root_c: [u8; 32],
    pub block_hash: [u8; 32],
}

pub fn session() -> Session {
    let dir = format!("{}/../prover/fixtures", env!("CARGO_MANIFEST_DIR"));
    let facts = std::fs::read_to_string(format!("{dir}/session.txt")).unwrap();
    let fact = |k: &str| {
        let line = facts
            .lines()
            .find(|l| l.starts_with(&format!("{k}=")))
            .unwrap();
        arr32(line[k.len() + 1..].trim_start_matches("0x"))
    };
    let abi = std::fs::read_to_string(format!("{dir}/wrapped-proof.hex")).unwrap();
    Session {
        abi: unhex(abi.trim()),
        program_vk: fact("programVK"),
        root_c: fact("rootC"),
        block_hash: fact("block_hash"),
    }
}

/// One of the verifier crate's proofs: its release, block number and 1,344 bytes.
pub struct VerifierProof {
    pub abi: Vec<u8>,
    pub program_vk: [u8; 32],
    pub root_c: [u8; 32],
}

pub fn verifier_proof(release: &str, block: u32) -> VerifierProof {
    let path = format!(
        "{}/../verifier/fixtures/zisk-{release}/block{block}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let j = read_json(path);
    let field = |k: &str| unhex(j[k].as_str().unwrap().trim_start_matches("0x"));
    let (vk, root) = (field("programVK"), field("rootCVadcopFinal"));
    VerifierProof {
        abi: [
            field("proofBytes"),
            vk.clone(),
            root.clone(),
            field("publicValues"),
        ]
        .concat(),
        program_vk: vk.try_into().unwrap(),
        root_c: root.try_into().unwrap(),
    }
}

/// The block hash a proof commits to, read out of its public values by hand: the 64 slots of
/// 8 bytes hold one 4-byte word each; the words together are 0x20, the hash, then zeros.
pub fn committed_hash(abi: &[u8]) -> [u8; 32] {
    let pv = &abi[832..];
    let stream: Vec<u8> = pv.chunks(8).flat_map(|slot| slot[..4].to_vec()).collect();
    assert_eq!(stream[0], 0x20);
    stream[1..33].try_into().unwrap()
}

/// A proof check that accepts everything, so the rest of `verify` can be tested with a block that
/// has no proof of its own.
pub fn accept_any(_: &[u8]) -> Result<bool, zk_verifier::Error> {
    Ok(true)
}

pub fn config_accepting_any() -> Config {
    Config::new([0xaa; 32], [0xbb; 32]).with_proof_check(accept_any)
}

/// The 1,344-byte input for `block`'s hash under the pins of `config_accepting_any`.
pub fn abi_for(hash: &[u8; 32]) -> Vec<u8> {
    let mut stream = vec![0x20];
    stream.extend_from_slice(hash);
    stream.resize(256, 0);
    let mut pv = Vec::new();
    for word in stream.chunks(4) {
        pv.extend_from_slice(word);
        pv.extend_from_slice(&[0; 4]);
    }
    [vec![0u8; 768], vec![0xaa; 32], vec![0xbb; 32], pv].concat()
}
