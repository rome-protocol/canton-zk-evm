#!/usr/bin/env bash
# demo/live.sh's argument handling, its settings checks and the guards that make `setup` safe to run again, against fake evm.py and canton.py
# commands (CZE_LIVE_EVM, CZE_LIVE_CANTON). No network, no chain, no Canton.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
LIVE=$ROOT/demo/live.sh
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
FAKE=$WORK/fake; mkdir -p "$FAKE"

cat > "$WORK/evm" <<'FAKE_EVM'
#!/usr/bin/env bash
echo "evm $*" >> "$FAKE_DIR/calls"
case $1 in
  keys) echo '{"v":"0x1111111111111111111111111111111111111111","u":"0x2222222222222222222222222222222222222222"}' ;;
  ether) echo '{"wei":1000,"ether":0}' ;;
  register) echo '{"tx":"0xaaaa","token":"0x3333333333333333333333333333333333333333"}' ;;
  wait) echo '{"block":5,"blockHash":"0xbbbb","gasUsed":1,"status":1,"contract":null,"finalized":true}' ;;
  *) echo "fake evm: unexpected $*" >&2; exit 1 ;;
esac
FAKE_EVM
cat > "$WORK/canton" <<'FAKE_CANTON'
#!/usr/bin/env bash
echo "canton $*" >> "$FAKE_DIR/calls"
case $1 in
  setup) echo '{}' ;;
  registered) [ -f "$FAKE_DIR/registered" ] && echo '{"registered":true}' || echo '{"registered":false}' ;;
  register-token) touch "$FAKE_DIR/registered"; echo "{\"evmToken\":\"${2#0x}\"}" ;;
  balances) [ -f "$FAKE_DIR/accepted" ] && echo '{"acceptances":1}' || echo '{"acceptances":0}' ;;
  accept) touch "$FAKE_DIR/accepted"; echo '{}' ;;
  *) echo "fake canton: unexpected $*" >&2; exit 1 ;;
esac
FAKE_CANTON
chmod +x "$WORK/evm" "$WORK/canton"

run() {   # <live.sh arguments>: live.sh with the fakes and the settings it needs; its output is in $WORK/out
  env -i PATH="$PATH" HOME="$WORK" FAKE_DIR="$FAKE" CZE_STATE_DIR="$WORK/state" CZE_LIVE_EVM="$WORK/evm" CZE_LIVE_CANTON="$WORK/canton" \
    CZE_LEDGER_URL=http://127.0.0.1:1 CZE_RPC_URL=http://127.0.0.1:2 "${EXTRA[@]}" "$LIVE" "$@" > "$WORK/out" 2>&1
}
EXTRA=()
calls() { { grep -c "^$1" "$FAKE/calls" 2>/dev/null || true; } | head -1; }
reset() { rm -rf "$FAKE" "$WORK/state"; mkdir -p "$FAKE"; : > "$FAKE/calls"; }

# ---- arguments
reset
run --help || fail "--help did not succeed"
grep -q '^Usage: demo/live.sh' "$WORK/out" || fail "--help does not print the usage"
run bogus && fail "an unknown argument was accepted"
grep -q 'unknown argument: bogus' "$WORK/out" || fail "an unknown argument is not named"
run setup legs && fail "two arguments were accepted"
[ ! -s "$FAKE/calls" ] || fail "something was called while the arguments were refused"

# ---- settings
EXTRA=(CZE_LEDGER_URL=); run setup && fail "no Ledger API URL was accepted"
grep -q CZE_LEDGER_URL "$WORK/out" || fail "a missing Ledger API URL is not named"
EXTRA=(CZE_RPC_URL=); run setup && fail "no RPC URL was accepted"
EXTRA=(CZE_CANTON=local); run setup && fail "the local network was accepted"
EXTRA=(CZE_WTKB=0x12); run setup && fail "a short wTKB address was accepted"
EXTRA=(CZE_LIVE_PAY=0); run setup && fail "a payment of 0 was accepted"
EXTRA=(CZE_WTROME=0x4444444444444444444444444444444444444444); run legs && fail "legs ran without CZE_SOURCE_COMMIT"
grep -q CZE_SOURCE_COMMIT "$WORK/out" || fail "a missing source commit is not named"
EXTRA=(CZE_SOURCE_COMMIT=0123456789abcdef0123456789abcdef01234567); run legs && fail "legs ran without CZE_WTROME"
grep -q CZE_WTROME "$WORK/out" || fail "a missing WtROME address is not named"
[ ! -s "$FAKE/calls" ] || fail "something was called while the settings were refused"
EXTRA=(CZE_SOURCE_COMMIT=0123456789abcdef0123456789abcdef01234567 CZE_WTROME=0x4444444444444444444444444444444444444444)
run legs && fail "legs ran before setup"
grep -q 'run demo/live.sh setup first' "$WORK/out" || fail "legs before setup does not say what to do: $(tail -3 "$WORK/out")"
[ "$(calls 'evm register')" = 0 ] || fail "legs made wTKB"

# ---- setup, and setup again
EXTRA=()
reset
run setup || fail "setup failed: $(tail -5 "$WORK/out")"
[ "$(calls 'evm register')" = 1 ] || fail "the first setup did not make wTKB once"
[ "$(calls 'canton register-token 0x3333333333333333333333333333333333333333')" = 1 ] || fail "the first setup did not register wTKB on Canton once"
[ "$(calls 'canton accept u')" = 1 ] || fail "the first setup did not make U's acceptance once"
[ "$(jq -r .token "$WORK/state/demo/wtkb.json")" = 0x3333333333333333333333333333333333333333 ] || fail "wtkb.json does not hold the token"
run setup || fail "the second setup failed: $(tail -5 "$WORK/out")"
[ "$(calls 'evm register')" = 1 ] || fail "the second setup made another wTKB"
[ "$(calls 'canton register-token')" = 1 ] || fail "the second setup registered wTKB again"
[ "$(calls 'canton accept')" = 1 ] || fail "the second setup made another acceptance"
[ "$(calls 'canton setup')" = 2 ] || fail "canton.py setup (which keeps itself idempotent) is not run each time"

# ---- a setup that stopped half way: wTKB made but not registered, no acceptance yet
rm "$FAKE/registered" "$FAKE/accepted"
run setup || fail "the resumed setup failed: $(tail -5 "$WORK/out")"
[ "$(calls 'evm register')" = 1 ] || fail "the resumed setup made another wTKB"
[ "$(calls 'canton register-token')" = 2 ] || fail "the resumed setup did not register wTKB"
[ "$(calls 'canton accept')" = 2 ] || fail "the resumed setup did not make the acceptance"

# ---- an existing wrapped token is used as it is
reset
EXTRA=(CZE_WTKB=0x5555555555555555555555555555555555555555)
run setup || fail "setup with CZE_WTKB failed: $(tail -5 "$WORK/out")"
[ "$(calls 'evm register')" = 0 ] || fail "setup made a wTKB although CZE_WTKB names one"
[ "$(calls 'canton register-token 0x5555555555555555555555555555555555555555')" = 1 ] || fail "setup did not register the token CZE_WTKB names"
[ ! -e "$WORK/state/demo/wtkb.json" ] || fail "setup kept a wtkb.json for a token it did not make"

# ---- legs, against a stand-in that keeps balances
reset
mkdir -p "$WORK/state/demo" "$WORK/state/canton" "$WORK/results"
echo '{"tx":"0x1","token":"0x3333333333333333333333333333333333333333"}' > "$WORK/state/demo/wtkb.json"
echo 'U_PARTY=u::abc' > "$WORK/state/canton/parties.env"
printf '#!/usr/bin/env bash\nFAKE_ROLE=evm exec python3 %s/fake_live.py "$@"\n' "$ROOT/demo/tests" > "$WORK/evm2"
printf '#!/usr/bin/env bash\nFAKE_ROLE=canton exec python3 %s/fake_live.py "$@"\n' "$ROOT/demo/tests" > "$WORK/canton2"
chmod +x "$WORK/evm2" "$WORK/canton2"
legs_run() {   # <the stand-in's balances file>
  env -i PATH="$PATH" HOME="$WORK" FAKE_STATE="$1" CZE_STATE_DIR="$WORK/state" CZE_LIVE_EVM="$WORK/evm2" CZE_LIVE_CANTON="$WORK/canton2" \
    CZE_LEDGER_URL=http://127.0.0.1:1 CZE_RPC_URL=http://127.0.0.1:2 CZE_WTROME=0x4444444444444444444444444444444444444444 \
    CZE_SOURCE_COMMIT=0123456789abcdef0123456789abcdef01234567 CZE_LIVE_RESULTS="$WORK/results" "$LIVE" legs > "$WORK/out" 2>&1
}
legs_run "$WORK/balances.json" || fail "legs failed against the stand-in: $(tail -5 "$WORK/out")"
results=$(ls "$WORK"/results/live-*.txt)
for line in format=2 deposit_block=11 payment_block=14 withdrawal_block=15 one_leg_per_block=yes custody_equals_supply=yes tkb_u_before=100 tkb_u_after=84 \
            custody_after=6 wtkb_supply_after=6.0 wtkb_u_after=6.0 payment_amount_wtrome=1; do
  grep -qx "$line" "$results" || fail "$results has no line $line"
done
! grep -q "$WORK" "$results" || fail "the results name a path of this machine"
# Canton's custody and wTKB's supply must be equal before the runs, or live.sh stops.
echo '{"u":100,"v":0,"cust":3,"wu":0,"sup":0,"rome_u":0,"rome_v":0,"block":10,"tx":{},"reg":true,"acc":1,"alloc":[],"n":0,"blocks":{}}' > "$WORK/odd.json"
legs_run "$WORK/odd.json" && fail "legs ran with a custody that differs from wTKB's supply"
grep -q "custody and wTKB's supply before the runs" "$WORK/out" || fail "the custody check is not named: $(tail -3 "$WORK/out")"

echo "ok: demo/live.sh arguments, settings, the setup guards and the legs"
