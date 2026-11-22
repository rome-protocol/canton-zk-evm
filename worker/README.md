# Worker for the Canton router

Small services for the [Canton router](../router/README.md). Flow A: a Canton deposit that names the router as recipient arrives on another AggLayer chain (the out-relayer and the Sepolia claimer). Flow C: a coin sent to an inbox on Ostia goes on to Canton, or back (the in-relayer). Each is off unless its switch is `1`; with it off it reads and sends nothing.

| File | What it is |
|---|---|
| `relay_out.py` | The out-relayer (`OSTIA_RELAY_OUT=1`). It reads the router's open `DepositRequest`s from the ledger as the operator, and for each one checks the chain, the label, the allocation, the book and the fee, then sends `claimAndBridge` on Ostia. One transaction at a time. |
| `claim_sepolia.py` | The Sepolia claimer (`OSTIA_CLAIM_SEPOLIA=1`). It reads the router's `RoutedOut` events (its sends) and `Refunded` events (its refunds to a Sepolia address, flow C) in Ostia's finalized blocks, takes each leaf and proof from AggKit's bridge service, and sends `claimAsset` on Ethereum Sepolia. The user's own claim stays the fallback. |
| `relay_in.py` | The in-relayer (`OSTIA_RELAY_IN=1`), flow C. See below. |
| `chain.py`, `records.py` | JSON-RPC, the hot key, sending and replacing a transaction; the records and the caps. |
| `main.py` | `main.py out [--once]`, `main.py claim [--once]` and `main.py in [--once]`. |

## What the out-relayer checks

A request that fails a check is left alone: it lapses on Canton at its `settleBefore` and the depositor keeps the coin.

- At start, the endpoint's chain id must equal the ledger chain record's (and the Sepolia endpoint's must be 11155111), or the worker exits.
- The request names this chain (operator, confirmer, gateway, builder, chain id).
- The label matches `r1:<network>:0x<40 lowercase hex>:<max fee>:<nonce>` as a whole string, each part fits its type, and the destination is not zero. Then the router rebuilds the label (`routeLabel`) and the deposit id (`depositId`) by `eth_call`, and both must equal the ledger's byte for byte. The relayer keeps no copy of the format of its own.
- The allocation is active, from the depositor to the gateway with the operator as executor, and outlives the relay by the settle margin.
- The instrument has a wrapped token, the book opens the route and the destination now (`checkOut`), the gateway has not used the id, and the lock cap leaves room.
- The fee that is finally charged is at most the label's most fee: `amount - send <= maxFee`, with `send` cut down to a multiple of the destination's unit, so the cut is part of the fee.
- The caps and the balance allow it, and the gas and gas price stay under their limits.

A request that fails in an unexpected way is skipped and tried again on the next pass; it never stops the requests after it. A request that waits on something that can change (the route is closed, the fee is above the most fee, the cap is reached) is tried again on every pass; one that can never pass (a bad label, another chain) is recorded and not looked at again. Only one transaction is out at a time, because a transaction that the builder leaves out stays in the pool and holds the later ones. It counts as done only in a block at or under Ostia's finalized block. When it has no receipt after `OSTIA_RELAY_WAIT_SECONDS`, its nonce goes to a transfer of nothing to the key itself at twice the fees (never over the gas price limit, and at least a tenth over the stuck transaction's; if that cannot be met the worker logs that it waits, and when the pool has dropped the transaction it lets the request go at once), and the request is let go. A transaction is recorded before it is sent, so one whose answer was lost (a timeout) or whose sender died is still found again and replaced.

## What the claimer checks

The leaf that the bridge service gives must be the one the router's event describes: origin network and token, destination network and address, and the amount. Anything else is never claimed. The bridge service must be on this machine, every answer is checked field by field, and a claim goes out only when the leaf is ready on Ethereum and `isClaimed` says nobody has claimed it. A refund is read from its `Refunded` event (the deposit count) when something went back; the refund address comes from the inbox's `InboxOpened` event and only when the router works out the same inbox for it, and the leaf must be the router's token from Ostia to that address for that amount. Transfers that the router did not send are not read at all. A claim that sticks is replaced as above, and tried again up to three times.

## What the in-relayer does

One transaction at a time, in this order each pass (it finishes the one that is out first; a stuck one is replaced as above).

1. **Opens an inbox** that the page asked for. A small intake (`POST /open` on `127.0.0.1`, port `OSTIA_RELAY_IN_INTAKE_PORT`, behind the explorer's same-origin route; body at most 2 KiB) takes `{party, refundNetwork, refundAddress}`, checks the form, that the refund network is known to the book and is not Ostia, that flow C is open, and, read only on Canton, that the party has a standing acceptance of withdrawals. It only queues the request (at most `OSTIA_RELAY_IN_OPEN_PER_HOUR` an hour) and the pass sends `openInbox`. The page works the address out itself and trusts only the final `InboxOpened` event.
2. **Sweeps each inbox that holds a listed token**, oldest refund clock first: `forward` when Canton can pay or the balance is only the fee (the dust sweep), `mark` when no clock runs, `refund` when the clock has ended. It reads no switch for `mark` and `refund`, so a held coin always goes home. A `forward` that is left out of a block is not tried again for `OSTIA_RELAY_IN_COOLDOWN_SECONDS` (300), and the coin is marked meanwhile.
3. **Claims a send** into an open inbox (after the held coins of step 2 in each pass, so an older inbox that waits for Canton has the quota first; while another inbox holds the same coin, a new send is claimed into its inbox only). Open inboxes come from the router's `InboxOpened` events (the address must be the one the router works out for the event's party); sends come from the source bridge's `BridgeEvent` logs, final blocks only, for asset leaves to Ostia whose destination is an open inbox. The bridge service must give the same leaf (origin, token, destination, amount) and the proof, with the root already taken on Ostia. It sends `claimAndWithdraw` when the router takes it now and Canton can pay it now (acceptance, no pause, quota room, as the builder checks them), and `claimToInbox` otherwise. A pay-claim that does not land is claimed into the inbox only next time. A send made before its inbox was open is left to the user's own claim.

Everything it signs can be signed by anyone, and the fee taken from the amount is the same whoever signs. It never submits a command on Canton: the operator's token needs read-as rights only. A send to an inbox that was never opened or whose token the book does not list is never claimed by it.

## Settings

Names only; values come from the environment. A key file holds one hex key and must be mode 0600. Nothing here prints a URL, a key or a token, and an error says what failed and the kind of error.

| Variable | Meaning |
|---|---|
| `OSTIA_RELAY_OUT`, `OSTIA_CLAIM_SEPOLIA`, `OSTIA_RELAY_IN` | The switches. Off unless `1` |
| `OSTIA_RPC_URL` | Ostia's JSON-RPC (https, or http on this machine) |
| `OSTIA_ROUTER` | The router's proxy address |
| `OSTIA_WORKER_STATE_DIR` | Where the records are kept (`relay-out.json`, `claim-sepolia.json`, `relay-in.json`) |
| `OSTIA_WORKER_INTERVAL_SECONDS` | Seconds between passes (15) |
| `OSTIA_RELAY_KEY_FILE` | The relayer's key: tROME only |
| `CZE_CANTON`, `CZE_LEDGER_URL`, `CZE_TOKEN_FILE_OPERATOR`, `CZE_STATE_DIR` | The ledger, as `demo/canton.py` reads them. The operator's token needs read-as rights for the operator only: the relayer never submits a command on Canton |
| `OSTIA_CLAIM_KEY_FILE` | The claimer's key: Sepolia ETH only |
| `OSTIA_CLAIM_SEPOLIA_RPC_URL` | The claimer's own Sepolia endpoint (a secret) |
| `OSTIA_CLAIM_SEPOLIA_CHAIN_ID` | The chain id the Sepolia endpoint must answer (11155111) |
| `OSTIA_CLAIM_SEPOLIA_BRIDGE` | The bridge's address on Sepolia |
| `OSTIA_RELAY_IN_KEY_FILE` | The in-relayer's key: tROME only |
| `OSTIA_RELAY_IN_TOKENS` | The listed Canton tokens it sweeps, comma-separated addresses |
| `OSTIA_RELAY_IN_SOURCE_RPC_URL`, `OSTIA_RELAY_IN_SOURCE_BRIDGE`, `OSTIA_RELAY_IN_SOURCE_CHAIN_ID` | The source chain's own endpoint (a secret), its bridge, and the chain id the endpoint must answer (11155111) |
| `OSTIA_RELAY_IN_SOURCE_NETWORK` | The source chain's network id in the bridge (0) |
| `AGGKIT_BRIDGE_URL` | The bridge service, http on this machine only (`http://127.0.0.1:5578`) |

Guards, each with the prefix `OSTIA_RELAY_` or `OSTIA_CLAIM_`: `MAX_GAS` (3,000,000), `MAX_GAS_PRICE` (wei, 100 gwei), `PER_HOUR` (20), `PER_DAY` (100), `PER_RECIPIENT` (10 a day), `MIN_BALANCE` (wei, 0.01), `WAIT_SECONDS` (900). Relayer only: `OSTIA_RELAY_SETTLE_MARGIN_SECONDS` (600). In-relayer, prefix `OSTIA_RELAY_IN_` (the same guards, and the same defaults): also `FLOOR` (smallest send it claims, 0), `FROM_BLOCK` (source chain) and `OSTIA_FROM_BLOCK`, both required (the worker will not start without them, so a first start never reads from block 0), `CHUNK_BLOCKS` (2,000), `COOLDOWN_SECONDS` (300), `OPEN_PER_HOUR` (20), `INTAKE_PORT` (5591). Set both `FROM_BLOCK`s to the block where flow C opened. Claimer only: `OSTIA_CLAIM_FLOOR` (smallest send it claims, in base units, 0), `OSTIA_CLAIM_NETWORK` (the destination's network id, 0), `OSTIA_CLAIM_FROM_BLOCK` (0), `OSTIA_CLAIM_CHUNK_BLOCKS` (2,000).

## Tests

`python3 -W error::ResourceWarning -m unittest tests/test_worker.py tests/test_relay_in.py` (CI: `worker.yml`, in the hash-pinned environment of `demo/requirements.txt`). They use stand-ins only: a fake chain behind `chain.Rpc`, a fake ledger snapshot, and a local server for the bridge service. The label and the deposit id are checked against the router's own vectors (`router/test/vectors/r1.json`), and, for flow C, every signature, the `ClaimArgs` field order and the event topics against the router's, the book's and the interface's source.
