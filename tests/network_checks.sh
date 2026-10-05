#!/usr/bin/env bash
# The small checks the network scripts rely on, run without a GPU, Docker or Canton:
#   - network/canton/check-damlc.sh refuses a damlc whose registry manifest is not the pinned one (a re-pushed tag)
#   - network/canton/dar-id.sh prints a DAR's SHA-256 and its main package id (read with Python's zipfile, no unzip)
#   - network/canton/check-package.sh refuses a package id that the participant's Ledger API does not list
#   - network/check-program-vk.sh refuses a built programVK that is not the recorded one
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# --- check-damlc.sh, against a curl that serves a fixed manifest
mkdir "$WORK/bin"
cat > "$WORK/bin/curl" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_CURL_LOG"
out=
while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done
cat "$FAKE_MANIFEST" > "${out:-/dev/stdout}"
FAKE
chmod +x "$WORK/bin/curl"
printf '{"schemaVersion":2,"layers":[{"digest":"sha256:aa"}]}' > "$WORK/manifest.json"
export FAKE_MANIFEST=$WORK/manifest.json FAKE_CURL_LOG=$WORK/curl.log
good=$(sha "$WORK/manifest.json")
PATH="$WORK/bin:$PATH" "$ROOT/network/canton/check-damlc.sh" "$good" >/dev/null || fail "check-damlc.sh refused the pinned manifest"
grep -q 'damlc/manifests/.*linux_amd64' "$FAKE_CURL_LOG" || fail "check-damlc.sh did not ask for the linux manifest of damlc"
printf '{"schemaVersion":2,"layers":[{"digest":"sha256:bb"}]}' > "$WORK/manifest.json"
out=$(PATH="$WORK/bin:$PATH" "$ROOT/network/canton/check-damlc.sh" "$good" 2>&1) && fail "check-damlc.sh accepted a changed manifest"
grep -q "$good" <<<"$out" || fail "the refusal does not name the pinned digest"
PATH="$WORK/bin:$PATH" "$ROOT/network/canton/check-damlc.sh" "not-a-sha" >/dev/null 2>&1 && fail "check-damlc.sh accepted a malformed pin"
# The pin in PINS is the default.
grep -q 'check-damlc.sh' "$ROOT/network/canton/fetch.sh" || fail "fetch.sh does not run check-damlc.sh"

# --- dar-id.sh, on a DAR with a wrapped manifest as damlc writes it
ID=$(printf '6769d912%.0s' $(seq 8))
python3 - "$WORK/t.dar" "$ID" <<'PY'
import sys, zipfile
path, i = sys.argv[1:3]
d = f"canton-zk-evm-0.1.0-{i}"
main = f"{d}/{d}.dalf"
dalfs = f"{main}, {d}/daml-prim-{'3' * 64}.dalf"
def wrap(line):   # a manifest line is at most 72 bytes; a continuation starts with one space
    out, first = [], True
    while len(line) > 70:
        out.append(line[:70] if first else " " + line[:69]); line = line[70:] if first else line[69:]; first = False
    out.append(line if first else " " + line)
    return "\r\n".join(out)
m = "\r\n".join(["Manifest-Version: 1.0", "Created-By: damlc", "Name: canton-zk-evm-0.1.0", wrap("Main-Dalf: " + main), wrap("Dalfs: " + dalfs), "Format: daml-lf", ""]) + "\r\n"
with zipfile.ZipFile(path, "w") as z:
    z.writestr("META-INF/MANIFEST.MF", m)
    z.writestr(main, b"x")
PY
out=$("$ROOT/network/canton/dar-id.sh" "$WORK/t.dar")
[ "$(sed -n 's/^dar_sha256=//p' <<<"$out")" = "$(sha "$WORK/t.dar")" ] || fail "dar-id.sh: wrong dar_sha256"
[ "$(sed -n 's/^package_id=//p' <<<"$out")" = "$ID" ] || fail "dar-id.sh: wrong package_id ($out)"
"$ROOT/network/canton/dar-id.sh" "$WORK/missing.dar" >/dev/null 2>&1 && fail "dar-id.sh accepted a missing file"
echo notadar > "$WORK/bad.dar"
out=$("$ROOT/network/canton/dar-id.sh" "$WORK/bad.dar" 2>&1) && fail "dar-id.sh accepted a file that is not a DAR"
grep -q 'is not a DAR' <<<"$out" || fail "dar-id.sh: no clear error for a file that is not a DAR ($out)"
python3 -c 'import sys, zipfile; z = zipfile.ZipFile(sys.argv[1], "w"); z.writestr("x.txt", "x"); z.close()' "$WORK/nomanifest.dar"
out=$("$ROOT/network/canton/dar-id.sh" "$WORK/nomanifest.dar" 2>&1) && fail "dar-id.sh accepted a zip with no manifest"
grep -q 'is not a DAR' <<<"$out" || fail "dar-id.sh: no clear error for a zip with no manifest ($out)"
python3 -c 'import sys, zipfile; z = zipfile.ZipFile(sys.argv[1], "w"); z.writestr("META-INF/MANIFEST.MF", "Manifest-Version: 1.0\r\nMain-Dalf: a/b-123.dalf\r\n"); z.close()' "$WORK/noid.dar"
out=$("$ROOT/network/canton/dar-id.sh" "$WORK/noid.dar" 2>&1) && fail "dar-id.sh accepted a manifest whose main dalf has no package id"
grep -q 'no main package id' <<<"$out" || fail "dar-id.sh: no clear error for a main dalf with no package id ($out)"
# It must not need unzip: with an unzip that always fails first on the path, the id is the same.
mkdir "$WORK/nounzip"; printf '#!/bin/sh\necho unzip was run >&2\nexit 99\n' > "$WORK/nounzip/unzip"; chmod +x "$WORK/nounzip/unzip"
out=$(PATH="$WORK/nounzip:$PATH" "$ROOT/network/canton/dar-id.sh" "$WORK/t.dar" 2>&1) || fail "dar-id.sh needs unzip ($out)"
[ "$(sed -n 's/^package_id=//p' <<<"$out")" = "$ID" ] || fail "dar-id.sh gave another id with no working unzip"

# --- check-package.sh, against a curl that serves a fixed package list as GET /v2/packages does
mkdir "$WORK/pkgbin"
cat > "$WORK/pkgbin/curl" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_CURL_LOG"
[ -f "$FAKE_PACKAGES" ] || exit 22
cat "$FAKE_PACKAGES"
FAKE
chmod +x "$WORK/pkgbin/curl"
OTHER_ID=$(printf 'ab%.0s' $(seq 32))
export FAKE_PACKAGES=$WORK/packages.json FAKE_CURL_LOG=$WORK/pkg-curl.log
: > "$FAKE_CURL_LOG"
printf '{"packageIds":["%s","%s"]}' "$OTHER_ID" "$ID" > "$FAKE_PACKAGES"
PATH="$WORK/pkgbin:$PATH" "$ROOT/network/canton/check-package.sh" "$ID" "http://127.0.0.1:7575" >/dev/null || fail "check-package.sh refused a package the participant lists"
grep -q 'http://127.0.0.1:7575/v2/packages' "$FAKE_CURL_LOG" || fail "check-package.sh did not ask GET /v2/packages on the given ledger URL"
printf '{"packageIds":["%s"]}' "$OTHER_ID" > "$FAKE_PACKAGES"
out=$(PATH="$WORK/pkgbin:$PATH" "$ROOT/network/canton/check-package.sh" "$ID" 2>&1) && fail "check-package.sh accepted a package the participant does not list"
grep -q "$ID" <<<"$out" || fail "the refusal does not name the package id"
printf '{"packageIds":["%s"]}' "${ID}00" > "$FAKE_PACKAGES"
PATH="$WORK/pkgbin:$PATH" "$ROOT/network/canton/check-package.sh" "$ID" >/dev/null 2>&1 && fail "check-package.sh matched a longer id (it must match the whole id)"
printf '{"packageIds":[]}' > "$FAKE_PACKAGES"
PATH="$WORK/pkgbin:$PATH" "$ROOT/network/canton/check-package.sh" "$ID" >/dev/null 2>&1 && fail "check-package.sh accepted an empty package list"
printf 'not json' > "$FAKE_PACKAGES"
PATH="$WORK/pkgbin:$PATH" "$ROOT/network/canton/check-package.sh" "$ID" >/dev/null 2>&1 && fail "check-package.sh accepted an answer that is not a package list"
rm "$FAKE_PACKAGES"
out=$(PATH="$WORK/pkgbin:$PATH" "$ROOT/network/canton/check-package.sh" "$ID" 2>&1) && fail "check-package.sh accepted a Ledger API that did not answer"
grep -q 'did not answer' <<<"$out" || fail "check-package.sh: no clear error when the Ledger API does not answer ($out)"
printf '{"packageIds":["%s"]}' "$ID" > "$FAKE_PACKAGES"
PATH="$WORK/pkgbin:$PATH" "$ROOT/network/canton/check-package.sh" "not-an-id" >/dev/null 2>&1 && fail "check-package.sh accepted a malformed package id"

# --- check-program-vk.sh
REC=$(printf 'e7%.0s' $(seq 32)); OTHER=$(printf '69%.0s' $(seq 32))
printf 'zisk=1\nprogramVK=0x%s\nrootC=0xaa\n' "$REC" > "$WORK/session.txt"
export CZE_SESSION_FILE=$WORK/session.txt
"$ROOT/network/check-program-vk.sh" "0x$REC" >/dev/null || fail "check-program-vk.sh refused the recorded key"
out=$("$ROOT/network/check-program-vk.sh" "0x$OTHER" 2>&1) && fail "check-program-vk.sh accepted another key"
grep -q "$OTHER" <<<"$out" || fail "the refusal does not show the built key"
grep -q "$REC" <<<"$out" || fail "the refusal does not show the recorded key"
"$ROOT/network/check-program-vk.sh" "" >/dev/null 2>&1 && fail "check-program-vk.sh accepted an empty key"
printf 'zisk=1\n' > "$WORK/session.txt"
"$ROOT/network/check-program-vk.sh" "0x$REC" >/dev/null 2>&1 && fail "check-program-vk.sh accepted a session file with no recorded key"
echo "network checks passed"
