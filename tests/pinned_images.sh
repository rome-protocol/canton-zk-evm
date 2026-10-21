#!/usr/bin/env bash
# Tests the pinned-images action's script against a fake docker (no registry, no image, no network), and tests that tests/ci_images_static.py
# really fails when a job's pinned-images step is missing, late or short of an image.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT=$ROOT/.github/actions/pinned-images/pinned-images.sh
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

DIGEST=$(printf 'a%.0s' $(seq 64))
OTHER=$(printf 'b%.0s' $(seq 64))
REF=example.invalid/team/tool@sha256:$DIGEST
cat > "$WORK/PINS" <<PINS
TOOL_IMAGE=$REF
OTHER_IMAGE=example.invalid/team/other:1.2@sha256:$OTHER
TAGGED_IMAGE=example.invalid/team/tool:1.0
NOT_PINNED=$REF
PINS

mkdir -p "$WORK/bin"
# The fake docker keeps its state in files under $FAKE: images on the machine, a count of pulls, a log of calls.
cat > "$WORK/bin/docker" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >> "$FAKE/calls"
last=${*: -1}
hex=${last##*@sha256:}
case $1 in
  pull)
    n=$(( $(cat "$FAKE/pulls" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$FAKE/pulls"
    if [ "$n" -le "${FAKE_PULL_FAILS:-0}" ]; then echo "toomanyrequests: Data limit exceeded" >&2; exit 1; fi
    mkdir -p "$FAKE/have"
    if [ -n "${FAKE_WRONG_DIGEST:-}" ]; then echo "${last%@*}@sha256:$FAKE_WRONG_DIGEST" > "$FAKE/have/$hex"; else echo "$last" > "$FAKE/have/$hex"; fi ;;
  image)
    case $* in
      *"{{.Id}}"*) echo "sha256:1d" ;;
      *) [ -f "$FAKE/have/$hex" ] && cat "$FAKE/have/$hex" || exit 1 ;;
    esac ;;
  save) out=$3; echo "saved $last" > "$out" ;;
  load) [ -f "$3" ] || exit 1; grep -q '^saved ' "$3" || exit 1
        if [ -n "${FAKE_LOAD_KEEPS_NAME:-}" ]; then mkdir -p "$FAKE/have"; h=$(sed 's/.*@sha256://' "$3"); echo "$(sed 's/^saved //' "$3")" > "$FAKE/have/$h"; fi ;;
  *) echo "unexpected docker call: $*" >&2; exit 2 ;;
esac
FAKE
# A sleep that only records how long it was asked to wait.
cat > "$WORK/bin/sleep" <<'FAKE'
#!/usr/bin/env bash
echo "$1" >> "$FAKE/sleeps"
FAKE
chmod +x "$WORK/bin/docker" "$WORK/bin/sleep"

# run_case NAME ARGS...: a fresh machine (no images, no calls); the environment of the test is in the caller's variables.
fresh() { FAKE=$WORK/fake-$1; rm -rf "$FAKE"; mkdir -p "$FAKE"; export FAKE; export PINNED_IMAGES_DIR=$FAKE/base GITHUB_OUTPUT=$FAKE/out; : > "$GITHUB_OUTPUT"; }
runs() { PATH="$WORK/bin:$PATH" "$SCRIPT" "$@"; }
out_of() { sed -n "s/^$1=//p" "$GITHUB_OUTPUT" | tail -n 1; }

echo "== resolve"
fresh resolve
runs resolve "$WORK/PINS" "TOOL_IMAGE OTHER_IMAGE" 2>/dev/null
key1=$(out_of key); dir1=$(out_of dir)
[[ $key1 == pinned-images-v1-*-[0-9a-f]* ]] || fail "odd cache key: $key1"
[ -f "$dir1.refs" ] && [ "$(grep -c . "$dir1.refs")" = 2 ] || fail "the refs file does not list both images"
runs resolve "$WORK/PINS" "OTHER_IMAGE TOOL_IMAGE" 2>/dev/null
[ "$(out_of key)" = "$key1" ] || fail "the key depends on the order of the names"
runs resolve "$WORK/PINS" "TOOL_IMAGE" 2>/dev/null
[ "$(out_of key)" != "$key1" ] || fail "the key is the same for another set of images"
for bad in "TAGGED_IMAGE" "NOT_PINNED" "MISSING_IMAGE"; do
  ! runs resolve "$WORK/PINS" "$bad" 2>/dev/null || fail "resolve accepted $bad"
done

echo "== cache miss: pulled, checked, saved"
fresh miss
runs resolve "$WORK/PINS" "TOOL_IMAGE" 2>/dev/null; dir=$(out_of dir)
PINNED_IMAGES_CACHE_DIR=$dir runs ensure 2>/dev/null
[ "$(cat "$FAKE/pulls")" = 1 ] || fail "expected one pull"
[ -f "$dir/$DIGEST.tar" ] || fail "the image was not saved into the cache folder"
[ "$(out_of save)" = true ] || fail "save was not asked for"

echo "== cache hit: loaded, then the pull finds it"
fresh hit
runs resolve "$WORK/PINS" "TOOL_IMAGE" 2>/dev/null; dir=$(out_of dir)
echo "saved $REF" > "$dir/$DIGEST.tar"
FAKE_LOAD_KEEPS_NAME=1 PINNED_IMAGES_CACHE_DIR=$dir runs ensure 2>/dev/null
grep -q '^load ' "$FAKE/calls" || fail "the cached tarball was not loaded"
[ ! -f "$FAKE/pulls" ] || fail "an image loaded under its digest was pulled anyway"
[ "$(out_of save)" = false ] || fail "a cache hit asked to save again"
fresh hit2
runs resolve "$WORK/PINS" "TOOL_IMAGE" 2>/dev/null; dir=$(out_of dir)
echo "saved $REF" > "$dir/$DIGEST.tar"
PINNED_IMAGES_CACHE_DIR=$dir runs ensure 2>/dev/null
[ "$(cat "$FAKE/pulls")" = 1 ] || fail "an image loaded without a name should be pulled once (the layers are there)"

echo "== a bad cache entry is dropped and the image pulled"
fresh bad
runs resolve "$WORK/PINS" "TOOL_IMAGE" 2>/dev/null; dir=$(out_of dir)
echo "garbage" > "$dir/$DIGEST.tar"
PINNED_IMAGES_CACHE_DIR=$dir runs ensure 2>/dev/null
grep -q '^saved ' "$dir/$DIGEST.tar" || fail "the bad entry was kept"

echo "== the limit: retries with a growing wait, then success"
fresh retry
runs resolve "$WORK/PINS" "TOOL_IMAGE" 2>/dev/null; dir=$(out_of dir)
FAKE_PULL_FAILS=3 PINNED_IMAGES_CACHE_DIR=$dir runs ensure > "$FAKE/log" 2>&1 || { cat "$FAKE/log" >&2; fail "did not recover after 3 limit errors"; }
[ "$(cat "$FAKE/pulls")" = 4 ] || fail "expected 4 pulls"
[ "$(tr '\n' ' ' < "$FAKE/sleeps")" = "20 40 80 " ] || fail "waits were: $(tr '\n' ' ' < "$FAKE/sleeps")"
grep -q 'toomanyrequests' "$FAKE/log" || fail "the registry's error was not shown"

echo "== the limit never lifts: six tries, about ten minutes, then a failure"
fresh giveup
runs resolve "$WORK/PINS" "TOOL_IMAGE" 2>/dev/null; dir=$(out_of dir)
! FAKE_PULL_FAILS=99 PINNED_IMAGES_CACHE_DIR=$dir runs ensure >/dev/null 2>&1 || fail "ensure succeeded with no image"
[ "$(cat "$FAKE/pulls")" = 6 ] || fail "expected 6 pulls, got $(cat "$FAKE/pulls")"
[ "$(tr '\n' ' ' < "$FAKE/sleeps")" = "20 40 80 160 300 " ] || fail "waits were: $(tr '\n' ' ' < "$FAKE/sleeps")"

echo "== an image under another digest is refused"
fresh wrong
runs resolve "$WORK/PINS" "TOOL_IMAGE" 2>/dev/null; dir=$(out_of dir)
! FAKE_WRONG_DIGEST=$OTHER PINNED_IMAGES_CACHE_DIR=$dir runs ensure >/dev/null 2>&1 || fail "an image with the wrong digest was accepted"

echo "== the static check fails on a job without the step, with it late, and with it short of an image"
copy_repo() {
  rm -rf "$WORK/repo"; mkdir -p "$WORK/repo/.github" "$WORK/repo/tests"
  cp -R "$ROOT/.github/workflows" "$WORK/repo/.github/"
  for d in network gateway demo explorer sidecar builder prover; do cp -R "$ROOT/$d" "$WORK/repo/$d" 2>/dev/null || true; done
  cp "$ROOT"/tests/*.sh "$ROOT"/tests/*.py "$WORK/repo/tests/"
}
check() { python3 "$WORK/repo/tests/ci_images_static.py" >/dev/null 2>"$WORK/err"; }
copy_repo
check || { cat "$WORK/err" >&2; fail "the static check fails on the real workflows"; }
python3 - "$WORK/repo/.github/workflows/gateway.yml" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
a = "      - uses: ./.github/actions/pinned-images\n        with:\n          images: SOLC_IMAGE\n"
assert a in s
open(p, "w").write(s.replace(a, ""))
PY
! check || fail "a job without the step passed"
grep -q 'gateway.yml job build' "$WORK/err" || fail "the failure does not name the job"
copy_repo
sed -i.bak 's/images: RETH_IMAGE BUSYBOX_IMAGE SOLC_IMAGE/images: RETH_IMAGE SOLC_IMAGE/' "$WORK/repo/.github/workflows/gateway.yml"
! check || fail "a step short of an image passed"
copy_repo
python3 - "$WORK/repo/.github/workflows/gateway.yml" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
a = "      - uses: ./.github/actions/pinned-images\n        with:\n          images: SOLC_IMAGE\n      - run: gateway/build.sh --check\n"
assert a in s
open(p, "w").write(s.replace(a, "      - run: gateway/build.sh --check\n" + a.rsplit("      - run", 1)[0]))
PY
! check || fail "a step after the first use passed"
echo "pinned images: ok"
