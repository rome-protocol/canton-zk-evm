#!/usr/bin/env bash
# Gets the pinned Docker images of PINS onto this machine without leaning on one public registry's pull limit.
#   pinned-images.sh resolve PINS_FILE "NAME NAME ..."   checks the names, writes the cache keys and folders to $GITHUB_OUTPUT
#   pinned-images.sh ensure                              loads each image from its folder, else pulls it by digest; checks the image ID;
#                                                        asks for a save of every image that was not in the cache
#
# The repository holds the truth, the cache only holds bytes. Every *_IMAGE of PINS is pinned by digest and has a *_IMAGE_ID next to it,
# the image ID (config digest, linux/amd64). An image comes into a job in one of two ways:
#   - from the Actions cache: the tarball must load as exactly that ID, or it is dropped; then the digest name is written for it into
#     Docker's own reference file (repositories.json of the classic image store) while the daemon is stopped, as a pull would have
#     done, so the registry is not asked at all. No cache entry, whoever wrote it, can make a job run anything but the pinned image.
#   - from a registry, by digest: a pull by digest is verified by Docker, and the ID is checked again afterwards. If the registry
#     refuses (a pull limit), the same digest is pulled from the other home of the official images (public.ecr.aws/docker/library/X and
#     docker.io/library/X carry identical digests); that image is checked against the ID and given the pinned name the same way.
# Where the names cannot be written (another image store, no sudo, no jq) a cached image is pulled instead: the layers are on the machine
# and only the manifest is fetched.
# The cache is keyed per image (one entry per image digest, kept once per scope). An entry that was bad is replaced under a fresh key:
# the newest entry of the prefix wins on restore.
# The pull is retried with a short wait, since a data quota is not lifted by waiting: PINNED_IMAGES_TRIES (3), PINNED_IMAGES_FIRST_DELAY
# (10 s), PINNED_IMAGES_MAX_DELAY (30 s): 10 + 20 s per registry. A retry stops at once when the Docker daemon is not answering.
set -euo pipefail

TRIES=${PINNED_IMAGES_TRIES:-3}
FIRST_DELAY=${PINNED_IMAGES_FIRST_DELAY:-10}
MAX_DELAY=${PINNED_IMAGES_MAX_DELAY:-30}
BASE=${PINNED_IMAGES_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/pinned-images}
SLOTS=7   # the action has this many cache slots (tests/ci_images_static.py: the most images a job names is seven)

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

containerd_store() { docker info --format '{{.DriverStatus}}' 2>/dev/null | grep -q 'io.containerd.snapshotter'; }

# True when the image under this reference has the ID PINS records. On the containerd image store an ID is not the config digest, so
# there the check is left to Docker's own verification of a pull by digest.
has_id() {
  local ref=$1 want=$2
  if containerd_store; then return 0; fi
  [ "$(docker image inspect --format '{{.Id}}' "$ref" 2>/dev/null || true)" = "$want" ]
}

# The other home of an official image: public.ecr.aws/docker/library/NAME[:tag]@digest is docker.io/library/NAME@digest. Nothing for the others.
mirror_of() {
  local ref=$1 name
  case $ref in
    public.ecr.aws/docker/library/*)
      name=${ref#public.ecr.aws/docker/library/}; name=${name%@*}; name=${name%:*}
      echo "docker.io/library/$name@${ref##*@}" ;;
  esac
}

pull_with_retries() {
  local ref=$1 attempt=1 delay=$FIRST_DELAY
  while :; do
    if docker pull --quiet "$ref" >/dev/null 2>"$BASE/pull.err"; then return 0; fi
    echo "::warning::pull of $ref failed (attempt $attempt of $TRIES): $(tail -n 1 "$BASE/pull.err")"
    docker info >/dev/null 2>&1 || { log "the Docker daemon does not answer; not retrying"; return 1; }
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
  # Some Docker image stores cannot save a digest reference; the image ID always can.
  id=$(docker image inspect --format '{{.Id}}' "$ref") || return 1
  if docker save --output "$tar.part" "$id" 2>/dev/null; then mv "$tar.part" "$tar"; return 0; fi
  rm -f "$tar.part"; return 1
}

cmd_resolve() {
  local pins=${1:?PINS file} names=${2:?image names} name value id refs="" ref hex idx=0 dir prefix
  [ -f "$pins" ] || fail "no PINS file at $pins"
  for name in $names; do
    case $name in *_IMAGE) ;; *) fail "$name is not an image name (*_IMAGE)" ;; esac
    value=$(grep -E "^${name}=" "$pins" | head -n 1 | cut -d= -f2- || true)
    [ -n "$value" ] || fail "$name is not in $pins"
    [[ $value =~ ^[a-z0-9./_:-]+@sha256:[0-9a-f]{64}$ ]] || fail "$name is not pinned by digest"
    id=$(grep -E "^${name}_ID=" "$pins" | head -n 1 | cut -d= -f2- || true)
    [[ $id =~ ^sha256:[0-9a-f]{64}$ ]] || fail "${name}_ID is not in $pins (the image ID, sha256: and 64 hex digits)"
    refs="$refs$value $id"$'\n'
  done
  refs=$(printf '%s' "$refs" | LC_ALL=C sort -u)
  [ "$(printf '%s\n' "$refs" | grep -c .)" -le "$SLOTS" ] || fail "more than $SLOTS different images: the action has $SLOTS cache slots"
  mkdir -p "$BASE"
  : > "$BASE/images.list"
  while read -r ref id; do
    [ -n "$ref" ] || continue
    idx=$((idx + 1)); hex=$(digest_of "$ref")
    dir="$BASE/image-${hex:0:16}"
    mkdir -p "$dir"
    prefix="pinned-image-v2-${RUNNER_OS:-local}-${RUNNER_ARCH:-local}-$hex-"
    echo "$idx $ref $id $dir" >> "$BASE/images.list"
    output "dir_$idx" "$dir"
    output "prefix_$idx" "$prefix"
    # The key to save under is new every run: restore takes the newest entry of the prefix, so a bad entry is replaced, never stuck.
    output "key_$idx" "${prefix}${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"
  done <<< "$refs"
  output list "$BASE/images.list"
}

# The repository name and the key Docker writes after a pull by digest: the tag, if the reference has one, is dropped.
store_names() {
  local ref=$1 base name
  base=${ref%@*}
  name=$base
  case ${base##*/} in *:*) name=${base%:*} ;; esac
  echo "$name@${ref##*@}"
}

# Writes name@digest -> image ID into the classic image store's reference file, with the daemon stopped. "REF ID" lines on stdin.
# The file is written whole beside the original and moved over it; a copy of the original is kept.
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
  log "stopping Docker to write the digest names of the images"
  # shellcheck disable=SC2086
  $sudo_cmd systemctl stop docker.socket docker.service || return 1
  # shellcheck disable=SC2086
  if ! { $sudo_cmd cp -p "$file" "$file.pinned-images.orig" && printf '%s\n' "$edited" | $sudo_cmd tee "$file.pinned-images.tmp" >/dev/null \
         && $sudo_cmd mv "$file.pinned-images.tmp" "$file"; }; then
    $sudo_cmd rm -f "$file.pinned-images.tmp" || true
    $sudo_cmd systemctl start docker.service || true
    return 1
  fi
  # shellcheck disable=SC2086
  $sudo_cmd systemctl start docker.service || return 1
  local _
  for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}

cmd_ensure() {
  local list=${PINNED_IMAGES_LIST:?list of images} idx ref id dir hex tar loaded_id bind="" mirror
  mkdir -p "$BASE"
  # 1. Load what the cache has. An entry that does not load, or loads as another image than the ID in PINS, is dropped.
  while read -r idx ref id dir; do
    [ -n "$ref" ] || continue
    hex=$(digest_of "$ref"); tar="$dir/$hex.tar"
    [ -f "$tar" ] || continue
    loaded_id=$(docker load --input "$tar" 2>/dev/null | sed -n 's/^Loaded image ID: //p' | tail -n 1 || true)
    if [ "$loaded_id" != "$id" ]; then
      log "the cached $ref is not the pinned image (loaded as '${loaded_id:-nothing}', PINS has $id); dropping it"; rm -f "$tar"; continue
    fi
    if ! { have_pinned "$ref" && has_id "$ref" "$id"; }; then bind="$bind$ref $id"$'\n'; fi
  done < "$list"
  # 2. Give the loaded images their digest names, so the registry is not asked for them.
  if [ -n "$bind" ]; then
    printf '%s' "$bind" | bind_names || log "the digest names could not be written; those images will be pulled"
  fi
  # 3. Whatever is still not here under its digest name and ID is pulled; then everything is checked, and what was not in the cache is saved.
  while read -r idx ref id dir; do
    [ -n "$ref" ] || continue
    hex=$(digest_of "$ref"); tar="$dir/$hex.tar"
    if have_pinned "$ref" && has_id "$ref" "$id"; then
      log "$ref is on this machine"
    else
      if pull_with_retries "$ref"; then
        have_pinned "$ref" || fail "$ref was pulled but is not under the pinned digest"
        has_id "$ref" "$id" || fail "$ref was pulled but its image ID is not the one in PINS ($id)"
      else
        mirror=$(mirror_of "$ref")
        [ -n "$mirror" ] || fail "could not pull $ref in $TRIES tries (no other registry holds it)"
        log "could not pull $ref; trying the same digest at $mirror"
        pull_with_retries "$mirror" || fail "could not pull $ref in $TRIES tries, nor $mirror"
        has_id "$mirror" "$id" || fail "$mirror was pulled but its image ID is not the one in PINS ($id)"
        printf '%s %s\n' "$ref" "$id" | bind_names || fail "pulled $mirror, but could not give it the pinned name $ref (no sudo, or another image store)"
        have_pinned "$ref" || fail "$ref is not under the pinned digest after the pull of $mirror"
        has_id "$ref" "$id" || fail "$ref has not the image ID of PINS after the pull of $mirror"
      fi
    fi
    if [ ! -f "$tar" ]; then
      if save_image "$ref" "$tar"; then
        output "save_$idx" true; log "saved $ref for the cache"
      else
        rm -f "$tar"; echo "::warning::could not save $ref for the cache"
      fi
    fi
  done < "$list"
}

case ${1:-} in
  resolve) shift; cmd_resolve "$@" ;;
  ensure) cmd_ensure ;;
  *) fail "usage: $0 resolve PINS_FILE NAMES | ensure" ;;
esac
