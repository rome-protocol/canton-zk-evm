#!/usr/bin/env bash
# Build the DAR, then run the Daml Script tests (test/) against it in memory.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
dars=$(cd "$here/../../daml/dars" && pwd)
"$here/build.sh"
t=$here/build/test
rm -rf "$t"; mkdir -p "$t"
cp -r "$here/test/src" "$t/src"
sed "s|__DARS__|$dars|; s|__DAR__|$here/dist/ostia-twin.dar|" "$here/test/daml.yaml" > "$t/daml.yaml"
if [ -n "${SDK_VERSION:-}" ]; then
  sed -i.bak "s|^sdk-version:.*|sdk-version: $SDK_VERSION|; s|--target=2.1|--target=${TARGET:-2.4}|" "$t/daml.yaml"
fi
(cd "$t" && dpm test)
