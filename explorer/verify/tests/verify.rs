//! The crate answers exactly as the sidecar's `verify` does, on the recorded session proof (a real
//! proof of block 1 of a throwaway copy of the chain) and on blocks that do not belong to it. The
//! last test goes through the exported functions the browser calls.

use zk_explorer_verify::{alloc, answer, answer_ptr, dealloc, verify_block};

const ROOT: &str = env!("CARGO_MANIFEST_DIR");

fn unhex(s: &str) -> Vec<u8> {
    assert!(s.len().is_multiple_of(2), "odd hex");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// The two pins from the recorded session, and its proof.
struct Session {
    program_vk: [u8; 32],
    root_c: [u8; 32],
    proof: Vec<u8>,
}

fn session() -> Session {
    let text =
        std::fs::read_to_string(format!("{ROOT}/../../prover/fixtures/session.txt")).unwrap();
    let pin = |key: &str| -> [u8; 32] {
        let value = text
            .lines()
            .find_map(|l| l.strip_prefix(&format!("{key}=0x")))
            .unwrap_or_else(|| panic!("session.txt has no {key}"));
        unhex(value).try_into().unwrap()
    };
    let proof =
        std::fs::read_to_string(format!("{ROOT}/../../prover/fixtures/wrapped-proof.hex")).unwrap();
    Session {
        program_vk: pin("programVK"),
        root_c: pin("rootC"),
        proof: unhex(proof.trim()),
    }
}

/// A real block, but not the one the session proof is for: the sidecar's own test block.
fn other_block() -> (Vec<u8>, Vec<u8>) {
    let text = std::fs::read(format!("{ROOT}/../../sidecar/tests/fixtures/block.json")).unwrap();
    let j: serde_json::Value = serde_json::from_slice(&text).unwrap();
    let field = |k: &str| unhex(j[k].as_str().unwrap());
    (field("header"), field("txs"))
}

fn line(proof: &[u8], header: &[u8], txs: &[u8]) -> String {
    format!("{},{},{}", hex(proof), hex(header), hex(txs))
}

/// What the sidecar answers, asked the way the sidecar asks.
fn sidecar(s: &Session, line: &str) -> String {
    zk_sidecar::verify(&zk_sidecar::Config::new(s.program_vk, s.root_c), line)
}

fn check(s: &Session, line: &str, expected: &str) {
    assert_eq!(answer(s.program_vk, s.root_c, line.as_bytes()), expected);
    assert_eq!(
        sidecar(s, line),
        expected,
        "the sidecar answers differently"
    );
}

#[test]
fn the_session_proof_with_a_header_that_is_not_its_block_passes_the_proof_half_only() {
    let s = session();
    let (header, txs) = other_block();
    check(
        &s,
        &line(&s.proof, &header, &txs),
        "no the header does not hash to the proven block hash",
    );
}

#[test]
fn one_flipped_proof_byte_does_not_verify() {
    let s = session();
    let (header, txs) = other_block();
    let mut proof = s.proof.clone();
    proof[10] ^= 1;
    check(
        &s,
        &line(&proof, &header, &txs),
        "no the proof does not verify",
    );
}

#[test]
fn other_pins_refuse_a_proof_that_verifies() {
    let s = session();
    let (header, txs) = other_block();
    let line = line(&s.proof, &header, &txs);
    let mut other = session();
    other.program_vk[0] ^= 1;
    assert_eq!(
        answer(other.program_vk, other.root_c, line.as_bytes()),
        "no the proof was made by another program or ZisK release"
    );
    assert_eq!(
        sidecar(&other, &line),
        answer(other.program_vk, other.root_c, line.as_bytes())
    );
}

#[test]
fn a_proof_of_the_wrong_length_is_refused() {
    let s = session();
    let (header, txs) = other_block();
    check(
        &s,
        &line(&s.proof[1..], &header, &txs),
        "no the proof is not 1,344 bytes",
    );
}

#[test]
fn lines_that_are_not_well_formed_are_malformed_input() {
    let s = session();
    let proof = hex(&s.proof);
    for bad in [
        String::new(),
        "zz,00,00".to_string(),
        format!("{proof},00"),
        format!("{proof},00,00,00"),
        format!("{},00,", proof.to_uppercase()),
        format!("{proof},0,"),
    ] {
        check(&s, &bad, "no malformed input");
    }
    // Bytes that are not text at all get the same answer.
    assert_eq!(
        answer(s.program_vk, s.root_c, &[0xff, 0xfe]),
        "no malformed input"
    );
}

#[test]
fn the_exported_functions_answer_the_same() {
    let s = session();
    let (header, txs) = other_block();
    let pins = [s.program_vk, s.root_c].concat();
    for line in [
        line(&s.proof, &header, &txs),
        "nonsense".to_string(),
        String::new(),
    ] {
        let expected = answer(s.program_vk, s.root_c, line.as_bytes());
        // Copy the input in the way the browser does.
        let (pins_at, line_at) = (alloc(pins.len()), alloc(line.len()));
        let got = unsafe {
            std::ptr::copy_nonoverlapping(pins.as_ptr(), pins_at, pins.len());
            std::ptr::copy_nonoverlapping(line.as_ptr(), line_at, line.len());
            let len = verify_block(pins_at, line_at, line.len());
            let text = std::slice::from_raw_parts(answer_ptr(), len).to_vec();
            dealloc(pins_at, pins.len());
            dealloc(line_at, line.len());
            String::from_utf8(text).unwrap()
        };
        assert_eq!(got, expected);
    }
}
