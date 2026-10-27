#!/usr/bin/env bash
# Build the app's DAR: dist/otc-venue.dar. The build happens in a copy under build/, so the sources stay clean. SDK_VERSION
# and TARGET pick another toolchain than daml.yaml's.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
dars=$(cd "$here/../../daml/dars" && pwd)
b=$here/build/app
rm -rf "$b"; mkdir -p "$b" "$here/dist"
cp -r "$here/src" "$b/src"
sed "s|__DARS__|$dars|" "$here/daml.yaml" > "$b/daml.yaml"
if [ -n "${SDK_VERSION:-}" ]; then
  sed -i.bak "s|^sdk-version:.*|sdk-version: $SDK_VERSION|; s|--target=2.1|--target=${TARGET:-2.4}|" "$b/daml.yaml"
fi
(cd "$b" && dpm build -o "$here/dist/otc-venue.dar")
