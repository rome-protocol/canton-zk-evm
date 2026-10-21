#!/usr/bin/env bash
# Gets the pinned Docker images of PINS onto this machine without leaning on a public registry's pull limit.
#   pinned-images.sh resolve PINS_FILE "NAME NAME ..."   checks the names, writes the cache key and folder to $GITHUB_OUTPUT
#   pinned-images.sh ensure                              loads each image from the folder, else pulls it by digest with retries;
#                                                        checks the digest; saves a tarball of each image that was pulled
# Every image is named by digest in PINS, so a cache entry is keyed by those digests and a loaded or pulled image is checked
# against the same digest. Docker cannot give a loaded image a digest name (a digest is not a tag), so after a load the pull by
# digest still runs; it finds every layer on the machine and fetches only the few-kilobyte manifest, and it is what proves the
# image is the pinned one: layers are matched by content, so a bad cache entry cannot stand in for the pinned image. The pull is retried with a doubling wait: PINNED_IMAGES_TRIES (6), PINNED_IMAGES_FIRST_DELAY (20 s),
# PINNED_IMAGES_MAX_DELAY (300 s): 20 + 40 + 80 + 160 + 300 s, about ten minutes, before the job fails.
set -euo pipefail

TRIES=${PINNED_IMAGES_TRIES:-6}
FIRST_DELAY=${PINNED_IMAGES_FIRST_DELAY:-20}
MAX_DELAY=${PINNED_IMAGES_MAX_DELAY:-300}
BASE=${PINNED_IMAGES_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/pinned-images}

log() { echo "pinned-images: $*" >&2; }
fail() { echo "pinned-images: FAIL: $*" >&2; exit 1; }
output() { if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "$1=$2" >> "$GITHUB_OUTPUT"; else echo "$1=$2"; fi; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi
}

digest_of() { echo "${1##*@sha256:}"; }

# True when the machine has the image under this reference and records the pinned digest for it.
have_pinned() {
  local ref=$1 want
  want="sha256:$(digest_of "$ref")"
  docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$ref" 2>/dev/null | grep -q "@${want}\$"
}

pull_with_retries() {
  local ref=$1 attempt=1 delay=$FIRST_DELAY
  while :; do
    if docker pull --quiet "$ref" >/dev/null 2>"$BASE/pull.err"; then return 0; fi
    echo "::warning::pull of $ref failed (attempt $attempt of $TRIES): $(tail -n 1 "$BASE/pull.err")"
    [ "$attempt" -lt "$TRIES" ] || return 1
    log "waiting ${delay}s before the next try"
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2)); [ "$delay" -le "$MAX_DELAY" ] || delay=$MAX_DELAY
  done
}

save_image() {
  local ref=$1 tar=$2 id
  if docker save --output "$tar.part" "$ref" 2>/dev/null; then mv "$tar.part" "$tar"; return 0; fi
  # Some Docker image stores cannot save a digest reference; the image ID always can. A load of that tarball has no name, and the
  # pull that follows it then finds every layer on the machine and fetches only the manifest.
  id=$(docker image inspect --format '{{.Id}}' "$ref") || return 1
  if docker save --output "$tar.part" "$id" 2>/dev/null; then mv "$tar.part" "$tar"; return 0; fi
  rm -f "$tar.part"; return 1
}

cmd_resolve() {
  local pins=${1:?PINS file} names=${2:?image names} name value refs="" hash dir
  [ -f "$pins" ] || fail "no PINS file at $pins"
  for name in $names; do
    case $name in *_IMAGE) ;; *) fail "$name is not an image name (*_IMAGE)" ;; esac
    value=$(grep -E "^${name}=" "$pins" | head -n 1 | cut -d= -f2-)
    [ -n "$value" ] || fail "$name is not in $pins"
    [[ $value =~ ^[a-z0-9./_:-]+@sha256:[0-9a-f]{64}$ ]] || fail "$name is not pinned by digest"
    refs="$refs$value"$'\n'
  done
  refs=$(printf '%s' "$refs" | LC_ALL=C sort -u)
  hash=$(printf '%s\n' "$refs" | sha256_of)
  dir="$BASE/cache-${hash:0:16}"
  mkdir -p "$dir"
  printf '%s\n' "$refs" > "$dir.refs"
  output key "pinned-images-v1-${RUNNER_OS:-local}-${RUNNER_ARCH:-local}-$hash"
  output dir "$dir"
}

cmd_ensure() {
  local dir=${PINNED_IMAGES_CACHE_DIR:?cache folder} ref tar saved=0 loaded
  mkdir -p "$dir" "$BASE"
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    tar="$dir/$(digest_of "$ref").tar"
    loaded=0
    if [ -f "$tar" ]; then
      if docker load --input "$tar" >/dev/null 2>&1; then loaded=1; else log "the cached $ref did not load; dropping it"; rm -f "$tar"; fi
    fi
    if have_pinned "$ref"; then
      log "$ref is on this machine"
    else
      [ "$loaded" = 0 ] || log "$ref is loaded without its digest; pulling it (the layers are here already)"
      pull_with_retries "$ref" || fail "could not pull $ref in $TRIES tries"
    fi
    have_pinned "$ref" || fail "$ref is on this machine but not under the pinned digest"
    if [ ! -f "$tar" ]; then
      if save_image "$ref" "$tar"; then saved=1; log "saved $ref for the cache"; else echo "::warning::could not save $ref for the cache"; fi
    fi
  done < "${PINNED_IMAGES_CACHE_DIR}.refs"
  output save "$([ "$saved" = 1 ] && echo true || echo false)"
}

case ${1:-} in
  resolve) shift; cmd_resolve "$@" ;;
  ensure) cmd_ensure ;;
  *) fail "usage: $0 resolve PINS_FILE NAMES | ensure" ;;
esac
