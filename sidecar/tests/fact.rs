//! `fact`: how far a holder's balance rose between the parent block and this one, on real balance
//! proofs from our reth, on states written out by hand, and the refusals.

mod common;

use common::*;
use zk_sidecar::fact;

const ACCOUNT_BAD: &str = "no the account proof does not verify";
const STORAGE_BAD: &str = "no the storage proof does not verify";
const FELL: &str = "no the balance fell";
const ZERO: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// The answer for a rise of `rise`, with the roots of `b` (the new block) and `parent`.
fn ok_line(b: &Balance, parent: &Balance, rise: &str) -> String {
    format!(
        "ok {} {} {} {} {} {}",
        b.state_root, parent.state_root, b.token, b.holder, b.slot, rise
    )
}

/// The parent state in which `b`'s token has nothing stored: every balance there is zero.
fn nothing_stored(b: &Balance) -> Balance {
    hand_built(&b.token, &b.holder, b.slot, None)
}

fn flip_first_byte(node: &str) -> String {
    let mut bytes = unhex(node);
    bytes[0] ^= 1;
    hex(&bytes)
}

#[test]
fn a_balance_that_rose_from_nothing_answers_its_value() {
    // The new side is real: the holder's balance in reth's block. The parent has nothing stored.
    let b = reth_balance("present");
    assert_eq!(b.value.len(), 64);
    assert_ne!(b.value, ZERO);
    let parent = nothing_stored(&b);
    assert_eq!(fact(&b.line(&parent)), ok_line(&b, &parent, &b.value));
}

#[test]
fn a_balance_that_did_not_change_rose_by_zero() {
    // Real data, the same state on both sides.
    let b = reth_balance("present");
    assert_eq!(fact(&b.line(&b)), ok_line(&b, &b, ZERO));
}

#[test]
fn a_holder_with_no_balance_before_and_after_rose_by_zero() {
    let b = reth_balance("absent");
    assert_eq!(fact(&b.line(&b)), ok_line(&b, &b, ZERO));
    let parent = nothing_stored(&b);
    assert_eq!(fact(&b.line(&parent)), ok_line(&b, &parent, ZERO));
}

#[test]
fn the_answer_is_the_difference_of_the_two_balances() {
    let (token, holder) = ("44".repeat(20), "22".repeat(20));
    let at = |v: [u8; 32]| hand_built(&token, &holder, 3, Some(v));
    let hex32 = |w: [u8; 32]| hex(&w);
    // 10 -> 13, and a rise from nothing at all.
    let (parent, b) = (at(word(10)), at(word(13)));
    assert_eq!(
        fact(&b.line(&parent)),
        ok_line(&b, &parent, &hex32(word(3)))
    );
    let parent = nothing_stored(&b);
    assert_eq!(
        fact(&b.line(&parent)),
        ok_line(&b, &parent, &hex32(word(13)))
    );
    // A borrow that runs through every byte: 2^255 - 1.
    let mut high = [0u8; 32];
    high[0] = 0x80;
    let mut rise = [0xffu8; 32];
    rise[0] = 0x7f;
    let (parent, b) = (at(word(1)), at(high));
    assert_eq!(fact(&b.line(&parent)), ok_line(&b, &parent, &hex32(rise)));
}

#[test]
fn a_balance_that_fell_is_refused() {
    let (token, holder) = ("44".repeat(20), "22".repeat(20));
    let at = |v: u128| hand_built(&token, &holder, 3, Some(word(v)));
    let (parent, b) = (at(13), at(10));
    assert_eq!(fact(&b.line(&parent)), FELL);
    // A holder whose balance was emptied.
    let b = nothing_stored(&parent);
    assert_eq!(fact(&b.line(&parent)), FELL);
}

#[test]
fn a_flipped_byte_in_any_of_the_four_proofs_is_refused() {
    let good = reth_balance("present");
    let parent = || hand_built(&good.token, &good.holder, good.slot, Some(word(5)));
    for i in 0..good.account_nodes.len() {
        let mut b = reth_balance("present");
        b.account_nodes[i] = flip_first_byte(&b.account_nodes[i]);
        assert_eq!(fact(&b.line(&parent())), ACCOUNT_BAD, "account node {i}");
    }
    for i in 0..good.storage_nodes.len() {
        let mut b = reth_balance("present");
        b.storage_nodes[i] = flip_first_byte(&b.storage_nodes[i]);
        assert_eq!(fact(&b.line(&parent())), STORAGE_BAD, "storage node {i}");
    }
    let (mut p, b) = (parent(), reth_balance("present"));
    p.account_nodes[0] = flip_first_byte(&p.account_nodes[0]);
    assert_eq!(fact(&b.line(&p)), ACCOUNT_BAD, "parent account node");
    let (mut p, b) = (parent(), reth_balance("present"));
    p.storage_nodes[0] = flip_first_byte(&p.storage_nodes[0]);
    assert_eq!(fact(&b.line(&p)), STORAGE_BAD, "parent storage node");
}

#[test]
fn each_proof_must_be_under_its_own_root() {
    let b = reth_balance("present");
    let parent = hand_built(&b.token, &b.holder, b.slot, Some(word(5)));
    // The two roots swapped: each side's proofs are then under the other side's root.
    let line = b.line(&parent);
    let swapped = line
        .replacen(&b.state_root, "@", 1)
        .replacen(&parent.state_root, &b.state_root, 1)
        .replacen('@', &parent.state_root, 1);
    assert_eq!(fact(&swapped), ACCOUNT_BAD);
    // The parent's root is wrong, or it is the new root with the parent's proofs under it.
    for wrong in ["00".repeat(32), b.state_root.clone()] {
        let mut p = hand_built(&b.token, &b.holder, b.slot, Some(word(5)));
        p.state_root = wrong;
        assert_eq!(fact(&b.line(&p)), ACCOUNT_BAD);
    }
}

#[test]
fn proofs_for_another_state_root_are_refused() {
    // The state root of another chain's real proof (the mpt crate's test data).
    let other = std::fs::read_to_string(format!(
        "{}/../mpt/fixtures/single_root.json",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    let other = serde_json::from_str::<serde_json::Value>(&other).unwrap();
    let mut b = reth_balance("present");
    let parent = nothing_stored(&b);
    b.state_root = other["state_root"]
        .as_str()
        .unwrap()
        .trim_start_matches("0x")
        .to_string();
    assert_eq!(fact(&b.line(&parent)), ACCOUNT_BAD);
    b.state_root = "00".repeat(32);
    assert_eq!(fact(&b.line(&parent)), ACCOUNT_BAD);
}

#[test]
fn a_storage_proof_from_another_state_is_refused() {
    // Real storage nodes of another account (the mpt crate's test data) under this account's root.
    let other = std::fs::read_to_string(format!(
        "{}/../mpt/fixtures/single_proof.json",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    let other = serde_json::from_str::<serde_json::Value>(&other).unwrap();
    let mut b = reth_balance("present");
    let parent = nothing_stored(&b);
    b.storage_nodes = other["storageProof"][0]["proof"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n.as_str().unwrap().trim_start_matches("0x").to_string())
        .collect();
    assert_eq!(fact(&b.line(&parent)), STORAGE_BAD);
}

#[test]
fn a_proof_for_another_token_is_refused() {
    let mut b = reth_balance("present");
    let parent = nothing_stored(&b);
    b.token = "55".repeat(20);
    assert_eq!(fact(&b.line(&parent)), ACCOUNT_BAD);
}

#[test]
fn missing_proofs_are_refused() {
    let parent = nothing_stored(&reth_balance("present"));
    let mut b = reth_balance("present");
    b.storage_nodes.clear();
    assert_eq!(fact(&b.line(&parent)), STORAGE_BAD);
    let mut b = reth_balance("present");
    b.account_nodes.clear();
    assert_eq!(fact(&b.line(&parent)), ACCOUNT_BAD);
    let b = reth_balance("present");
    let mut p = hand_built(&b.token, &b.holder, b.slot, Some(word(5)));
    p.storage_nodes.clear();
    assert_eq!(fact(&b.line(&p)), STORAGE_BAD);
    p.account_nodes.clear();
    assert_eq!(fact(&b.line(&p)), ACCOUNT_BAD);
}

#[test]
fn lines_that_are_not_well_formed_are_refused() {
    let b = reth_balance("present");
    let parent = nothing_stored(&b);
    let line = b.line(&parent);
    for bad in [
        String::new(),
        format!("{line},"),
        line.replacen(',', "", 1),
        line.to_uppercase(),
        line.replace(&format!(",{},", b.slot), ",x,"),
        line.replace(&b.token, &b.token[2..]),
        line.replace(&b.holder, &format!("{}00", b.holder)),
        line.replace(&b.state_root, &b.state_root[..62]),
        line.replace(&parent.state_root, &parent.state_root[..62]),
        line.replace(&format!(",{},", b.slot), ",-1,"),
        line.replace(&format!(",{},", b.slot), ",99999999999999999999999,"),
        line.replace(';', ";;"),
        // the one-root form of the first version
        line.splitn(3, ',').collect::<Vec<_>>()[0].to_string()
            + ","
            + line.splitn(3, ',').collect::<Vec<_>>()[2],
    ] {
        assert_eq!(fact(&bad), "no malformed input", "{bad}");
    }
}
