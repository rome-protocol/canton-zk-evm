# OTC app

A seller who holds a Canton token offers it to a buyer who pays in an ERC-20 token on an EVM chain. A venue runs the trade. This is the Canton side of that trade: two templates in their own Daml package, `otc-venue`.

The package depends only on the Canton token standard (CIP-0056), on its API packages in [`../../daml/dars`](../../daml/dars). It does not depend on the `canton-zk-evm` package and knows nothing about how a chain settles. Any venue can use it; a chain such as Ostia settles its trades through a small driver that sits beside the venue (below), which acts for the seller as well as the venue.

## Templates

| Template | Signed by | What it is |
|---|---|---|
| `TradeOffer` | the seller (the venue observes) | What the seller offers. The Canton side: the instrument and the amount. The EVM side: the ERC-20 token (40 hex digits), its amount in base units (64 hex digits), the seller's EVM address that is paid, the buyer's EVM address that receives, and a label. It also names the chain's gateway party, and how long the seller has to allocate and how long the settlement may take. Choices: `Accept` (the venue), `Decline` (the venue), `Withdraw` (the seller). |
| `Trade` | the venue and the seller | What the venue makes when it accepts the offer; the offer is gone. It implements the token standard's `AllocationRequest`, so a CIP-0056 wallet shows the seller a request to allocate: the settlement's executor is the venue, its reference is the label, and its one transfer leg (id `leg`) is the seller's amount to the chain's gateway party. Choices: `Close` (the venue archives a trade it will not settle) and the standard's `AllocationRequest_Reject` (the seller or the venue) and `AllocationRequest_Withdraw` (the venue). |

An offer or a trade whose EVM side is malformed (a token, payee or recipient that is not 40 lowercase hex digits, an amount that is not 64 lowercase hex digits, or is zero), with no amount or no label, or with a settlement window shorter than the allocation window, is refused when it is created.

## The journey

1. The seller creates a `TradeOffer`; the venue accepts it, which makes the `Trade`.
2. The seller's wallet shows the `AllocationRequest`. The seller allocates through the token's own factory (`AllocationFactory_Allocate`) with the trade's spec: the request's settlement, transfer leg id `leg` and the leg itself.
3. The buyer pays on the EVM and the chain settles the trade, which executes the seller's allocation and leaves the buyer a claim (below).
4. The venue archives the `Trade` (`Close`). For a trade it will not settle, the driver's `close` also archives the `VenueTrade` and has the seller take back his allocation: a builder started with `--venue` cannot see a withdrawn allocation, and would keep sending `Advance`s that Canton refuses. Once a trade is published, turning down the request (`AllocationRequest_Reject` by the seller or the venue, or `AllocationRequest_Withdraw` by the venue) does not stop it: the `VenueTrade` and the seller's allocation stay, and a full payment still settles. Only `close` (or the seller withdrawing his allocation, and then `close`) ends it, and `close` also works when the `Trade` is already gone.

## How a chain like Ostia settles its trades

The app does not name the chain. The venue's own driver, off the ledger, links the two: once the seller has allocated, it creates the chain package's `VenueTrade` through the Ledger API, with

- `venue` and `sender` (the seller) as the signatories. Settling on this chain needs the seller's own signature on the `VenueTrade`, so the driver submits as the venue and the seller: the seller's party must be hosted where the venue's driver can act as it, or the seller co-submits. The driver then has the seller's authority on the Ledger API, not only the allocation the seller made. This per-trade signature by the venue and the seller is the design today; a step in which the seller proposes the trade, so that the driver no longer holds the seller's authority, is planned for mainnet (the chain's Daml package 0.5.0);
- `label` the trade's label, `payId` = `venueTradeId venue label` and `claimId` = `venueClaimId payId` (the helpers in `daml/src/Zk/Chain.daml`);
- `token`, `payee` and `amount` the offer's EVM side, `recipient` the buyer's address;
- `allocation` the seller's allocation, only if it is the trade's own: the driver builds the allocation the trade asks for (the settlement with the venue as executor, the label as reference and the trade's times, and the one leg from the seller to the gateway for the trade's instrument and amount) and takes no allocation that is not equal to it, whoever made it and whatever label it shares. The chain ties the Canton side to nothing but the allocation's own amount, so this is the check that the buyer gets what the trade says. A trade past its settle-before time is not published. `allocationDisclosed` is its created event as a disclosed contract in the JSON Ledger API v2 form, when the builder cannot see it itself. The builder takes such an allocation on trust only for a venue it was started with `--venue` for.

The buyer pays through the gateway's `pay(payId, token, payee, amount)`. The block that records the payment carries a trade leg; `Advance` then executes the allocation, so the gateway holds the Canton token, and creates a `FundedClaim` for the buyer. The buyer redeems it with the gateway's `claim(claimId, wrapped token, amount)` in a later block. The rules are in [../../daml/README.md](../../daml/README.md) ("A venue's trade"); `demo/otc.py` drives the whole swap.

## On DevNet

The swap ran end to end on Ostia's DevNet on 2026-10-27 at 15:55 UTC, with package `otc-venue` 0.1.0: TKB, a CIP-0056 token on Canton, for TKA (`0xf4b69022b3e6501101600743f17fbe0659dd1af8`), an ERC-20 on the EVM. The buyer's payment in block 16816 committed in one Canton update, `1220ad687926fde1ca580721ea5ab457935b054b82be35435ff52056d3d5adb98a74`, in which the seller's allocation was executed. The buyer's claim was in block 16823 (update `1220f08d8e2cfeca915416a678735f0d236f1cef0a6ab695d79594ac459642f7ff14`). A payment below the trade's amount was left out of block 16834 and moved nothing. The commands are in [demo/README.md](../../demo/README.md) ("The OTC swap").

## Build and test

```
apps/otc/build.sh   # dist/otc-venue.dar
apps/otc/test.sh    # builds, then runs the Daml Script tests in apps/otc/test (dpm, Daml SDK 3.5.12)
```

The tests run the offer and the acceptance, the `AllocationRequest` view, the seller's allocation through the Splice reference token's factory with the trade's spec (and its execution by the venue, the seller and the gateway together), the venue's `Close`, and the refusals. CI runs them in the `daml` workflow.
