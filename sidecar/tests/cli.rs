// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
//! The program's command line: the release option.

use std::process::Command;

const KEY: &str = "0000000000000000000000000000000000000000000000000000000000000001";

fn run(extra: &[&str]) -> (Option<i32>, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_zk-sidecar"))
        .args([
            "--program-vk",
            KEY,
            "--root-c",
            KEY,
            "--listen",
            "256.0.0.1:1",
        ])
        .args(extra)
        .output()
        .unwrap();
    (
        out.status.code(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

#[test]
fn a_release_it_does_not_know_stops_it_before_it_listens() {
    for bad in ["1.2.0", "1.3.3", "latest", ""] {
        let (code, err) = run(&["--zisk-release", bad]);
        assert_eq!(code, Some(2), "{bad:?}");
        assert!(err.contains("not a ZisK release"), "{bad:?}: {err}");
    }
}

#[test]
fn the_release_option_needs_a_value() {
    let (code, err) = run(&["--zisk-release"]);
    assert_eq!(code, Some(2));
    assert!(err.contains("usage"), "{err}");
}

#[test]
fn the_known_releases_get_as_far_as_the_address() {
    // The address is not valid, so it stops there: past the release, which is what is checked.
    for ok in ["1.3.1", "1.3.2", "1.3.2-alpha"] {
        let (code, err) = run(&["--zisk-release", ok]);
        assert_eq!(code, Some(2), "{ok}");
        assert!(err.contains("cannot listen"), "{ok}: {err}");
    }
    let (code, err) = run(&[]);
    assert_eq!(code, Some(2));
    assert!(err.contains("cannot listen"), "{err}");
}
