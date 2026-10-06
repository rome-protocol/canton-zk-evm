# zk-verifier

Checks the wrapped ZisK proof, a PLONK proof over BN254, in plain Rust. It takes the 1,344-byte form (proof 768 bytes, programVK 32, rootC 32, publicValues 512) and answers yes or no:

```rust
use zk_verifier::{verify, vk};

let accepted: Result<bool, zk_verifier::Error> = verify(&vk::ZISK_1_3_1, &input);
```

`Ok(true)` accepts, `Ok(false)` rejects a well-formed proof that does not check out, and an error means the input is not a proof (wrong length, a number out of range, a point off the curve).

## The verifying key

Each ZisK release has its own key, so a proof from one release is refused under the other's. The caller pins a release by choosing the key. The crate exposes one:

| Key | Where it comes from |
|---|---|
| `vk::ZISK_1_3_1` | `zisk-contracts/PlonkVerifier.sol` at tag `v1.3.1-alpha` of github.com/0xPolygonHermez/zisk (commit `306a9c934ba4947b1d586d69b67120f8b4c41466`) |

The ZisK 1.2.0 key is in the source too, but only for the tests: it sits behind the `zisk-1-2-0-test-key` feature, which the crate's own dev-dependency switches on. It lets the tests check that a 1.2.0 proof is refused under the 1.3.1 key and the other way round. A crate that depends on `zk-verifier` does not get it unless it turns the feature on by name.

The curve constants, the domain and the G2 points are the same in both releases' files.

## Test data

`fixtures/` holds proofs of three test blocks (14, 166 and 169) made with ZisK 1.2.0 and with ZisK 1.3.1. They are public data: a proof, its program key, the root of the final circuit and its public values. Each proof is accepted under its own release's key and refused under the other's. The tests also change proofs in many ways (every single bit of one proof, a negated or missing commitment, another block's data) and check the exact answer for each. `fixtures/SHA256SUMS` lists the checksum of each fixture file; check it with `cd fixtures && sha256sum -c SHA256SUMS`.

```sh
cd verifier             # from the repository root
cargo test
```

Copyright 2026 Rome Protocol. Licensed under the Apache License 2.0.
