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

/// One holder's balance proof: the state root, the token, the holder, the slot of the balance
/// mapping, the value reth reports, and the two node lists.
pub struct Balance {
    pub state_root: String,
    pub token: String,
    pub holder: String,
    pub slot: u64,
    pub value: String,
    pub account_nodes: Vec<String>,
    pub storage_nodes: Vec<String>,
}

impl Balance {
    /// The `fact` input line: this balance is the one in the new block, `parent` the one in the
    /// parent block (the token, holder and slot are this one's).
    pub fn line(&self, parent: &Balance) -> String {
        format!(
            "{},{},{},{},{},{},{},{},{}",
            self.state_root,
            parent.state_root,
            self.token,
            self.holder,
            self.slot,
            self.account_nodes.join(";"),
            self.storage_nodes.join(";"),
            parent.account_nodes.join(";"),
            parent.storage_nodes.join(";")
        )
    }
}

/// A one-account state written out by hand: the token's account, and in it the holder's balance
/// at `slot` (`None`: nothing is stored in the account at all). Built with the crate's own RLP
/// writer, because the chain's own state has no such account.
pub fn hand_built(token: &str, holder: &str, slot: u64, value: Option<[u8; 32]>) -> Balance {
    let storage_nodes = value.map(|v| {
        let mut preimage = [0u8; 64];
        preimage[12..32].copy_from_slice(&unhex(holder));
        preimage[56..].copy_from_slice(&slot.to_be_bytes());
        let trimmed: Vec<u8> = v.iter().copied().skip_while(|&b| b == 0).collect();
        // The storage trie's key is the hash of the mapping entry's slot.
        let path = [vec![0x20], keccak(&keccak(&preimage)).to_vec()].concat();
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
    let path = [vec![0x20], keccak(&unhex(token)).to_vec()].concat();
    let leaf = rlp::list_of(&[rlp::string(&path), rlp::string(&account)].concat());
    Balance {
        state_root: hex(&keccak(&leaf)),
        token: token.to_string(),
        holder: holder.to_string(),
        slot,
        value: hex(&value.unwrap_or([0; 32])),
        account_nodes: vec![hex(&leaf)],
        storage_nodes: storage_nodes.iter().map(|n| hex(n)).collect(),
    }
}

/// A 256-bit value from a small one, as the 32 bytes a balance has.
pub fn word(v: u128) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[16..].copy_from_slice(&v.to_be_bytes());
    w
}

/// The holder who has a balance (`present`) and the one who has none (`absent`).
pub fn reth_balance(which: &str) -> Balance {
    let j = fixtures("balances");
    let h = &j[which];
    let list = |k: &str| -> Vec<String> {
        h[k].as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap().to_string())
            .collect()
    };
    Balance {
        state_root: j["stateRoot"].as_str().unwrap().to_string(),
        token: j["token"].as_str().unwrap().to_string(),
        holder: h["holder"].as_str().unwrap().to_string(),
        slot: j["slot"].as_u64().unwrap(),
        value: h["value"].as_str().unwrap().to_string(),
        account_nodes: list("accountNodes"),
        storage_nodes: list("storageNodes"),
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
