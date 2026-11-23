# Custody worker

Part 1, the intake: turns a plain token-standard transfer to the gateway into a `Receipt`, for any registered token (Canton Coin is one entry). Off by default.

```
apps/custody/intake.py --intake [--once] --gateway-party PARTY --ledger-user USER [--poll-seconds 10]
    [--min-deposit ADMIN/ID=AMOUNT]... [--router 0xADDRESS]
    [--registry ADMIN=URL]... [--registry-token-file ADMIN=FILE]...
```

Every poll the worker reads the gateway's active `TransferInstruction` views (as the gateway, with the ledger user's token, read again from its file for each call) and keeps those whose receiver is the gateway and whose status is `TransferPendingReceiverAcceptance`. For each one:

1. The instrument must be that of an active `GatewayToken` of the chain's `Intake`.
2. The amount must be at least that token's `--min-deposit` (split on the first `/` and the last `=`; no setting, no minimum).
3. The memo (`splice.lfdecentralizedtrust.org/reason` in the transfer's meta) must be one EVM address: lowercase or uppercase as written, mixed case only with the EIP-55 checksum. The label is `romeprotocol.com/ostia-label` if the memo has one, else the instruction's contract id. With `--router`, the memo may instead be one route text `r1:<network>:0x<40 lowercase hex>:<most fee>:<nonce>` (no leading zeros, destination not zero): its receipt is for the router and its label is the route text.
4. The deposit id (the one `Gateway.claim` takes, from the sender and the label) must not be open already in a `Receipt` or a `DepositRequest`.
5. The choice context for the accept comes from that admin's registry (`--registry`, `--registry-token-file`, read by the builder's reader; Canton Coin's is the validator's scan proxy). An admin with no registry gets an empty context.
6. The worker submits `Intake_Accept` as the gateway in one transaction, with the registry's disclosed contracts. The accept and the `Receipt` happen together or not at all.

A transfer that fails any step stays pending, as the issuer made it: the sender takes it back in their wallet. A transfer in the issuer's own workflow is not looked at. One line of JSON on stdout for each accept and, once, for each transfer left pending with the reason. An accept that the participant refuses or that does not complete is tried again at the next poll. The deposit ids that a claim already used cannot be seen from Canton; `Gateway.claim` refuses them, and the operator's `Receipt_Return` gives the token back.

Settings can also come from the environment: `CZE_INTAKE=1`, `CZE_GATEWAY_PARTY`, `CZE_LEDGER_URL`, `CZE_LEDGER_USER`, `CZE_LEDGER_TOKEN_FILE`, `CZE_TOKEN_REGISTRIES`, `CZE_TOKEN_REGISTRY_TOKEN_FILES`, `CZE_ROUTER_ADDRESS`, `CZE_POLL_SECONDS`.

The worker uses the builder's ledger client and registry reader (`builder/builder.py`), so it needs the builder's one dependency (`pip install --require-hashes -r builder/requirements.txt`).

Tests: `python3 -m unittest discover -s apps/custody/tests`, against a fake Ledger API and a fake registry; `tests/canton_network.sh` runs the worker once on the real Canton network.
