// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
//! The HTTP side: Canton's contract, over a real socket.

mod common;

use common::*;
use std::io::{Read, Write};
use std::net::TcpStream;
use zk_sidecar::{http, Config};

/// Starts a sidecar on a free port and returns its address.
fn start(cfg: Config) -> String {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let addr = server.server_addr().to_ip().unwrap().to_string();
    std::thread::spawn(move || http::serve(server, cfg));
    addr
}

/// One request; returns the status and the body.
fn request(
    addr: &str,
    method: &str,
    path: &str,
    function: Option<&str>,
    body: &str,
) -> (u16, String) {
    let mut head = format!(
        "{method} {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\nContent-Length: {}\r\n",
        body.len()
    );
    if let Some(f) = function {
        head.push_str(&format!(
            "X-Daml-External-Function-Id: {f}\r\nX-Daml-External-Mode: validation\r\n"
        ));
    }
    let mut stream = TcpStream::connect(addr).unwrap();
    stream
        .write_all(format!("{head}\r\n{body}").as_bytes())
        .unwrap();
    let mut reply = String::new();
    stream.read_to_string(&mut reply).unwrap();
    let status = reply.split(' ').nth(1).unwrap().parse().unwrap();
    (
        status,
        reply.split("\r\n\r\n").nth(1).unwrap_or("").to_string(),
    )
}

fn text_of_hex(body: &str) -> String {
    String::from_utf8(unhex(body)).unwrap()
}

#[test]
fn the_version_answers_json() {
    let addr = start(config_accepting_any());
    let (status, body) = request(&addr, "GET", "/api/v1/version", None, "");
    assert_eq!(status, 200);
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(json["version"].is_string());
}

#[test]
fn verify_answers_in_hex() {
    let b = reth_block();
    let addr = start(config_accepting_any());
    let line = format!(
        "{},{},{}",
        hex(&abi_for(&b.hash)),
        hex(&b.header),
        hex(&b.txs)
    );
    let (status, body) = request(
        &addr,
        "POST",
        "/api/v1/external-call",
        Some("verify"),
        &hex(line.as_bytes()),
    );
    assert_eq!(status, 200);
    let answer = text_of_hex(&body);
    assert!(
        answer.starts_with(&format!(
            "ok {} {} {}",
            hex(&[0xaa; 32]),
            hex(&[0xbb; 32]),
            hex(&b.hash)
        )),
        "{answer}"
    );
    // and refuses a block whose header is not the proven one
    let line = format!("{},{},{}", hex(&abi_for(&b.hash)), hex(&b.header), "");
    let (status, body) = request(
        &addr,
        "POST",
        "/api/v1/external-call",
        Some("verify"),
        &hex(line.as_bytes()),
    );
    assert_eq!(status, 200);
    assert_eq!(
        text_of_hex(&body),
        "no the transactions do not match the header's transactions root"
    );
}

#[test]
fn verify_refuses_the_session_proof_with_a_flipped_byte() {
    let s = session();
    let b = reth_block();
    let addr = start(Config::new(s.program_vk, s.root_c));
    let mut abi = s.abi.clone();
    abi[500] ^= 1;
    let line = format!("{},{},{}", hex(&abi), hex(&b.header), hex(&b.txs));
    let (status, body) = request(
        &addr,
        "POST",
        "/api/v1/external-call",
        Some("verify"),
        &hex(line.as_bytes()),
    );
    assert_eq!(
        (status, text_of_hex(&body)),
        (200, "no the proof does not verify".to_string())
    );
}

#[test]
fn legs_answers_in_hex() {
    let addr = start(config_accepting_any());
    let b = gateway_block("three");
    let (status, body) = request(
        &addr,
        "POST",
        "/api/v1/external-call",
        Some("legs"),
        &hex(b.line().as_bytes()),
    );
    assert_eq!(status, 200);
    assert_eq!(text_of_hex(&body), b.ok());
    let mut bad = gateway_block("three");
    bad.state_root = "00".repeat(32);
    let (status, body) = request(
        &addr,
        "POST",
        "/api/v1/external-call",
        Some("legs"),
        &hex(bad.line().as_bytes()),
    );
    assert_eq!(
        (status, text_of_hex(&body)),
        (200, "no the account proof does not verify".to_string())
    );
    // a block with no legs is answered too
    let none = gateway_block("registered");
    let (status, body) = request(
        &addr,
        "POST",
        "/api/v1/external-call",
        Some("legs"),
        &hex(none.line().as_bytes()),
    );
    assert_eq!((status, text_of_hex(&body)), (200, none.ok()));
}

#[test]
fn fact_is_no_longer_a_function() {
    let addr = start(config_accepting_any());
    let b = gateway_block("three");
    let (status, body) = request(
        &addr,
        "POST",
        "/api/v1/external-call",
        Some("fact"),
        &hex(b.line().as_bytes()),
    );
    assert_eq!(status, 400);
    assert_eq!(body, "the function is not verify or legs");
}

#[test]
fn a_wrong_function_id_or_a_bad_request_is_refused() {
    let addr = start(config_accepting_any());
    let body = hex(b"x");
    for function in [
        Some("execute"),
        Some("Verify"),
        Some("Legs"),
        Some(""),
        None,
    ] {
        let (status, _) = request(&addr, "POST", "/api/v1/external-call", function, &body);
        assert_eq!(status, 400, "{function:?}");
    }
    // a body that is not lowercase hex
    for body in ["xyz", "ABCD", "abc"] {
        let (status, _) = request(&addr, "POST", "/api/v1/external-call", Some("legs"), body);
        assert_eq!(status, 400, "{body}");
    }
    assert_eq!(
        request(&addr, "GET", "/api/v1/external-call", Some("legs"), "").0,
        405
    );
    assert_eq!(request(&addr, "POST", "/api/v1/version", None, "").0, 405);
    assert_eq!(request(&addr, "GET", "/", None, "").0, 404);
}
