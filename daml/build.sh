#!/usr/bin/env bash
# Build the DAR in one of its two forms. The only difference is the Zk.Sidecar module (sidecar/<form>.daml).
#   build.sh stub      the form the tests run against: the sidecar's answers come from a small table. It builds with the
#                      sdk-version and target of daml.yaml, or with SDK_VERSION and TARGET if given (as for external).
#   build.sh external  the form a Canton node runs: Zk.Sidecar calls DA.ExternalCall. It needs a Daml toolchain
#                      that has DA.ExternalCall; give it with SDK_VERSION (and optionally TARGET, default 2.4: the first
#                      Daml-LF version with the external call, from the Daml 3.6 release).
#                      network/canton/build-dar.sh does this with the toolchain pinned in PINS.
# Writes dist/canton-zk-evm-<form>.dar. The stub form's package is named canton-zk-evm-stub, so it can never be
# mistaken for, or loaded in place of, the real one. The build happens in a copy under build/, so the sources stay clean.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
form=${1:?usage: build.sh stub|external}
b=$here/build/$form
rm -rf "$b"; mkdir -p "$b" "$here/dist"
cp -r "$here/src" "$b/src"
cp "$here/sidecar/$form.daml" "$b/src/Zk/Sidecar.daml"
# The chain package depends on the twin app's DAR (from 0.5.0). While the chain package is 0.5.0, that is ostia-twin 0.1.0, as the
# live 0.5.0 was built (both package ids are in PINS), not the current twin source: it is built here from the source commit that
# PINS names (TWIN_V0_1_0_COMMIT), with the same toolchain as the chain package. A new chain version moves this pin with it.
commit=$(sed -n 's/^TWIN_V0_1_0_COMMIT=//p' "$here/../PINS")
[[ $commit =~ ^[0-9a-f]{40}$ ]] || { echo "FAIL: PINS has no TWIN_V0_1_0_COMMIT" >&2; exit 1; }
git -C "$here/.." cat-file -e "$commit^{tree}" 2>/dev/null || git -C "$here/.." fetch --no-tags --depth=1 origin "$commit" >&2
twinsrc=$here/../apps/twin/build/src-0.1.0
rm -rf "$twinsrc"; mkdir -p "$twinsrc"
git -C "$here/.." archive "$commit" apps/twin/src apps/twin/daml.yaml | tar -x -C "$twinsrc"
grep -qx 'version: 0.1.0' "$twinsrc/apps/twin/daml.yaml" || { echo "FAIL: $commit has no ostia-twin 0.1.0" >&2; exit 1; }
TWIN_SRC=$twinsrc/apps/twin "$here/../apps/twin/build.sh" >&2
twin=$(cd "$here/../apps/twin" && pwd)/dist/ostia-twin-0.1.0.dar
sed "s|__DARS__|$here/dars|; s|__TWIN__|$twin|" "$here/daml.yaml" > "$b/daml.yaml"
if [ "$form" = stub ]; then
  sed -i.bak "s|^name: canton-zk-evm\$|name: canton-zk-evm-stub|" "$b/daml.yaml"
fi
if [ "$form" = external ]; then
  sed -i.bak "s|^sdk-version:.*|sdk-version: ${SDK_VERSION:?external form needs SDK_VERSION}|; s|--target=2.1|--target=${TARGET:-2.4}|" "$b/daml.yaml"
elif [ -n "${SDK_VERSION:-}" ]; then
  # The stub form, on another toolchain (the one network/canton/build-dar.sh pins): SDK_VERSION and TARGET as above.
  sed -i.bak "s|^sdk-version:.*|sdk-version: $SDK_VERSION|; s|--target=2.1|--target=${TARGET:-2.4}|" "$b/daml.yaml"
fi
(cd "$b" && dpm build -o "$here/dist/canton-zk-evm-$form.dar")
