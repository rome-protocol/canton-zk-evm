# shellcheck shell=bash
# shellcheck disable=SC2154  # the rehearsal's own variables, which this file is sourced into: WORK, flood_tx, FLOOD, EXPLORER and the rest
# The part of the nightly load test (.github/workflows/explorer-nightly.yml) that runs on the rehearsal's chain. tests/demo_rehearsal.sh sources this file, with
# REHEARSAL_NIGHTLY=tests/demo_nightly_chain.sh, after its own checks and W1, and before it takes the chain down: so it runs with the rehearsal's variables and
# functions (cut_block, w1py, receipt_of, rpc, fail, $FLOOD, $EXPLORER, $WORK ...). W1 (the worst-case block, indexed into a database of its own) has run already; its
# log, $WORK/w1.log, is copied here with the results of
#   L3  a flood of blocks of plain transfers, cut one after another through the real builder: index lag, live-stream delay and database growth (tests/demo_nightly_l3.py)
#   L4  the pages in a cold browser on a slow link (explorer/test/l4)
#   L5  the contract tools against the explorer's Etherscan-compatible API (explorer/test/l5); SKIPPED, never passed, while that API is not there
# into $NIGHTLY_OUT. Every part runs even when an earlier one broke a budget; the rehearsal then fails if any did.
#
# Reads: NIGHTLY_OUT (the folder for the results), L3_SECONDS (how long L3 floods; 1800 by default), L3_TXS_PER_BLOCK (1428, what fits under the 30 Mgas cap),
# L4_REPEAT (5).
: "${NIGHTLY_OUT:?NIGHTLY_OUT is not set}"
mkdir -p "$NIGHTLY_OUT"
nightly_failed=()

# What cut_block (run by `bash -c cut_block` from L3) needs: itself, `fail`, and the variables it reads. The Canton and reth variables are exported already.
export -f cut_block fail
export PY ROOT BUILDER_PARTY OPERATOR_PARTY GATEWAY_PARTY EXPLORER RETH_HTTP_PORT="${RETH_HTTP_PORT:-8545}"
export L3_PY=$PY L3_DB=cze-rehearsal-explorer-db

cp "$WORK/w1.log" "$NIGHTLY_OUT/w1.log"

echo "== L3: ${L3_SECONDS:-1800} s of blocks of ${L3_TXS_PER_BLOCK:-1428} plain transfers"
l3_rc=0
python3 "$ROOT/tests/demo_nightly_l3.py" run "${L3_SECONDS:-1800}" "${L3_TXS_PER_BLOCK:-1428}" "$NIGHTLY_OUT/l3.json" || l3_rc=$?
[ -s "$NIGHTLY_OUT/l3.json" ] || echo '{"failures":["L3 wrote no results"]}' > "$NIGHTLY_OUT/l3.json"
[ "$l3_rc" = 0 ] || nightly_failed+=("L3 (exit $l3_rc)")

echo "== L4: the pages in a cold browser, ${L4_REPEAT:-5} runs each, 10 Mbit/s and 100 ms"
l4_name=cze-nightly-l4-$$
l4_rc=0
docker run --rm --name "$l4_name" --network host --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -e EXPLORER="$EXPLORER" -e L4_TX="$flood_tx" -e L4_CONTRACT="$FLOOD" -e L4_REPEAT="${L4_REPEAT:-5}" -e L4_OUT=/out/l4.json \
  -v "$ROOT/explorer/test/l4:/l4:ro" -v "$NIGHTLY_OUT:/out" -w /tmp "$EXPLORER_BROWSER_IMAGE" \
  sh -c "mkdir /tmp/l4 && cp /l4/package.json /l4/package-lock.json /l4/driver.mjs /l4/judge.ts /tmp/l4/ && cd /tmp/l4 && npm ci --ignore-scripts --no-audit --no-fund && node driver.mjs" || l4_rc=$?
docker rm -f -v "$l4_name" >/dev/null 2>&1 || true
[ -s "$NIGHTLY_OUT/l4.json" ] || echo '{"failures":["L4 wrote no results"],"pages":[]}' > "$NIGHTLY_OUT/l4.json"
[ "$l4_rc" = 0 ] || nightly_failed+=("L4 (exit $l4_rc)")

echo "== L5: the contract tools against the Etherscan-compatible API"
L5=$ROOT/explorer/test/l5
l5_rc=0
if ! EXPLORER=$EXPLORER "$L5/l5.sh" probe; then
  # A skip is not a pass. The API's modules (E8a, E9b) are what L5 tests; without them every check would fail for a reason that is not a defect.
  jq -n '{status: "skipped", reason: "SKIPPED: E8a/E9b not landed", checks: [], failures: []}' > "$NIGHTLY_OUT/l5.json"
  echo "L5 SKIPPED: E8a/E9b not landed (the explorer does not answer /api?module=proxy&action=eth_blockNumber)"
else
  chain_id=$(($(rpc eth_chainId | jq -r .result)))
  l5_work=$WORK/l5
  L5_EXPLORER=$EXPLORER L5_CHAIN_ID=$chain_id "$L5/l5.sh" prepare "$l5_work"
  "$L5/l5.sh" tools "$WORK/l5-foundry"
  l5_docker() { # <name> <command...>: one step of L5 in the browser image, as this user, with Foundry mounted
    local name=$1; shift
    docker run --rm --name "$name" --network host --user "$(id -u):$(id -g)" -e HOME=/l5/home -e PATH=/foundry:/usr/local/bin:/usr/bin:/bin \
      -e L5_EXPLORER="$EXPLORER" -e L5_RPC="http://127.0.0.1:${RETH_HTTP_PORT:-8545}" -e L5_CHAIN_ID="$chain_id" -e L5_ADDRS="${l5_addrs:-}" -e L5_ARGS=1,2,3 -e L5_TX="${l5_tx:-}" -e L5_OUT=/l5/l5.json \
      -v "$l5_work:/l5" -v "$WORK/l5-foundry:/foundry:ro" -v "$L5:/src:ro" -w /l5/project "$EXPLORER_BROWSER_IMAGE" "$@"
  }
  l5_docker "cze-nightly-l5-build-$$" bash /src/l5.sh build || fail "L5's contract did not build"
  docker rm -f -v "cze-nightly-l5-build-$$" >/dev/null 2>&1 || true
  # three Counters, one for each way of verifying, with the constructor arguments 1, 2 and 3
  l5_txs=()
  for n in 1 2 3; do
    printf '%s%064x\n' "$(cat "$l5_work/creation.hex")" "$n" > "$l5_work/deploy-$n.hex"
    l5_txs+=("$(w1py deploy "$l5_work/deploy-$n.hex")")
  done
  cut_block
  l5_addrs=""
  for tx in "${l5_txs[@]}"; do
    addr=$(receipt_of "$tx" | jq -r '.contract // empty')
    [ -n "$addr" ] || fail "L5's contract was not created by $tx"
    l5_addrs=${l5_addrs:+$l5_addrs,}$addr
  done
  l5_tx=${l5_txs[0]}
  # the explorer has to have indexed the block before a tool can ask it about the contracts
  for _ in $(seq 1 120); do
    curl -sf -A 'Rome Protocol rome@romeprotocol.com' "$EXPLORER/api/tx/$l5_tx" | jq -e '.block != null' >/dev/null 2>&1 && break
    sleep 1
  done
  l5_docker "cze-nightly-l5-verify-$$" bash /src/l5.sh verify || l5_rc=$?
  docker rm -f -v "cze-nightly-l5-verify-$$" >/dev/null 2>&1 || true
  if [ -s "$l5_work/l5.json" ]; then cp "$l5_work/l5.json" "$NIGHTLY_OUT/l5.json"; else echo '{"status":"failed","checks":[],"failures":["L5 wrote no results"]}' > "$NIGHTLY_OUT/l5.json"; fi
  [ "$l5_rc" = 0 ] || nightly_failed+=("L5 (exit $l5_rc)")
fi

# What a person reads first: a few lines for the job's summary.
{
  echo "### The nightly load test on the rehearsal chain"
  echo
  echo "| | result |"
  echo "|---|---|"
  jq -r '"| L3 flood | \(.blocks // 0) blocks, \(.transactions // 0) transactions; index lag p95 \(.served_p95_s // "n/a") s (budget 1.0), stream p95 \(.sse_p95_s // "n/a") s (budget 0.5), time to final p95 \(.final_p95_s // "n/a") s (reported), database \(if .growth_bytes_per_million then ((.growth_bytes_per_million / 1e7 | round) / 100) else "n/a" end) GB per million transactions (budget 2.5)\(if (.failures | length) > 0 then " **FAILED: \(.failures | join("; "))**" else "" end) |"' "$NIGHTLY_OUT/l3.json"
  jq -r '"| L4 pages | " + ([.pages[] | "\(.name) LCP \(if .median.lcpMs then (.median.lcpMs | round) else "n/a" end) ms\(if .held then "" else " (not held)" end)"] | join(", ")) + (if (.failures | length) > 0 then " **FAILED: \(.failures | join("; "))**" else "" end) + " |"' "$NIGHTLY_OUT/l4.json"
  jq -r '"| L5 contract tools | \(if .reason then .reason else (.status | ascii_upcase) end)\(if (.failures | length) > 0 then " **\(.failures | join("; ") | gsub("\n"; " "))**" else "" end) |"' "$NIGHTLY_OUT/l5.json"
  echo
  echo "L4's Address and Contract pages are measured and not held: there is no Contract page yet (E11a) and the Address page is a stub. L5 is skipped, not passed, until the Etherscan-compatible API (E8a, E9b) is in the explorer."
} > "$NIGHTLY_OUT/summary.md"
cat "$NIGHTLY_OUT/summary.md"

if [ "${#nightly_failed[@]}" -gt 0 ]; then
  fail "the nightly load test broke: ${nightly_failed[*]}"
fi
echo "the nightly load test passed (L5: $(jq -r .status "$NIGHTLY_OUT/l5.json"))"
