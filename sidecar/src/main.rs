//! `zk-sidecar --program-vk <64 hex digits> --root-c <64 hex digits> [--listen 127.0.0.1:8085]`
//!
//! Originally written by Rome Protocol.

use zk_sidecar::{http, unhex, Config};

const USAGE: &str = "usage: zk-sidecar --program-vk <64 lowercase hex digits> --root-c <64 lowercase hex digits> [--listen <address:port, default 127.0.0.1:8085>]";

fn key(value: Option<String>) -> Result<[u8; 32], String> {
    value
        .as_deref()
        .and_then(|v| unhex(v.strip_prefix("0x").unwrap_or(v)))
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| USAGE.to_string())
}

fn run() -> Result<(), String> {
    let (mut program_vk, mut root_c, mut listen) = (None, None, "127.0.0.1:8085".to_string());
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--program-vk" => program_vk = args.next(),
            "--root-c" => root_c = args.next(),
            "--listen" => listen = args.next().ok_or(USAGE)?,
            _ => return Err(USAGE.to_string()),
        }
    }
    let cfg = Config::new(key(program_vk)?, key(root_c)?);
    let server =
        tiny_http::Server::http(&listen).map_err(|e| format!("cannot listen on {listen}: {e}"))?;
    eprintln!("listening on {listen}");
    http::serve(server, cfg);
    Ok(())
}

fn main() {
    if let Err(message) = run() {
        eprintln!("{message}");
        std::process::exit(2);
    }
}
