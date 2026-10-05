#!/bin/sh
# Makes the faucet's key for this run, and a copy of the run's genesis that also funds it. Run it once, before the network starts:
#
#   explorer/faucet-setup.sh
#   CZE_GENESIS_FILE=<state>/faucet/genesis.json network/up.sh
#   READER_PARTY=<reader party id, from <state>/canton/parties.env> FAUCET_KEY_FILE=<state>/faucet/key npm start
#       (in explorer/, after npm run build; the key path is absolute, or relative to explorer/; see explorer/README.md)
#
# The genesis it copies is the one CZE_GENESIS_FILE names when that is set (as the demo sets it), and network/genesis.json otherwise.
# The key is made fresh each run in <state>/faucet/key, readable by its owner only, and is never printed and never committed. Nothing
# mints coins and nothing tops the faucet up. FAUCET_FUND (whole coins, default 1000000) sets what the faucet starts with.
# It needs Node 22.18 or newer, and `npm ci` done in explorer/.
set -eu
umask 077
exec node "$(dirname "$0")/server/faucet-setup.ts"
