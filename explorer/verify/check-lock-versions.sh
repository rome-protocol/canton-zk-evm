#!/usr/bin/env bash
# The WebAssembly module is built from the sidecar's code with this crate's own Cargo.lock, so the two lockfiles can drift apart:
# a crate the sidecar's confirmers run at one version could be built into the module at another. This fails when a crate that is in
# both explorer/verify/Cargo.lock and sidecar/Cargo.lock is locked at different versions. A crate in only one of them is not compared.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
a="$root/explorer/verify/Cargo.lock"
b="$root/sidecar/Cargo.lock"

# "name version" for each package in a lockfile, one per line, sorted.
packages() {
  awk '
    /^\[\[package\]\]/ { name = ""; next }
    /^name = / { gsub(/"/, "", $3); name = $3; next }
    /^version = / && name != "" { gsub(/"/, "", $3); print name, $3; name = "" }
  ' "$1" | sort -u
}

# For each crate in both, the versions each lockfile holds, joined: "name  verify: 1.0.1  sidecar: 1.0.2".
mismatch="$(join -j 1 \
  <(packages "$a" | awk '{ v[$1] = v[$1] (v[$1] ? "," : "") $2 } END { for (n in v) print n, v[n] }' | sort) \
  <(packages "$b" | awk '{ v[$1] = v[$1] (v[$1] ? "," : "") $2 } END { for (n in v) print n, v[n] }' | sort) |
  awk '$2 != $3 { printf "  %s: explorer/verify has %s, sidecar has %s\n", $1, $2, $3 }')"

shared="$(join -j 1 <(packages "$a" | cut -d' ' -f1 | sort -u) <(packages "$b" | cut -d' ' -f1 | sort -u) | wc -l | tr -d ' ')"
if [ "$shared" -eq 0 ]; then
  echo "No crate is in both lockfiles. Either they changed shape or this script reads them wrongly." >&2
  exit 1
fi

if [ -n "$mismatch" ]; then
  echo "These crates are locked at different versions in explorer/verify/Cargo.lock and sidecar/Cargo.lock:" >&2
  echo "$mismatch" >&2
  echo "Run: cargo update --manifest-path explorer/verify/Cargo.toml --precise <version> <crate>   (or the same in sidecar/)" >&2
  exit 1
fi
echo "The $shared crates in both lockfiles are at the same versions."
