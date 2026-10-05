#!/usr/bin/env bash
# Checks on the network files that need neither Docker nor Canton:
#   - reth is started only by network/reth/launch.sh, and network/up.sh checks discovery after starting it
#   - canton.conf: every node in memory and on localhost, the extension on the operator's and the confirmer's
#     participants only, each pointing at its own sidecar port, and the sidecar ports are the ones up.sh starts
#   - no key, token or password is written in any network file
#   - the recorded smoke result is complete and consistent and in format 2 (what network/smoke.sh writes), and the same
#     checks are run on a fixture, which they must accept, and on copies with one fault each, which they must refuse
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
fail() { echo "FAIL: $*" >&2; exit 1; }
CONF=$ROOT/network/canton/canton.conf

# reth: nothing but launch.sh names its image or runs it.
others=$(grep -rIlE --include='*.sh' --include='*.py' --include='*.rs' 'RETH_IMAGE|paradigmxyz|reth node|docker run' "$ROOT/network" "$ROOT/builder" "$ROOT/prover" "$ROOT/sidecar/src" 2>/dev/null | grep -v '^'"$ROOT"'/network/reth/launch.sh$' || true)
[ -z "$others" ] || fail "something other than network/reth/launch.sh starts or names reth's image: $others"
grep -q 'network/reth/launch.sh' "$ROOT/network/up.sh" || fail "up.sh does not start reth through launch.sh"
grep -q 'network/reth/check.sh' "$ROOT/network/up.sh" || fail "up.sh does not check that discovery is off"
grep -q 'network/reth/stop.sh' "$ROOT/network/down.sh" || fail "down.sh does not stop reth through stop.sh"

# canton.conf
[ "$(grep -c 'storage.type = memory' "$CONF")" = 5 ] || fail "not every node (1 sequencer, 1 mediator, 3 participants) is in memory"
bad=$(grep -E 'address *=' "$CONF" | grep -v '"127.0.0.1"' || true)
[ -z "$bad" ] || fail "an address other than 127.0.0.1: $bad"
[ "$(grep -c 'extensions.canton-zk-evm' "$CONF")" = 2 ] || fail "the extension is not on exactly two participants"
users=$(sed -n '/^    users {/,$p' "$CONF")
! grep -q 'extensions' <<<"$users" || fail "the users participant has an extension"
for who in operator:8085 confirmer:8086; do
  block=$(sed -n "/^    ${who%%:*} {/,/^    }/p" "$CONF")
  grep -q "port = ${who##*:}" <<<"$block" || fail "the ${who%%:*} participant's extension is not on ${who##*:}"
done
for port in 8085 8086; do grep -q "$port" "$ROOT/network/up.sh" || fail "up.sh does not start a sidecar on $port"; done
# The Ledger API port the builder defaults to is the operator's.
grep -A8 '^    operator {' "$CONF" | grep -q 'http-ledger-api.*port = 7575' || fail "the operator's JSON Ledger API is not on 7575"

# No secret is written down: keys, tokens and passwords are made per run (see network/make-state.sh).
! grep -rInE '(secret|password|passwd|token|private[-_ ]?key) *[=:] *["'"'"']?[A-Za-z0-9+/]{16,}' "$ROOT/network" || fail "something that looks like a secret in network/"
# What a smoke result must hold. check_smoke <result file> <file with the recorded programVK>: prints what is wrong and
# returns 1, so that the same checks run on the recorded result and, in the tests below, on a fixture.
check_smoke() {
  local R=$1 S=$2
  bad() { echo "$*"; return 1; }
  for k in block_hash proof_seconds advance_seconds canton_head_number canton_head_hash block_record_seen_by_reader reth_finalized canton daml_sdk zisk; do
    grep -qE "^$k=." "$R" || { bad "smoke result has no $k"; return 1; }
  done
  [ "$(sed -n 's/^block_hash=//p' "$R")" = "$(sed -n 's/^canton_head_hash=//p' "$R")" ] || { bad "Canton's head is not the block"; return 1; }
  [ "$(sed -n 's/^canton_head_number=//p' "$R")" = 1 ] || { bad "Canton's head is not 1"; return 1; }
  [ "$(sed -n 's/^reth_finalized=//p' "$R")" = yes ] || { bad "reth did not finalize the block"; return 1; }
  # Generic only: no email address and no IPv4 address.
  ! grep -qE '@|[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}([^0-9.]|$)' "$R" || { bad "an email address or an IPv4 address"; return 1; }
  # Format 2 (what network/smoke.sh writes): the result also names the source commit it ran, the DAR and the package id,
  # and its programVK is the recorded one. These checks always run; a result without a format line is refused.
  [ "$(sed -n 's/^format=//p' "$R")" = 2 ] || { bad "not format 2 (missing or unknown format line)"; return 1; }
  for k in source_commit dar_sha256 package_id; do grep -qE "^$k=." "$R" || { bad "no $k"; return 1; }; done
  [[ $(sed -n 's/^source_commit=//p' "$R") =~ ^[0-9a-f]{40}$ ]] || { bad "source_commit is not a full commit hash"; return 1; }
  [[ $(sed -n 's/^dar_sha256=//p' "$R") =~ ^[0-9a-f]{64}$ ]] || { bad "dar_sha256 is not a SHA-256"; return 1; }
  [[ $(sed -n 's/^package_id=//p' "$R") =~ ^[0-9a-f]{64}$ ]] || { bad "package_id is not 64 hex digits"; return 1; }
  [ "$(sed -n 's/^programVK=//p' "$R")" = "$(sed -n 's/^programVK=//p' "$S")" ] || { bad "programVK is not the recorded one"; return 1; }
}
# The recorded smoke result is complete and consistent.
out=$(check_smoke "$ROOT/demo/results/smoke.txt" "$ROOT/prover/fixtures/session.txt") || fail "demo/results/smoke.txt: $out"

# The same checks, exercised on a fixture with made-up values: the fixture passes, and each fault that the checks are
# there to catch is caught.
F=$ROOT/tests/data/smoke-format2.txt
grep -q '^format=2$' "$F" || fail "the fixture is not format 2"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
printf 'programVK=%s\n' "$(sed -n 's/^programVK=//p' "$F")" > "$WORK/recorded.txt"
out=$(check_smoke "$F" "$WORK/recorded.txt") || fail "the format 2 fixture is refused: $out"
must_refuse() {   # <what is wrong> <sed expression applied to the fixture>
  sed -e "$2" "$F" > "$WORK/bad.txt"
  ! check_smoke "$WORK/bad.txt" "$WORK/recorded.txt" >/dev/null || fail "the format 2 checks accept a result with $1"
}
must_refuse "no format line" '/^format=/d'
must_refuse "an unknown format" 's/^format=2$/format=3/'
must_refuse "no source_commit" '/^source_commit=/d'
must_refuse "a short source_commit" 's/^source_commit=.*/source_commit=0123abc/'
must_refuse "no dar_sha256" '/^dar_sha256=/d'
must_refuse "a dar_sha256 that is not 64 hex digits" 's/^dar_sha256=.*/dar_sha256=zz/'
must_refuse "no package_id" '/^package_id=/d'
must_refuse "a package_id that is not 64 hex digits" 's/^package_id=.*/package_id=abc/'
must_refuse "a programVK that is not the recorded one" 's/^programVK=0x4/programVK=0x5/'
must_refuse "a Canton head that is not the block" 's/^canton_head_hash=.*/canton_head_hash=0xbb/'
must_refuse "a Canton head that is not 1" 's/^canton_head_number=1$/canton_head_number=2/'
must_refuse "a block that reth did not finalize" 's/^reth_finalized=yes$/reth_finalized=no/'
must_refuse "an IPv4 address" 's/^gpu=fixture$/gpu=10.1.2.3/'

# up.sh stops on a program key that is not the recorded one, and records the DAR it loads; smoke.sh needs the commit it ran.
grep -q 'network/check-program-vk.sh' "$ROOT/network/up.sh" || fail "up.sh does not stop on a programVK that is not the recorded one"
grep -q 'network/canton/dar-id.sh' "$ROOT/network/up.sh" || fail "up.sh does not record the DAR's SHA-256 and package id"
grep -q 'network/canton/check-package.sh' "$ROOT/network/smoke.sh" || fail "smoke.sh does not check the package id against the participant's package list"
grep -q 'network/canton/check-package.sh' "$ROOT/tests/canton_network.sh" || fail "the canton job does not check the DAR's package id against the participant's package list"
grep -q 'CZE_SOURCE_COMMIT' "$ROOT/network/smoke.sh" || fail "smoke.sh does not take the source commit"
for k in format source_commit dar_sha256 package_id; do grep -q "echo \"$k=" "$ROOT/network/smoke.sh" || fail "smoke.sh does not write $k"; done
# The Daml-LF target is described as what it is: a snapshot line, not a release.
grep -q 'Daml 3.6 snapshot line' "$ROOT/daml/build.sh" || fail "daml/build.sh does not say LF 2.4 is from the Daml 3.6 snapshot line"

# The gateway party (the chain's custody holder): hosted on the operator's participant, the operator's user may act as it, the
# builder may read as it, and its id goes to the parties file. up.sh gives the chain the gateway contract's address from PINS and
# stops unless the genesis reth runs holds the gateway's code.
B=$ROOT/network/canton/bootstrap.canton
grep -q 'val gatewayParty = operator.parties.enable("gateway")' "$B" || fail "bootstrap.canton does not create the gateway party on the operator's participant"
grep -qE 'users.create\("operator", actAs = Set\(operatorParty, gatewayParty\)' "$B" || fail "the operator's user cannot act as the gateway party"
grep -qE 'users.create\("builder", .*readAs = Set\(operatorParty, gatewayParty\)' "$B" || fail "the builder cannot read as the gateway party"
grep -q 'GATEWAY_PARTY=' "$B" || fail "bootstrap.canton does not write GATEWAY_PARTY to parties.env"
[ "$(grep -cE 'actAs = Set\([^)]*gatewayParty' "$B")" = 1 ] || fail "a user other than the operator's can act as the gateway party"
# shellcheck disable=SC2016
grep -q -- '--gateway-address "${GATEWAY_ADDRESS#0x}"' "$ROOT/network/up.sh" || fail "up.sh does not give the chain the gateway address from PINS"
grep -q 'eth_getCode' "$ROOT/network/up.sh" || fail "up.sh does not read the gateway's code from reth's genesis"
grep -q 'gateway/Gateway.bin-runtime' "$ROOT/network/up.sh" || fail "up.sh does not compare it with gateway/Gateway.bin-runtime"
echo "network static checks passed"
