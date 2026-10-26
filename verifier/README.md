# zk-verifier

Checks the wrapped ZisK proof, a PLONK proof over BN254, in plain Rust. It takes the 1,344-byte form (proof 768 bytes, programVK 32, rootC 32, publicValues 512) and answers yes or no:

```rust
use zk_verifier::{verify, vk};

let accepted: Result<bool, zk_verifier::Error> = verify(&vk::ZISK_1_3_1, &input);
```

`Ok(true)` accepts, `Ok(false)` rejects a well-formed proof that does not check out, and an error means the input is not a proof (wrong length, a number out of range, a point off the curve).

## The verifying key

ZisK 1.2.0 has its own key, so a 1.2.0 proof is refused under the 1.3 key. ZisK 1.3.1 and ZisK 1.3.2 have one key between them: the wrapping circuit did not change, and the sixteen numbers read from the PLONK setup that ZisK 1.3.2 installs are the ones read from 1.3.1's `PlonkVerifier.sol` (upstream's `zisk-contracts/PlonkVerifier.sol` is byte for byte the same at both tags). The crate names the key once for each release, so a caller picks the key by release and does not have to know that two releases share one. What tells a 1.3.1 proof from a 1.3.2 proof is the program key and the root of the final circuit, which the caller pins (the sidecar and the explorer do). The crate exposes:

| Key | Where it comes from |
|---|---|
| `vk::ZISK_1_3_1` | `zisk-contracts/PlonkVerifier.sol` at tag `v1.3.1-alpha` of github.com/0xPolygonHermez/zisk (commit `306a9c934ba4947b1d586d69b67120f8b4c41466`) |
| `vk::ZISK_1_3_2` | the same key, found again in the `PlonkVerifier.sol` that the SNARK setup of ZisK 1.3.2-alpha (commit `1e22630bb7e143c30705a1603ed87cfd3da8c6ec`) installs. The tests check that it is equal to `ZISK_1_3_1` |

The root of the final circuit that each release pins (`rootC`) is the `vadcop_final` root in ZisK's own published `zisk-verifykey-<release>.tar.gz` (`vadcop_final.verkey.bin`, four little-endian 64-bit words), for 1.3.1-alpha and for 1.3.2-alpha, so the pins have a second source besides the installed setup.

ZisK 1.3.1 has a soundness advisory that 1.3.2 fixes (see [SECURITY.md](../SECURITY.md)). The 1.3.1 key stays for the blocks that chains proved under 1.3.1; new proofs are 1.3.2's.

The ZisK 1.2.0 key is in the source too, but only for the tests: it sits behind the `zisk-1-2-0-test-key` feature, which the crate's own dev-dependency switches on. It lets the tests check that a 1.2.0 proof is refused under the 1.3 key and the other way round. A crate that depends on `zk-verifier` does not get it unless it turns the feature on by name.

The curve constants, the domain and the G2 points are the same in all the releases' files.

## Test data

`fixtures/` holds proofs of three test blocks (14, 166 and 169) made with ZisK 1.2.0, with ZisK 1.3.1 and with ZisK 1.3.2 (`fixtures/zisk-1.2.0`, `zisk-1.3.1`, `zisk-1.3.2`; the 1.3.2 proofs are of the same blocks, from the same unmodified zisk-eth-client guest at v0.13.1, built against 1.3.2). They are public data: a proof, its program key, the root of the final circuit and its public values. Each proof is accepted under its own release's key and refused under the other's. For 1.3.1 and 1.3.2, which share a key, the tests check that the pins tell them apart: a proof with the other release's program key or root is refused, and so is a proof that is altered. The tests also change proofs in many ways (every single bit of one proof, a negated or missing commitment, another block's data) and check the exact answer for each. `fixtures/SHA256SUMS` lists the checksum of each fixture file; check it with `cd fixtures && sha256sum -c SHA256SUMS`.

```sh
cd verifier             # from the repository root
cargo test
```

Copyright 2026 Rome Protocol. Licensed under the Apache License 2.0.
