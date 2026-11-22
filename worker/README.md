# Worker for the Canton router, Canton to another chain

Two small services for flow A of the [Canton router](../router/README.md): a Canton deposit that names the router as recipient arrives on another AggLayer chain. Both are off unless their switch is `1`; with it off they read and send nothing.

| File | What it is |
|---|---|
| `relay_out.py` | The out-relayer (`OSTIA_RELAY_OUT=1`). It reads the router's open `DepositRequest`s from the ledger as the operator, and for each one checks the chain, the label, the allocation, the book and the fee, then sends `claimAndBridge` on Ostia. One transaction at a time. |
| `claim_sepolia.py` | The Sepolia claimer (`OSTIA_CLAIM_SEPOLIA=1`). It reads the router's `RoutedOut` events in Ostia's finalized blocks, takes each leaf and proof from AggKit's bridge service, and sends `claimAsset` on Ethereum Sepolia. The user's own claim stays the fallback. |
| `chain.py`, `records.py` | JSON-RPC, the hot key, sending and replacing a transaction; the records and the caps. |
| `main.py` | `main.py out [--once]` and `main.py claim [--once]`. |

## What the out-relayer checks

A request that fails a check is left alone: it lapses on Canton at its `settleBefore` and the depositor keeps the coin.

- The request names this chain (operator, confirmer, gateway, builder, chain id).
- The label matches `r1:<network>:0x<40 lowercase hex>:<max fee>:<nonce>` as a whole string, each part fits its type, and the destination is not zero. Then the router rebuilds the label (`routeLabel`) and the deposit id (`depositId`) by `eth_call`, and both must equal the ledger's byte for byte. The relayer keeps no copy of the format of its own.
- The allocation is active, from the depositor to the gateway with the operator as executor, and outlives the relay by the settle margin.
- The instrument has a wrapped token, the book opens the route and the destination now (`checkOut`), the gateway has not used the id, and the lock cap leaves room.
- The fee that is finally charged is at most the label's most fee: `amount - send <= maxFee`, with `send` cut down to a multiple of the destination's unit, so the cut is part of the fee.
- The caps and the balance allow it, and the gas and gas price stay under their limits.

A request that waits on something that can change (the route is closed, the fee is above the most fee, the cap is reached) is tried again on every pass; one that can never pass (a bad label, another chain) is recorded and not looked at again. Only one transaction is out at a time, because a transaction that the builder leaves out stays in the pool and holds the later ones. It counts as done only in a block at or under Ostia's finalized block. When it has no receipt after `OSTIA_RELAY_WAIT_SECONDS`, its nonce goes to a transfer of nothing to the key itself at twice the fees, and the request is let go.

## What the claimer checks

The leaf that the bridge service gives must be the one the router's event describes: origin network and token, destination network and address, and the amount. Anything else is never claimed. The bridge service must be on this machine, every answer is checked field by field, and a claim goes out only when the leaf is ready on Ethereum and `isClaimed` says nobody has claimed it. Transfers that the router did not send are not read at all. A claim that sticks is replaced as above, and tried again up to three times.

## Settings

Names only; values come from the environment. A key file holds one hex key and must be mode 0600. Nothing here prints a URL, a key or a token, and an error says what failed and the kind of error.

| Variable | Meaning |
|---|---|
| `OSTIA_RELAY_OUT`, `OSTIA_CLAIM_SEPOLIA` | The switches. Off unless `1` |
| `OSTIA_RPC_URL` | Ostia's JSON-RPC (https, or http on this machine) |
| `OSTIA_ROUTER` | The router's proxy address |
| `OSTIA_WORKER_STATE_DIR` | Where the records are kept (`relay-out.json`, `claim-sepolia.json`) |
| `OSTIA_WORKER_INTERVAL_SECONDS` | Seconds between passes (15) |
| `OSTIA_RELAY_KEY_FILE` | The relayer's key: tROME only |
| `CZE_CANTON`, `CZE_LEDGER_URL`, `CZE_TOKEN_FILE_OPERATOR`, `CZE_STATE_DIR` | The ledger, as `demo/canton.py` reads them |
| `OSTIA_CLAIM_KEY_FILE` | The claimer's key: Sepolia ETH only |
| `OSTIA_CLAIM_SEPOLIA_RPC_URL` | The claimer's own Sepolia endpoint (a secret) |
| `OSTIA_CLAIM_SEPOLIA_BRIDGE` | The bridge's address on Sepolia |
| `AGGKIT_BRIDGE_URL` | The bridge service, http on this machine only (`http://127.0.0.1:5578`) |

Guards, each with the prefix `OSTIA_RELAY_` or `OSTIA_CLAIM_`: `MAX_GAS` (3,000,000), `MAX_GAS_PRICE` (wei, 100 gwei), `PER_HOUR` (20), `PER_DAY` (100), `PER_RECIPIENT` (10 a day), `MIN_BALANCE` (wei, 0.01), `WAIT_SECONDS` (900). Relayer only: `OSTIA_RELAY_SETTLE_MARGIN_SECONDS` (600). Claimer only: `OSTIA_CLAIM_FLOOR` (smallest send it claims, in base units, 0), `OSTIA_CLAIM_NETWORK` (the destination's network id, 0), `OSTIA_CLAIM_FROM_BLOCK` (0), `OSTIA_CLAIM_CHUNK_BLOCKS` (2,000).

## Tests

`python3 -W error::ResourceWarning -m unittest tests/test_worker.py` (CI: `worker.yml`, in the hash-pinned environment of `demo/requirements.txt`). They use stand-ins only: a fake chain behind `chain.Rpc`, a fake ledger snapshot, and a local server for the bridge service. The label and the deposit id are checked against the router's own vectors (`router/test/vectors/r1.json`), and the selectors against the router's source.
