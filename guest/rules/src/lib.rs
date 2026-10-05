//! The chain settings the guest is built for, and the rules hash that stands for them.
//!
//! The settings are the `config` part of `network/genesis.json`: chain id 770101, every fork
//! from genesis up to Prague. They are compiled into the guest, which refuses any input whose
//! chain config is not exactly this one.
//!
//! The rules hash is the SHA-256 of the canonical encoding of the chain config. The canonical
//! encoding is the config written as JSON by `alloy-genesis`, with the keys of every object in
//! byte order and no spaces. Two configs have the same rules hash exactly when they have the same
//! canonical encoding.

use alloy_genesis::ChainConfig;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

/// The chain id of this chain.
pub const CHAIN_ID: u64 = 770101;

const GENESIS: &str = include_str!("../../../network/genesis.json");

#[derive(Deserialize)]
struct GenesisConfig {
    config: ChainConfig,
}

/// The chain config this chain runs under: the `config` of `network/genesis.json`.
pub fn chain_config() -> ChainConfig {
    serde_json::from_str::<GenesisConfig>(GENESIS)
        .expect("network/genesis.json holds a chain config")
        .config
}

/// The canonical encoding of a chain config.
pub fn canonical_encoding(config: &ChainConfig) -> Vec<u8> {
    let value = serde_json::to_value(config).expect("a chain config is JSON");
    let mut out = String::new();
    write_sorted(&value, &mut out);
    out.into_bytes()
}

fn write_sorted(value: &Value, out: &mut String) {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (i, key) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(key.clone()).to_string());
                out.push(':');
                write_sorted(&map[key], out);
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_sorted(item, out);
            }
            out.push(']');
        }
        other => out.push_str(&other.to_string()),
    }
}

/// The rules hash of a chain config: SHA-256 of its canonical encoding.
pub fn rules_hash(config: &ChainConfig) -> [u8; 32] {
    Sha256::digest(canonical_encoding(config)).into()
}

/// A hash as lower-case hex.
pub fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Ok if `config` is this chain's config, an error saying so if it is not.
pub fn check(config: &ChainConfig) -> Result<(), String> {
    let ours = rules_hash(&chain_config());
    let theirs = rules_hash(config);
    if ours == theirs {
        Ok(())
    } else {
        Err(format!(
            "the input's chain config (chain id {}, rules hash {}) is not this chain's (chain id {CHAIN_ID}, rules hash {})",
            config.chain_id,
            to_hex(&theirs),
            to_hex(&ours)
        ))
    }
}
