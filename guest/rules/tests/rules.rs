// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
use alloy_genesis::ChainConfig;
use cze_rules::{canonical_encoding, chain_config, check, rules_hash, CHAIN_ID};
use serde::{Deserialize, Serialize};
use serde_with::serde_as;

fn recorded() -> String {
    include_str!("../../fixtures/rules-hash.txt").trim().to_string()
}

fn hex(bytes: [u8; 32]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn the_built_in_config_is_this_chain() {
    let ours = chain_config();
    assert_eq!(ours.chain_id, CHAIN_ID);
    assert_eq!(CHAIN_ID, 770101);
    assert_eq!(ours.prague_time, Some(0));
}

#[test]
fn the_rules_hash_is_the_recorded_one() {
    assert_eq!(hex(rules_hash(&chain_config())), recorded());
}

// The recorded encoding lets anyone work out the rules hash with `sha256sum`.
#[test]
fn the_canonical_encoding_is_the_recorded_one() {
    let recorded = include_str!("../../fixtures/rules-encoding.json");
    assert_eq!(String::from_utf8(canonical_encoding(&chain_config())).unwrap(), recorded);
}

#[test]
fn it_accepts_the_built_in_config() {
    assert!(check(&chain_config()).is_ok());
}

#[test]
fn it_refuses_another_chain_id() {
    let mut other = chain_config();
    other.chain_id = 1;
    assert!(check(&other).is_err());
}

#[test]
fn it_refuses_another_fork_schedule() {
    let changes: [fn(&mut ChainConfig); 4] = [
        |c| c.prague_time = None,
        |c| c.osaka_time = Some(0),
        |c| c.cancun_time = Some(1),
        |c| c.london_block = Some(1),
    ];
    for change in changes {
        let mut other = chain_config();
        change(&mut other);
        assert!(check(&other).is_err());
    }
}

// The guest reads its chain config in this encoding. It must come out with the same hash.
#[serde_as]
#[derive(Serialize, Deserialize)]
struct AsTheGuestReadsIt {
    #[serde_as(as = "alloy_genesis::serde_bincode_compat::ChainConfig<'_>")]
    config: ChainConfig,
}

#[test]
fn the_hash_survives_the_encoding_the_guest_reads() {
    let wrapped = AsTheGuestReadsIt { config: chain_config() };
    let bytes = bincode::serde::encode_to_vec(&wrapped, bincode::config::standard()).unwrap();
    let (back, _): (AsTheGuestReadsIt, usize) =
        bincode::serde::decode_from_slice(&bytes, bincode::config::standard()).unwrap();
    assert!(check(&back.config).is_ok());
}
