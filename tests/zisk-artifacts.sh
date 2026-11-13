#!/usr/bin/env bash
# prover/zisk-artifacts.sh, the part of install.sh that checks the ZisK release files: a file is used only with its pinned SHA-256,
# a kept copy is used without a download, and the copy of ziskup that installs from the checked files differs from the pinned
# ziskup in its two download addresses and nothing else. Needs no GPU; it downloads the pinned ziskup (checked against PINS).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
set -a
# shellcheck disable=SC1091
. "$ROOT/PINS"
set +a
fail() { echo "FAIL: $*" >&2; exit 1; }
# shellcheck disable=SC1091
. "$ROOT/prover/zisk-artifacts.sh"

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/upstream" "$T/art"
printf 'a release file\n' > "$T/upstream/key.tar.gz"
good=$(sha256sum "$T/upstream/key.tar.gz" | cut -d' ' -f1)
bad=$(printf 'something else\n' | sha256sum | cut -d' ' -f1)

# A download whose checksum is not the pinned one is refused and leaves nothing behind.
if (zisk_fetch_checked "file://$T/upstream/key.tar.gz" "$T/art/key.tar.gz" "$bad") 2>/dev/null; then fail "a file with another checksum was accepted"; fi
[ ! -e "$T/art/key.tar.gz" ] && [ ! -e "$T/art/key.tar.gz.part" ] || fail "a refused download left a file"

# The pinned checksum: downloaded, kept, and an md5 file ziskup can check written next to it.
out=$(zisk_fetch_checked "file://$T/upstream/key.tar.gz" "$T/art/key.tar.gz" "$good")
[[ $out == *downloaded* ]] || fail "the file was not downloaded: $out"
( cd "$T/art" && md5sum -c --status key.tar.gz.md5 ) || fail "the md5 file does not check the file"
grep -qE '^[0-9a-f]{32}  key\.tar\.gz$' "$T/art/key.tar.gz.md5" || fail "the md5 file does not name the file by its bare name"

# A kept copy with the pinned checksum is used without a download (the upstream file is gone).
rm "$T/upstream/key.tar.gz"
out=$(zisk_fetch_checked "file://$T/upstream/key.tar.gz" "$T/art/key.tar.gz" "$good")
[[ $out == *present* ]] || fail "a kept copy was not used: $out"

# A kept copy that does not match is not used: it is downloaded again, and refused when that fails.
printf 'changed\n' > "$T/art/key.tar.gz"
if (zisk_fetch_checked "file://$T/upstream/key.tar.gz" "$T/art/key.tar.gz" "$good") 2>/dev/null; then fail "a changed kept copy was used"; fi

# The local copy of the pinned ziskup: two lines differ, and they point at the folder.
curl -sSfL -o "$T/ziskup" "https://raw.githubusercontent.com/0xPolygonHermez/zisk/v${ZISK_VERSION}/ziskup/ziskup"
echo "$ZISKUP_SHA256  $T/ziskup" | sha256sum -c --status - || fail "ziskup does not match ZISKUP_SHA256"
zisk_local_installer "$T/ziskup" "$T/ziskup-local" "$T/art"
changed=$(diff "$T/ziskup" "$T/ziskup-local" | grep '^>' || true)
[ "$(printf '%s\n' "$changed" | wc -l)" = 2 ] || fail "the local copy does not differ in exactly two lines"
grep -qx "> BUCKET_URL=\"file://$T/art\"" <<< "$changed" || fail "the key bucket is not the folder: $changed"
grep -qE "^> +RELEASE_URL=\"file://$T/art/\"$" <<< "$changed" || fail "the release address is not the folder: $changed"
bash -n "$T/ziskup-local" || fail "the local copy of ziskup is not valid bash"

# Another installer, or a relative folder, is refused.
printf '#!/bin/sh\necho hello\n' > "$T/other"
if (zisk_local_installer "$T/other" "$T/other-local" "$T/art") 2>/dev/null; then fail "an installer without the two lines was changed"; fi
if (zisk_local_installer "$T/ziskup" "$T/ziskup-rel" art) 2>/dev/null; then fail "a relative folder was accepted"; fi

echo "zisk artifacts checks pass"
