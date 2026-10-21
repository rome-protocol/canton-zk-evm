#!/usr/bin/env bash
# Gets the pinned Docker images of PINS onto this machine without leaning on a public registry's pull limit.
#   pinned-images.sh resolve PINS_FILE "NAME NAME ..."   checks the names, writes the cache key and folder to $GITHUB_OUTPUT
#   pinned-images.sh ensure                              loads each image from the folder, else pulls it by digest with retries;
#                                                        checks the digest; saves a tarball of each image that was pulled
# Every image is named by digest in PINS, so a cache entry is keyed by those digests. Docker cannot give a loaded image a digest
# name (a digest is not a tag), and a pull to find the image would ask the registry, which is the thing that is over its limit.
# So after a load this script writes the digest name into Docker's own reference file (repositories.json of the classic image
# store) while the daemon is stopped, as a pull would have; the image ID loaded must be the ID recorded when the image was first
# pulled from the registry, and the daemon then answers for the pinned digest name. Where that cannot be done (another image
# store, no sudo, no jq) the pull by digest still runs, with retries, and finds every layer on the machine.
# The pull is retried with a doubling wait: PINNED_IMAGES_TRIES (6), PINNED_IMAGES_FIRST_DELAY (20 s), PINNED_IMAGES_MAX_DELAY
# (300 s): 20 + 40 + 80 + 160 + 300 s, about ten minutes, before the job fails.
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

# The repository name and the key Docker writes after a pull by digest: the tag, if the reference has one, is dropped.
store_names() {
  local ref=$1 base name
  base=${ref%@*}
  name=$base
  case ${base##*/} in *:*) name=${base%:*} ;; esac
  echo "$name@${ref##*@}"
}

# Writes name@digest -> image ID into the classic image store's reference file, with the daemon stopped. Arguments: "REF ID" lines on stdin.
bind_names() {
  local sudo_cmd=${PINNED_IMAGES_SUDO:-sudo} file root driver info lines edited ref id key name
  lines=$(cat)
  [ -n "$lines" ] || return 0
  command -v jq >/dev/null 2>&1 || { log "no jq; not binding digest names"; return 1; }
  info=$(docker info --format '{{.DockerRootDir}}|{{.Driver}}|{{.DriverStatus}}') || return 1
  case $info in *io.containerd.snapshotter*) log "this Docker uses the containerd image store; not binding digest names"; return 1 ;; esac
  root=${info%%|*}; driver=${info#*|}; driver=${driver%%|*}
  file=${PINNED_IMAGES_STORE_FILE:-$root/image/$driver/repositories.json}
  # shellcheck disable=SC2086
  edited=$($sudo_cmd cat "$file") || { log "cannot read $file"; return 1; }
  while read -r ref id; do
    [ -n "$ref" ] || continue
    key=$(store_names "$ref"); name=${key%@*}
    edited=$(printf '%s' "$edited" | jq --arg n "$name" --arg k "$key" --arg id "$id" '.Repositories[$n][$k] = $id') || return 1
  done <<< "$lines"
  [ -n "$edited" ] || return 1
  log "stopping Docker to write the digest names of the loaded images"
  # shellcheck disable=SC2086
  $sudo_cmd systemctl stop docker.socket docker.service || return 1
  # shellcheck disable=SC2086
  printf '%s\n' "$edited" | $sudo_cmd tee "$file" >/dev/null || { $sudo_cmd systemctl start docker.service || true; return 1; }
  # shellcheck disable=SC2086
  $sudo_cmd systemctl start docker.service || return 1
  local _
  for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}

cmd_ensure() {
  local dir=${PINNED_IMAGES_CACHE_DIR:?cache folder} ref hex tar loaded_id want_id saved=0 bind="" id
  mkdir -p "$dir" "$BASE"
  # 1. Load what the cache has; an entry that does not load, or loads as another image than the one recorded (when one was), is dropped.
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    hex=$(digest_of "$ref"); tar="$dir/$hex.tar"
    [ -f "$tar" ] || continue
    want_id=$(cat "$dir/$hex.id" 2>/dev/null || true)
    loaded_id=$(docker load --input "$tar" 2>/dev/null | sed -n 's/^Loaded image ID: //p' | tail -n 1 || true)
    if [ -z "$loaded_id" ] || { [ -n "$want_id" ] && [ "$loaded_id" != "$want_id" ]; }; then
      log "the cached $ref did not load as the image that was saved; dropping it"; rm -f "$tar" "$dir/$hex.id"; continue
    fi
    have_pinned "$ref" || bind="$bind$ref $loaded_id"$'\n'
  done < "${PINNED_IMAGES_CACHE_DIR}.refs"
  # 2. Give the loaded images their digest names, so the registry is not asked for them.
  if [ -n "$bind" ]; then
    printf '%s' "$bind" | bind_names || log "the digest names could not be written; those images will be pulled"
  fi
  # 3. Whatever is still not here under its digest is pulled, with retries; then everything is checked and the new ones are saved.
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    hex=$(digest_of "$ref"); tar="$dir/$hex.tar"
    if have_pinned "$ref"; then
      log "$ref is on this machine"
    else
      pull_with_retries "$ref" || fail "could not pull $ref in $TRIES tries"
    fi
    have_pinned "$ref" || fail "$ref is on this machine but not under the pinned digest"
    if [ ! -f "$tar" ]; then
      if id=$(docker image inspect --format '{{.Id}}' "$ref") && save_image "$ref" "$tar"; then
        echo "$id" > "$dir/$hex.id"; saved=1; log "saved $ref for the cache"
      else
        rm -f "$tar"; echo "::warning::could not save $ref for the cache"
      fi
    fi
  done < "${PINNED_IMAGES_CACHE_DIR}.refs"
  output save "$([ "$saved" = 1 ] && echo true || echo false)"
}

case ${1:-} in
  resolve) shift; cmd_resolve "$@" ;;
  ensure) cmd_ensure ;;
  *) fail "usage: $0 resolve PINS_FILE NAMES | ensure" ;;
esac
