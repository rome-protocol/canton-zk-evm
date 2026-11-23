# Custody worker

One process, two parts, each off by default and each for any registered token (Canton Coin is one entry):

- the intake (`--intake`) turns a plain token-standard transfer to the gateway into a `Receipt`;
- the payouts (`--payout-offers`) pay each open `Payout` as a token-standard transfer offer from the gateway.

```
apps/custody/intake.py [--intake] [--payout-offers] [--once] --gateway-party PARTY --ledger-user USER [--poll-seconds 10]
    [--min-deposit ADMIN/ID=AMOUNT]... [--router 0xADDRESS] [--ostia-rpc URL --gateway-address 0xADDRESS]
    [--registry ADMIN=URL]... [--registry-token-file ADMIN=FILE]...
    [--work-dir DIR] [--offer-hours 24] [--expiring-instrument ADMIN]... [--custody-floor-days 30] [--max-transfer-inputs 50] [--disclosed FILE]
```

## The intake

Every poll the worker reads the gateway's active `TransferInstruction` views (as the gateway, with the ledger user's token, read again from its file for each call) and keeps those whose receiver is the gateway and whose status is `TransferPendingReceiverAcceptance`. For each one:

1. The instrument must be that of an active `GatewayToken` of the chain's `Intake`.
2. The amount must be at least that token's `--min-deposit` (split on the first `/` and the last `=`; no setting, no minimum).
3. The memo (`splice.lfdecentralizedtrust.org/reason` in the transfer's meta) must be one EVM address: lowercase or uppercase as written, mixed case only with the EIP-55 checksum. The label is `romeprotocol.com/ostia-label` if the memo has one, else the instruction's contract id. With `--router` (an address; anything else stops the start with a message), the memo may instead be one route text `r1:<network>:0x<40 lowercase hex>:<most fee>:<nonce>` (no leading zeros, destination not zero, the network under 2^32, the fee under 2^256 and the nonce under 2^64, as the router reads it): its receipt is for the router and its label is the route text.
4. The deposit id (the one `Gateway.claim` takes, from the sender and the label) must not be open already in a `Receipt` or a `DepositRequest`, and, with `--ostia-rpc` and `--gateway-address`, not used already by the gateway (its `used` mapping, read on Ostia at the latest block; the URL is never printed). A transfer whose id is taken stays pending. Without those two settings only the open ids are known.
5. The choice context for the accept comes from that admin's registry (`--registry`, `--registry-token-file`, read by the builder's reader; Canton Coin's is the validator's scan proxy). An admin with no registry gets an empty context.
6. The worker submits `Intake_Accept` as the gateway in one transaction, with the registry's disclosed contracts. The accept and the `Receipt` happen together or not at all.

A transfer that fails any step stays pending, as the issuer made it: the sender takes it back in their wallet. A transfer in the issuer's own workflow is not looked at. One line of JSON on stdout for each accept and, once, for each transfer left pending with the reason. An accept that the participant refuses or that does not complete is tried again at the next poll. Without the Ostia read, an id that a claim used already cannot be seen from Canton; `Gateway.claim` refuses it, and the operator's `Receipt_Return` gives the token back.

## The payouts

Every poll, for each open `Payout` of the gateway the worker does one of these, by what the ledger and its journal say:

1. **Offer.** No offer for it yet: one standard transfer from the gateway to the party, through the factory that the token's registry names for that transfer (the factory's own `expectedAdmin` check ties it to the token's admin; the `GatewayToken`'s factory is used only for a token with no registry, with the contracts given by `--disclosed`), with the registry's choice context. The transfer's meta `romeprotocol.com/ostia-withdrawal` is the payout's id, and its `executeBefore` is now plus `--offer-hours` (default 24; also `CZE_OFFER_HOURS`).
   - Inputs. For an `--expiring-instrument` (Canton Coin) the builder's choice: the floor (what stays is zero or at least the floor), at most the cap, nearest expiry first, and the open round's fee check (a create, transfer or lock fee above zero keeps the payout waiting). While `custody-stop.json` (or a pending `custody-check.json`) is in the work folder, the instrument's payouts wait. For any other token the largest holdings first.
2. **Follow.** An offer found by the id in its meta is never offered twice. One that waits for the receiver is left alone until its `executeBefore`; then the worker withdraws it (with the registry's withdraw context) and offers again. One that is in the issuer's own approval step (`TransferPendingInternalWorkflow`) is followed, step by step, until it completes or ends.
3. **Pay.** When the offer is gone, the choice that archived it says how it ended, and nothing else does: a completed transfer (the receiver accepted, or the issuer's last step completed it, or a pre-approved receiver took it at once) is paid, and the worker exercises `Payout_Paid`. A reject, a withdraw or a failed transfer is not paid, and the offer is made again once the time of the last offer has passed (a reject is treated like a lapse). For an `--expiring-instrument` the custody check of the builder runs first at the completing update (custody fell by exactly the amount); on a difference it writes `custody-stop.json`, which holds the worker's payouts of the instrument until the operator clears it (the builder's payout legs go on, and their `Payout`s wait; the floor counts the open payouts), and the payout, which was made, is still marked. A receiver who accepts two of its own payout offers in one transaction makes custody fall by both amounts at once, which the check reads as a difference: it fails closed, both payouts are still marked, and the operator clears the stop.

The journal, `payouts.json` in `--work-dir` (the builder's work folder; also `CZE_WORK_DIR`), keeps for each open payout the number of offers, the time of the last, its command id (the same payout and offer number always give the same one, so the participant never runs it twice), the ledger end before it and its state. A send whose answer was lost is found by its completion, and a transfer that completed is marked without another transfer. A send with no completion is sent again only when Canton's own time (from the completions stream, not this machine's clock) is past `resolve_seconds` after it and not more than 30 s ahead of this clock; a failed completion is sent again at once; a committed completion without an update id waits. A journal that cannot be read stops the worker. One line of JSON on stdout for each offer, withdrawal, failure and payment, and, once, for each payout that waits with its reason.

The protections of the intake and of Canton Coin payouts take effect only with their settings: the used-id check needs `--ostia-rpc` and `--gateway-address` (else only open ids are checked), and the floor, stop file and fee check need `--expiring-instrument` with `--registry` and `--registry-token-file` (else Canton Coin is paid largest first).

Settings can also come from the environment: `CZE_INTAKE=1`, `CZE_PAYOUT_OFFERS=1`, `CZE_GATEWAY_PARTY`, `CZE_LEDGER_URL`, `CZE_LEDGER_USER`, `CZE_LEDGER_TOKEN_FILE`, `CZE_TOKEN_REGISTRIES`, `CZE_TOKEN_REGISTRY_TOKEN_FILES`, `CZE_ROUTER_ADDRESS`, `CZE_OSTIA_RPC_URL`, `CZE_GATEWAY_ADDRESS`, `CZE_POLL_SECONDS`, `CZE_OFFER_HOURS`, `CZE_WORK_DIR`.

The worker uses the builder's ledger client and registry reader (`builder/builder.py`), so it needs the builder's one dependency (`pip install --require-hashes -r builder/requirements.txt`).

Tests: `python3 -m unittest discover -s apps/custody/tests`, against a fake Ledger API and a fake registry, for Canton Coin and a token with no registry; `tests/canton_network.sh` runs the worker on the real Canton network (the intake of a Splice test token transfer, and the payout of it: the offer, U's accept, the payment).
