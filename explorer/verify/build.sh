#!/bin/sh
# Builds the Verify check for WebAssembly and puts the file where the explorer serves it from: explorer/public/verify/. The pages' build
# (`npm run build`) then copies it to dist/verify/. Needs Rust's wasm32-unknown-unknown target (`rustup target add wasm32-unknown-unknown`).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
cargo build --locked --release --target wasm32-unknown-unknown --manifest-path "$here/Cargo.toml"
mkdir -p "$here/../public/verify"
cp "$here/target/wasm32-unknown-unknown/release/zk_explorer_verify.wasm" "$here/../public/verify/zk_explorer_verify.wasm"
echo "explorer/public/verify/zk_explorer_verify.wasm: $(wc -c < "$here/../public/verify/zk_explorer_verify.wasm" | tr -d ' ') bytes"
