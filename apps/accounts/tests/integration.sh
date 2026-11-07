#!/usr/bin/env bash
# The accounts service on a real Canton, on the protocol version PINS names (CANTON_PROTOCOL_VERSION; CZE_PROTOCOL_VERSION=36 runs the other one Canton 3.7.1 supports): the pinned Canton, started as tests/canton_external.sh
# starts it (an existing participant with a login on its Ledger API), Ostia's chain set up on it, and a Ledger API user that holds NO right. The service
# runs with that user's token alone (the participant lets a user with no right allocate up to 100 parties for itself); integration.py then makes an external party from an Ed25519 key, creates a WithdrawalAcceptance for it, and lists its holdings.
# The tokens live two minutes (as on the DevNet) and are written again every twenty seconds, each by a replace of the file, so a reader never sees half of one.
# Needs Java 21, openssl 3 and network access to the registry in PINS. No GPU, no reth, no ZisK.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
# shellcheck disable=SC1091
. "$ROOT/PINS"
WORK=$(mktemp -d)
export CZE_STATE_DIR=$WORK/state FAKE_LOG=$WORK/calls FAKE_ANSWER=$WORK/answer
fail() { echo "FAIL: $*" >&2; exit 1; }
CANTON_PROTOCOL_VERSION=${CZE_PROTOCOL_VERSION:-$CANTON_PROTOCOL_VERSION}
[[ $CANTON_PROTOCOL_VERSION =~ ^3[67]$ ]] || fail "CZE_PROTOCOL_VERSION is 36 or 37 (the versions Canton $CANTON_VERSION supports)"
export CANTON_PROTOCOL_VERSION
pids=()
cleanup() {
  local status=$?
  [ "$status" = 0 ] || {
    echo "--- Canton log (errors)"; grep -E 'ERROR|WARN|Exception|rror' "$WORK/canton.log" 2>/dev/null | head -n 25 | cut -c1-400 || true
    echo "--- service log"; head -n 40 "$WORK/service.log" 2>/dev/null | cut -c1-400 || true
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

SECRET=$(openssl rand -hex 32)
cat > "$WORK/auth.conf" <<CONF
canton.participants.operator.ledger-api.auth-services = [{ type = unsafe-jwt-hmac-256, secret = "$SECRET", target-audience = "https://canton.network.global" }]
canton.participants.operator.ledger-api.party-management-service.max-self-allocated-parties = 100
CONF
ACCOUNTS_USER=accounts-service; export ACCOUNTS_USER
mint() {
python3 - "$SECRET" "$WORK" "$ACCOUNTS_USER" <<'PY'
import base64, hashlib, hmac, json, os, sys, time
secret, work, accounts = sys.argv[1:]
enc = lambda raw: base64.urlsafe_b64encode(raw).rstrip(b"=")
users = {"admin": "participant_admin", "operator": "ostia-operator", "confirmer": "ostia-confirmer", "builder": "ostia-builder", "reader": "ostia-reader", "demo": "ostia-demo", "accounts": accounts}
for role, user in users.items():
    claims = {"sub": user, "aud": "https://canton.network.global", "exp": int(time.time()) + 120}
    signing = enc(b'{"alg":"HS256","typ":"JWT"}') + b"." + enc(json.dumps(claims).encode())
    token = signing + b"." + enc(hmac.new(secret.encode(), signing, hashlib.sha256).digest())
    fd = os.open(f"{work}/token-{role}.tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(token + b"\n")
    os.replace(f"{work}/token-{role}.tmp", f"{work}/token-{role}")
PY
}
mint
for role in admin operator confirmer builder reader demo; do
  export "CZE_TOKEN_FILE_${role^^}=$WORK/token-$role"
done
export CZE_LEDGER_URL=http://127.0.0.1:7575 CZE_READER_LEDGER_URL=http://127.0.0.1:7575 CZE_USER_PREFIX=ostia-
( while sleep 20; do mint; done ) & pids+=($!)

VERIFY_OK="ok $(printf 'cd%.0s' $(seq 32)) $(printf 'ef%.0s' $(seq 32)) $(printf 'bb%.0s' $(seq 32)) $(printf 'ab%.0s' $(seq 32)) 1 $(printf '55%.0s' $(seq 32)) 1700000000 30000000 0 0"
LEGS_OK="ok $(printf '55%.0s' $(seq 32)) 1 ${GATEWAY_ADDRESS#0x} 0"
mkdir -p "$CZE_STATE_DIR"
echo "$VERIFY_OK" > "$FAKE_ANSWER.verify"; echo "$VERIFY_OK" > "$FAKE_ANSWER.verify2"; echo "$LEGS_OK" > "$FAKE_ANSWER.legs"; : > "$FAKE_LOG"
# The stand-ins for the sidecars: Canton checks them at start-up (canton.conf); nothing here asks them for a block.
python3 "$ROOT/tests/fake_sidecar.py" 8085 & pids+=($!)
python3 "$ROOT/tests/fake_sidecar.py" 8086 & pids+=($!)
sleep 1

java -Xmx3g -jar "$CANTON_JAR" daemon -c "$ROOT/network/canton/canton.conf" -c "$WORK/auth.conf" --bootstrap "$ROOT/tests/external_bootstrap.canton" --no-tty > "$WORK/canton.log" 2>&1 &
pids+=($!)
for _ in $(seq 1 300); do grep -q "EXTERNAL PARTICIPANT READY" "$WORK/canton.log" && break; kill -0 "${pids[-1]}" 2>/dev/null || fail "Canton stopped"; sleep 1; done
grep -q "EXTERNAL PARTICIPANT READY" "$WORK/canton.log" || fail "the participant did not come up"
echo "the synchronizer runs protocol version $CANTON_PROTOCOL_VERSION"

# Ostia's chain: the package, the parties, the users and the chain record, as an existing participant gets them.
H0=$(printf 'ab%.0s' $(seq 32)); VK=$(printf 'cd%.0s' $(seq 32)); RC=$(printf 'ef%.0s' $(seq 32))
python3 "$ROOT/network/external/setup.py" --demo -- --genesis-hash "$H0" --genesis-state-root "$(printf '44%.0s' $(seq 32))" --program-vk "$VK" --root-c "$RC" \
  --rules-hash "$(printf '12%.0s' $(seq 32))" --gateway-address "${GATEWAY_ADDRESS#0x}" > "$WORK/setup.json" || fail "the setup failed"

# The test token (its DAR, its rules and 100 of it for U, a party on this participant: demo/canton.py) for an allocation, and the twin app's package for a TwinAcceptance.
(export DPM_HOME=$CZE_TOOLS_DIR/dpm DPM_REGISTRY PATH="$CZE_TOOLS_DIR/bin:$PATH" SDK_VERSION=$DAML_SDK_VERSION TARGET=$DAML_TARGET; "$ROOT/apps/twin/build.sh" >&2)
curl -sf -X POST -H "Authorization: Bearer $(tr -d '[:space:]' < "$WORK/token-admin")" -H 'content-type: application/octet-stream' --data-binary @"$ROOT/apps/twin/dist/ostia-twin.dar" \
  "$CZE_LEDGER_URL/v2/packages?vetAllPackages=true&synchronizeVetting=true" > /dev/null || fail "the twin app's package was not uploaded"
CZE_CANTON=external python3 "$ROOT/demo/canton.py" upload-dars > /dev/null || fail "the test token's package was not uploaded"
CZE_CANTON=external python3 "$ROOT/demo/canton.py" setup > /dev/null || fail "the test token's rules and U's holding were not made"

# The service's user: no right at all. The participant gives it the right to act as each account when the account is allocated.
curl -sf -H "Authorization: Bearer $(tr -d '[:space:]' < "$WORK/token-admin")" -H 'content-type: application/json' "$CZE_LEDGER_URL/v2/users" \
  -d "{\"user\":{\"id\":\"$ACCOUNTS_USER\",\"primaryParty\":\"\",\"isDeactivated\":false,\"identityProviderId\":\"\"},\"rights\":[]}" > /dev/null || fail "the service's user was not made"

# The chain's parties: the only observers the service lets an account's create name.
python3 - "$CZE_STATE_DIR/canton/parties.env" "$WORK/chain-parties.json" <<'PY'
import json, sys
env = dict(line.strip().split("=", 1) for line in open(sys.argv[1]) if "=" in line)
json.dump({f: env[f.upper() + "_PARTY"] for f in ("operator", "confirmer", "gateway", "builder")}, open(sys.argv[2], "w"))
PY

# The built-in list, and the Archive of the acceptance besides: the test prepares one exercise on a contract of the account's own, for a fixture.
ALLOW=(--allow '#canton-zk-evm:Zk.Chain:WithdrawalAcceptance' --allow '#canton-zk-evm:Zk.Chain:WithdrawalAcceptance#Archive' --allow '#canton-zk-evm:Zk.Chain:DepositRequest'
  --allow '#splice-api-token-allocation-instruction-v1:Splice.Api.Token.AllocationInstructionV1:AllocationFactory#AllocationFactory_Allocate'
  --allow '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory#TransferFactory_Transfer'
  --allow '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction#TransferInstruction_Accept'
  --allow '#canton-zk-evm:Zk.Chain:RedeemRequest' --open-limit '#canton-zk-evm:Zk.Chain:RedeemRequest=3'
  --allow '#ostia-twin:Twin.Twin:TwinAcceptance' --open-limit '#ostia-twin:Twin.Twin:TwinAcceptance=1'
  --requests-per-minute 600 --requests-per-account-minute 600 --requests-per-network-minute 600)
python3 "$ROOT/apps/accounts/accounts.py" "${ALLOW[@]}" --chain-parties "$WORK/chain-parties.json" --ledger-url "$CZE_LEDGER_URL" --user-id "$ACCOUNTS_USER" --token-file "$WORK/token-accounts" \
  --state-file "$WORK/accounts.jsonl" --listen 127.0.0.1:18081 > "$WORK/service.log" 2>&1 & pids+=($!)
for _ in $(seq 1 30); do curl -sf http://127.0.0.1:18081/healthz > /dev/null && break; sleep 1; done
curl -sf http://127.0.0.1:18081/healthz > /dev/null || fail "the service did not come up"

CZE_CANTON=external ACCOUNTS_URL=http://127.0.0.1:18081 python3 "$ROOT/apps/accounts/tests/integration.py" -v
echo "accounts service test on Canton passed"
