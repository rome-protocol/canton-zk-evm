#!/usr/bin/env bash
# prover/build-guest.sh builds the guest in one fixed folder (/tmp/cze-guest-build), so that the
# folder the sources came from does not change the ELF and the programVK. ZisK is not available
# here, so this test runs the real script against stand-ins for cargo-zisk, cargo-zisk-dev and
# cargo. The stand-in cargo-zisk writes an "ELF" that holds what a real build leaves in it: the
# paths in a panic message, remapped by the --remap-path-prefix flags it was given the way rustc
# does, and a hash of the absolute path it was run in, which is what cargo does with a path
# dependency and which the flags do not change. The stand-in program-setup takes its key from that
# ELF. So this shows that the script copies the sources into the fixed folder, builds there with
# fixed CARGO_HOME and CARGO_TARGET_DIR, passes the flags, and refuses an ELF that holds a build
# path. It does not show that a real ZisK build gives the same ELF from two folders: that was shown
# on real ZisK on 2026-10-04 (guest/README.md).
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
fail() { echo "FAIL: $*" >&2; exit 1; }
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT

# make_tree DIR: a small copy of the repository with what build-guest.sh needs, and the stand-ins.
make_tree() {
  local d=$1 zisk=$1/zisk
  mkdir -p "$d/prover" "$d/guest/bin/guests/stateless-validator-reth/src" "$d/guest/rules/src" "$d/guest/rules/target" \
    "$d/guest/bin/guests/stateless-validator-reth/target" "$d/network" "$zisk/bin" "$zisk/provingKey/zisk"
  cp "$HERE"/prover/*.sh "$d/prover/"; cp "$HERE/PINS" "$d/"
  echo "# lock" > "$d/guest/bin/guests/stateless-validator-reth/Cargo.lock"
  echo "[workspace]" > "$d/guest/Cargo.toml"
  echo "fn main() {}" > "$d/guest/bin/guests/stateless-validator-reth/src/main.rs"
  echo "pub fn rules() {}" > "$d/guest/rules/src/lib.rs"
  echo '{"config":{}}' > "$d/network/genesis.json"
  echo "stale build output" > "$d/guest/rules/target/stale"
  echo "stale build output" > "$d/guest/bin/guests/stateless-validator-reth/target/stale"
  echo '{"name":"zisk"}' > "$zisk/provingKey/pilout.globalInfo.json"
  mkdir -p "$zisk/provingKey/zisk/vadcop_final"
  echo '["1","2","3","4"]' > "$zisk/provingKey/zisk/vadcop_final/vadcop_final.verkey.json"

  cat > "$zisk/bin/cargo-zisk" <<'STUB'
#!/usr/bin/env bash
# Records what the build was given and writes the ELF a real build would, remapped by the flags.
set -euo pipefail
{ echo "RUSTFLAGS=${RUSTFLAGS-<unset>}"; env | grep -E '^(CARGO_ENCODED_RUSTFLAGS|CARGO_BUILD_RUSTFLAGS|CARGO_TARGET_[A-Z0-9_]*RUSTFLAGS|CARGO_PROFILE_[A-Z0-9_]*)=' || true; } > "$STUB_LOG"
remap() { # remap PATH: the last matching --remap-path-prefix wins
  local p=$1 out=$1 f from to
  for f in ${RUSTFLAGS-}; do
    case $f in --remap-path-prefix=*) from=${f#--remap-path-prefix=}; to=${from#*=}; from=${from%%=*}
      [[ $p == "$from"* ]] && out=$to${p#"$from"} ;; esac
  done
  printf '%s' "$out"
}
[ -z "${STUB_TOUCH_LOCK:-}" ] || echo "# changed" >> Cargo.lock
out=$CARGO_TARGET_DIR/elf/riscv64ima-zisk-zkvm-elf/release
mkdir -p "$out"
{ printf 'panicked at %s\n' "$(remap "$PWD/src/main.rs")"
  printf 'panicked at %s\n' "$(remap "${CARGO_HOME:-$HOME/.cargo}/registry/src/index.crates.io-1/alloy-1.0.0/src/lib.rs")"
  # what cargo does with a path dependency: the absolute path goes into the metadata hash
  printf 'metadata %s\n' "$(printf '%s %s %s' "$PWD" "${CARGO_HOME-}" "$CARGO_TARGET_DIR" | sha256sum | cut -c1-16)"
  # what the build was run on, to show the copy is the source and nothing stale came with it
  printf 'main %s\n' "$(sha256sum < src/main.rs | cut -c1-16)"
  printf 'genesis %s\n' "$(sha256sum < ../../../../network/genesis.json | cut -c1-16)"
  printf '%s\n' "${STUB_EXTRA:-}"; } > "$out/zec-reth"
{ pwd; echo "CARGO_HOME=$CARGO_HOME"; echo "CARGO_TARGET_DIR=$CARGO_TARGET_DIR"; ls ../../../rules 2>&1 || true; ls ../../../rules/target 2>&1 || true; ls target 2>&1 || true; } > "$STUB_LOG.run"
STUB
  cat > "$zisk/bin/cargo-zisk-dev" <<'STUB'
#!/usr/bin/env bash
# program-setup -e ELF -o DIR: the key is four u64 taken from the ELF's SHA-256.
set -euo pipefail
elf=$3; out=$5
sha256sum "$elf" | cut -c1-64 | xxd -r -p > "$out/x.verkey.bin"
STUB
  printf '#!/usr/bin/env bash\necho 0000000000000000000000000000000000000000000000000000000000000000\n' > "$zisk/bin/cargo"
  chmod +x "$zisk"/bin/*
}

# run_build DIR [VAR=value ...]: runs build-guest.sh in DIR with a clean HOME; prints its output.
run_build() {
  local d=$1; shift
  mkdir -p "$d/home/.cargo"
  env -i PATH=/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin:"$(dirname "$(command -v xxd)")":"$(dirname "$(command -v sha256sum)")" \
    HOME="$d/home" ZISK_DIR="$d/zisk" CZE_PROVER_STATE="$d/state" STUB_LOG="$d/stub.log" "$@" \
    "$d/prover/build-guest.sh" 2>&1
}
vk() { grep '^programVK=' <<<"$1" | cut -d= -f2; }

FIXED=/tmp/cze-guest-build
make_tree "$WORK/a one"; make_tree "$WORK/b"
# 1. a source folder with a space in its name is fine, because the build does not run there.
make_tree "$WORK/a"
out_a=$(run_build "$WORK/a") || fail "build in folder a failed: $out_a"
out_b=$(run_build "$WORK/b") || fail "build in folder b failed: $out_b"
mkdir -p "$WORK/home-s"; cp -R "$WORK/a one/zisk" "$WORK/zisk-s"
out_s=$(run_build "$WORK/a one" HOME="$WORK/home-s" ZISK_DIR="$WORK/zisk-s") || fail "build from a source folder with a space failed: $out_s"
# 2. three different source folders, one ELF and one key, because the build runs in the fixed folder.
[ -n "$(vk "$out_a")" ] || fail "no programVK printed"
for o in "$out_b" "$out_s"; do
  [ "$(vk "$out_a")" = "$(vk "$o")" ] || fail "programVK depends on the source folder"
  [ "$(grep '^elf_sha256=' <<<"$out_a")" = "$(grep '^elf_sha256=' <<<"$o")" ] || fail "the ELF depends on the source folder"
done
# and the stand-in does see the difference when it runs in two different folders (the test can fail).
direct() { # runs the stand-in cargo-zisk in a given folder, without build-guest.sh
  local d=$1
  mkdir -p "$d/x/y/z/w"; echo "fn main() {}" > "$d/x/y/z/w/main.rs"
  ( cd "$d/x/y/z/w" && mkdir -p src ../../../../network && cp main.rs src/main.rs && echo '{"config":{}}' > ../../../../network/genesis.json \
    && env -i PATH="$PATH" HOME="$d/home" CARGO_TARGET_DIR="$d/t" CARGO_HOME="$d/h" STUB_LOG="$d/direct.log" "$d/zisk/bin/cargo-zisk" build --release \
    && sha256sum "$d/t/elf/riscv64ima-zisk-zkvm-elf/release/zec-reth" | cut -c1-64 )
}
[ "$(direct "$WORK/a")" != "$(direct "$WORK/b")" ] || fail "the stand-in does not depend on the folder it runs in, so the check above shows nothing"

# 3. the build ran in the fixed folder, on a copy of the sources, with CARGO_HOME and CARGO_TARGET_DIR inside it.
run_log=$(cat "$WORK/a one/stub.log.run")
grep -qx "$FIXED/src/guest/bin/guests/stateless-validator-reth" <<<"$run_log" || fail "the build did not run in the fixed folder: $run_log"
grep -qx "CARGO_HOME=$FIXED/cargo-home" <<<"$run_log" || fail "CARGO_HOME is not fixed: $run_log"
grep -qx "CARGO_TARGET_DIR=$FIXED/target" <<<"$run_log" || fail "CARGO_TARGET_DIR is not fixed: $run_log"
grep -q '^src$' <<<"$run_log" || fail "the rules crate was not copied next to the guest: $run_log"
! grep -q stale <<<"$run_log" || fail "build output of the source folder was copied into the build folder: $run_log"
# the folder is emptied each time: something left there by an earlier build is gone.
mkdir -p "$FIXED/left-over"; touch "$FIXED/left-over/x"
out=$(run_build "$WORK/a") || fail "rebuild failed: $out"
[ ! -e "$FIXED/left-over" ] || fail "the build folder was not emptied"
[ "$(vk "$out")" = "$(vk "$out_a")" ] || fail "programVK changed on a rebuild"
# a change in a source file changes the ELF, so the copy is of the current sources.
echo "fn main() { println!(); }" > "$WORK/a/guest/bin/guests/stateless-validator-reth/src/main.rs"
out=$(run_build "$WORK/a") || fail "build after an edit failed: $out"
[ "$(vk "$out")" != "$(vk "$out_a")" ] || fail "the build did not use the edited source"
echo "fn main() {}" > "$WORK/a/guest/bin/guests/stateless-validator-reth/src/main.rs"
# a build that changes Cargo.lock is refused.
out=$(run_build "$WORK/a" STUB_TOUCH_LOCK=1 || true)
grep -q 'Cargo.lock' <<<"$out" || fail "a build that changed Cargo.lock was accepted: $out"
! grep -q '^programVK=' <<<"$out" || fail "a programVK was printed after Cargo.lock changed"

# 4. a different user's settings do not reach the build, and the paths are remapped.
out=$(run_build "$WORK/a" RUSTFLAGS="-C target-cpu=native" CARGO_ENCODED_RUSTFLAGS="-Cfoo" CARGO_BUILD_RUSTFLAGS="-Cbar" \
  CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS="-Cbaz" CARGO_PROFILE_RELEASE_DEBUG=2 CARGO_TARGET_DIR=/elsewhere CARGO_HOME=/elsewhere/cargo) \
  || fail "build with a poisoned environment failed: $out"
[ "$(vk "$out")" = "$(vk "$out_a")" ] || fail "programVK changed with the caller's environment"
log=$(cat "$WORK/a/stub.log")
for bad in target-cpu CARGO_ENCODED CARGO_BUILD_RUSTFLAGS CARGO_TARGET_X86 CARGO_PROFILE elsewhere; do
  ! grep -q -- "$bad" <<<"$log" || fail "the build still saw $bad"
done
grep -q -- "--remap-path-prefix=$FIXED/src=/build/src" <<<"$log" || fail "the source copy is not remapped"
grep -q -- "--remap-path-prefix=$FIXED/cargo-home=/build/cargo" <<<"$log" || fail "CARGO_HOME is not remapped"
grep -q -- "--remap-path-prefix=$FIXED/target=/build/target" <<<"$log" || fail "the target folder is not remapped"

# 5. an ELF that still holds a build path is not reported.
for leak in "built in $FIXED/left" "built in $WORK/a/home/leftover" "built in $WORK/a/guest"; do
  out=$(run_build "$WORK/a" STUB_EXTRA="$leak" || true)
  grep -q 'build path' <<<"$out" || fail "an ELF with a build path was accepted ($leak): $out"
  ! grep -q '^programVK=' <<<"$out" || fail "a programVK was printed for an ELF with a build path ($leak)"
done
echo "guest reproducibility checks passed"
