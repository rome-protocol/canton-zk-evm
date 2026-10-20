#!/usr/bin/env bash
# Fetches the released Canton (CANTON_VERSION in PINS) from its release tarball and prints the path of its jar.
# The tarball is checked against CANTON_TARBALL_SHA256 before anything is taken out of it, and the jar against
# CANTON_JAR_SHA256 after; a changed file is refused. A jar that is already there and matches is kept (no download).
# Usage: fetch-jar.sh <folder for the jar> [tarball sha256] [jar sha256]    (default: the pins)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"
fail() { echo "FAIL: $*" >&2; exit 1; }
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
dir=${1:?usage: fetch-jar.sh <folder> [tarball sha256] [jar sha256]}
tar_sha=${2:-$CANTON_TARBALL_SHA256}
jar_sha=${3:-$CANTON_JAR_SHA256}
[[ $tar_sha =~ ^[0-9a-f]{64}$ && $jar_sha =~ ^[0-9a-f]{64}$ ]] || fail "a pinned SHA-256 is missing or malformed"

name=canton-open-source-$CANTON_VERSION
JAR=$dir/$name.jar
if [ ! -f "$JAR" ] || [ "$(sha "$JAR")" != "$jar_sha" ]; then
  mkdir -p "$dir"
  tmp=$(mktemp -d "$dir/fetch.XXXXXX"); trap 'rm -rf "$tmp"' EXIT
  curl -sSfL -o "$tmp/$name.tar.gz" "$CANTON_TARBALL_URL" || fail "could not download $CANTON_TARBALL_URL"
  [ "$(sha "$tmp/$name.tar.gz")" = "$tar_sha" ] || fail "the Canton release tarball does not match CANTON_TARBALL_SHA256"
  tar -xzf "$tmp/$name.tar.gz" -C "$tmp" --strip-components=2 "$name/lib/$name.jar" || fail "the tarball has no $name/lib/$name.jar"
  [ "$(sha "$tmp/$name.jar")" = "$jar_sha" ] || fail "the Canton jar does not match CANTON_JAR_SHA256"
  mv "$tmp/$name.jar" "$JAR"
fi
echo "$JAR"
