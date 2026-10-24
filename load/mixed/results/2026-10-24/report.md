## Counts by kind

| kind | sent | final | succeeded | reverted |
| --- | ---: | ---: | ---: | ---: |
| erc20Transfer | 2527 | 2527 | 2527 | 0 |
| erc20Approve | 1295 | 1295 | 1295 | 0 |
| trexTransfer | 907 | 907 | 907 | 0 |
| erc721Mint | 869 | 869 | 869 | 0 |
| wrap | 770 | 770 | 770 | 0 |
| swapEthToUsd | 706 | 706 | 706 | 0 |
| erc721Transfer | 695 | 695 | 695 | 0 |
| swapUsdToTrome | 694 | 694 | 694 | 0 |
| swapTromeToUsd | 599 | 599 | 596 | 3 |
| swapUsdToEth | 590 | 590 | 590 | 0 |
| erc1155MintBatch | 570 | 570 | 570 | 0 |
| erc1155Mint | 569 | 569 | 569 | 0 |
| addLiquidity | 559 | 559 | 559 | 0 |
| removeLiquidity | 437 | 437 | 437 | 0 |
| erc1155Transfer | 431 | 431 | 431 | 0 |
| unwrap | 415 | 415 | 414 | 1 |
| erc1155BatchTransfer | 285 | 285 | 285 | 0 |
| mercesTransfer | 174 | 174 | 174 | 0 |
| revert: ERC-1155 bad id | 62 | 62 | 0 | 62 (on purpose) |
| revert: unwrap more than held | 61 | 61 | 0 | 61 (on purpose) |
| trexRefused | 59 | 59 | 0 | 59 (on purpose) |
| mercesDeposit | 59 | 59 | 59 | 0 |
| revert: ERC-721 not the owner | 58 | 58 | 0 | 58 (on purpose) |
| revert: swap: output below the minimum | 57 | 57 | 57 | 0 (on purpose) |
| revert: ERC-20 amount over balance | 48 | 48 | 0 | 48 (on purpose) |

Accepted 13496, final 13496, lost 0, refused by the RPC at send 5, unexpected failures 4.

## Phases

| phase | target tx/s | sent tx/s | minutes | every tx final | time to final p50 / p95 (s) |
| --- | ---: | ---: | ---: | --- | ---: |
| 2 tx/s | 2 | 1.99 | 10 | true | 21.72 / 28.45 |
| 3 tx/s | 3 | 3.00 | 10 | true | 23.26 / 30.72 |
| 4 tx/s | 4 | 4.00 | 10 | true | 24.94 / 32.72 |
| 4.5 tx/s | 4.5 | 4.50 | 10 | true | 25.74 / 33.41 |
| best (4.5 tx/s) | 4.5 | 4.50 | 20 | true | 25.42 / 33.16 |

## Proof and final time by block size

| txs in the block | blocks | proof p50 / p95 (s) | final p50 / p95 (s) | commit p50 / p95 (s) | our tx time to final p50 / p95 (s) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1-10 | 2 | 7.47 / 7.47 | 8.62 / 8.62 | 1.11 / 1.11 | 29.09 / 29.75 |
| 11-100 | 223 | 9.03 / 9.21 | 11.01 / 11.95 | 2.03 / 2.87 | 24.71 / 32.92 |
| 101-1000 | 0 | n/a / n/a | n/a / n/a | n/a / n/a | n/a / n/a |
| over 1000 | 0 | n/a / n/a | n/a / n/a | n/a / n/a | n/a / n/a |

Time to final for every transaction: p50 24.72 s, p95 32.92 s, max 37.95 s (from the moment it was sent to the moment its block was first seen final).

## Blocks

225 blocks carried our transactions: 69 of ours per block (median), 84 at most; 69 transactions per block in all (median), 84 at most; gas per block median 5287195, at most 7886580 of 30,000,000.

Busiest block: 377, 84 transactions (84 ours), 6147278 gas, proof 8.95 s, final 11.31 s, commit 2.31 s.

## Canton ledger

225 blocks read from /api/canton/updates: argument bytes per block p50 42403.00, p95 48849.00, max 50573.00; per transaction p50 628.27. Traffic fields the explorer showed: producerRecord.trafficBytes.

## RPC

Budget 285 calls a minute; the most used in any minute: 276; 15603 calls in all; 0 answers of "too many requests"; the driver waited 518 s for budget; 1594 receipts read through the RPC (0 differed from the explorer).

## Reverts

Deliberate reverts (sent to fail): 288 reverted as intended, 57 succeeded when they should not have. Unexpected failures: 4 (swapTromeToUsd 0x82ae5f2c8e7327dc6fab778b8af68b66c66e578d27042b57bdf9567db280b23f in block 232; swapTromeToUsd 0x0ed2c4e54897fed59c39e02270af265cb0f1dea245339d53d173a369f1b04583 in block 234; unwrap 0xe8e5beb3dde7f5dcbdccf08ec057a32edd8dcf5205ad72310a33bcd3551c7673 in block 235; swapTromeToUsd 0xd822c5082fbafa7273e0590a091264eea50f4ecbdb252db3999fa4c9230ad87c in block 244).

## Lost transactions and refusals

Lost (accepted by the RPC, never seen in a final block): 0.

Refused by the RPC at send, by reason: nonce gap: send the missing transactions first. This transaction has nonce 4, an: 2; nonce gap: send the missing transactions first. This transaction has nonce 5, an: 1; nonce gap: send the missing transactions first. This transaction has nonce 6, an: 1; nonce gap: send the missing transactions first. This transaction has nonce 7, an: 1.

## Kinds that did not run

Skipped because they could not be built when their turn came: erc721Transfer: 9; swapTromeToUsd: 3; erc1155Transfer: 6; erc1155BatchTransfer: 2; removeLiquidity: 11; vaultRecord: 689.

## RedStone

The feeder asked RedStone's gateways 80 times and got signed prices 0 times; 0 PriceVault.record transactions were sent and 0 price reads (eth_call with a payload) answered. The public gateways refused every request (they are being switched off and stop on 2026-10-29), so the oracle consumer recorded no price in this run.

## Merces (private transfers)

Client side only: 177 Groth16 transfer proofs were made on the sending machine (median 328.00 ms); deposits and transfers were sent to the Merces contract, whose verifier checks each proof. Nothing is settled: no MPC node runs, so the queued actions are never processed and no balance moves. See the kinds table for how many of each were final.
