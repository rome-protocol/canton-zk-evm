// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
//! Canton's HTTP contract for an external-call service: `GET /api/v1/version` answers JSON, and
//! `POST /api/v1/external-call` takes the function in the `X-Daml-External-Function-Id` header and
//! the hex of the input line as its body, and answers the hex of the answer line.

use crate::{hex, legs, unhex, verify, Config};
use std::io::Read;
use std::sync::Arc;

/// The most a request body may hold (as hex). A block with a few thousand transactions fits.
const MAX_BODY: u64 = 64 << 20;

/// What to answer: the status and the body.
pub fn route(
    cfg: &Config,
    method: &str,
    path: &str,
    function: Option<&str>,
    body: &[u8],
) -> (u16, String) {
    match (method, path) {
        ("GET", "/api/v1/version") => (
            200,
            format!(
                r#"{{"application":"canton-zk-evm-sidecar","version":"{}"}}"#,
                env!("CARGO_PKG_VERSION")
            ),
        ),
        ("POST", "/api/v1/external-call") => {
            let line = std::str::from_utf8(body)
                .ok()
                .and_then(unhex)
                .and_then(|b| String::from_utf8(b).ok());
            match (function, line) {
                (_, None) => (
                    400,
                    "the body is not the lowercase hex of a line of text".into(),
                ),
                (Some("verify"), Some(line)) => (200, hex(verify(cfg, &line).as_bytes())),
                (Some("legs"), Some(line)) => (200, hex(legs(&line).as_bytes())),
                _ => (400, "the function is not verify or legs".into()),
            }
        }
        (_, "/api/v1/version" | "/api/v1/external-call") => (405, "method not allowed".into()),
        _ => (404, "not found".into()),
    }
}

/// Answers requests, each on its own thread, for as long as the server runs.
pub fn serve(server: tiny_http::Server, cfg: Config) {
    let cfg = Arc::new(cfg);
    for mut request in server.incoming_requests() {
        let cfg = Arc::clone(&cfg);
        std::thread::spawn(move || {
            let function = request
                .headers()
                .iter()
                .find(|h| h.field.equiv("X-Daml-External-Function-Id"))
                .map(|h| h.value.to_string());
            let mut body = Vec::new();
            let read = request
                .as_reader()
                .take(MAX_BODY + 1)
                .read_to_end(&mut body);
            let (status, text) = match read {
                Ok(_) if body.len() as u64 <= MAX_BODY => route(
                    &cfg,
                    request.method().as_str(),
                    request.url(),
                    function.as_deref(),
                    &body,
                ),
                _ => (400, "the body could not be read or is too large".into()),
            };
            let type_ = if text.starts_with('{') {
                "application/json"
            } else {
                "text/plain"
            };
            let header =
                tiny_http::Header::from_bytes(&b"Content-Type"[..], type_.as_bytes()).unwrap();
            let _ = request.respond(
                tiny_http::Response::from_string(text)
                    .with_status_code(status)
                    .with_header(header),
            );
        });
    }
}
