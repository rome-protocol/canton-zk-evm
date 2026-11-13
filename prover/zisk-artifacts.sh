#!/usr/bin/env bash
# Helpers for install.sh: the ZisK release files, checked by SHA-256 before they are installed. Source this file; do not run it.
#
# ziskup checks a key it downloads only against an md5 file from the same bucket, which catches a broken download but not a
# changed file, and it does not check the binaries at all. install.sh therefore downloads the three files itself, checks each
# against its SHA-256 in PINS, and runs a copy of ziskup whose two download addresses point at the folder that holds them.

# zisk_fetch_checked URL FILE SHA256: leaves at FILE a file whose SHA-256 is SHA256. A file already there with that checksum is
# kept (a copy put there beforehand, so the upstream servers are not needed); otherwise URL is downloaded and checked first.
# Also writes FILE.md5 (md5sum's format, the bare name), which ziskup reads next to each key.
zisk_fetch_checked() {
  local url=$1 file=$2 sha=$3 name
  name=$(basename "$file")
  if [ -f "$file" ] && echo "$sha  $file" | sha256sum -c --status -; then
    echo "$name: present, SHA-256 matches PINS"
  else
    curl -sSfL --retry 3 -o "$file.part" "$url" || fail "could not download $url"
    echo "$sha  $file.part" | sha256sum -c --status - || { rm -f "$file.part"; fail "$name does not match its SHA-256 in PINS"; }
    mv "$file.part" "$file"
    echo "$name: downloaded, SHA-256 matches PINS"
  fi
  ( cd "$(dirname "$file")" && md5sum "$name" > "$name.md5" )
}

# zisk_local_installer ZISKUP OUT DIR: writes to OUT a copy of the checked installer ZISKUP that takes the release binaries and
# the keys from DIR (file://) instead of the GitHub release and the setup bucket. Only those two lines change; it refuses if
# either is not found exactly once, so another ziskup is never changed blindly.
zisk_local_installer() {
  local src=$1 out=$2 dir=$3
  local bucket='BUCKET_URL="https://storage.googleapis.com/zisk-setup"'
  # shellcheck disable=SC2016  # the line as ziskup has it, variables and all
  local release='RELEASE_URL="https://github.com/${ZISKUP_REPO}/releases/download/${ZISK_VERSION}/"'
  [ "$(grep -cF "$bucket" "$src")" = 1 ] || fail "ziskup does not set the key bucket the way install.sh expects"
  [ "$(grep -cF "$release" "$src")" = 1 ] || fail "ziskup does not set the release address the way install.sh expects"
  case $dir in /*) ;; *) fail "the artifacts folder must be an absolute path: $dir" ;; esac
  [[ $dir != *[\|\&\\]* ]] || fail "the artifacts folder name has a character install.sh cannot pass on: $dir"
  sed -e "s|^BUCKET_URL=\"https://storage.googleapis.com/zisk-setup\"\$|BUCKET_URL=\"file://$dir\"|" \
      -e "s|^\( *\)RELEASE_URL=\"https://github.com/\${ZISKUP_REPO}/releases/download/\${ZISK_VERSION}/\"\$|\1RELEASE_URL=\"file://$dir/\"|" \
      "$src" > "$out"
  [ "$(diff "$src" "$out" | grep -c '^>')" = 2 ] || fail "the local copy of ziskup does not differ from it in exactly two lines"
}
