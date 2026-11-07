#!/usr/bin/env bash
# Regenerates explorer/canton-proto/gen: TypeScript for the topology messages of Canton's protocol versions 30 and 31 and for the versioned wrapper around them, from the
# .proto files of the Canton release in PINS (tag v$CANTON_VERSION), with protobuf-ts (the plugin and protoc of explorer/package-lock.json: run `npm ci --ignore-scripts` in explorer first).
# Each .proto is fetched by tag and checked against its SHA-256 in PROTOS; a file that does not match stops the script, and nothing is generated. The generated code is committed, so
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
rm -rf canton-proto/gen
mkdir -p canton-proto/gen
# protobuf-ts's protoc (it brings its own, fetched on first use) finds the plugin in node_modules/.bin. The well-known types come from that protoc's own include folder, and are named
# below, so that the generated code can import them.
npx --no-install protoc --version > /dev/null
include=$(ls -d node_modules/@protobuf-ts/protoc/installed/*/include | head -n 1)
[ -f "$include/google/protobuf/timestamp.proto" ] || fail "protobuf-ts's protoc has no include folder"
mkdir -p "$work/google/protobuf"
cp "$include/google/protobuf/timestamp.proto" "$include/google/protobuf/duration.proto" "$include/google/protobuf/descriptor.proto" "$work/google/protobuf/"
npx --no-install protoc --proto_path "$work" --ts_out canton-proto/gen --ts_opt optimize_code_size --ts_opt import_extension=.ts --ts_opt force_exclude_all_options \
  "${files[@]}" google/protobuf/timestamp.proto google/protobuf/duration.proto
