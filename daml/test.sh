#!/usr/bin/env bash
# Build the stub-form DAR, then run the Daml Script tests (test/) against it in memory.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
"$here/build.sh" stub
t=$here/build/test
rm -rf "$t"; mkdir -p "$t"
cp -r "$here/test/src" "$t/src"
sed "s|__DARS__|$here/dars|; s|__DAR__|$here/dist/canton-zk-evm-stub.dar|" "$here/test/daml.yaml" > "$t/daml.yaml"
(cd "$t" && dpm test)
