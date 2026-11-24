# Custody worker

One process, two parts, each off by default and each for any registered token (Canton Coin is one entry):

- the intake (`--intake`) turns a plain token-standard transfer to the gateway into a `Receipt`, and rejects one that could not be claimed;
- the payouts (`--payout-offers`) pay each open `Payout` as a token-standard transfer offer from the gateway.

A third mode, the buy mode (`--buy`), runs on its own and sells the chain's coin for Canton Coin (see [The paid path](#the-paid-path-buy-mode)).

```
apps/custody/intake.py [--intake] [--payout-offers] [--once] --gateway-party PARTY --ledger-user USER [--poll-seconds 10]
    [--min-deposit ADMIN/ID=AMOUNT]... [--router 0xADDRESS --book 0xADDRESS] [--ostia-rpc URL] [--gateway-address 0xADDRESS]
    [--registry ADMIN=URL]... [--registry-token-file ADMIN=FILE]...
    [--work-dir DIR] [--offer-hours 24] [--min-payout ADMIN/ID=AMOUNT]... [--max-offers N] [--expiring-instrument ADMIN]... [--custody-floor-days 30] [--max-transfer-inputs 50] [--disclosed FILE]
```

## The intake

Every poll the worker reads the gateway's active `TransferInstruction` views (as the gateway, with the ledger user's token, read again from its file for each call) and keeps those whose receiver is the gateway and whose status is `TransferPendingReceiverAcceptance`. For each one:

1. The instrument must be that of an active `GatewayToken` of the chain's `Intake`.
2. The amount must be at least that token's `--min-deposit` (split on the first `/` and the last `=`; no setting, no minimum).
3. The memo (`splice.lfdecentralizedtrust.org/reason` in the transfer's meta) must be one EVM address: lowercase or uppercase as written, mixed case only with the EIP-55 checksum. The label is `romeprotocol.com/ostia-label` if the memo has one, else the instruction's contract id. With `--router` (an address; anything else stops the start with a message), the memo may instead be one route text `r1:<network>:0x<40 lowercase hex>:<most fee>:<nonce>` (no leading zeros, destination not zero, the network under 2^32, the fee under 2^256 and the nonce under 2^64, as the router reads it): its receipt is for the router and its label is the route text. `--router` needs `--book` (the router's book on Ostia) and `--ostia-rpc`, or the start stops.
4. **The transfer must be claimable now.** Read live on Ostia for each transfer, never kept:
   - a route memo: the book's `checkOut(token, network)` (the asset's `feeOut`, `minAmount`, the claim fee of the network and the destination's `unit`; it reverts when the direction, the route or the destination is not open) and the router's `lockRoom(token)`, with the router's own checks from `claimAndBridge`: the fee `feeOut + claim fee` is at most the memo's most fee; the amount is at least `minAmount` and leaves at least one `unit` after the fee (what is sent is the rest cut down to the unit, the cut going to the fee); the fee finally taken is at most the memo's most fee; what is sent fits the lock room. The token's address on Ostia is the `GatewayToken`'s `evmToken`;
   - a plain memo deposit: the gateway has no fee or minimum of its own in Daml 0.6.0 (`Gateway.claim` only refuses zero), so it must leave something to claim; `--min-deposit` is the operator's own floor and leaves a smaller transfer pending.

   A transfer that fails this is **rejected**: the gateway exercises the standard's `TransferInstruction_Reject` (with the registry's reject context) with the reason in the choice's meta (`romeprotocol.com/ostia-reject-reason`, for example "the least amount for this route is now 0.3"), so the coin goes back to its sender at once and nothing spam-like stays in custody. A book or router that cannot be read leaves the transfer pending, and it is tried again at the next poll: the intake never accepts on a minimum it does not know. A route memo with no `--book` is never accepted.
5. The deposit id (the one `Gateway.claim` takes, from the sender and the label) must not be open already in a `Receipt` or a `DepositRequest`, and, with `--ostia-rpc` and `--gateway-address`, not used already by the gateway (its `used` mapping, read on Ostia at the latest block; the URL is never printed). A transfer whose id is taken stays pending. Without those two settings only the open ids are known.
6. The choice context for the accept comes from that admin's registry (`--registry`, `--registry-token-file`, read by the builder's reader; Canton Coin's is the validator's scan proxy). An admin with no registry gets an empty context.
7. The worker submits `Intake_Accept` as the gateway in one transaction, with the registry's disclosed contracts. The accept and the `Receipt` happen together or not at all.

A transfer that fails any other step stays pending, as the issuer made it: the sender takes it back in their wallet. A transfer in the issuer's own workflow is not looked at. One line of JSON on stdout for each accept, for each reject (`rejected`, with the `reason`) and, once, for each transfer left pending with the reason.

**The gateway must hold no Canton Coin transfer preapproval.** The refusal above works because Canton Coin reaches the gateway as an offer, which the receiver may accept or reject. With a `TransferPreapproval` for the gateway the coin would land at once, with nothing to refuse. At the start the worker looks for one and prints a `warning` line if the gateway holds it (or if that cannot be checked); the operator archives it. An accept that the participant refuses or that does not complete is tried again at the next poll. Without the Ostia read, an id that a claim used already cannot be seen from Canton; `Gateway.claim` refuses it, and the operator's `Receipt_Return` gives the token back.

## The payouts

Every poll, for each open `Payout` of the gateway the worker does one of these, by what the ledger and its journal say:

1. **Offer.** No offer for it yet: one standard transfer from the gateway to the party, through the factory that the token's registry names for that transfer (the factory's own `expectedAdmin` check ties it to the token's admin; the `GatewayToken`'s factory is used only for a token with no registry, with the contracts given by `--disclosed`), with the registry's choice context. The transfer's meta `romeprotocol.com/ostia-withdrawal` is the payout's id, and its `executeBefore` is now plus `--offer-hours` (default 24; also `CZE_OFFER_HOURS`).
   - Inputs. For an `--expiring-instrument` (Canton Coin) the builder's choice: the floor (what stays is zero or at least the floor), at most the cap, nearest expiry first, and the open round's fee check (a create, transfer or lock fee above zero keeps the payout waiting). While `custody-stop.json` (or a pending `custody-check.json`) is in the work folder, the instrument's payouts wait. For any other token the largest holdings first.
2. **Follow.** An offer found by the id in its meta is never offered twice. One that waits for the receiver is left alone until its `executeBefore`; then the worker withdraws it (with the registry's withdraw context) and offers again. One that is in the issuer's own approval step (`TransferPendingInternalWorkflow`) is followed, step by step, until it completes or ends.
3. **Pay.** When the offer is gone, the choice that archived it says how it ended, and nothing else does: a completed transfer (the receiver accepted, or the issuer's last step completed it, or a pre-approved receiver took it at once) is paid, and the worker exercises `Payout_Paid`. A reject, a withdraw or a failed transfer is not paid, and the offer is made again once the time of the last offer has passed (a reject is treated like a lapse). For an `--expiring-instrument` the custody check of the builder runs first at the completing update (custody fell by exactly the amount; it leaves the builder's own pending `custody-check.json` alone, so run the builder and the worker with the same `--payout-offers` setting); on a difference it writes `custody-stop.json`, which holds the worker's payouts of the instrument until the operator clears it (the builder's payout legs go on, and their `Payout`s wait; the floor counts the open payouts), and the payout, which was made, is still marked. A receiver who accepts two of its own payout offers in one transaction makes custody fall by both amounts at once, which the check reads as a difference: it fails closed, both payouts are still marked, and the operator clears the stop.

Two limits keep a payout from costing more than it is worth (an offer costs Canton traffic, paid by the gateway's operator, whether or not it is accepted). Both are settings; with neither, every payout is offered, and offered again after each lapse, as above.
- `--min-payout ADMIN/ID=AMOUNT` (repeatable, per token; the same form as `--min-deposit`): a payout below its token's least amount gets no offer and no Canton transaction at all. It is journaled as `below the least payout`, said once as a `waiting` line, and left open; it is offered when the setting is lowered or removed.
- `--max-offers N` (also `CZE_MAX_OFFERS`; default 0, no limit): a payout that was offered N times and not accepted is not offered again. It is journaled as `offers used up` and said once as a `waiting` line. A send that the participant refused counts as an offer, so a payout that can never be sent stops retrying after N tries. The payout stays open; a larger N, or 0, makes the worker offer it again.

At the start the worker says one `payouts` line with its settings (`offerHours`, `minPayout`, `maxOffers`).

The journal, `payouts.json` in `--work-dir` (the builder's work folder; also `CZE_WORK_DIR`), keeps for each open payout the number of offers, the time of the last, its command id (the same payout and offer number always give the same one, so the participant never runs it twice), the ledger end before it and its state (and `why` while an offer is held back). A send whose answer was lost is found by its completion, and a transfer that completed is marked without another transfer. A send with no completion is sent again only when Canton's own time (from the completions stream, not this machine's clock) is past `resolve_seconds` after it and not more than 30 s ahead of this clock; a failed completion is sent again at once; a committed completion without an update id waits. A journal that cannot be read stops the worker. One line of JSON on stdout for each offer, withdrawal, failure and payment, and, once, for each payout that waits with its reason.

## The paid path (buy mode)

`--buy` (also `CZE_BUY=1`; off by default) makes the worker a seller of the chain's coin. It is its own process, with its own ledger user, which acts as Rome's validator party: it runs with neither `--intake` nor `--payout-offers`.

```
apps/custody/intake.py --buy --validator-party PARTY --ledger-user USER --registry ADMIN=URL [--registry-token-file ADMIN=FILE]...
    --price CC --min-buy CC --buy-key-file FILE --reth-rpc URL --work-dir DIR [--max-meta-bytes N] [--poll-seconds 10]
```

A buyer sends Canton Coin from any wallet that makes a two-step token-standard transfer, to the validator party, with their address on the chain as the memo. Every poll the worker reads the validator party's pending Canton Coin transfers (the instrument is Canton Coin: id `Amulet`, an admin that has a `--registry`). For each:

1. **Checks.** The memo (`splice.lfdecentralizedtrust.org/reason`) is exactly one address on the chain (the intake's rule 3: lowercase or uppercase as written, mixed case only with the EIP-55 checksum); the transfer's meta is at most `--max-meta-bytes` (the UTF-8 bytes of its keys and values; 0, the default, is no cap); the amount is at least `--min-buy`; reth's gas estimate for the send to that address succeeds and is at most 100000 (a recipient whose code does real work, or would refuse the coin, is left pending: the send is signed with the estimate and room, a plain transfer with exactly 21000); the buy key holds the coin for it and for the gas of that send, less what the buys not yet settled still take. A transfer that fails a check is **left pending, never rejected**: it goes back to its sender at its own deadline, at no cost to Rome. A transfer with no address memo is left alone, as the intake leaves one. Each is said once as a `pending` line with its reason.
2. **Accept**: `TransferInstruction_Accept` as the validator party, with the registry's accept context, as the intake gets it.
3. **Send** floor(amount / `--price`) coin, rounded down to the coin's smallest unit (1 wei), from the buy key to the address, as an EIP-1559 transfer straight to reth (`--reth-rpc`, never printed). The fees are twice reth's gas price, and the tip is reth's.

The worker refuses to accept anything while reth cannot be read: a buy it could not pay is not accepted.

**The journal** (`buy.json` in `--work-dir`) keeps each buy: the accept first (`accepting`, with its command id and the ledger end), then `accepted`, then `sent` with the nonce and the signed bytes, then `done` when reth has the receipt (kept 30 days). The bytes are written before the first send, and the signature is deterministic, so a send that reth does not hold (a restart of reth, a lost answer) is sent again as the same transaction with the same nonce, and lands once. A record reaches the worker's memory only once it is on disk, so nothing is sent from a state a restart would not see; a write that fails is said, and the buy is tried again at the next poll. Each try to accept has its own command id (the transfer and the try's number); a transfer that is still pending after a try is accepted again only once that try has failed (a failed completion, or no completion once Canton's own time is past the window), never while it may still commit. A restart takes the journal up where it stopped: a stop between the accept and its record is settled by the command's completion (a commit goes on to the send; a transfer that is gone and whose last try did not commit is dropped); an accept that was signed is not signed again. A journal that cannot be read stops the worker.

**One worker per work folder.** The worker takes an exclusive lock on `buy.lock` in `--work-dir` and stops at the start, with a message, if another worker holds it: two would each sign a send for one accepted transfer.

**The buy key** is a file of 64 hex digits (`0x` allowed) that must be readable by its owner only (mode 0600), or the worker stops. The key is never printed or put in a log or in the environment. The worker says the address it sends from.

**The validator party must hold no Canton Coin transfer preapproval.** With one, a transfer lands at once and a bad memo, a transfer under the least buy or a buy with the stock out could not be refused. The worker checks at the start and says a `warning` line if the party holds one (or if that cannot be checked).

**The status file** (`buy-status.json` in `--work-dir`, replaced whole at the end of each poll): `{"version": 1, "updatedAt": "...", "price": "20", "minBuy": "20", "party": "...", "state": "open"}`. `price` and `minBuy` are `--price` and `--min-buy` as plain decimal text; `state` is `open` while the buy key's stock, less what is owed, covers the least buy and the gas of its send, and `sold out` when it does not. Nothing is written while reth cannot be read. The explorer shows it in `/api/status`.

Settings (none has a default): `--price` (Canton Coin per coin, more than 0), `--min-buy` (0 or more), `--buy-key-file`, `--reth-rpc`, `--validator-party`, `--work-dir` (its own folder: the journal and the status file), `--registry` (and `--registry-token-file`) for Canton Coin's admin. From the environment: `CZE_BUY=1`, `CZE_VALIDATOR_PARTY`, `CZE_BUY_PRICE`, `CZE_BUY_MIN`, `CZE_BUY_KEY_FILE`, `CZE_MAX_META_BYTES`, `CZE_RETH_RPC_URL`.

## The limits file

With `--work-dir`, the worker writes `custody-limits.json` there at the start of every poll round (all or nothing: a reader never sees half of it), so that a reader sees the least amounts the running worker enforces and how old they are. Nothing is copied into a second setting.

```json
{
  "version": 1,
  "updatedAt": "2026-11-24T10:30:05Z",
  "pollSeconds": 10,
  "minDeposits": [{ "instrumentAdmin": "ADMIN", "instrumentId": "ID", "least": "10" }],
  "minPayouts": [{ "instrumentAdmin": "ADMIN", "instrumentId": "ID", "least": "10" }],
  "maxOffers": 3
}
```

`minDeposits` is the intake's `--min-deposit` (a transfer below it is not accepted and stays as the sender made it); `minPayouts` is `--min-payout` and `maxOffers` is `--max-offers` (0: no limit). A part that is not switched on has `null` for its fields, and a part that is on with no setting has an empty list. `least` is plain decimal text in the instrument's own units. `updatedAt` is UTC. A write that fails is said once on stdout and never stops the worker.

The protections of the intake and of Canton Coin payouts take effect only with their settings: the used-id check needs `--ostia-rpc` and `--gateway-address` (else only open ids are checked), and the floor, stop file and fee check need `--expiring-instrument` with `--registry` and `--registry-token-file` (else Canton Coin is paid largest first).

Settings can also come from the environment: `CZE_INTAKE=1`, `CZE_PAYOUT_OFFERS=1`, `CZE_GATEWAY_PARTY`, `CZE_LEDGER_URL`, `CZE_LEDGER_USER`, `CZE_LEDGER_TOKEN_FILE`, `CZE_TOKEN_REGISTRIES`, `CZE_TOKEN_REGISTRY_TOKEN_FILES`, `CZE_ROUTER_ADDRESS`, `CZE_BOOK_ADDRESS`, `CZE_OSTIA_RPC_URL`, `CZE_GATEWAY_ADDRESS`, `CZE_POLL_SECONDS`, `CZE_OFFER_HOURS`, `CZE_MAX_OFFERS`, `CZE_WORK_DIR`.

The worker uses the builder's ledger client and registry reader (`builder/builder.py`), so it needs the builder's one dependency (`pip install --require-hashes -r builder/requirements.txt`).

Tests: `python3 -m unittest discover -s apps/custody/tests`, against a fake Ledger API, a fake registry and a fake reth (the buy mode), for Canton Coin and a token with no registry; `tests/canton_network.sh` runs the worker on the real Canton network (the intake of a Splice test token transfer, and the payout of it: the offer, U's accept, the payment).
