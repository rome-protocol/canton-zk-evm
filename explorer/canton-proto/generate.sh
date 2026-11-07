#!/usr/bin/env bash
# Regenerates explorer/canton-proto/gen: TypeScript for the topology messages of Canton's protocol versions 30 and 31 and for the versioned wrapper around them, from the
# .proto files of the Canton release in PINS (tag v$CANTON_VERSION), with protobuf-ts (the plugin of explorer/package-lock.json: run `npm ci --ignore-scripts` in explorer first; the protoc is the release that package.json's config.protocVersion names).
# Each .proto is fetched by tag and checked against its SHA-256 in PROTOS, and the protoc archive against its SHA-256 in PROTOC; a file that does not match stops the script, and nothing is generated. The generated code is committed, so
# nothing else needs the network; CI runs this again and fails if the result is not what is committed. The pinned Canton's own topology answers (src/bridge/canton/fixtures.json) are decoded with it.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$here/../.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"
SCALAPB_TAG=v0.11.17
fail() { echo "FAIL: $*" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
files=()
while read -r sha source path; do
  case "$sha" in ""|"#"*) continue ;; esac
  case "$source" in
    canton) url=https://raw.githubusercontent.com/digital-asset/canton/v$CANTON_VERSION/community/base/src/main/protobuf/$path; files+=("$path") ;;
    scalapb) url=https://raw.githubusercontent.com/scalapb/ScalaPB/$SCALAPB_TAG/protobuf/$path ;;
    *) fail "PROTOS: unknown source $source" ;;
  esac
  mkdir -p "$work/$(dirname "$path")"
  curl -sSfL --retry 3 -A "Rome Protocol rome@romeprotocol.com" -o "$work/$path" "$url" || fail "cannot fetch $url"
  [ "$(sha256sum "$work/$path" | cut -d' ' -f1)" = "$sha" ] || fail "$path does not match its SHA-256 in PROTOS"
done < "$here/PROTOS"

cd "$here/.."
# protoc is pinned: its version is config.protocVersion in package.json, and its release archive is fetched here, checked against its SHA-256 in PROTOC, and only then unpacked where protobuf-ts
# looks for an installed protoc, so that protobuf-ts downloads nothing itself.
version=$(node -p 'require("./package.json").config.protocVersion')
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) build=linux-x86_64 ;;
  Linux-aarch64|Linux-arm64) build=linux-aarch_64 ;;
  Darwin-arm64) build=osx-aarch_64 ;;
  Darwin-x86_64) build=osx-x86_64 ;;
  *) fail "no pinned protoc for $(uname -s) $(uname -m)" ;;
esac
release=protoc-$version-$build
want=$(awk -v r="$release" '$2 == r { print $1 }' canton-proto/PROTOC)
[ -n "$want" ] || fail "PROTOC has no SHA-256 for $release"
curl -sSfL --retry 3 -A "Rome Protocol rome@romeprotocol.com" -o "$work/$release.zip" "https://github.com/protocolbuffers/protobuf/releases/download/v$version/$release.zip" || fail "cannot fetch $release.zip"
[ "$(sha256sum "$work/$release.zip" | cut -d' ' -f1)" = "$want" ] || fail "$release.zip does not match its SHA-256 in PROTOC"
installed=node_modules/@protobuf-ts/protoc/installed
rm -rf "${installed:?}/$release"
mkdir -p "$installed/$release"
unzip -q "$work/$release.zip" -d "$installed/$release"
chmod +x "$installed/$release/bin/protoc"
rm -rf canton-proto/gen
mkdir -p canton-proto/gen
# protobuf-ts's protoc (the one unpacked above) finds the plugin in node_modules/.bin. The well-known types come from that protoc's own include folder, and are named
# below, so that the generated code can import them.
npx --no-install protoc --version > /dev/null
include=$installed/$release/include
[ -f "$include/google/protobuf/timestamp.proto" ] || fail "protobuf-ts's protoc has no include folder"
mkdir -p "$work/google/protobuf"
cp "$include/google/protobuf/timestamp.proto" "$include/google/protobuf/duration.proto" "$include/google/protobuf/descriptor.proto" "$work/google/protobuf/"
npx --no-install protoc --proto_path "$work" --ts_out canton-proto/gen --ts_opt optimize_code_size --ts_opt force_exclude_all_options \
  "${files[@]}" google/protobuf/timestamp.proto google/protobuf/duration.proto
# The generated imports name their files without an extension; this explorer's imports (NodeNext, allowImportingTsExtensions) name them with .ts, so the types of one generated file reach the next.
find canton-proto/gen -name '*.ts' -exec sed -i -E 's#^(import .* from "\.\.?/[^"]*)";#\1.ts";#' {} +
# Nothing imports descriptor.ts (the scalapb options file was only parsed), and the generated code is not held to this explorer's strict checks (it declares enums, which erasableSyntaxOnly refuses): each file says so.
rm -f canton-proto/gen/google/protobuf/descriptor.ts
find canton-proto/gen -name '*.ts' | while read -r f; do { echo "// @ts-nocheck"; cat "$f"; } > "$f.part" && mv "$f.part" "$f"; done
