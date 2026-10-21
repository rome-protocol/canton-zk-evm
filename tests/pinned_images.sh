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
# The fake docker gives an image the ID of its digest with a->c and b->d.
ID=sha256:$(printf 'c%.0s' $(seq 64))
OTHER_ID=sha256:$(printf 'd%.0s' $(seq 64))
STRANGER_ID=sha256:$(printf 'e%.0s' $(seq 64))
REF=example.invalid/team/tool@sha256:$DIGEST
ECR=public.ecr.aws/docker/library/tool@sha256:$DIGEST
cat > "$WORK/PINS" <<PINS
TOOL_IMAGE=$REF
TOOL_IMAGE_ID=$ID
OTHER_IMAGE=example.invalid/team/other:1.2@sha256:$OTHER
OTHER_IMAGE_ID=$OTHER_ID
ECR_IMAGE=$ECR
ECR_IMAGE_ID=$ID
TAGGED_IMAGE=example.invalid/team/tool:1.0
NOT_PINNED=$REF
NO_ID_IMAGE=$REF
BAD_ID_IMAGE=$REF
BAD_ID_IMAGE_ID=sha256:1d
PINS

mkdir -p "$WORK/bin"
# The fake docker keeps its state in files under $FAKE: names on the machine per digest (have/), image IDs (ids/), a count of pulls, a log of calls.
cat > "$WORK/bin/docker" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >> "$FAKE/calls"
last=${*: -1}
hex=${last##*@sha256:}
idof() { echo "sha256:$(echo "$1" | tr 'ab' 'cd')"; }
# Docker names an image name@digest and ignores a tag that comes with the digest.
base=${last%@*}; case ${base##*/} in *:*) base=${base%:*} ;; esac; norm=$base@sha256:$hex
case $1 in
  pull)
    n=$(( $(cat "$FAKE/pulls" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$FAKE/pulls"
    [ -z "${FAKE_DEAD:-}" ] || { echo "Cannot connect to the Docker daemon" >&2; exit 1; }
    case $last in "${FAKE_FAIL_HOST:-@none@}"/*) echo "toomanyrequests: Data limit exceeded" >&2; exit 1 ;; esac
    if [ "$n" -le "${FAKE_PULL_FAILS:-0}" ]; then echo "toomanyrequests: Data limit exceeded" >&2; exit 1; fi
    mkdir -p "$FAKE/have" "$FAKE/ids"
    if [ -n "${FAKE_WRONG_DIGEST:-}" ]; then echo "$base@sha256:$FAKE_WRONG_DIGEST" >> "$FAKE/have/$hex"; else echo "$norm" >> "$FAKE/have/$hex"; fi
    echo "${FAKE_PULL_ID:-$(idof "$hex")}" > "$FAKE/ids/$hex" ;;
  image)
    case $* in
      *"{{.Id}}"*) case $last in sha256:*) echo "$last" ;; *) grep -Fxq -- "$norm" "$FAKE/have/$hex" 2>/dev/null && cat "$FAKE/ids/$hex" || exit 1 ;; esac ;;
      *) grep -Fx -- "$norm" "$FAKE/have/$hex" 2>/dev/null || exit 1 ;;
    esac ;;
  save) [ -z "${FAKE_SAVE_FAILS:-}" ] || exit 1; out=$3; echo "saved $last" > "$out" ;;
  info) [ -z "${FAKE_DEAD:-}" ] || exit 1; echo "/var/lib/docker|overlay2|${FAKE_DRIVER_STATUS:-[[Backing Filesystem extfs]]}" ;;
  load) [ -f "$3" ] || exit 1; grep -q '^saved ' "$3" || exit 1
        h=$(sed 's/.*@sha256://' "$3"); lid=${FAKE_LOAD_ID:-$(idof "$h")}
        mkdir -p "$FAKE/have" "$FAKE/ids"; echo "$lid" > "$FAKE/ids/$h"
        echo "Loaded image ID: $lid" ;;
  *) echo "unexpected docker call: $*" >&2; exit 2 ;;
esac
FAKE
# A sleep that only records how long it was asked to wait.
cat > "$WORK/bin/sleep" <<'FAKE'
#!/usr/bin/env bash
echo "$1" >> "$FAKE/sleeps"
FAKE
# sudo runs the command (or fails when FAKE_NO_SUDO is set); systemctl logs, and a start makes Docker know the names (and IDs) in the reference file.
cat > "$WORK/bin/sudo" <<'FAKE'
#!/usr/bin/env bash
[ -z "${FAKE_NO_SUDO:-}" ] || exit 1
exec "$@"
FAKE
cat > "$WORK/bin/systemctl" <<'FAKE'
#!/usr/bin/env bash
echo "systemctl $*" >> "$FAKE/calls"
if [ "$1" = start ]; then
  mkdir -p "$FAKE/have" "$FAKE/ids"
  jq -r '.Repositories[] | to_entries[] | "\(.key) \(.value)"' "$PINNED_IMAGES_STORE_FILE" | while read -r key id; do
    echo "$key" >> "$FAKE/have/${key##*@sha256:}"; echo "$id" > "$FAKE/ids/${key##*@sha256:}"
  done
fi
FAKE
chmod +x "$WORK/bin/docker" "$WORK/bin/sleep" "$WORK/bin/sudo" "$WORK/bin/systemctl"

# fresh NAME: a new machine (no images, no calls); the environment of a test is in the caller's variables.
fresh() { FAKE=$WORK/fake-$1; rm -rf "$FAKE"; mkdir -p "$FAKE"; export FAKE; export PINNED_IMAGES_DIR=$FAKE/base GITHUB_OUTPUT=$FAKE/out PINNED_IMAGES_STORE_FILE=$FAKE/repositories.json
  : > "$GITHUB_OUTPUT"; echo '{"Repositories":{}}' > "$PINNED_IMAGES_STORE_FILE"; }
runs() { PATH="$WORK/bin:$PATH" "$SCRIPT" "$@"; }
out_of() { sed -n "s/^$1=//p" "$GITHUB_OUTPUT" | tail -n 1; }
# resolve NAMES: resolves, and leaves the folder of the first image in $dir and its list in $list.
resolve() { runs resolve "$WORK/PINS" "$1" 2>/dev/null; dir=$(out_of dir_1); list=$(out_of list); }
ensure() { PINNED_IMAGES_LIST=$list runs ensure; }

echo "== resolve: one cache entry per image, keyed by its digest"
fresh resolve
runs resolve "$WORK/PINS" "TOOL_IMAGE OTHER_IMAGE" 2>/dev/null
key1=$(out_of key_1); key2=$(out_of key_2); prefix1=$(out_of prefix_1)
[[ $prefix1 == pinned-image-v2-*-$OTHER- ]] || fail "odd cache prefix (images sort by reference): $prefix1"
[[ $key1 == "$prefix1"* ]] || fail "the key is not under the prefix: $key1"
[ "$(out_of prefix_2)" = "pinned-image-v2-local-local-$DIGEST-" ] || fail "odd cache prefix: $(out_of prefix_2)"
[ "$(out_of dir_1)" != "$(out_of dir_2)" ] || fail "two images share a folder"
[ -z "$(out_of key_3)" ] || fail "a third slot was filled"
[ "$(grep -c . "$(out_of list)")" = 2 ] || fail "the list does not have both images"
grep -q " $OTHER_ID " "$(out_of list)" || fail "the list does not carry the image ID of PINS"
runs resolve "$WORK/PINS" "OTHER_IMAGE TOOL_IMAGE" 2>/dev/null
[ "$(out_of key_1)" = "$key1" ] && [ "$(out_of key_2)" = "$key2" ] || fail "the keys depend on the order of the names"
runs resolve "$WORK/PINS" "TOOL_IMAGE" 2>/dev/null
[ "$(out_of prefix_1)" = "$(out_of prefix_2)" ] || fail "the entry of an image depends on the other images of the job"
fresh solo1; runs resolve "$WORK/PINS" "TOOL_IMAGE" 2>/dev/null; p_solo=$(out_of prefix_1)
[ "$p_solo" = "pinned-image-v2-local-local-$DIGEST-" ] || fail "one image alone has another prefix: $p_solo"
RUNNER_OS=Linux RUNNER_ARCH=X64 GITHUB_RUN_ID=77 GITHUB_RUN_ATTEMPT=2 runs resolve "$WORK/PINS" "TOOL_IMAGE" 2>/dev/null
[ "$(out_of key_1)" = "pinned-image-v2-Linux-X64-$DIGEST-77-2" ] || fail "odd key: $(out_of key_1)"
for bad in "TAGGED_IMAGE" "NOT_PINNED" "MISSING_IMAGE" "NO_ID_IMAGE" "BAD_ID_IMAGE"; do
  ! runs resolve "$WORK/PINS" "$bad" 2>/dev/null || fail "resolve accepted $bad"
done
msg=$(runs resolve "$WORK/PINS" "NO_ID_IMAGE" 2>&1 || true)
[[ $msg == *NO_ID_IMAGE_ID* ]] || fail "the missing ID is not named: $msg"

echo "== cache miss: pulled, checked against the ID, saved"
fresh miss
resolve TOOL_IMAGE
ensure 2>/dev/null
[ "$(cat "$FAKE/pulls")" = 1 ] || fail "expected one pull"
[ -f "$dir/$DIGEST.tar" ] || fail "the image was not saved into the cache folder"
[ "$(out_of save_1)" = true ] || fail "save was not asked for"

echo "== cache hit: loaded as the pinned ID, given its digest name, no pull, no save"
fresh hit
resolve "TOOL_IMAGE OTHER_IMAGE"
echo "saved $REF" > "$(out_of dir_2)/$DIGEST.tar"; echo "saved example.invalid/team/other:1.2@sha256:$OTHER" > "$(out_of dir_1)/$OTHER.tar"
ensure 2>/dev/null
grep -q '^load ' "$FAKE/calls" || fail "the cached tarball was not loaded"
[ ! -f "$FAKE/pulls" ] || { cat "$FAKE/calls" >&2; fail "a cached image was pulled: the registry was asked"; }
[ "$(grep -c '^systemctl stop ' "$FAKE/calls")" = 1 ] || fail "Docker should be stopped once for both images"
grep -q '^systemctl start ' "$FAKE/calls" || fail "Docker was not started after the edit"
[ "$(jq -r '.Repositories["example.invalid/team/tool"] | keys[0]' "$PINNED_IMAGES_STORE_FILE")" = "example.invalid/team/tool@sha256:$DIGEST" ] || fail "the digest name of the first image is not in the reference file"
[ "$(jq -r '.Repositories["example.invalid/team/tool"][]' "$PINNED_IMAGES_STORE_FILE")" = "$ID" ] || fail "the name is bound to another ID than the pinned one"
[ "$(jq -r '.Repositories["example.invalid/team/other"] | keys[0]' "$PINNED_IMAGES_STORE_FILE")" = "example.invalid/team/other@sha256:$OTHER" ] || fail "a tagged reference was not written as name@digest"
[ -z "$(out_of save_1)$(out_of save_2)" ] || fail "a cache hit asked to save again"
echo "== the reference file is written whole and moved into place, a copy of the original is kept"
[ ! -e "$PINNED_IMAGES_STORE_FILE.pinned-images.tmp" ] || fail "the temporary file was left"
[ "$(cat "$PINNED_IMAGES_STORE_FILE.pinned-images.orig")" = '{"Repositories":{}}' ] || fail "no copy of the original reference file"

echo "== a cache entry that loads as another image than the pinned ID is refused (whoever wrote it)"
fresh strange
resolve TOOL_IMAGE
echo "saved $REF" > "$dir/$DIGEST.tar"
FAKE_LOAD_ID=$STRANGER_ID ensure > "$FAKE/log" 2>&1 || { cat "$FAKE/log" >&2; fail "did not recover from a wrong cache entry"; }
grep -q 'not the pinned image' "$FAKE/log" || fail "the refusal was not logged"
[ "$(cat "$FAKE/pulls")" = 1 ] || fail "an entry with the wrong ID was used instead of a pull"
! grep -q "$STRANGER_ID" "$PINNED_IMAGES_STORE_FILE" || fail "the wrong ID was bound to the pinned name"
[ "$(out_of save_1)" = true ] || fail "the refused entry was not replaced"
echo "== a cache entry with no way to tell its ID (a garbage tarball) is refused too"
fresh garbage
resolve TOOL_IMAGE
echo "garbage" > "$dir/$DIGEST.tar"
ensure >/dev/null 2>&1
[ "$(cat "$FAKE/pulls")" = 1 ] || fail "garbage was not replaced by a pull"
grep -q '^saved ' "$dir/$DIGEST.tar" || fail "the bad entry was kept"
[ "$(out_of save_1)" = true ] || fail "the bad entry is not refreshed (a save under a fresh key was not asked for)"

echo "== a pulled image with another ID than PINS is refused"
fresh pulledid
resolve TOOL_IMAGE
! FAKE_PULL_ID=$STRANGER_ID ensure >/dev/null 2>&1 || fail "a pulled image with the wrong ID was accepted"
[ ! -f "$dir/$DIGEST.tar" ] || fail "an image with the wrong ID was saved for the cache"

echo "== no sudo, or the containerd store: a cached image is pulled by digest instead"
fresh nosudo
resolve TOOL_IMAGE
echo "saved $REF" > "$dir/$DIGEST.tar"
FAKE_NO_SUDO=1 ensure >/dev/null 2>&1
[ "$(cat "$FAKE/pulls")" = 1 ] || fail "without sudo the image should be pulled once"
fresh containerd
resolve TOOL_IMAGE
echo "saved $REF" > "$dir/$DIGEST.tar"
FAKE_DRIVER_STATUS='[[driver-type io.containerd.snapshotter.v1]]' ensure >/dev/null 2>&1
[ "$(cat "$FAKE/pulls")" = 1 ] || fail "on the containerd store the image should be pulled"
! grep -q '^systemctl' "$FAKE/calls" || fail "Docker was restarted on the containerd store"

echo "== a pull limit: short waits, then the other home of the official image at the same digest"
fresh mirror
resolve ECR_IMAGE
FAKE_FAIL_HOST=public.ecr.aws ensure > "$FAKE/log" 2>&1 || { cat "$FAKE/log" >&2; fail "did not fall back to docker.io"; }
[ "$(grep -c '^pull .*public.ecr.aws' "$FAKE/calls")" = 3 ] || fail "expected 3 tries at ECR Public"
grep -q "^pull --quiet docker.io/library/tool@sha256:$DIGEST\$" "$FAKE/calls" || fail "the same digest was not pulled from docker.io"
[ "$(tr '\n' ' ' < "$FAKE/sleeps")" = "10 20 " ] || fail "waits were: $(tr '\n' ' ' < "$FAKE/sleeps")"
[ "$(jq -r '.Repositories["public.ecr.aws/docker/library/tool"] | keys[0]' "$PINNED_IMAGES_STORE_FILE")" = "$ECR" ] || fail "the pinned name was not given to the mirrored image"
[ "$(out_of save_1)" = true ] || fail "the mirrored image was not saved"
grep -q 'toomanyrequests' "$FAKE/log" || fail "the registry's error was not shown"
echo "== the mirror's image is checked against the ID too, and needs the pinned name"
fresh mirrorid
resolve ECR_IMAGE
! FAKE_FAIL_HOST=public.ecr.aws FAKE_PULL_ID=$STRANGER_ID ensure >/dev/null 2>&1 || fail "a mirrored image with the wrong ID was accepted"
fresh mirrornosudo
resolve ECR_IMAGE
! FAKE_FAIL_HOST=public.ecr.aws FAKE_NO_SUDO=1 ensure >/dev/null 2>&1 || fail "a mirrored image without the pinned name was accepted"
echo "== an image with no other home is only retried"
fresh nomirror
resolve TOOL_IMAGE
! FAKE_PULL_FAILS=99 ensure >/dev/null 2>&1 || fail "ensure succeeded with no image"
[ "$(cat "$FAKE/pulls")" = 3 ] || fail "expected 3 pulls, got $(cat "$FAKE/pulls")"
[ "$(tr '\n' ' ' < "$FAKE/sleeps")" = "10 20 " ] || fail "waits were: $(tr '\n' ' ' < "$FAKE/sleeps")"
echo "== a recovery inside the tries"
fresh retry
resolve TOOL_IMAGE
FAKE_PULL_FAILS=2 ensure >/dev/null 2>&1 || fail "did not recover after 2 limit errors"
[ "$(cat "$FAKE/pulls")" = 3 ] || fail "expected 3 pulls"
echo "== a Docker daemon that does not answer is not retried"
fresh dead
resolve TOOL_IMAGE
! FAKE_DEAD=1 ensure >/dev/null 2>&1 || fail "ensure succeeded without a daemon"
[ "$(cat "$FAKE/pulls")" = 1 ] || fail "a dead daemon was retried: $(cat "$FAKE/pulls") pulls"
[ ! -f "$FAKE/sleeps" ] || fail "waited for a dead daemon"

echo "== an image that cannot be saved is a warning, not a partial entry"
fresh nosave
resolve TOOL_IMAGE
FAKE_SAVE_FAILS=1 ensure > "$FAKE/log" 2>&1 || fail "a failed save failed the job"
grep -q '::warning::could not save' "$FAKE/log" || fail "no warning for the failed save"
[ -z "$(out_of save_1)" ] || fail "a save was asked for an image that has no tarball"
[ ! -e "$dir/$DIGEST.tar" ] && [ ! -e "$dir/$DIGEST.tar.part" ] || fail "a partial tarball was left"

echo "== an image under another digest is refused"
fresh wrong
resolve TOOL_IMAGE
! FAKE_WRONG_DIGEST=$OTHER ensure >/dev/null 2>&1 || fail "an image with the wrong digest was accepted"

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
