// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
//! The program's command line: the release option and the key list.

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
    for bad in ["1.2.0", "1.3.3", "1.4.1", "latest", ""] {
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
    for ok in ["1.3.1", "1.3.2", "1.3.2-alpha", "1.4.0", "1.4.0-alpha"] {
        let (code, err) = run(&["--zisk-release", ok]);
        assert_eq!(code, Some(2), "{ok}");
        assert!(err.contains("cannot listen"), "{ok}: {err}");
    }
}

#[test]
fn a_missing_release_stops_it_before_it_listens() {
    // There is no default release: a sidecar started without one is an error, not a 1.3.1 sidecar.
    let (code, err) = run(&[]);
    assert_eq!(code, Some(2));
    assert!(err.contains("--zisk-release is required"), "{err}");
    assert!(!err.contains("cannot listen"), "{err}");
}

const KEY_A: &str = "0000000000000000000000000000000000000000000000000000000000000002";

fn run_keys(args: &[&str]) -> (Option<i32>, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_zk-sidecar"))
        .args(args)
        .args(["--listen", "256.0.0.1:1"])
        .output()
        .unwrap();
    (
        out.status.code(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

fn key(n: &str, release: Option<&str>) -> String {
    let n = format!("{:0>64}", n);
    match release {
        Some(r) => format!("{n}:{KEY}:{r}"),
        None => format!("{n}:{KEY}"),
    }
}

#[test]
fn a_key_with_no_release_stops_it_before_it_listens() {
    let k = key("1", None);
    let (code, err) = run_keys(&["--key", &k]);
    assert_eq!(code, Some(2));
    assert!(
        err.contains("is not <programVK>:<rootC>:<release>"),
        "{err}"
    );
    assert!(!err.contains("cannot listen"), "{err}");
}

#[test]
fn keys_with_block_ranges_get_as_far_as_the_address_and_bad_ranges_do_not() {
    let b = format!("{:0>64}", "1");
    let c = format!("{:0>64}", "2");
    let old = format!("{b}:{KEY}:1.3.2@..5000");
    let new = format!("{c}:{KEY}:1.4.0@5000..");
    let (code, err) = run_keys(&["--key", &old, "--key", &new]);
    assert_eq!(code, Some(2));
    assert!(err.contains("cannot listen"), "{err}");
    for bad in ["@..", "@6..5", "@x.."] {
        let k = format!("{b}:{KEY}:1.4.0{bad}");
        let (code, err) = run_keys(&["--key", &k]);
        assert_eq!(code, Some(2), "{bad}");
        assert!(err.contains("block range"), "{bad}: {err}");
        assert!(!err.contains("cannot listen"), "{bad}: {err}");
    }
}

#[test]
fn keys_whose_block_ranges_overlap_stop_it_before_it_listens() {
    let b = format!("{:0>64}", "1");
    let c = format!("{:0>64}", "2");
    // The new key without its `@5000..`.
    let old = format!("{b}:{KEY}:1.3.2@..5000");
    let new = format!("{c}:{KEY}:1.4.0");
    let (code, err) = run_keys(&["--key", &old, "--key", &new]);
    assert_eq!(code, Some(2));
    assert!(err.contains("overlap"), "{err}");
    assert!(!err.contains("cannot listen"), "{err}");
}

#[test]
fn up_to_four_keys_get_as_far_as_the_address() {
    for n in 1..=4 {
        let keys: Vec<String> = (1..=n)
            .map(|i| {
                key(
                    &i.to_string(),
                    Some(if i % 2 == 0 { "1.3.2" } else { "1.4.0" }),
                )
            })
            .collect();
        let args: Vec<&str> = keys.iter().flat_map(|k| ["--key", k.as_str()]).collect();
        let (code, err) = run_keys(&args);
        assert_eq!(code, Some(2), "{n} keys");
        assert!(err.contains("cannot listen"), "{n} keys: {err}");
    }
}

#[test]
fn a_list_that_is_wrong_stops_it_before_it_listens() {
    let five: Vec<String> = (1..=5)
        .map(|i| key(&i.to_string(), Some("1.3.2")))
        .collect();
    let twice = [key("1", Some("1.3.1")), key("1", Some("1.3.2"))];
    let one = key("1", Some("1.3.2"));
    let mut cases: Vec<(Vec<&str>, &str)> = vec![
        (
            five.iter().flat_map(|k| ["--key", k.as_str()]).collect(),
            "at most 4",
        ),
        (
            twice.iter().flat_map(|k| ["--key", k.as_str()]).collect(),
            "twice",
        ),
        (vec!["--key", "zz:zz:1.3.2"], "not 64 lowercase hex"),
        (vec!["--key", &one, "--key", "1234"], "is not <programVK>"),
        // `--key` takes the next flag, `--listen`, as its value.
        (vec!["--key"], "is not <programVK>"),
    ];
    let bad_release = format!("{}:{KEY}:1.2.0", "00".repeat(32));
    cases.push((vec!["--key", &bad_release], "not a ZisK release"));
    for (args, expected) in cases {
        let (code, err) = run_keys(&args);
        assert_eq!(code, Some(2), "{args:?}");
        assert!(err.contains(expected), "{args:?}: {err}");
        assert!(!err.contains("cannot listen"), "{args:?}: {err}");
    }
}

#[test]
fn the_list_cannot_be_mixed_with_the_single_key_options() {
    let one = key("1", Some("1.3.2"));
    for extra in [
        ["--program-vk", KEY_A],
        ["--root-c", KEY_A],
        ["--zisk-release", "1.3.1"],
    ] {
        let (code, err) = run_keys(&["--key", &one, extra[0], extra[1]]);
        assert_eq!(code, Some(2), "{extra:?}");
        assert!(err.contains("cannot be mixed"), "{extra:?}: {err}");
        assert!(!err.contains("cannot listen"), "{extra:?}: {err}");
    }
}

#[test]
fn a_key_option_with_no_value_is_the_usage_message() {
    let out = Command::new(env!("CARGO_BIN_EXE_zk-sidecar"))
        .arg("--key")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("usage"));
}
