# explorer/verify

The check a confirmer's sidecar runs on a block, built for WebAssembly, for the explorer's Verify button to run in the visitor's browser.

`zk_sidecar::verify` is that check. It runs the PLONK check from the `verifier` crate, reads the block hash the proof commits to, and checks the header and the transactions against it. It uses no network and no clock. This crate builds it unchanged and adds a plain C interface to it, so the build needs only Rust's `wasm32-unknown-unknown` target, with no wasm-bindgen and no other tool. It depends on the sidecar crate by path and does not turn on the sidecar's test feature, so nothing here can replace the proof check.

## Build

From the repository root:

```sh
cd explorer/verify
rustup target add wasm32-unknown-unknown
cargo build --locked --release --target wasm32-unknown-unknown
```

The file is `target/wasm32-unknown-unknown/release/zk_explorer_verify.wasm`. `build.sh` (or `npm run build:verify` in `explorer/`) does the same build and copies the file to `explorer/public/verify/`, where the explorer's build takes it from to serve it as `/verify/zk_explorer_verify.wasm`. Built by the explorer's image, it is about 170 KB. The exact size depends on the build folder because panic messages include source paths.

In Node's WebAssembly (V8) on GitHub's CI runners, one check took 8 to 32 ms. The timed check verifies the recorded proof, then refuses a header that does not match it. A successful full-block check has not been benchmarked. No test here runs the module in a browser yet, so this README does not say how long it takes in one. The Verify panel measures that on each visitor's machine, with the browser's own clock, and shows it after each run. It says the file's size before the first press.

## The interface

The module imports nothing. It exports its `memory` and four functions:

| Export | What it does |
|---|---|
| `alloc(len)` | Returns the address of `len` bytes of room for the caller's input |
| `dealloc(ptr, len)` | Gives that room back |
| `verify_block(pins, line, line_len)` | `pins` is 64 bytes: the program key, then the ZisK release root. `line` is `proofHex,headerHex,txsHex` as text. Returns the length of the answer |
| `answer_ptr()` | The address of the answer's bytes. It stays until the next call |

The answer is the sidecar's own: `ok` and ten facts, or `no` and the reason. The reasons are listed in [sidecar/README.md](../../sidecar/README.md). Bytes that are not text get `no malformed input`.

The loader that calls these is `explorer/src/verify/verifier.ts`. The panel that shows the result is `explorer/src/verify/VerifyPanel.tsx`.

## Keeping the lockfiles together

The module is built with this crate's `Cargo.lock`, and the confirmers' sidecar with `sidecar/Cargo.lock`. `check-lock-versions.sh` fails when a crate that is in both is locked at different versions, so the check in the browser is built from the same crate versions as the one the sidecars run. CI runs it in the `verify-wasm` job. To fix a difference, move one lockfile to the other's version with `cargo update --precise`.

## Tests

From the repository root:

```sh
cd explorer/verify
cargo test --locked
```

They check that the export answers exactly as the sidecar's `verify` does, on the recorded session proof (`prover/fixtures/wrapped-proof.hex`) and on a real block that is not its own:

- with the proof and a header that is not its block's, the proof half passes and the answer is `no the header does not hash to the proven block hash`;
- with one proof byte flipped, `no the proof does not verify`;
- with other pins, `no the proof was made by another program or ZisK release`;
- with a proof of the wrong length, and with lines that are not well formed, the sidecar's own answers;
- through the exported functions, the same answers as the plain call.

There is no test of a full pass yet, because the recorded results do not hold a header and transactions for the session proof. CI also builds the module and asks the built file the same questions through the loader (`explorer/src/verify/verifier.test.ts`), and loads it through the panel's own download in a jsdom page (`explorer/src/verify/VerifyPanel.test.tsx`). Both run in Node's WebAssembly, not in a browser.
