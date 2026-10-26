// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
//! `zk-sidecar --program-vk <64 hex digits> --root-c <64 hex digits> [--zisk-release 1.3.1|1.3.2] [--listen 127.0.0.1:8085]`
//! or `zk-sidecar --key <programVK>:<rootC>[:<release>] [--key ...] [--listen 127.0.0.1:8085]`
//!
//! The release is the ZisK release the chain's proofs are made with. Without it the proofs are
//! checked as ZisK 1.3.1's. `--key` may be given up to four times and may not be mixed with the
//! three single-key flags.

use zk_sidecar::{http, unhex, Config, Key, Release};

const USAGE: &str = "usage: zk-sidecar --program-vk <64 lowercase hex digits> --root-c <64 lowercase hex digits> [--zisk-release <1.3.1 or 1.3.2, default 1.3.1>] [--listen <address:port, default 127.0.0.1:8085>]
   or: zk-sidecar --key <programVK>:<rootC>[:<release, default 1.3.1>] [--key ... up to 4 in all] [--listen <address:port>]";

fn key(value: Option<String>) -> Result<[u8; 32], String> {
    value
        .as_deref()
        .and_then(|v| unhex(v.strip_prefix("0x").unwrap_or(v)))
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| USAGE.to_string())
}

fn run() -> Result<(), String> {
    let (mut program_vk, mut root_c, mut listen) = (None, None, "127.0.0.1:8085".to_string());
    let (mut release, mut release_given) = (Release::default(), false);
    let mut keys = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--program-vk" => program_vk = args.next(),
            "--root-c" => root_c = args.next(),
            "--zisk-release" => {
                let given = args.next().ok_or(USAGE)?;
                release = Release::parse(&given).ok_or_else(|| {
                    format!("{given} is not a ZisK release this sidecar knows (1.3.1 or 1.3.2)")
                })?;
                release_given = true;
            }
            "--key" => keys.push(Key::parse(&args.next().ok_or(USAGE)?)?),
            "--listen" => listen = args.next().ok_or(USAGE)?,
            _ => return Err(USAGE.to_string()),
        }
    }
    let cfg = if keys.is_empty() {
        Config::for_release(key(program_vk)?, key(root_c)?, release)
    } else {
        if program_vk.is_some() || root_c.is_some() || release_given {
            return Err(
                "--key cannot be mixed with --program-vk, --root-c or --zisk-release".to_string(),
            );
        }
        Config::with_keys(keys)?
    };
    let server =
        tiny_http::Server::http(&listen).map_err(|e| format!("cannot listen on {listen}: {e}"))?;
    match cfg.keys()[..] {
        [one] => eprintln!("listening on {listen}, ZisK {}", one.release.name()),
        _ => {
            let listed: Vec<String> = cfg
                .keys()
                .iter()
                .map(|k| {
                    format!(
                        "{} (ZisK {})",
                        zk_sidecar::hex(&k.program_vk),
                        k.release.name()
                    )
                })
                .collect();
            eprintln!("listening on {listen}, keys: {}", listed.join(", "));
        }
    }
    http::serve(server, cfg);
    Ok(())
}

fn main() {
    if let Err(message) = run() {
        eprintln!("{message}");
        std::process::exit(2);
    }
}
