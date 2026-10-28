# Twin app

The Canton twin of an ERC-20 token that an Ostia vault holds: a CIP-0056 token (token standard V1) with the instrument id `erc20:<token address>` (40 lowercase hex digits, no `0x`) and 10 decimals, administered by the twin's admin party. On DevNet the admin is the gateway party. This is the Canton side of moving an ERC-20 to Canton: the vault and the chain's legs for it are separate.

The package is `ostia-twin` 0.1.0 and depends only on the Canton token standard packages in [`../../daml/dars`](../../daml/dars), as [`apps/otc`](../otc) does. It does not depend on the `canton-zk-evm` package.

## One-to-one with an ERC-20

| ERC-20 | The twin |
|---|---|
| `balanceOf(owner)` | the owner's `Holding`s of the instrument, summed |
| `transfer(to, v)` | `TransferFactory_Transfer`, completed at once (`TransferInstructionResult_Completed`): the admin alone signs every holding, so the receiver has nothing to accept. There is no `TransferInstruction` contract |
| `approve` + `transferFrom` | `AllocationFactory_Allocate`, then the settlement's executor, the sender and the receiver together run `Allocation_ExecuteTransfer` |
| `name`, `symbol`, `decimals` | the `meta` of the factory view and of the holdings: `ostia/erc20`, `ostia/name`, `ostia/symbol`, `ostia/decimals` (always 10) |
| mint, burn | the admin's choices `Mint` and `Burn` on `TwinRules` |

| Template | Signed by | What it is |
|---|---|---|
| `TwinHolding` | the admin (the owner observes) | an amount of the twin owned by a party |
| `TwinAllocation` | the admin (sender, receiver and executor observe) | the sender's amount held for a settlement; also a locked `Holding` of the sender. Executing it makes the receiver's holding; withdraw and cancel give the sender's back |
| `TwinRules` | the admin | one per ERC-20: the transfer factory, the allocation factory, `Mint` and `Burn`. Wallets get it by explicit disclosure |

## Mint and burn (what the chain's `Advance` calls)

Both are non-consuming choices on `TwinRules` with the admin as the only controller. The caller is the chain's `Advance` acting as the admin, against a payment into or out of the vault that the proven block recorded; this package knows nothing of that proof.

- `Mint with owner : Party; amount : Decimal; reference : Text` returns the new `ContractId TwinHolding`. `reference` is stored on the holding as `ostia/mint-reference`. Amount must be positive and `reference` not empty.
- `Burn with owner : Party; holdingCids : [ContractId Holding]; amount : Decimal; reference : Text` archives the owner's holdings of this twin (at least one, none locked, all the owner's, all of this instrument), and returns the change (the total less `amount`) as one new holding, or `None` when nothing is left. It is refused when the holdings are worth less than `amount`.

Replays are not guarded here: a second `Mint` with the same `reference` mints again. The chain's own record of the payment (the legs it consumes once) is the guard.

## Amounts

A Daml `Decimal` has 10 decimals, so every twin amount does. `Twin.Amount.fromBaseUnits decimals baseUnits` converts an ERC-20 amount (64 lowercase hex digits, as the repo carries them) of a token with `decimals` decimals (0 to 36): exact for 10 or fewer, a multiple of 10^(decimals - 10) base units for more, and `None` for anything finer, malformed or above 10^17 whole units. It never rounds.

## Build and test

```
apps/twin/build.sh   # dist/ostia-twin.dar
apps/twin/test.sh    # builds, then runs the Daml Script tests in apps/twin/test (dpm, Daml SDK 3.5.12)
```

CI runs it in [`twin.yml`](../../.github/workflows/twin.yml). The tests cover the instrument and metadata, the balance, a transfer completed at once (change, merging, a split, the smallest amount), allocation and execution (DvP), withdraw and cancel, mint and burn by the admin alone, every refused case, and the base-unit conversion.
