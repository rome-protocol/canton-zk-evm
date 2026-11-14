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
if [ -e "$T/art/key.tar.gz" ] || [ -e "$T/art/key.tar.gz.part" ]; then fail "a refused download left a file"; fi

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

# install.sh gets every ZisK file through zisk_fetch_checked, so a kept folder is enough: no other download from ZisK's GitHub.
if grep -E 'curl|wget' "$ROOT/prover/install.sh" | grep -v '^#' | grep -qE '0xPolygonHermez|zisk-setup|ZISKUP_URL|RELEASE_URL|BUCKET_URL|TOOLCHAIN_URL'; then
  fail "install.sh downloads a ZisK file without zisk_fetch_checked"
fi
for f in ZISKUP_URL TOOLCHAIN_URL RELEASE_URL BUCKET_URL; do
  [ "$(grep -c "zisk_fetch_checked \"\$$f" "$ROOT/prover/install.sh" || true)" -ge 1 ] || fail "install.sh does not fetch $f through zisk_fetch_checked"
done

# node_tree_digest: one digest for a node_modules tree, the same wherever it was made, and any change to a file, a link, a name or an added file changes it.
mkdir -p "$T/tree-a/node_modules/pkg/bin" "$T/tree-b/node_modules/pkg/bin"
for t in a b; do
  printf 'one\n' > "$T/tree-$t/node_modules/pkg/index.js"
  printf 'two\n' > "$T/tree-$t/node_modules/pkg/bin/cli.js"
  ln -s ../pkg/bin/cli.js "$T/tree-$t/node_modules/link"
done
touch -d '2020-01-01' "$T/tree-b/node_modules/pkg/index.js"   # times do not count
d=$(node_tree_digest "$T/tree-a/node_modules")
[[ $d =~ ^[0-9a-f]{64}$ ]] || fail "node_tree_digest gave $d"
[ "$(node_tree_digest "$T/tree-b/node_modules")" = "$d" ] || fail "the same tree gave two digests"
printf 'one!\n' > "$T/tree-b/node_modules/pkg/index.js"
[ "$(node_tree_digest "$T/tree-b/node_modules")" != "$d" ] || fail "a changed file kept the digest"
printf 'one\n' > "$T/tree-b/node_modules/pkg/index.js"
ln -sfn ../pkg/index.js "$T/tree-b/node_modules/link"
[ "$(node_tree_digest "$T/tree-b/node_modules")" != "$d" ] || fail "a link to another file kept the digest"
ln -sfn ../pkg/bin/cli.js "$T/tree-b/node_modules/link"
[ "$(node_tree_digest "$T/tree-b/node_modules")" = "$d" ] || fail "the restored tree has another digest"
printf 'x\n' > "$T/tree-b/node_modules/extra.js"
[ "$(node_tree_digest "$T/tree-b/node_modules")" != "$d" ] || fail "an added file kept the digest"

# check_plonk_key_list: every file of the list is in the folder with its SHA-256, and it names each one that differs.
mkdir -p "$T/snark/final" "$T/snark/recursivef"
printf 'zkey\n' > "$T/snark/final/final.zkey"; printf 'vk\n' > "$T/snark/final/final.verkey.json"; printf 'rec\n' > "$T/snark/recursivef/recursivef.verkey.json"
( cd "$T" && sha256sum snark/final/final.zkey snark/final/final.verkey.json snark/recursivef/recursivef.verkey.json | sed 's# snark/# provingKeySnark/#' ) > "$T/plonk.list"
check_plonk_key_list "$T/snark" "$T/plonk.list" || fail "the matching key files were refused"
printf 'zkey!\n' > "$T/snark/final/final.zkey"
if out=$(check_plonk_key_list "$T/snark" "$T/plonk.list" 2>&1); then fail "a changed final.zkey was accepted"; fi
[[ $out == *final/final.zkey* ]] || fail "the refusal does not name the changed file: $out"
printf 'zkey\n' > "$T/snark/final/final.zkey"
rm "$T/snark/recursivef/recursivef.verkey.json"
if (check_plonk_key_list "$T/snark" "$T/plonk.list") >/dev/null 2>&1; then fail "a missing key file was accepted"; fi
if (check_plonk_key_list "$T/no-such-folder" "$T/plonk.list") >/dev/null 2>&1; then fail "a missing folder was accepted"; fi

# install.sh installs the proving key by its pinned checksum (the Poseidon1 one), and the PLONK key only through check_plonk_key_files; it never runs setup_snark (pilfflonk).
grep -q -- '--poseidon1' "$ROOT/prover/install.sh" || fail "install.sh does not install the Poseidon1 key"
grep -q 'check_plonk_key_list' "$ROOT/prover/install.sh" || fail "install.sh does not check the PLONK key against its list"
! grep -v '^ *#' "$ROOT/prover/install.sh" | grep -q 'setup_snark' || fail "install.sh runs setup_snark, which installs a pilfflonk key"
# build-plonk-key.sh installs the Node packages from the lock file only, with npm ci, and keeps npm from running during the setup.
grep -q 'npm ci --ignore-scripts' "$ROOT/prover/zisk-artifacts.sh" || fail "the Node packages are not installed with npm ci from the lock file"
! grep -v '^ *#' "$ROOT/prover/build-plonk-key.sh" "$ROOT/prover/zisk-artifacts.sh" | grep -E 'npm (install|i) ' | grep -q . || fail "a prover script runs npm install, which takes whatever the registry holds"
grep -q 'npm must not run' "$ROOT/prover/build-plonk-key.sh" || fail "build-plonk-key.sh does not stop npm from running during the setup"

echo "zisk artifacts checks pass"
