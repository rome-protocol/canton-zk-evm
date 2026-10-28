#!/usr/bin/env bash
# Build the stub-form DAR, then run the Daml Script tests (test/) against it in memory. SDK_VERSION and TARGET pick another
# toolchain than daml.yaml's (the pinned one is DAML_SDK_VERSION and DAML_TARGET in PINS).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
"$here/build.sh" stub
t=$here/build/test
rm -rf "$t"; mkdir -p "$t"
cp -r "$here/test/src" "$t/src"
sed "s|__DARS__|$here/dars|; s|__DAR__|$here/dist/canton-zk-evm-stub.dar|; s|__TWIN__|$(cd "$here/../apps/twin" && pwd)/dist/ostia-twin.dar|" "$here/test/daml.yaml" > "$t/daml.yaml"
if [ -n "${SDK_VERSION:-}" ]; then   # the same toolchain as build.sh used for the stub form
  sed -i.bak "s|^sdk-version:.*|sdk-version: $SDK_VERSION|; s|--target=2.1|--target=${TARGET:-2.4}|" "$t/daml.yaml"
fi
(cd "$t" && dpm test)
