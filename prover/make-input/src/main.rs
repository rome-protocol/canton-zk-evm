// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
//! Builds the prover input for one block.
//!
//! Usage: cze-make-input <block.json> <witness.json> <genesis.json> <out.bin>
//!
//! `block.json` is the reply of `eth_getBlockByNumber` with full transactions, `witness.json` the
//! reply of `debug_executionWitness`, and the chain config is the `config` of `genesis.json`.
//! zisk-eth-client's own input tool reads these from an RPC node and refuses a chain it does not
//! know; this takes them from files and uses the same input code for everything after that.
use alloy_genesis::Genesis;
use alloy_rpc_types_debug::ExecutionWitness;
use alloy_rpc_types_eth::Block as RpcBlock;
use anyhow::{anyhow, Context, Result};
use input_reth::RethClient;
use stateless_reth::StatelessInput;
use std::path::PathBuf;

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [block, witness, genesis, out] = <[String; 4]>::try_from(args).map_err(|_| {
        anyhow!("usage: cze-make-input <block.json> <witness.json> <genesis.json> <out.bin>")
    })?;

    let block: RpcBlock = serde_json::from_slice(&std::fs::read(&block)?).context("block.json")?;
    let witness: ExecutionWitness =
        serde_json::from_slice(&std::fs::read(&witness)?).context("witness.json")?;
    let genesis: Genesis =
        serde_json::from_slice(&std::fs::read(&genesis)?).context("genesis.json")?;

    let stateless_input = StatelessInput {
        block: block.into(),
        witness,
        chain_config: genesis.config,
    };
    let stdin = RethClient::default().from_stateless_input(&stateless_input)?;
    stdin.save(&PathBuf::from(&out))?;
    Ok(())
}
