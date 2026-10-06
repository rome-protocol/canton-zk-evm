// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
//! Prints this chain's rules hash.
fn main() {
    println!("{}", cze_rules::to_hex(&cze_rules::rules_hash(&cze_rules::chain_config())));
}
