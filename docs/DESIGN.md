# ZK EVM on Canton: the design

Rome Protocol

## What we want

Ostia, a Canton zkEVM (chain id 770101): one EVM chain whose blocks are ordered by Canton and proven by a zkVM (ZisK), so that an EVM block and the Canton actions it needs settle together in one Canton transaction. A Canton token can move onto the EVM and back, and an EVM payment can be tied to the Canton payment it stands for. Blocks are made on demand. Each builder run builds, proves and submits one block. Speed and throughput are not goals yet.

## The idea

Every EVM block becomes one Canton transaction, and only once it is proven. That transaction carries the block, its proof and the Canton actions the block asked for. Canton's confirmers check the proof. Daml checks that the block follows the chain's current head. The block and its actions commit together, or neither does.

The EVM side writes down what a block needs from Canton. One small contract, the gateway, is part of the chain from its genesis. Transactions that have a Canton side go through it, and it keeps one running hash per block of the requests they made. Each request is a leg, and there are three kinds:

- **Deposit.** A Canton token is locked with the gateway, and its wrapped form is minted on the EVM to the address that claims it.
- **Withdrawal.** The wrapped form is burnt, and the gateway releases the Canton token to a Canton party.
- **Payment.** An ERC-20 payment made through the gateway executes a Canton allocation that the payer and the payee agreed to, for that payment and no other.

The proof fixes the chain's state at the end of the block, so it fixes what the gateway wrote. `Advance` receives the legs with the proof and settles all of them, or the Canton transaction fails and the block with it. The same check serves all three kinds. Adding the gateway needed no change to the proven program: it is ordinary EVM code, and the program key is the one the first proof used.

```mermaid
flowchart LR
  W["EVM wallets"] -->|transactions| R["reth<br/>(the EVM, with the gateway)"]
  B["Builder"] -->|"1 make a block"| R
  B -->|"2 prove it"| P["Prover<br/>ZisK 1.3.1 + wrap"]
  P -->|"proof, 1,344 bytes"| B
  B -->|"3 one Canton transaction:<br/>block + proof + legs"| C["Canton"]
  C --> X["Confirmers' sidecars<br/>verify the proof,<br/>check the legs"]
  X --> D[("Daml<br/>chain record moves on,<br/>tokens are locked, released<br/>or paid")]
```

## The parts

| Part | What it does |
|---|---|
| **reth** | A stock Ethereum execution client with our own genesis, which also holds the gateway. It makes a block only when the builder asks. Peer discovery is always off. |
| **Gateway** | The EVM contract that records each block's legs and makes the wrapped tokens. It has no owner, no admin key, no upgrade and no pause. See [gateway/README.md](../gateway/README.md). |
| **Builder** | Picks the transactions, asks reth for the block, reads the block's legs and finds the Canton contracts they need, sends the block to the prover, and submits the proven block with its legs to Canton. It cannot finalize anything or change Canton's order. |
| **Prover** | ZisK 1.3.1 running our copy of its EVM program, with our chain's rules built in. It outputs a small wrapped proof (1,344 bytes) that commits to the block's hash. |
| **Daml package** | The chain's one state contract (its current head), a record per block, and the contracts for deposits, withdrawals, payments and registered tokens. See [daml/README.md](../daml/README.md). |
| **Sidecar** | A small Rust program beside each confirming participant. It does two things: `verify` checks a proof, and `legs` checks that the legs attached to a block hash to the value the proven block recorded in the gateway (an account proof and a storage proof, at the block's state root). |
| **Canton network** | A local network of our own, with a party for the gateway. |
| **Explorer** | Shows each EVM block next to its Canton record, read as the reader party, from a database of its own that an indexer fills. It serves a REST API, an Etherscan-compatible API, a live stream and an optional public RPC that shows only final blocks. Its Verify button runs the sidecar's block check in the browser through WebAssembly. Its faucet sends the test coin, tROME, through reth. See [The explorer](#the-explorer). |

## One block

1. Wallets send EVM transactions to reth as usual. A transaction that has a Canton side calls the gateway, which writes the leg and folds it into the block's running hash.
2. The builder asks reth for block n on top of the chain's current head, and reads the legs from the gateway's events.
3. For each leg the builder looks for its Canton side: a deposit needs the depositor's request and allocation, a withdrawal needs the receiver's standing acceptance, a payment needs the terms that carry its id. If a leg has none, the builder leaves out the transaction that made it, moves reth back to Canton's head and builds again. Nothing has been proven by then.
4. The prover proves block n.
5. The builder submits one Canton transaction: block n, its proof, the legs and the gateway's proofs of its state at the end of the block.
6. Each confirmer's sidecar verifies the proof. Daml checks that block n's parent is the current head, that the proof came from our program and ZisK release, and that the block is within the gas cap.
7. Daml writes one line for each leg from the Canton contracts it names, and the sidecar hashes those lines as the gateway does and compares the result with the value the proven block recorded. A block with no legs is checked in the same way, with no lines, which is how it is shown that it needed none.
8. Daml settles the legs in order: it locks the deposited token, pays the withdrawn token to its receiver, or executes the payment's allocation.
9. Canton commits everything at once: the chain record moves to block n, the block is recorded, and the legs settle. If any check fails, nothing changes; reth returns to Canton's head and the next builder run builds and proves again.

## The flows

**A deposit.** The depositor, U, allocates a Canton token to the gateway, with the operator as executor, and signs a deposit request: an id, the EVM address that may claim, and the allocation. The address sends `claim(id, token, amount)` to the gateway, which mints the wrapped token to the sender and records a deposit leg. The builder matches the leg to the request by its id. `Advance` executes the allocation, so the token is now held by the gateway. The block record and the gateway's new holding come from one Canton update.

**A withdrawal.** A holder sends `withdraw(token, amount, party)`. The gateway burns the wrapped tokens and records a withdrawal leg that names the Canton party. That party must already have signed a standing acceptance of withdrawals; if it has not, the builder leaves the transaction out. `Advance` has the gateway pay the Canton token from its custody to the party, through the token registry's own transfer factory. Again the block record and the new holding come from one update.

**A payment tied to a Canton payment.** U allocates a Canton token to V. U and V sign terms that name a payment id, the EVM token, the payee and the amount; the id is derived from U, V and a label, so only terms both signed can carry it. V approves the gateway and sends `pay(id, token, to, amount)`, which moves the ERC-20 from V to the payee and records a payment leg. `Advance` executes the allocation, and V gets the Canton token. A plain transfer of the same token, even to the same person in the same block, is not a payment: it moves the token on the EVM, but it records no leg and settles nothing on Canton. This replaces an earlier rule that settled a leg when the holder's balance rose by the expected amount in the block. That rule could not tell the payment from any other transfer of the same size.

**Why neither side can be final without the other.** A block cannot commit without every leg it recorded, and a leg cannot settle outside `Advance`. A payment made on the EVM does not become final until the Canton payment it names has been made, and the other way round.

## Why it holds

- **No proof, no block.** `Advance` verifies the proof before Canton commits the block. The builder returns reth to Canton's head after a refused submission.
- **Canton orders.** Every block consumes the chain's one state contract, so Canton alone decides which block comes next.
- **The proof fixes the rules.** Our program refuses any chain settings except its own, and every confirmer pins that program's key. A block proven under other rules is refused. The genesis state root in the chain record fixes the gateway's code, so the gateway cannot be changed.
- **The legs are the block's legs.** The attached legs must hash to the value the proven block recorded in the gateway. A leg that is missing, an extra one, a different order, or any changed field (another recipient, amount, id or token) gives another hash, and `Advance` is refused.
- **Canton legs settle only with a proven block.** Settling a leg requires the operator and the confirmer, and for a deposit or a withdrawal the gateway as well. The design provides their joint authority only inside a block's transaction. The builder cannot settle a leg. The operator and confirmer together are the root of trust because they both sign the chain record.
- **The chain can be re-checked.** A party that can read the block records, such as the reader party, can re-verify every proof. The explorer exposes that reader's view. The records last as long as Canton's databases do: the default local network keeps them in memory and loses them on restart, and a network started with `CZE_PERSIST=1` keeps them in PostgreSQL (see [network/README.md](../network/README.md)).

**Custody.** The gateway party holds the Canton tokens that are locked for their wrapped forms. It is hosted on the operator's participant, so whoever runs that participant can move the locked tokens. Under the Daml rules, they leave only inside `Advance`, for a withdrawal that the proven block recorded; but a Canton party can always act through its own participant. This is acceptable for a local proof where we run every party, and not for anything of value. Registering a token is also a trust decision, because the gateway runs that token's registry's Daml code with its own authority.

## The explorer

The explorer is three processes and one database. The server answers the pages and the APIs. The indexer is the only writer of the chain's tables. A verifier, which is off unless it is started, checks contract sources. They share a PostgreSQL that the explorer owns, apart from the one Canton uses (see [network/README.md](../network/README.md#the-explorers-database)). The explorer never submits to Canton. The only thing it sends to reth is the faucet's transfer and the transactions a wallet gives to its public RPC. [explorer/README.md](../explorer/README.md) has the routes, settings and commands.

**What it reads.** From reth, the methods on a fixed list: the server's is `eth_` reads and `trace_transaction`, for one transaction's call tree. The indexer has its own list, which adds `trace_replayBlockTransactions`. A reader asked for any other method refuses before it calls. From Canton, three calls on the JSON Ledger API of the participant that holds the reader party: the ledger end, the participant's id, and the updates after the last offset it has seen, each filtered to the reader party and the block record template (`explorer/server/ledger.ts`).

**What the reader party can see.** The reader is an observer of the block record and of nothing else in the Daml package (`BlockRecord` in `daml/src/Zk/Chain.daml`). It sees each record's number, hash, parent hash, header, transactions and proof, the update id and record time, and the two signers, the operator and the confirmer. It does not see the gateway's holdings, the deposit requests, the withdrawal acceptances or the payment terms. The explorer reads the builder's and the reader's party ids from the record and keeps neither. The local network has no login on its Ledger API, so the limit comes from what the explorer asks for, and a test holds it to that list. A participant with a login gives the explorer a user token with read-only rights on the reader party.

**Final only.** reth makes a block its head while the block is still being proven, and goes back if Canton refuses it. So the explorer calls a block final only when its record has been read from Canton. The indexer writes only blocks that have a record, so everything in the database is final. The REST and Etherscan APIs serve final data, and a balance is reth's at the newest final block. A block that is not final is shown from reth, with its status (`proving`, `unindexed` or `waiting`) and no Canton side. The public RPC ends at reth's finalized block, which is Canton's head: a receipt from it means the block is proven and final on Canton.

**The indexer.** Stage 1 takes each record the reader can read and the block and receipts from reth, runs four checks, and writes the block, proof, transactions, logs, balances, addresses and gateway legs in one database transaction with its cursor. The checks compare reth's block hash with the record's hash and the Keccak of the record's header, the order of the records and block 1 against reth's genesis, the record's transactions against reth's, and the three facts in the proof (program key, ZisK release, block hash) against the explorer's pins. A check that fails stops the indexer before it writes. It never restarts by itself, and the explorer answers 503 until a person has read the log and started it again. Stage 2 works from the block's traces behind its own cursor and writes internal calls, contracts, tokens and token transfers. A route that returns something stage 2 writes says it is not derived yet until the cursor has passed the block. The indexer also loads the builder's journal, which gives each transaction its lifecycle from accepted to final, and it runs the stats rollups and the health checks.

**The APIs.** The REST API (`/api/...`) lists blocks, transactions, addresses, contracts, tokens, legs and Canton updates, and every route is in `/api/openapi.json`. Lists page by key, newest first, 25 rows by default and 100 at most. The Etherscan-compatible API (`/api` and `/v2/api`) answers the `module` and `action` calls that Foundry, Hardhat and ethers send, in Etherscan's shape. It takes no API key. `GET /api/stream` is a server-sent-events stream of new blocks, transactions and stats. `POST /rpc` is the public RPC, on when `PUBLIC_RPC=1`. Every object the API returns carries only the fields listed in `FIELDS` in `explorer/server/rest/fields.ts`, and no party id except the two signers.

**Contract verification.** `POST /api/verify`, or `verifysourcecode` on the Etherscan door, queues a Solidity source of at most 500 KB. The verifier role takes one job at a time. It downloads the compiler named in the request and checks its SHA-256 against the compiler list, then runs it in a throwaway container with no network, a read-only filesystem, one CPU, 2 GiB of memory, 128 processes, no capabilities and a 60 s limit (`explorer/server/verifier/sandbox.ts`). The compiled code is matched against the code at the address by lib-sourcify (`@ethereum-sourcify/lib-sourcify`): a full match, a partial match where only the metadata differs, or a similar match for a contract with the same runtime code. A verified source belongs to the code at an address, not to the address.

**Rate limits and health.** Limits are per client and have no keys: 20 requests a second with bursts of 60 for the pages' REST routes and `/healthz`, 10 a second and 600 a minute for the Etherscan door, 30 verifications an hour, and `RPC_RATE_PER_MINUTE` calls a minute for `/rpc` (`explorer/server/limits.ts`). Health is a table of checks, each written by the indexer, an API instance or the verifier with its word (`ok`, `degraded` or `down`), the value seen and its threshold. `GET /api/health` lists them. A row that its writer has not refreshed within three of its intervals counts as failed, so a stopped indexer turns `/healthz` red instead of leaving its last `ok` behind. A `down` check makes `/healthz` answer 503. A `degraded` check is named and the answer stays 200.

**Stats.** The indexer rolls its facts up every 10 seconds into minute, hour and day tables (`stats_minute`, `stats_hour`, `stats_day`). A run changes nothing if repeated, and `stats-rebuild` fills them again from the facts. Times come from histograms with buckets 5% wide, so a percentile is at most 5% above the truth. A time or rate with nothing behind it is null, not a guess. `GET /api/stats/summary` and `GET /api/stats/series` serve them.

**Budgets.** Seven budgets bound what the explorer costs, each held by a test that fails when it is passed. The figures measured against them are in [METRICS.md](METRICS.md), in "The indexer on a real chain (W1)", "The API at scale (L2)" and "The nightly load test".

| Budget | Held to | Measured by |
|---|---|---|
| B1 Stage 1 of the worst-case block | At most 2,750 ms (`B1_MS`). The target on the reference machine is 1.0 s | L1 (blocks of 0 to 5,000 transactions), W1 (the costliest block the 30 Mgas cap allows, on a real chain), and L3 (index lag from the ledger to the served page under a flood of blocks) |
| B2 Both stages of that block | At most 12,750 ms (`B2_MS`) | L1, W1 |
| B3 The API, mixed load at 200 requests a second | p95 at most 100 ms for one block, transaction, address or search; 200 ms for a list page; 300 ms for an address's page of transactions; 500 ms for `getLogs` | L2 |
| B4 Live stream | A new final block reaches 2,000 clients in p95 at most 500 ms | L2 |
| B5 Page load, cold, 10 Mbit/s and 100 ms round trips | Largest contentful paint at most 2.0 s for Home, Block and Transaction; at most 200 KB of gzipped script | L4 |
| B6 Database size | At most 2.5 GB per million transactions, indexes included | L2, L3 |
| B7 `/api/health` | p97.5 at most 50 ms, and no answer other than 200 | L2 |

L1 to L5 and W1 are described in [explorer/README.md](../explorer/README.md#the-load-tests-and-the-nightly). L2 and L3 run in the nightly, not on every pull request. The W1 figures come from a CI runner, not from the reference machine, and B1 and B2 were set from W1's slowest run with 25% headroom.

## What the demo showed

On our own local Canton network, in a setup block and five runs ([demo/README.md](../demo/README.md) has them in full):

- **A deposit** of 10 TKB: U ends with 10 wTKB, and the supply of wTKB and the gateway's custody are both 10.
- **A payment** of 10 TKA from V to U against U's allocation of 10 TKB, with a plain transfer of 1 TKA in the same block that moved on the EVM and made no leg.
- **A withdrawal** of 4 wTKB: U gets 4 TKB, and the supply and the custody fall to 6.
- **A payment whose allocation is taken back after the proof was made:** Canton refuses the block and nothing moves. The same proven block sent again without its leg is refused too ("the legs are not the ones the block recorded"). The next builder run leaves the payment out and commits.
- **A tampered proof:** refused by the sidecar, and nothing moves.

These ran on a local network started for the run; Ostia does not yet run as a standing network.

## Numbers we have

The machine, the versions and every measurement, with dates and sources, are in [METRICS.md](METRICS.md).

- Proof: 6.7 s (1 transfer) to 21.2 s (5,000 transfers) on one NVIDIA RTX PRO 6000, with a prover that stays running. Measured in the prover benchmark on the upstream reth guest, not on this repository's guest; see [METRICS.md](METRICS.md).
- Proof size: 1,344 bytes. Measured.
- On this chain, in the demo (2026-10-05, one machine, commit `6b445073163832e9023850f53678617d90dfc808`): a block with no transactions was proved in 6.31 s, and the blocks of the runs in 6.71 to 6.75 s. The time from the finished proof to Canton's commit on both confirmers and reth marking the block final was 0.49 s for an empty block, 0.66 s for the deposit, 0.42 s for the payment and 0.58 s for the withdrawal. That interval also includes fetching the gateway's account and storage proofs from reth (one `eth_getProof` call), so it is more than Canton's commit alone. The builder matches the legs to Canton contracts before it proves the block, so that work is not in it. Measured; see [demo/results/](../demo/results/).
- Not yet measured on their own: building the witness on a warm machine, the sidecar's proof check run natively, and the Canton commit of a large block. The WebAssembly build took 8 to 32 ms in Node on CI runners for verifying a proof and rejecting a mismatched header; see [explorer/verify/README.md](../explorer/verify/README.md).

The recorded GPU demo ran from commit `6b445073163832e9023850f53678617d90dfc808` of this repository (6b44507). The Daml tests check the refusals of each leg kind; the GPU runs and the CI rehearsal check the cases listed in [demo/README.md](../demo/README.md#results).

## Rules

- The supplied reth launcher disables peer discovery.

## Not now

Throughput and block-time targets, more than one builder, forced inclusion, public Canton (the Global Synchronizer), privacy and hardening. Hardening includes custody that needs more than the operator's participant (for example, the gateway party hosted on both participants with a threshold), and a builder that remembers across runs which transaction a token registry refused (today the next run needs `--exclude`). The recipient of a deposit sends its own `claim` and so needs a little tROME for gas; the gateway's `claim` mints to its caller, so the recipient sends it; having the gateway mint for the recipient would need a key the gateway does not have.
