#!/usr/bin/env bash
# Helpers for build-guest.sh. Source this file after common.sh; do not run it.
#
# The guest's key (programVK) is the key of the ELF, so the ELF has to be the same bytes whoever
# builds it and wherever. Two things carry the build folder into the ELF. rustc writes the paths it
# sees (panic messages, debug information), which --remap-path-prefix renames. Cargo also hashes the
# absolute path of every path dependency into the crate's metadata, and --remap-path-prefix does not
# change that hash. So the build does not run in the source folder: build-guest.sh copies the guest
# sources into one fixed folder (GUEST_BUILD_DIR) and builds there, with fixed CARGO_HOME and
# CARGO_TARGET_DIR. These helpers set that up and refuse an ELF that still holds a build path.

# The one folder every guest build runs in. It is emptied at the start of each build.
GUEST_BUILD_DIR=/tmp/cze-guest-build

# guest_prepare_build: empties GUEST_BUILD_DIR and copies the sources the guest build reads into it,
# keeping their layout: guest/ (without any target folder) and network/genesis.json, which the rules
# crate includes by a relative path. Sets GUEST_BUILD_PKG, the guest package inside the copy.
guest_prepare_build() {
  case $GUEST_BUILD_DIR in /tmp/?*) ;; *) fail "refusing to empty $GUEST_BUILD_DIR" ;; esac
  rm -rf "$GUEST_BUILD_DIR"
  mkdir -p "$GUEST_BUILD_DIR/src/network" "$GUEST_BUILD_DIR/cargo-home" "$GUEST_BUILD_DIR/target"
  ( cd "$ROOT" && tar -cf - --exclude=target guest ) | tar -xf - -C "$GUEST_BUILD_DIR/src"
  cp "$ROOT/network/genesis.json" "$GUEST_BUILD_DIR/src/network/genesis.json"
  # shellcheck disable=SC2034  # used by build-guest.sh
  GUEST_BUILD_PKG=$GUEST_BUILD_DIR/src/guest/bin/guests/stateless-validator-reth
}

# guest_build_env: gives the build a known environment. It drops every compiler-flag and profile
# setting that came from the caller (they change the ELF), sets CARGO_HOME and CARGO_TARGET_DIR to
# folders inside GUEST_BUILD_DIR, then sets one RUSTFLAGS that maps each folder the build reads from
# to a fixed name. rustc uses the last mapping that matches, so the mappings go from the shortest
# folder to the longest: a folder inside another gets its own name. Sets GUEST_BUILD_PATHS, the
# folders the ELF must not mention.
guest_build_env() {
  local v src_logical src
  while IFS= read -r v; do unset "$v"; done < <(env | cut -d= -f1 | grep -E \
    '^(RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|CARGO_BUILD_RUSTFLAGS|CARGO_TARGET_.*_RUSTFLAGS|CARGO_PROFILE_.*|CARGO_TARGET_DIR|CARGO_BUILD_TARGET_DIR)$' || true)

  local user_cargo_home=${CARGO_HOME:-$HOME/.cargo} rustup_home=${RUSTUP_HOME:-$HOME/.rustup}
  src_logical=$ROOT
  src=$(cd "$ROOT" && pwd -P)
  export CARGO_HOME=$GUEST_BUILD_DIR/cargo-home CARGO_TARGET_DIR=$GUEST_BUILD_DIR/target
  local -a pairs=("$HOME=/build/home" "$rustup_home=/build/rustup" "$ZISK_DIR=/build/zisk"
    "$GUEST_BUILD_DIR/cargo-home=/build/cargo" "$GUEST_BUILD_DIR/target=/build/target" "$GUEST_BUILD_DIR/src=/build/src")

  GUEST_BUILD_PATHS=("$GUEST_BUILD_DIR" "$src" "$src_logical" "$user_cargo_home" "$rustup_home" "$ZISK_DIR")
  [ "$HOME" = / ] || GUEST_BUILD_PATHS+=("$HOME/")

  local flags="" p from
  for p in "${pairs[@]}"; do
    [[ $p != *[[:space:]]* ]] || fail "a folder name with a space or tab cannot be put in a compiler flag: ${p%%=*}"
  done
  while IFS= read -r p; do flags="$flags --remap-path-prefix=${p#* }"; done \
    < <(for p in "${pairs[@]}"; do from=${p%%=*}; echo "${#from} $p"; done | sort -n -s | awk '!seen[$0]++')
  export RUSTFLAGS=${flags# }
}

# guest_elf_build_path ELF: prints the first build folder the ELF mentions, if any.
guest_elf_build_path() {
  local p
  for p in "${GUEST_BUILD_PATHS[@]}"; do
    if [ -z "$p" ] || [ "$p" = / ]; then continue; fi
    if grep -aqF -- "$p" "$1"; then printf '%s\n' "$p"; return 0; fi
  done
  return 0
}
