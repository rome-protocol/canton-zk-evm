//! `legs`: whether the legs attached to `Advance` are exactly the ones a block recorded in the gateway,
//! on the gateway's real proofs from our reth, on states written out by hand, and the refusals.

mod common;

use common::*;
use zk_sidecar::legs;

const ACCOUNT_BAD: &str = "no the account proof does not verify";
const STORAGE_BAD: &str = "no the storage proof does not verify";
const NOT_RECORDED: &str = "no the legs are not the ones the block recorded";
const MALFORMED: &str = "no malformed input";

fn flip_first_byte(node: &str) -> String {
    let mut bytes = unhex(node);
    bytes[0] ^= 1;
    hex(&bytes)
}

fn leg(kind: &str, id: u8, token: u8, account: u8, amount: &str, party: &str) -> Leg {
    Leg {
        kind: kind.into(),
        id: hex(&[id; 32]),
        token: hex(&[token; 20]),
        account: hex(&[account; 20]),
        amount: amount.into(),
        party: party.into(),
    }
}

/// A hand-built state in which the gateway recorded exactly `legs`, hashed here with the test's own
/// copy of the contract's rule. `base_units` are the amounts of the legs, which the test states
/// separately from their text.
fn recorded(legs: Vec<Leg>, base_units: &[[u8; 32]]) -> GatewayBlock {
    let value = leg_hash(&legs, base_units);
    hand_built(&"a7".repeat(20), 9, Some(value), legs)
}

// --- real data

#[test]
fn every_real_block_answers_ok_with_its_count() {
    for (which, count) in [
        ("unused", 0),
        ("registered", 0),
        ("deposit", 1),
        ("three", 3),
    ] {
        let b = gateway_block(which);
        assert_eq!(b.legs.len(), count, "{which}");
        assert_eq!(legs(&b.line()), b.ok(), "{which}");
    }
}

#[test]
fn the_tests_own_hash_is_the_value_reth_proves() {
    // Guards the helper the hand-built tests rely on: worked out here from the legs reth's events
    // gave, it is the value in the real storage proof.
    let one = |b: &GatewayBlock| -> [u8; 32] {
        let units: Vec<[u8; 32]> = b
            .legs
            .iter()
            .map(|l| {
                if l.kind == "payment" {
                    arr32(&l.amount)
                } else {
                    let (whole, frac) = l.amount.split_once('.').unwrap();
                    let frac = format!("{frac:0<10}");
                    word(
                        whole.parse::<u128>().unwrap() * 10u128.pow(10)
                            + frac.parse::<u128>().unwrap(),
                    )
                }
            })
            .collect();
        leg_hash(&b.legs, &units)
    };
    for which in ["unused", "registered", "deposit", "three"] {
        let b = gateway_block(which);
        assert_eq!(hex(&one(&b)), b.value, "{which}");
    }
}

#[test]
fn the_three_kinds_are_in_the_real_block() {
    let b = gateway_block("three");
    let kinds: Vec<&str> = b.legs.iter().map(|l| l.kind.as_str()).collect();
    assert_eq!(kinds, ["deposit", "withdrawal", "payment"]);
    assert!(!b.legs[1].party.is_empty());
    assert!(b.legs[0].party.is_empty() && b.legs[2].party.is_empty());
}

#[test]
fn a_block_that_recorded_nothing_proves_it_needs_nothing() {
    // Nothing stored in the gateway at all, and storage with other entries but not this block's.
    for which in ["unused", "registered"] {
        let b = gateway_block(which);
        assert_eq!(b.value, "00".repeat(32), "{which}");
        assert_eq!(legs(&b.line()), b.ok());
    }
    assert!(gateway_block("unused").storage_nodes.is_empty());
    assert!(!gateway_block("registered").storage_nodes.is_empty());
}

#[test]
fn a_leg_missing_added_swapped_or_changed_is_refused() {
    for which in ["deposit", "three"] {
        let b = gateway_block(which);
        let n = b.legs.len();
        // none at all
        assert_eq!(legs(&b.line_with(&[])), NOT_RECORDED, "{which}: none");
        // one left out, each in turn
        for i in 0..n {
            let mut fewer = b.legs.clone();
            fewer.remove(i);
            assert_eq!(
                legs(&b.line_with(&fewer)),
                NOT_RECORDED,
                "{which}: without {i}"
            );
        }
        // one more, a copy of the first
        let mut more = b.legs.clone();
        more.push(b.legs[0].clone());
        assert_eq!(
            legs(&b.line_with(&more)),
            NOT_RECORDED,
            "{which}: one extra"
        );
        // the same legs twice
        let twice = [b.legs.clone(), b.legs.clone()].concat();
        assert_eq!(legs(&b.line_with(&twice)), NOT_RECORDED, "{which}: twice");
    }
    // Two in the other order.
    let b = gateway_block("three");
    for (i, j) in [(0, 1), (1, 2), (0, 2)] {
        let mut swapped = b.legs.clone();
        swapped.swap(i, j);
        assert_eq!(legs(&b.line_with(&swapped)), NOT_RECORDED, "swap {i} {j}");
    }
    // The legs of another block.
    let (three, deposit) = (gateway_block("three"), gateway_block("deposit"));
    assert_eq!(legs(&three.line_with(&deposit.legs)), NOT_RECORDED);
    assert_eq!(legs(&deposit.line_with(&three.legs)), NOT_RECORDED);
    assert_eq!(
        legs(&gateway_block("registered").line_with(&deposit.legs)),
        NOT_RECORDED
    );
}

#[test]
fn any_one_field_of_a_leg_changed_is_refused() {
    let b = gateway_block("three");
    for i in 0..b.legs.len() {
        for field in ["id", "token", "account", "amount"] {
            let mut legs_ = b.legs.clone();
            let l = &mut legs_[i];
            match field {
                "id" => l.id = flip_first_byte(&l.id),
                "token" => l.token = flip_first_byte(&l.token),
                "account" => l.account = flip_first_byte(&l.account),
                _ if l.kind == "payment" => l.amount = flip_first_byte(&l.amount),
                // one base unit more
                _ => l.amount = format!("{}.0000000001", l.amount.split('.').next().unwrap()),
            }
            assert_eq!(legs(&b.line_with(&legs_)), NOT_RECORDED, "leg {i}, {field}");
        }
        // the kind, to each of the others
        for kind in ["deposit", "withdrawal", "payment"] {
            if kind != b.legs[i].kind {
                let mut legs_ = b.legs.clone();
                legs_[i].kind = kind.into();
                // a payment's amount is hex, the other two's a Canton amount: keep the form of the new kind
                legs_[i].amount = match (kind, b.legs[i].kind.as_str()) {
                    ("payment", "payment") => unreachable!(),
                    ("payment", _) => hex(&word(10_000_000_000)),
                    (_, "payment") => "1.0".into(),
                    _ => legs_[i].amount.clone(),
                };
                if kind != "withdrawal" {
                    legs_[i].party = String::new();
                }
                assert_eq!(
                    legs(&b.line_with(&legs_)),
                    NOT_RECORDED,
                    "leg {i} as {kind}"
                );
            }
        }
    }
    // the withdrawal's party: another one, and none
    for party in [hex(b"alice::1220"), String::new()] {
        let mut legs_ = b.legs.clone();
        legs_[1].party = party;
        assert_eq!(legs(&b.line_with(&legs_)), NOT_RECORDED);
    }
}

#[test]
fn the_answer_does_not_depend_on_anything_but_the_line() {
    let b = gateway_block("three");
    let line = b.line();
    assert_eq!(legs(&line), legs(&line));
}

// --- the proofs

#[test]
fn a_flipped_byte_in_either_proof_is_refused() {
    for which in ["deposit", "three", "registered"] {
        let good = gateway_block(which);
        for i in 0..good.account_nodes.len() {
            let mut b = gateway_block(which);
            b.account_nodes[i] = flip_first_byte(&b.account_nodes[i]);
            assert_eq!(legs(&b.line()), ACCOUNT_BAD, "{which}: account node {i}");
        }
        for i in 0..good.storage_nodes.len() {
            let mut b = gateway_block(which);
            b.storage_nodes[i] = flip_first_byte(&b.storage_nodes[i]);
            assert_eq!(legs(&b.line()), STORAGE_BAD, "{which}: storage node {i}");
        }
    }
}

#[test]
fn proofs_for_another_state_root_are_refused() {
    let other = std::fs::read_to_string(format!(
        "{}/../mpt/fixtures/single_root.json",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    let other = serde_json::from_str::<serde_json::Value>(&other).unwrap();
    let mut b = gateway_block("three");
    b.state_root = other["state_root"]
        .as_str()
        .unwrap()
        .trim_start_matches("0x")
        .to_string();
    assert_eq!(legs(&b.line()), ACCOUNT_BAD);
    b.state_root = "00".repeat(32);
    assert_eq!(legs(&b.line()), ACCOUNT_BAD);
    // the parent's state, which has no legs of this block, with this block's proofs
    let (mut b, parent) = (gateway_block("three"), gateway_block("deposit"));
    b.state_root = parent.state_root;
    assert_eq!(legs(&b.line()), ACCOUNT_BAD);
}

#[test]
fn a_storage_proof_from_another_state_is_refused() {
    let other = std::fs::read_to_string(format!(
        "{}/../mpt/fixtures/single_proof.json",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    let other = serde_json::from_str::<serde_json::Value>(&other).unwrap();
    let mut b = gateway_block("three");
    b.storage_nodes = other["storageProof"][0]["proof"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n.as_str().unwrap().trim_start_matches("0x").to_string())
        .collect();
    assert_eq!(legs(&b.line()), STORAGE_BAD);
}

#[test]
fn the_proof_of_another_blocks_record_cannot_stand_in() {
    // Block 4's account proof and storage proof sit under block 4's root. Under block 3's root, or with
    // another number, they must not pass for block 3's record.
    let three = gateway_block("three");
    let deposit = gateway_block("deposit");
    // another block's storage proof with this block's account proof: it hangs from another storage root
    let mut b = deposit.clone();
    b.storage_nodes = three.storage_nodes.clone();
    assert_eq!(legs(&b.line()), STORAGE_BAD);
    // this block's proofs, claimed for another block number: the path to the entry is another one
    for number in [deposit.number + 1, deposit.number - 1, 0, 1 << 40] {
        let mut b = deposit.clone();
        b.number = number;
        let answer = legs(&b.line());
        assert_ne!(answer, deposit.ok(), "number {number}");
        assert!(answer.starts_with("no "), "number {number}: {answer}");
    }
    // the same for a block that recorded nothing: it cannot borrow an absence proof for another key
    let mut b = gateway_block("registered");
    b.number += 1;
    let answer = legs(&b.line());
    assert!(answer == STORAGE_BAD || answer == b.ok(), "{answer}");
}

#[test]
fn another_gateway_address_is_refused() {
    let mut b = gateway_block("three");
    b.gateway = "55".repeat(20);
    assert_eq!(legs(&b.line()), ACCOUNT_BAD);
}

#[test]
fn missing_proofs_are_refused() {
    let mut b = gateway_block("three");
    b.storage_nodes.clear();
    assert_eq!(legs(&b.line()), STORAGE_BAD);
    // a block that recorded nothing, in a gateway that has storage, needs its absence proof too
    let mut b = gateway_block("registered");
    b.storage_nodes.clear();
    assert_eq!(legs(&b.line()), STORAGE_BAD);
    let mut b = gateway_block("three");
    b.account_nodes.clear();
    assert_eq!(legs(&b.line()), ACCOUNT_BAD);
    // the empty storage of a gateway that has none is proven by the account proof alone
    let b = gateway_block("unused");
    assert!(b.storage_nodes.is_empty());
    assert_eq!(legs(&b.line()), b.ok());
    // ... and that proven zero refuses any legs attached
    let mut b = gateway_block("unused");
    b.legs = gateway_block("deposit").legs;
    assert_eq!(legs(&b.line()), NOT_RECORDED);
}

// --- amounts and hashing, on states written out by hand

#[test]
fn a_canton_amount_is_turned_into_base_units_exactly() {
    let units: [(&str, u128); 8] = [
        ("10.0", 100_000_000_000),
        ("0.25", 2_500_000_000),
        ("0.0000000001", 1),
        ("1.2345678901", 12_345_678_901),
        ("0.0", 0),
        ("007.50", 75_000_000_000),
        ("123456789.5", 1_234_567_895_000_000_000),
        (
            "9999999999999999999999999999.9999999999",
            99_999_999_999_999_999_999_999_999_999_999_999_999,
        ),
    ];
    for kind in ["deposit", "withdrawal"] {
        for (text, n) in units {
            let party = if kind == "withdrawal" {
                hex(b"carol::1220ab")
            } else {
                String::new()
            };
            let l = leg(kind, 1, 2, 3, text, &party);
            let b = recorded(vec![l], &[word(n)]);
            assert_eq!(legs(&b.line()), b.ok(), "{kind} {text}");
            // and one base unit more or less is another hash
            let b2 = recorded(b.legs.clone(), &[word(n + 1)]);
            assert_eq!(
                legs(&b2.line_with(&b.legs)),
                NOT_RECORDED,
                "{kind} {text} +1"
            );
        }
    }
}

#[test]
fn a_payment_amount_is_taken_as_written() {
    let max = [0xffu8; 32];
    for amount in [word(1), word(10u128.pow(18)), max] {
        let l = leg("payment", 4, 5, 6, &hex(&amount), "");
        let b = recorded(vec![l], &[amount]);
        assert_eq!(legs(&b.line()), b.ok(), "{}", hex(&amount));
    }
}

#[test]
fn legs_of_all_kinds_in_a_row_are_chained_from_zero() {
    let party = hex(b"dora::1220cd");
    let legs_ = vec![
        leg("deposit", 1, 2, 3, "5.0", ""),
        leg("withdrawal", 4, 2, 3, "0.5", &party),
        leg("payment", 5, 6, 7, &hex(&word(9)), ""),
        leg("deposit", 8, 2, 9, "0.0000000003", ""),
    ];
    let b = recorded(
        legs_,
        &[word(50_000_000_000), word(5_000_000_000), word(9), word(3)],
    );
    assert_eq!(legs(&b.line()), b.ok());
    assert!(b.ok().ends_with(" 4"));
}

#[test]
fn a_gateway_with_nothing_stored_proves_zero() {
    let b = hand_built(&"a7".repeat(20), 9, None, vec![]);
    assert_eq!(legs(&b.line()), b.ok());
    let b = hand_built(
        &"a7".repeat(20),
        9,
        None,
        vec![leg("deposit", 1, 2, 3, "1.0", "")],
    );
    assert_eq!(legs(&b.line()), NOT_RECORDED);
}

#[test]
fn a_stored_value_that_is_not_the_hash_of_the_legs_is_refused() {
    // One leg recorded; the line attaches none.
    let b = recorded(
        vec![leg("deposit", 1, 2, 3, "1.0", "")],
        &[word(10_000_000_000)],
    );
    assert_eq!(legs(&b.line_with(&[])), NOT_RECORDED);
    // The block recorded no legs, but the line attaches one.
    let empty = hand_built(&"a7".repeat(20), 9, Some([0; 32]), vec![]);
    assert_eq!(
        legs(&empty.line_with(&[leg("deposit", 1, 2, 3, "1.0", "")])),
        NOT_RECORDED
    );
}

// --- lines that are not well formed

#[test]
fn lines_that_are_not_well_formed_are_refused() {
    let b = gateway_block("three");
    let line = b.line();
    let (g, root) = (b.gateway.clone(), b.state_root.clone());
    let with_legs = |l: &str| b.line_of(l);
    let good = &b.legs;
    let one = good[0].text();
    let mut bad = vec![
        String::new(),
        format!("{line},"),
        line.replacen(',', "", 1),
        line.to_uppercase(),
        line.replacen(&root, &root[..62], 1),
        line.replacen(&root, &format!("{root}00"), 1),
        line.replacen(&g, &g[2..], 1),
        line.replacen(&g, &format!("{g}00"), 1),
        // the number
        line.replacen(&format!(",{},", b.number), ",x,", 1),
        line.replacen(&format!(",{},", b.number), ",-1,", 1),
        line.replacen(&format!(",{},", b.number), ",4.0,", 1),
        line.replacen(&format!(",{},", b.number), ",+4,", 1),
        line.replacen(&format!(",{},", b.number), ",99999999999999999999999,", 1),
        line.replacen(&format!(",{},", b.number), ",,", 1),
        // the proofs
        line.replace(';', ";;"),
        // the legs: separators
        with_legs(&format!("{one}|")),
        with_legs(&format!("|{one}")),
        with_legs(&format!("{one}||{one}")),
        with_legs(&format!("{one},{one}")),
        with_legs(&one.replacen('/', "", 1)),
        with_legs(&format!("{one}/")),
        with_legs(&one.replacen("deposit", "Deposit", 1)),
        with_legs(&one.replacen("deposit", "transfer", 1)),
        with_legs(&one.replacen("deposit", "", 1)),
        with_legs(&one.replacen("deposit", "1", 1)),
        // the id, token and account
        with_legs(&one.replacen(&good[0].id, &good[0].id[2..], 1)),
        with_legs(&one.replacen(&good[0].id, &format!("{}00", good[0].id), 1)),
        with_legs(&one.replacen(&good[0].token, &good[0].token[2..], 1)),
        with_legs(&one.replacen(&good[0].token, &format!("{}00", good[0].token), 1)),
        with_legs(&one.replacen(&good[0].account, &good[0].account.to_uppercase(), 1)),
        with_legs(&one.replacen(&good[0].account, &format!("0x{}", &good[0].account[2..]), 1)),
        // a party on a deposit, odd or capital hex in a party
        with_legs(&format!("{one}ab")),
        with_legs(
            &good[1]
                .text()
                .replacen(&good[1].party, &good[1].party[1..], 1),
        ),
        with_legs(
            &good[1]
                .text()
                .replacen(&good[1].party, &good[1].party.to_uppercase(), 1),
        ),
        with_legs(
            &good[2]
                .text()
                .replacen(&good[2].amount, &good[2].amount[2..], 1),
        ),
    ];
    // amounts
    for amount in [
        "10",
        "10.",
        ".5",
        "1.00000000001",
        "-1.0",
        "+1.0",
        "1e5",
        "1.0 ",
        " 1.0",
        "1,0",
        "1..0",
        "1.0.0",
        "1.+5",
        "0x10",
        "٣.0",
        "",
        "340282366920938463463374607431768211456.0",
        "99999999999999999999999999999.0",
        "1.0a",
        &hex(&word(1)),
    ] {
        for kind in ["deposit", "withdrawal"] {
            let party = if kind == "withdrawal" {
                hex(b"p")
            } else {
                String::new()
            };
            bad.push(with_legs(&leg(kind, 1, 2, 3, amount, &party).text()));
        }
    }
    for amount in [
        "1.0",
        "",
        &hex(&word(1))[1..],
        &format!("{}0", hex(&word(1))),
        &hex(&word(1)).to_uppercase().replace('0', "A"),
    ] {
        bad.push(with_legs(&leg("payment", 1, 2, 3, amount, "").text()));
    }
    for bad in bad {
        assert_eq!(legs(&bad), MALFORMED, "{bad}");
    }
}

#[test]
fn the_reasons_come_in_this_order() {
    // A malformed line is refused before its proofs are looked at.
    let mut b = gateway_block("three");
    b.account_nodes[0] = flip_first_byte(&b.account_nodes[0]);
    assert_eq!(legs(&b.line_of("x")), MALFORMED);
    // A bad account proof is refused before the storage proof.
    b.storage_nodes[0] = flip_first_byte(&b.storage_nodes[0]);
    assert_eq!(legs(&b.line()), ACCOUNT_BAD);
    // A good pair of proofs is refused for the legs last.
    let b = gateway_block("three");
    assert_eq!(legs(&b.line_with(&b.legs[..2])), NOT_RECORDED);
}
