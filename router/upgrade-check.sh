#!/usr/bin/env bash
# The upgrade rules of the design's section 3.7, as a check that blocks a merge:
#  1. the inbox's checked-in bytes hash to the pinned inboxCodeHash and are the bytes src/InboxCode.sol embeds;
#  2. OpenZeppelin's upgrade-safety check (@openzeppelin/upgrades-core, pinned in upgrade-check/package-lock.json) on the Forge build, against the deployed
#     build's checked-in compiler output (artifacts/deployed-v1, written by snapshot.sh): the current src/ and the test version 2 must pass, and the test
#     versions that swap two fields (test/Reordered.sol) must fail on the storage layout.
# REFERENCE (a folder name under artifacts/) names the deployed build. Needs node and npm.
set -euo pipefail
# shellcheck disable=SC1091
. "$(dirname "$0")/tools.sh"
cd "$HERE"
REFERENCE=${REFERENCE:-deployed-v1}

inbox_check() { # hex file, vectors file
  local hex pinned
  hex=0x$(tr -d '[:space:]' < "$1")
  pinned=$(jq -r .inboxCodeHash "$2")
  [ "$(cast keccak "$hex")" = "$pinned" ] || return 1
  grep -q "hex\"${hex#0x}\"" src/InboxCode.sol
}
inbox_check artifacts/CantonInbox.creation.hex test/vectors/r1.json || fail "the inbox artifact is not the pinned inboxCodeHash, or src/InboxCode.sol embeds other bytes"
printf '00%s' "$(cat artifacts/CantonInbox.creation.hex)" > "$WORK/changed.hex"
! inbox_check "$WORK/changed.hex" test/vectors/r1.json || fail "the inbox check accepted changed bytes"
echo "ok: inbox artifact"

rm -rf out-upgrade cache-upgrade  # old build info files make the check name a contract twice
FOUNDRY_PROFILE=upgrade "$FORGE" build
(cd upgrade-check && npm ci --ignore-scripts --no-audit --no-fund --silent)
validate() { # contract reference
  node upgrade-check/node_modules/@openzeppelin/upgrades-core/dist/cli/cli.js validate out-upgrade/build-info --contract "$1" --reference "$REFERENCE:$2" \
    --referenceBuildInfoDirs "artifacts/$REFERENCE" 2>&1  # a constructor passes only where it is marked (@custom:oz-upgrades-unsafe-allow)
}
for pair in CantonRouter:CantonRouter CantonBook:CantonBook CantonRouterV2:CantonRouter CantonBookV2:CantonBook; do
  validate "${pair%%:*}" "${pair##*:}" > "$WORK/out.txt" || { cat "$WORK/out.txt"; fail "${pair%%:*} is not an upgrade-safe version of ${pair##*:}"; }
  echo "ok: ${pair%%:*} passes"
done
for pair in CantonRouterReordered:CantonRouter CantonBookReordered:CantonBook; do
  if validate "${pair%%:*}" "${pair##*:}" > "$WORK/out.txt"; then fail "${pair%%:*} swaps two fields and the check passed it"; fi
  grep -q "Inserted\|Deleted\|Replaced" "$WORK/out.txt" || { cat "$WORK/out.txt"; fail "${pair%%:*} failed, but not on the storage layout"; }
  echo "ok: ${pair%%:*} is refused"
done
if validate CantonBookUnmarked CantonBook > "$WORK/out.txt"; then fail "a constructor that is not marked passed the check"; fi
grep -q "constructor" "$WORK/out.txt" || { cat "$WORK/out.txt"; fail "CantonBookUnmarked failed, but not on its constructor"; }
echo "ok: an unmarked constructor is refused"
