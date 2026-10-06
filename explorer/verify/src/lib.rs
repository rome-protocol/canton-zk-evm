// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
//! The sidecar's block check, for a browser.
//!
//! `zk_sidecar::verify` is the one function each confirmer's sidecar runs on a block. This crate
//! builds it, unchanged, for WebAssembly and gives it a plain C interface, so the build needs only
//! Rust's `wasm32-unknown-unknown` target and no other tool.
//!
//! The caller copies its input into the module's memory with `alloc`, calls `verify_block`, reads
//! the answer's length from the result and its bytes from `answer_ptr`, and gives its input back
//! with `dealloc`. The answer stays where it is until the next call.

use std::cell::RefCell;
use zk_sidecar::{verify, Config};

/// The sidecar's answer to `line` (`proofHex,headerHex,txsHex`) under the two pins.
pub fn answer(program_vk: [u8; 32], root_c: [u8; 32], line: &[u8]) -> String {
    match std::str::from_utf8(line) {
        Ok(line) => verify(&Config::new(program_vk, root_c), line),
        Err(_) => "no malformed input".to_string(),
    }
}

thread_local! {
    static ANSWER: RefCell<String> = const { RefCell::new(String::new()) };
}

/// Room for `len` bytes of the caller's input. Give it back with `dealloc`, with the same `len`.
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// Gives back what `alloc(len)` returned.
///
/// # Safety
/// `ptr` must come from `alloc(len)` and must not be used again.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len));
}

/// Runs the check and returns the length of the answer, which `answer_ptr` points to.
/// `pins` is 64 bytes: the program key, then the ZisK release root. `line` is `line_len` bytes.
///
/// # Safety
/// `pins` must point to 64 readable bytes and `line` to `line_len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn verify_block(pins: *const u8, line: *const u8, line_len: usize) -> usize {
    let pins = std::slice::from_raw_parts(pins, 64);
    let line = std::slice::from_raw_parts(line, line_len);
    let text = answer(
        pins[..32].try_into().unwrap(),
        pins[32..].try_into().unwrap(),
        line,
    );
    ANSWER.with(|a| {
        *a.borrow_mut() = text;
        a.borrow().len()
    })
}

/// Where the last answer's bytes are.
#[no_mangle]
pub extern "C" fn answer_ptr() -> *const u8 {
    ANSWER.with(|a| a.borrow().as_ptr())
}
