// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
//! `zk-sidecar --program-vk <64 hex digits> --root-c <64 hex digits> --zisk-release 1.3.1|1.3.2|1.4.0 [--listen 127.0.0.1:8085]`
//! or `zk-sidecar --key <programVK>:<rootC>:<release>[@<from>..<until>] [--key ...] [--listen 127.0.0.1:8085]`
//!
//! The release is the ZisK release the chain's proofs are made with, and it is required: there is
//! no default. `--key` may be given up to four times and may not be mixed with the three single-key
//! flags. A `--key` may name the blocks it is valid for (`@<from>..<until>`, either side may be
//! empty), which is how a program switch at block N is configured: the old key `..N` and the new
//! one `N..`.

use zk_sidecar::{http, unhex, Config, Key, Release, KNOWN_RELEASES};

const USAGE: &str = "usage: zk-sidecar --program-vk <64 lowercase hex digits> --root-c <64 lowercase hex digits> --zisk-release <1.3.1, 1.3.2 or 1.4.0> [--listen <address:port, default 127.0.0.1:8085>]
   or: zk-sidecar --key <programVK>:<rootC>:<release>[@<from>..<until>] [--key ... up to 4 in all] [--listen <address:port>]";

fn key(value: Option<String>) -> Result<[u8; 32], String> {
    value
        .as_deref()
        .and_then(|v| unhex(v.strip_prefix("0x").unwrap_or(v)))
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| USAGE.to_string())
}

fn run() -> Result<(), String> {
    let (mut program_vk, mut root_c, mut listen) = (None, None, "127.0.0.1:8085".to_string());
    let mut release: Option<Release> = None;
    let mut keys = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--program-vk" => program_vk = args.next(),
            "--root-c" => root_c = args.next(),
            "--zisk-release" => {
                let given = args.next().ok_or(USAGE)?;
                release = Some(Release::parse(&given).ok_or_else(|| {
                    format!("{given} is not a ZisK release this sidecar knows ({KNOWN_RELEASES})")
                })?);
            }
            "--key" => keys.push(Key::parse(&args.next().ok_or(USAGE)?)?),
            "--listen" => listen = args.next().ok_or(USAGE)?,
            _ => return Err(USAGE.to_string()),
        }
    }
    let cfg = if keys.is_empty() {
        let release = release.ok_or_else(|| {
            format!("--zisk-release is required ({KNOWN_RELEASES}); there is no default release")
        })?;
        Config::for_release(key(program_vk)?, key(root_c)?, release)
    } else {
        if program_vk.is_some() || root_c.is_some() || release.is_some() {
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
                    let blocks = match (k.first_block, k.until_block) {
                        (0, None) => String::new(),
                        (f, u) => format!(
                            ", blocks {f}..{}",
                            u.map(|u| u.to_string()).unwrap_or_default()
                        ),
                    };
                    format!(
                        "{} (ZisK {}{blocks})",
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
