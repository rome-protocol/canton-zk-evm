#!/usr/bin/env bash
# Foundry's `cast` against a running explorer: what the Etherscan door's `proxy` module gives in hex is what cast reads from the same chain.
# cast has no call of the proxy (its Etherscan reads are the `contract` module's: cast source, interface and creation-code), so each proxy answer is
# set beside the same read through the explorer's /rpc, which has the same rules, and cast turns the hex into numbers and back to check it is a plain quantity.
# tests/demo_rehearsal.sh runs this after the faucet's coin is final; explorer/server/rest/etherscan-clients.test.ts runs it against a server of its own.
#
# Needs: EXPLORER (where it listens), ETHERSCAN_ADDRESS (an address without code), ETHERSCAN_BALANCE (its wei at the final block), ETHERSCAN_TX (a final transaction), and
# CAST (a cast to use). Without CAST the pinned release is downloaded (Linux x86-64), checked against its SHA-256 and used from a folder of this run's own.
# The release is pinned here and not in PINS, because the chain has no funded test accounts and PINS must not pin Foundry (tests/static.sh).
set -euo pipefail
FOUNDRY_VERSION=v1.8.6
FOUNDRY_SHA256=58850106984038f3a7200f38a4182c8cb423d3a4f4c7848eacbc2453e6bc35fc
fail() { echo "FAIL: $*" >&2; exit 1; }
: "${EXPLORER:?EXPLORER is not set}" "${ETHERSCAN_ADDRESS:?ETHERSCAN_ADDRESS is not set}" "${ETHERSCAN_BALANCE:?ETHERSCAN_BALANCE is not set}" "${ETHERSCAN_TX:?ETHERSCAN_TX is not set}"

# A folder of this run's own, removed on exit: the downloaded cast and the headers of the last answer.
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
if [ -z "${CAST:-}" ]; then
  [ "$(uname -s)-$(uname -m)" = Linux-x86_64 ] || fail "the pinned Foundry is the Linux x86-64 build; set CAST to use another"
  TMP=$WORK
  curl -sSfL -o "$TMP/foundry.tar.gz" "https://github.com/foundry-rs/foundry/releases/download/$FOUNDRY_VERSION/foundry_${FOUNDRY_VERSION}_linux_amd64.tar.gz"
  echo "$FOUNDRY_SHA256  $TMP/foundry.tar.gz" | sha256sum -c -
  tar -xzf "$TMP/foundry.tar.gz" -C "$TMP" cast
  CAST=$TMP/cast
fi
echo "using $("$CAST" --version | head -n 1)"

RPC=$EXPLORER/rpc
# The proxy's whole answer, and its result alone.
# A refusal for the door's rate is HTTP 200 with a Retry-After, as Etherscan's is: wait it out, as a client does.
proxy_raw() {
  local q=""; local a; local n=0; local out
  for a in "${@:2}"; do q="$q&$a"; done
  while :; do
    out=$(curl -sSf -D "$WORK/headers" "$EXPLORER/api?module=proxy&action=$1$q")
    grep -qi '^retry-after:' "$WORK/headers" || break
    n=$((n + 1)); [ "$n" -lt 20 ] || fail "the door kept asking to wait: $out"
    sleep "$(tr -d '\r' < "$WORK/headers" | awk 'tolower($1) == "retry-after:" { print $2 }')"
  done
  printf '%s\n' "$out"
}
proxy() { proxy_raw "$@" | jq -r 'if .jsonrpc == "2.0" and (has("error") | not) then .result else error("not a JSON-RPC result: \(tostring)") end'; }
# cast 1.8 wraps its --json output in {"schema_version", "success", "data"}; earlier releases print the object itself.
cast_json() { jq -r "(if (type == \"object\" and has(\"data\") and has(\"schema_version\")) then .data else . end) | $1"; }
eq() { [ "$2" = "$3" ] || fail "$1: the proxy gave '$2' and cast read '$3'"; }
dec() { "$CAST" to-dec "$1"; }

# A quantity is plain hex with no leading zero, as Etherscan gives it, and cast takes it to a number and back to the same text.
n_hex=$(proxy eth_blockNumber)
[[ $n_hex =~ ^0x(0|[1-9a-f][0-9a-f]*)$ ]] || fail "eth_blockNumber is not a plain hex quantity: $n_hex"
eq "a quantity written back" "$n_hex" "$("$CAST" to-hex "$(dec "$n_hex")")"
head_dec=$(dec "$n_hex")
cast_head=$("$CAST" block-number --rpc-url "$RPC")
[ "$cast_head" -ge "$head_dec" ] || fail "cast reads a final head ($cast_head) behind the proxy's ($head_dec)"
echo "the final head: $head_dec"

# The block at that height: the proxy's hash is cast's, with and without the transactions.
want=$(proxy eth_getBlockByNumber "tag=$n_hex" boolean=false)
cast_block=$("$CAST" block "$head_dec" --rpc-url "$RPC" --json)
eq "eth_getBlockByNumber" "$(jq -r .hash <<<"$want")" "$(cast_json .hash <<<"$cast_block")"
full=$(proxy eth_getBlockByNumber "tag=$n_hex" boolean=true)
[ "$(jq '.transactions | length' <<<"$full")" = "$(jq '.transactions | length' <<<"$want")" ] || fail "the block's transactions differ with boolean=true and false"

# A final transaction: the proxy's transaction and receipt are cast's.
eq "eth_getTransactionByHash" "$(proxy eth_getTransactionByHash "txhash=$ETHERSCAN_TX" | jq -r .hash)" "$("$CAST" tx "$ETHERSCAN_TX" --rpc-url "$RPC" --json | cast_json .hash)"
receipt=$(proxy eth_getTransactionReceipt "txhash=$ETHERSCAN_TX")
eq "eth_getTransactionReceipt status" "$(jq -r .status <<<"$receipt")" "$("$CAST" receipt "$ETHERSCAN_TX" --rpc-url "$RPC" --json | cast_json .status)"
tx_block=$(jq -r .blockNumber <<<"$receipt")
tx_index=$(jq -r .transactionIndex <<<"$receipt")
count=$(proxy eth_getBlockTransactionCountByNumber "tag=$tx_block")
[ "$(dec "$count")" -ge 1 ] || fail "the transaction's block has a count of $count"
eq "eth_getTransactionByBlockNumberAndIndex" "$(proxy eth_getTransactionByBlockNumberAndIndex "tag=$tx_block" "index=$tx_index" | jq -r .hash)" "$ETHERSCAN_TX"
echo "the transaction $ETHERSCAN_TX is in block $(dec "$tx_block")"

# The account: coins (the account module, which reth answers at the final block), count, code, storage, a call, an estimate and the price of gas.
eq "balance (account module)" "$(curl -sSf "$EXPLORER/api?module=account&action=balance&address=$ETHERSCAN_ADDRESS&tag=latest" | jq -r .result)" "$("$CAST" balance "$ETHERSCAN_ADDRESS" --rpc-url "$RPC")"
eq "balance held" "$ETHERSCAN_BALANCE" "$("$CAST" balance "$ETHERSCAN_ADDRESS" --rpc-url "$RPC")"
eq "eth_getTransactionCount" "$(dec "$(proxy eth_getTransactionCount "address=$ETHERSCAN_ADDRESS" tag=latest)")" "$("$CAST" nonce "$ETHERSCAN_ADDRESS" --rpc-url "$RPC")"
eq "eth_getCode" "$(proxy eth_getCode "address=$ETHERSCAN_ADDRESS" tag=latest)" "$("$CAST" code "$ETHERSCAN_ADDRESS" --rpc-url "$RPC")"
eq "eth_getStorageAt" "$(proxy eth_getStorageAt "address=$ETHERSCAN_ADDRESS" position=0x0 tag=latest)" "$("$CAST" storage "$ETHERSCAN_ADDRESS" 0 --rpc-url "$RPC")"
eq "eth_call" "$(proxy eth_call "to=$ETHERSCAN_ADDRESS" data=0x tag=latest)" "$("$CAST" rpc eth_call "{\"to\":\"$ETHERSCAN_ADDRESS\",\"data\":\"0x\"}" latest --rpc-url "$RPC" | jq -r .)"
eq "eth_estimateGas" "$(proxy eth_estimateGas "to=$ETHERSCAN_ADDRESS")" "$("$CAST" rpc eth_estimateGas "{\"to\":\"$ETHERSCAN_ADDRESS\"}" --rpc-url "$RPC" | jq -r .)"
eq "eth_gasPrice" "$(dec "$(proxy eth_gasPrice)")" "$("$CAST" gas-price --rpc-url "$RPC")"
eq "eth_getUncleByBlockNumberAndIndex" "$(proxy_raw eth_getUncleByBlockNumberAndIndex "tag=$n_hex" index=0x0 | jq -c .result)" null

# A block above the final head is not there, as it is not on /rpc.
eq "a block above final" "$(proxy_raw eth_getBlockByNumber "tag=$("$CAST" to-hex $((head_dec + 1000000)))" boolean=false | jq -c .result)" null
echo "cast and the proxy agree"
