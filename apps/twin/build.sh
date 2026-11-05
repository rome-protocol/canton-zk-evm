#!/usr/bin/env bash
# Build the app's DAR: dist/ostia-twin-<version>.dar, and dist/ostia-twin.dar (the same file) for the source in this directory.
# The build happens in a copy under build/, so the sources stay clean. SDK_VERSION and TARGET pick another toolchain than daml.yaml's.
# TWIN_SRC names another copy of the app (a directory with src/ and daml.yaml): daml/build.sh builds the 0.1.0 source this way
# (see TWIN_V0_1_0_COMMIT in PINS). Then only dist/ostia-twin-<version>.dar is written.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
src=${TWIN_SRC:-$here}
dars=$(cd "$here/../../daml/dars" && pwd)
version=$(sed -n 's/^version: *//p' "$src/daml.yaml")
b=$here/build/app-$version
rm -rf "$b"; mkdir -p "$b" "$here/dist"
cp -r "$src/src" "$b/src"
sed "s|__DARS__|$dars|" "$src/daml.yaml" > "$b/daml.yaml"
if [ -n "${SDK_VERSION:-}" ]; then
  sed -i.bak "s|^sdk-version:.*|sdk-version: $SDK_VERSION|; s|--target=2.1|--target=${TARGET:-2.4}|" "$b/daml.yaml"
fi
(cd "$b" && dpm build -o "$here/dist/ostia-twin-$version.dar")
[ -n "${TWIN_SRC:-}" ] || cp "$here/dist/ostia-twin-$version.dar" "$here/dist/ostia-twin.dar"
