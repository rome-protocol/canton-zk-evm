# shellcheck shell=bash
# Sourced by run.sh, deploy-test.sh and upgrade-check.sh. Sets up the pinned tools: forge, cast and anvil (tests/FOUNDRY, by SHA-256 of the release),
# solc (the static one in PINS' SOLC_IMAGE) and forge-std (TOOLS, by full commit hash). On Linux x86-64 it fetches what is not given;
# FORGE and SOLC (paths) override, and cast and anvil then come from PATH. Leaves FORGE and SOLC set, FOUNDRY_SOLC exported, HERE and ROOT set.
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
set -a
# shellcheck disable=SC1091
. "$ROOT/PINS"
# shellcheck disable=SC1091
. "$ROOT/tests/FOUNDRY"
# shellcheck disable=SC1091
. "$HERE/TOOLS"
set +a
fail() { echo "FAIL: $*" >&2; exit 1; }
WORK=$(mktemp -d)
cleanup() { docker rm -f cze-router-solc >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

if [ -z "${FORGE:-}" ]; then
  [ "$(uname -s)-$(uname -m)" = Linux-x86_64 ] || fail "the pinned Foundry is the Linux x86-64 build; set FORGE to use another"
  curl -fsSL -A "Rome Protocol rome@romeprotocol.com" -o "$WORK/foundry.tgz" "https://github.com/foundry-rs/foundry/releases/download/$FOUNDRY_VERSION/foundry_${FOUNDRY_VERSION}_linux_amd64.tar.gz"
  echo "$FOUNDRY_LINUX_AMD64_SHA256  $WORK/foundry.tgz" | sha256sum -c -
  tar -xzf "$WORK/foundry.tgz" -C "$WORK" forge cast anvil
  FORGE=$WORK/forge
  export PATH="$WORK:$PATH"
fi

if [ -z "${SOLC:-}" ]; then
  docker create --name cze-router-solc "$SOLC_IMAGE" >/dev/null
  docker cp cze-router-solc:/usr/bin/solc "$WORK/solc"
  SOLC=$WORK/solc
fi
"$SOLC" --version | grep -q "Version: $SOLC_VERSION+" || fail "the solc is not $SOLC_VERSION"
export FOUNDRY_SOLC=$SOLC

if [ ! -f "$HERE/lib/forge-std/src/Test.sol" ]; then
  mkdir -p "$HERE/lib/forge-std"
  git -C "$HERE/lib/forge-std" init -q
  git -C "$HERE/lib/forge-std" -c http.userAgent="Rome Protocol rome@romeprotocol.com" fetch -q --depth 1 https://github.com/foundry-rs/forge-std.git "$FORGE_STD_COMMIT"
  git -C "$HERE/lib/forge-std" checkout -q FETCH_HEAD
  [ "$(git -C "$HERE/lib/forge-std" rev-parse HEAD)" = "$FORGE_STD_COMMIT" ] || fail "forge-std is not the pinned commit"
fi
