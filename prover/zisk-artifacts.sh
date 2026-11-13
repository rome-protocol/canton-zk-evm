#!/usr/bin/env bash
# Helpers for install.sh: the ZisK release files, checked by SHA-256 before they are installed. Source this file; do not run it.
#
# ziskup checks a key it downloads only against an md5 file from the same bucket, which catches a broken download but not a
# changed file, and it does not check the binaries at all. install.sh therefore downloads the files itself (ziskup, the Rust
# toolchain archive, the release binaries and the two keys), checks each against its SHA-256 in PINS, and runs a copy of ziskup
# whose two download addresses point at the folder that holds them.

# zisk_fetch_checked URL FILE SHA256: leaves at FILE a file whose SHA-256 is SHA256. A file already there with that checksum is
# kept (a copy put there beforehand, so the upstream servers are not needed); otherwise URL is downloaded and checked first.
# Also writes FILE.md5 (md5sum's format, the bare name), which ziskup reads next to each key (unused for the other files).
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

# node_tree_digest DIR: one SHA-256 for a node_modules tree: the SHA-256 of every file and the target of every link, by name in byte order.
# The same packages give the same digest wherever they were installed.
node_tree_digest() {
  ( cd "$1" && { find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum; find . -type l -printf '%p -> %l\n' | LC_ALL=C sort; } | sha256sum | cut -d' ' -f1 )
}

# zisk_install_node_deps DEST SRC: installs the Node packages of the PLONK key (SRC/package.json and SRC/package-lock.json) into DEST/node_modules with npm ci,
# install scripts off, and stops unless the tree is the one PLONK_NODE_TREE_SHA256 pins. Needs the pinned Node and npm on PATH.
zisk_install_node_deps() {
  local dest=$1 src=$2 tree
  rm -rf "$dest"
  mkdir -p "$dest"
  cp "$src/package.json" "$src/package-lock.json" "$dest/"
  ( cd "$dest" && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error ) || fail "npm ci failed in $dest"
  tree=$(node_tree_digest "$dest/node_modules") || fail "could not digest $dest/node_modules"
  [ "$tree" = "$PLONK_NODE_TREE_SHA256" ] || fail "the installed Node packages (digest $tree) are not the pinned ones (PLONK_NODE_TREE_SHA256 $PLONK_NODE_TREE_SHA256)"
  echo "node packages: installed from package-lock.json, tree digest matches PINS"
}

# check_plonk_key_list SNARKDIR LIST: every file of LIST (the 22 files of the key, named provingKeySnark/<path>) is in SNARKDIR (a provingKeySnark
# folder) with its SHA-256, the compiled witness libraries included; it prints each file that differs. The two builds that were compared agreed on all of them.
check_plonk_key_list() {
  local dir=$1 list=$2
  [ -d "$dir" ] && [ -s "$list" ] || return 1
  sed 's#  provingKeySnark/#  #' "$list" | ( cd "$dir" && sha256sum -c --quiet - )
}
