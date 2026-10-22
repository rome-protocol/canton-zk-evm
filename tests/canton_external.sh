#!/usr/bin/env bash
# Ostia on an existing participant, for real: the pinned Canton, network/canton/canton.conf's operator participant started WITHOUT Ostia's
# bootstrap (tests/external_bootstrap.canton makes only a synchronizer and the connection) and treated as the validator's participant. Then
#   - network/external/setup.py uploads the real DAR, allocates the parties, creates the users, proposes and accepts the chain; a second run changes nothing
#     at all (the ledger end, the parties, the users and the chain are the same);
#   - the users have exactly the rights of their roles;
#   - one Advance commits, against one stand-in sidecar: this participant is every party's host, so its sidecar is the only confirmer, and Canton asks it
#     both when the block is submitted and when the block is validated; a refused block changes nothing.
# The participant's Ledger API has a login here, as the DevNet's has: HS256 tokens (audience https://canton.network.global, sub = the user's id) from a
# secret made for this run, written to a file of this run and never to the repository. Every call without a token is refused.
# Needs Java 21 and network access to the registry in PINS. No GPU, no reth, no ZisK.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"
WORK=$(mktemp -d)
export CZE_STATE_DIR=$WORK/state FAKE_LOG=$WORK/calls FAKE_ANSWER=$WORK/answer
fail() { echo "FAIL: $*" >&2; exit 1; }
pids=()
cleanup() {
  local status=$?
  [ "$status" = 0 ] || {
    echo "--- Canton log (errors)"; grep -E 'ERROR|WARN|Exception|rror' "$WORK/canton.log" 2>/dev/null | head -n 25 | cut -c1-400 || true
    echo "--- Canton log (head)"; head -n 25 "$WORK/canton.log" 2>/dev/null | cut -c1-300 || true
  }
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT
umask 077

tools=$("$ROOT/network/canton/fetch.sh")
CANTON_JAR=$(sed -n 's/^CANTON_JAR=//p' <<<"$tools")
export CZE_TOOLS_DIR=${CZE_TOOLS_DIR:-$CZE_STATE_DIR/tools}
CZE_DAR=$("$ROOT/network/canton/build-dar.sh"); export CZE_DAR

# The login: a secret for this run, in a configuration file and nowhere else; one token file per role.
SECRET=$(openssl rand -hex 32)
cat > "$WORK/auth.conf" <<CONF
canton.participants.operator.ledger-api.auth-services = [{ type = unsafe-jwt-hmac-256, secret = "$SECRET", target-audience = "https://canton.network.global" }]
CONF
# The participant refuses a token with a long lifetime (as the DevNet's does), so a token lives two minutes and is written again, in place, before each phase.
mint() {
python3 - "$SECRET" "$WORK" <<'PY'
import base64, hashlib, hmac, json, os, sys, time
secret, work = sys.argv[1:]
enc = lambda raw: base64.urlsafe_b64encode(raw).rstrip(b"=")
for role, user in {"admin": "participant_admin", "operator": "ostia-operator", "confirmer": "ostia-confirmer", "builder": "ostia-builder", "reader": "ostia-reader"}.items():
    claims = {"sub": user, "aud": "https://canton.network.global", "exp": int(time.time()) + 120}
    signing = enc(b'{"alg":"HS256","typ":"JWT"}') + b"." + enc(json.dumps(claims).encode())
    token = signing + b"." + enc(hmac.new(secret.encode(), signing, hashlib.sha256).digest())
    fd = os.open(f"{work}/token-{role}", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(token + b"\n")
PY
}
mint
for role in admin operator confirmer builder reader; do
  export "CZE_TOKEN_FILE_${role^^}=$WORK/token-$role"
done
export CZE_LEDGER_URL=http://127.0.0.1:7575 CZE_READER_LEDGER_URL=http://127.0.0.1:7575 CZE_USER_PREFIX=ostia-

VERIFY_OK="ok $(printf 'cd%.0s' $(seq 32)) $(printf 'ef%.0s' $(seq 32)) $(printf 'bb%.0s' $(seq 32)) $(printf 'ab%.0s' $(seq 32)) 1 $(printf '55%.0s' $(seq 32)) 1700000000 30000000 0 0"
LEGS_OK="ok $(printf '55%.0s' $(seq 32)) 1 ${GATEWAY_ADDRESS#0x} 0"
answers() { echo "$VERIFY_OK" > "$FAKE_ANSWER.verify"; echo "$LEGS_OK" > "$FAKE_ANSWER.legs"; : > "$FAKE_LOG"; }
mkdir -p "$CZE_STATE_DIR"; answers
# One sidecar, on 8085: the only confirmer. Canton checks it at start-up (canton.conf), so it runs before Canton does. The idle participants of canton.conf
# check 8086 at start-up, so a stand-in answers there too; the test fails if it is ever called.
python3 "$ROOT/tests/fake_sidecar.py" 8085 & pids+=($!)
python3 "$ROOT/tests/fake_sidecar.py" 8086 & pids+=($!)
sleep 1

java -Xmx3g -jar "$CANTON_JAR" daemon -c "$ROOT/network/canton/canton.conf" -c "$WORK/auth.conf" --bootstrap "$ROOT/tests/external_bootstrap.canton" --no-tty > "$WORK/canton.log" 2>&1 &
pids+=($!)
for _ in $(seq 1 300); do grep -q "EXTERNAL PARTICIPANT READY" "$WORK/canton.log" && break; kill -0 "${pids[-1]}" 2>/dev/null || fail "Canton stopped"; sleep 1; done
grep -q "EXTERNAL PARTICIPANT READY" "$WORK/canton.log" || fail "the participant did not come up"

# The Ledger API has a login: no token, no answer.
[ "$(curl -s -o /dev/null -w '%{http_code}' "$CZE_LEDGER_URL/v2/packages")" = 401 ] || fail "the Ledger API answers without a token"

H0=$(printf 'ab%.0s' $(seq 32)); VK=$(printf 'cd%.0s' $(seq 32)); RC=$(printf 'ef%.0s' $(seq 32))
setup() { mint; python3 "$ROOT/network/external/setup.py" -- --genesis-hash "$H0" --genesis-state-root "$(printf '44%.0s' $(seq 32))" --program-vk "$VK" --root-c "$RC" \
  --rules-hash "$(printf '12%.0s' $(seq 32))" --gateway-address "${GATEWAY_ADDRESS#0x}"; }
snapshot() {
  mint
  local t; t=$(tr -d '[:space:]' < "$WORK/token-admin")
  for path in /v2/state/ledger-end /v2/parties /v2/users /v2/packages; do curl -sf -H "Authorization: Bearer $t" "$CZE_LEDGER_URL$path" | jq -S .; done
}
first=$(setup 2> "$WORK/setup1.log") || { cat "$WORK/setup1.log" >&2; fail "the first setup failed"; }
cat "$WORK/setup1.log"
jq -e '.created == true and .headNumber == "0" and .headHash == "'"$H0"'"' <<<"$first" >/dev/null || fail "the chain was not created at head 0: $first"
sleep 3   # late topology events of the first run settle before the snapshot
snapshot > "$WORK/after1.json"
# What the Ledger API answers for one party by id, which setup.py relies on: a party this participant hosts is listed with isLocal true; a party it has never heard of is
# 200 with an empty list (measured on 3.6.3; setup.py takes a 404 or isLocal false as "not ours" too).
mint
operator_party=$(sed -n 's/^OPERATOR_PARTY=//p' "$CZE_STATE_DIR/canton/parties.env"); [ -n "$operator_party" ] || fail "no operator party in parties.env"
lookup() { curl -s -w '\n%{http_code}' -H "Authorization: Bearer $(tr -d '[:space:]' < "$WORK/token-admin")" "$CZE_LEDGER_URL/v2/parties/$(jq -rn --arg p "$1" '$p|@uri')"; }
local_answer=$(lookup "$operator_party"); unknown_answer=$(lookup "nobody::${operator_party##*::}")
body_of() { head -n -1 <<<"$1"; }
[ "$(tail -n 1 <<<"$local_answer")" = 200 ] || fail "a party this participant hosts is not answered with 200 by its id: $local_answer"
body_of "$local_answer" | jq -e --arg p "$operator_party" '.partyDetails | length == 1 and .[0].party == $p and .[0].isLocal == true' >/dev/null \
  || fail "a party this participant hosts is not listed with isLocal true by its id: $local_answer"
[ "$(tail -n 1 <<<"$unknown_answer")" = 200 ] || fail "an unknown party id is not answered with 200: $unknown_answer"
body_of "$unknown_answer" | jq -e '.partyDetails == []' >/dev/null || fail "an unknown party id is not an empty list: $unknown_answer"
second=$(setup 2> "$WORK/setup2.log") || { cat "$WORK/setup2.log" >&2; fail "the second setup failed"; }
cat "$WORK/setup2.log"
jq -e '.created == false and .contractId == "'"$(jq -r .contractId <<<"$first")"'"' <<<"$second" >/dev/null || fail "the second setup did not find the same chain: $second"
snapshot > "$WORK/after2.json"
cmp -s "$WORK/after1.json" "$WORK/after2.json" || { diff "$WORK/after1.json" "$WORK/after2.json" | head -20; fail "the second setup changed the participant"; }
grep -q 'allocated\|created the user\|uploaded' "$WORK/setup2.log" && fail "the second setup made something"

# The package the DAR holds is the one the participant lists, and it is vetted on the synchronizer (setup.py checked the vetting).
package_id=$("$ROOT/network/canton/dar-id.sh" "$CZE_DAR" | sed -n 's/^package_id=//p')
"$ROOT/network/canton/check-package.sh" "$package_id" "$CZE_LEDGER_URL" || fail "the DAR's main package is not on the participant"
# A restart lists the package with the builder's token, not the admin's.
mint
CZE_PACKAGE_TOKEN_FILE=$CZE_TOKEN_FILE_BUILDER "$ROOT/network/canton/check-package.sh" "$package_id" "$CZE_LEDGER_URL" || fail "the builder's token cannot list the package"
grep -q 'the package is vetted' "$WORK/setup1.log" || echo "NOTE: the participant gave no vetting list (setup.py warned)"

# Users and rights: the builder reads as the gateway and cannot act as it, the operator acts as it, the chain names the gateway.
gw=${GATEWAY_ADDRESS#0x}
mint
[ "$(python3 "$ROOT/tests/canton_advance.py" "$CZE_STATE_DIR" gateway "$gw")" = ok ] || fail "the users' rights, or the chain's gateway, are wrong"

# One Advance. The stand-in refuses first: nothing moves. Then it agrees: the head is 1, and the same sidecar was asked in both modes.
echo "no the proof does not verify" > "$FAKE_ANSWER.verify"
mint
[ "$(python3 "$ROOT/tests/canton_advance.py" "$CZE_STATE_DIR" refused 2>/dev/null)" = 0 ] || fail "a refused block moved the head"
answers; mint
[ "$(python3 "$ROOT/tests/canton_advance.py" "$CZE_STATE_DIR" accepted)" = 1 ] || fail "a good block did not move the head to 1"
for function in verify legs; do
  for mode in submission validation; do
    grep -q "^8085 $function $mode\$" "$FAKE_LOG" || fail "no $mode-mode $function call on the sidecar"
  done
done
! grep -qvE '^8085 (verify|legs) ' "$FAKE_LOG" || fail "a call other than verify and legs, or a call on another port"
# A third run, with the chain at block 1: it finds the chain, and does not move it back.
third=$(setup 2>/dev/null) || fail "the third setup failed"
jq -e '.created == false and .headNumber == "1"' <<<"$third" >/dev/null || fail "the third setup did not find the chain at block 1: $third"
echo "canton external participant test passed"
