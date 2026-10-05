#!/usr/bin/env bash
# Prints what identifies a built DAR, as two lines:
#   dar_sha256=<SHA-256 of the file>
#   package_id=<the main package's id: the 64 hex digits that end the name of the main .dalf in the DAR's manifest>
# The manifest is read with Python's zipfile, so unzip is not needed. Usage: dar-id.sh <file.dar>
set -euo pipefail
fail() { echo "FAIL: $*" >&2; exit 1; }
dar=${1:?usage: dar-id.sh <file.dar>}
[ -f "$dar" ] || fail "no file $dar"
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
# A manifest line is cut at 72 bytes and the rest goes on the next line after one space: join them, then read Main-Dalf.
# (A DAR is a zip file; one that is not, or that has no META-INF/MANIFEST.MF, is not a DAR.)
manifest=$(python3 - "$dar" <<'PY' || true
import sys, zipfile
try:
    with zipfile.ZipFile(sys.argv[1]) as z:
        raw = z.read("META-INF/MANIFEST.MF")
except (zipfile.BadZipFile, KeyError, OSError):
    sys.exit(1)
sys.stdout.write(raw.decode("utf-8", "replace").replace("\r", "").replace("\n ", ""))
PY
)
[ -n "$manifest" ] || fail "$dar is not a DAR (no META-INF/MANIFEST.MF)"
main=$(sed -n 's/^Main-Dalf: *//p' <<<"$manifest" | head -1)
id=$(sed -n 's/.*-\([0-9a-f]\{64\}\)\.dalf$/\1/p' <<<"$main")
[[ $id =~ ^[0-9a-f]{64}$ ]] || fail "no main package id in the manifest of $dar (Main-Dalf: '$main')"
echo "dar_sha256=$(sha "$dar")"
echo "package_id=$id"
