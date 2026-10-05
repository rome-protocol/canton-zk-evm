#!/usr/bin/env bash
# Build the DAR in one of its two forms. The only difference is the Zk.Sidecar module (sidecar/<form>.daml).
#   build.sh stub      the form the tests run against: the sidecar's answers come from a small table
#   build.sh external  the form a Canton node runs: Zk.Sidecar calls DA.ExternalCall. It needs a Daml toolchain
#                      that has DA.ExternalCall; give it with SDK_VERSION (and optionally TARGET, default 2.4: the first
#                      Daml-LF version with the external call, from the Daml 3.6 snapshot line; 3.6 is not released
#                      yet). network/canton/build-dar.sh does this with the toolchain pinned in PINS.
# Writes dist/canton-zk-evm-<form>.dar. The stub form's package is named canton-zk-evm-stub, so it can never be
# mistaken for, or loaded in place of, the real one. The build happens in a copy under build/, so the sources stay clean.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
form=${1:?usage: build.sh stub|external}
b=$here/build/$form
rm -rf "$b"; mkdir -p "$b" "$here/dist"
cp -r "$here/src" "$b/src"
cp "$here/sidecar/$form.daml" "$b/src/Zk/Sidecar.daml"
sed "s|__DARS__|$here/dars|" "$here/daml.yaml" > "$b/daml.yaml"
if [ "$form" = stub ]; then
  sed -i.bak "s|^name: canton-zk-evm\$|name: canton-zk-evm-stub|" "$b/daml.yaml"
fi
if [ "$form" = external ]; then
  sed -i.bak "s|^sdk-version:.*|sdk-version: ${SDK_VERSION:?external form needs SDK_VERSION}|; s|--target=2.1|--target=${TARGET:-2.4}|" "$b/daml.yaml"
fi
(cd "$b" && dpm build -o "$here/dist/canton-zk-evm-$form.dar")
