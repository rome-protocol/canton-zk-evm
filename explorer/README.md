# explorer

A block explorer and faucet for Ostia, a Canton zkEVM (chain id 770101). It shows each block next to its record on Canton, and gives out the chain's test coin, tROME.

The explorer reads two sources. reth, the chain's execution client, gives the EVM side of every block. Canton gives the block record: the explorer reads it as the reader party, a party that sees the block records and nothing else. A block is shown as final only when its record is on Canton. Until then it is shown from reth and marked as being proven. The block page's Verify button checks the proof in the visitor's browser and is greyed out while a block is being proven.

On Ostia's DevNet the explorer checks every proof under the key for its block (see [Key ranges](#key-ranges)): key A from block 0 (ZisK 1.3.1) and key B from block 15573 (ZisK 1.3.2-alpha, since 12:02 UTC on 2026-10-27). On the same day the indexer stopped after 16,384 blocks, because every block spent a new id for each row it looked up in a dictionary table, even when the row existed (two a block in the two-row party table, whose ids are a smallint). Pull request #120 looks a value up before it inserts it, restarts the four id sequences after their highest id, and adds the `db_ids` health check, which is `degraded` above 50% of an id column's range and `down` above 90%.

## The parts

| Part | Where | What it does |
|---|---|---|
| Server | `server/main.ts` (`npm start`) | One process on plain `node:http`. It serves the pages, the REST API, the Etherscan-compatible `/api`, the public RPC at `/rpc` and `/healthz`. It reads the chain from the database and reads reth for what the database does not hold |
| Indexer | `server/indexer/cli.ts` (`npm run index`) | Reads reth and Canton, checks what it reads, and writes the database. Stage 1 makes a block queryable. Stage 2 works out what needs the block's traces. It also loads the builder's journal, rolls up the stats and writes the health rows. See [The indexer](#the-indexer) |
| REST API and live updates | `server/rest/` | The routes the pages read, with keyset paging, cache headers, an OpenAPI document and a server-sent-events stream. See [The REST API](#the-rest-api) |
| Etherscan-compatible API | `server/rest/etherscan*.ts` | The `module` and `action` calls that Foundry, Hardhat and ethers send. See [The Etherscan-compatible API](#the-etherscan-compatible-api) |
| Public RPC | `server/public-rpc.ts` | JSON-RPC for wallets, cut at the finalized block. See [The public RPC](#the-public-rpc) |
| Transaction tracker | `server/tracker.ts` | Follows every accepted transaction until it is settled. See [The transaction tracker](#the-transaction-tracker) |
| Faucet | `server/faucet.ts` | Pays out tROME through a queue. See [The faucet](#the-faucet) |
| Verifier | `server/verifier/cli.ts` | A separate role that compiles submitted Solidity in a sandbox and compares it with the code on chain. Off unless started. See [Contract verification](#contract-verification) |
| Pages | `src/` | A React app built by Vite into `dist/`. See [The pages](#the-pages) |
| Verify check | `verify/`, `src/verify/` | The sidecar's block check built for WebAssembly, run in the browser. See [Verify](#verify) |
| Database | `db/migrations/`, `server/db/` | The explorer's own PostgreSQL. See [The database](#the-database) |
| Health checks | `server/health.ts`, `server/indexer/health.ts` | Rows in `health_checks` written by the indexer, each API instance and the verifier, read by `/healthz` and `/api/health` |

## Running it

The explorer runs as a container beside the chain it shows, on the same machine. It needs Docker on Linux.

The chain comes first, and it has its own prerequisites: a Linux x86-64 machine with an NVIDIA GPU, Docker, Rust, Python 3.12 or newer, `jq`, `curl` and `openssl`, and ZisK installed with `prover/install.sh`. `network/up.sh` stops when `cargo-zisk` is missing. [network/README.md](../network/README.md#running-it) has the details.

Start the chain with a genesis that funds the faucet. `setup` makes the faucet's key for this run and that genesis, and it comes before the network because reth starts from the genesis (see [The faucet](#the-faucet)):

```sh
explorer/run.sh setup
CZE_GENESIS_FILE=state/faucet/genesis.json network/up.sh
```

Run the builder once. The chain has no blocks until it does, and a faucet payout waits for the next proven block, so run it once per block, as `network/smoke.sh` does. Replace `<address>` with the address that receives the block's fees. The other builder settings are in [builder/README.md](../builder/README.md#settings):

```sh
CZE_LEDGER_USER=builder \
CZE_BUILDER_PARTY=$(sed -n 's/^BUILDER_PARTY=//p' state/canton/parties.env) \
CZE_FEE_RECIPIENT=<address> \
state/venv/bin/python3 builder/builder.py once
```

Start the explorer, then open http://127.0.0.1:8088:

```sh
explorer/run.sh start
```

`run.sh start` gives the indexer the builder's work folder (`CZE_WORK_DIR`, `<state>/builder` by default) only if the folder exists at that moment. If the explorer was started before the first builder run, run `explorer/run.sh start` again, or the block lifecycle stays blank and the health says so.

Stop it with the command below. When the state folder has no `persist.env` (a network made without `CZE_PERSIST`), `stop` also deletes the explorer's database with everything in it, including the tracker's rows, the faucet's requests and any verified contract sources. A persistent network keeps the database.

```sh
explorer/run.sh stop
```

`start` does three things before the explorer runs. It starts the database that `network/explorer-db.sh` makes for this state folder, unless that database is already up or `EXPLORER_DATABASE_URL` or `EXPLORER_DB_PASSWORD_FILE` names another. It applies the migrations. It starts the indexer as its own container, `cze-explorer-indexer`. The explorer answers 503 on `/healthz` until the indexer has started, and `/healthz` reports the indexer's checks when they go stale or fail. `run.sh` does not restart a stopped indexer: read its log (`docker logs cze-explorer-indexer`), then run `explorer/run.sh start` again. `stop` stops both containers.

`stop` removes the database for a network that is not persistent (`network/explorer-db.sh wipe`), as `network/down.sh` does, so the next chain made from the same genesis starts with an empty one and the indexer does not meet the old chain's rows. A persistent network keeps it, and `start` reads the database's container and port from `persist.env`. A database you name yourself is never removed.

The faucet's hash key is made once, as `faucet/client-key` in the state folder, when there is a faucet key and `FAUCET_CLIENT_KEY_FILE` names none. The indexer reads reth and Canton where the explorer does, or at `INDEXER_RETH_RPC_URL` and `INDEXER_LEDGER_URL` when those are set. `GATEWAY_ADDRESS` comes from `PINS`. The genesis is `<state>/genesis.json`, the one reth runs, and `GENESIS_FILE` names another. The indexer seeds the chain's contracts from the genesis at its first start, and `start` stops, naming the setting, when there is none.

`start` takes what it needs from the run's state folder (`CZE_STATE_DIR`, `./state` by default): the reader party from `canton/parties.env`, the run's own pins from `net/guest.txt` and the faucet's key from `faucet/key`. `READER_PARTY`, `PINS_FILE` and `FAUCET_KEY_FILE` set them instead. With no key the faucet is off. `run.sh` passes only some of the [settings](#settings) below on to the containers: the Settings tables name them, and the rest apply to a process started directly.

The container runs on the host's network, because the explorer reads reth and Canton on the machine's own ports, and it listens on 127.0.0.1 only. It runs as the user who starts it, with a read-only filesystem and no added rights, and it gets the pins file and the key as read-only files. This needs Docker on Linux.

`Dockerfile` has three stages. The first builds the Verify check for WebAssembly with the Rust toolchain that `rust-toolchain.toml` pins. The second builds the pages from the lockfile. The third is the server with the pages and the check's file, and nothing else: no tests and no development packages. Both base images come from `PINS` (`EXPLORER_NODE_IMAGE` and `EXPLORER_RUST_IMAGE`), by digest, and `run.sh` passes them in; the Dockerfile has no image of its own. The recorded session's pins, `prover/fixtures/session.txt`, are in the image, for a run that gives no pins file.

`tests/demo_explorer_static.sh` checks the pins, the Dockerfile and what `run.sh` gives the container, without Docker. The rehearsal in `tests/demo_rehearsal.sh` starts the explorer against the chain it runs, with no GPU. On run 1's block it checks the page (the Canton side, the update id, and that Verify says no, because the rehearsal's proof is a stand-in). It checks that the faucet sends 1 tROME, and refuses the same address a second time. And it checks from a log of the calls that the explorer and its indexer asked Canton only for the ledger end, the updates and the participant id (the updates as the reader party and for the block record alone, or, when the gateway's read is on, as the gateway party and for the registered tokens, the venue trades and the funded claims alone), and that the explorer asked reth only for `eth_`, `net_` and `web3_` methods (the indexer reads reth directly, and also asks for `trace_` methods). The page checks are in `e2e/running.test.tsx`, which runs only when `EXPLORER_URL` and `RUN1_FILE` are set.

## Settings

The server takes its settings from environment variables. A wrong value stops it at start, with a message that names the variable.

`run.sh` passes these settings to the explorer container: `EXPLORER_HOST`, `EXPLORER_PORT`, `RETH_RPC_URL`, `LEDGER_URL`, `CHAIN_NAME`, `NETWORK_NAME`, `COIN_SYMBOL`, `RPC_TIMEOUT_MS`, `POLL_MS`, `PUBLIC_RPC`, `RPC_RATE_PER_MINUTE`, `TRUSTED_IP_HEADER`, the `FAUCET_*`, `CAPTCHA_*` and `TRACKER_*` settings, and the files and database settings that it handles itself (see Running it). It passes `RPC_TIMEOUT_MS`, `INDEX_DERIVE`, `INDEX_POLL_MS`, `INDEX_RETH_BEHIND_MS` and `INDEX_TRACE_TIMEOUT_MS` to the indexer. `READ_CALL_GAS`, `EXPLORER_INSTANCE` and `INDEX_JOURNAL_MS` are not passed on: they take effect only when the process is started directly, as under "To run the server directly" in [The faucet](#the-faucet).

| Variable | Default | What it is |
|---|---|---|
| `EXPLORER_HOST`, `EXPLORER_PORT` | `127.0.0.1`, `8088` | Where the explorer listens |
| `RETH_RPC_URL` | `http://127.0.0.1:8545` | The chain's reth HTTP RPC |
| `LEDGER_URL` | `http://127.0.0.1:7577` | The JSON Ledger API of the participant that holds the reader party |
| `LEDGER_TOKEN_FILE` | none | A file with the bearer token (a JWT) for a participant whose Ledger API needs a login, such as an existing participant on the Canton Network's DevNet. Mode 0600 or the server refuses it (and sends nothing); it is read again on every Ledger API call, so a refreshed file is picked up with no restart; its value is never logged or put in an error. The indexer reads the same setting. With no file, no `Authorization` header is sent, as before. `run.sh` mounts the file read-only, and takes `CZE_TOKEN_FILE_READER` (the `ostia-reader` user's file, see `network/README.md`) when `LEDGER_TOKEN_FILE` is not set |
| `READER_PARTY` | none, required | Canton's id for the reader party. The server stops at start, naming it, when it is not set |
| `PINS_FILE` | `prover/fixtures/session.txt` | A file of `key=value` lines with `programVK` and `rootC`: the proving program and ZisK release this explorer expects (`zisk` names the release itself, see [Key ranges](#key-ranges)). A run's `state/net/guest.txt` has the same form. A chain that has switched program adds a key for each switch, see [Key ranges](#key-ranges) |
| `CHAIN_ID`, `CHAIN_NAME`, `COIN_SYMBOL` | `770101`, `Ostia`, `tROME` | How the chain and its native coin are named on every page |
| `NETWORK_NAME` | not set | The Canton network the chain runs on, as the header's pill names it (`DevNet`). When it is not set, no network is named and the "test coin" line is not shown |
| `RPC_TIMEOUT_MS`, `POLL_MS` | `5000`, `2000` | How long one call to reth may take, and how often the transaction tracker looks at the transactions it holds |
| `READ_CALL_GAS` | `100000` | The gas limit of every `eth_call` the indexer makes (a token's name, symbol, decimals, total supply and balances, and the proxy reads), so a contract that spends all the gas it gets costs a short read and not a long one; a low limit also bounds the memory reth builds for the answer (memory expansion costs gas), and honest reads cost a few thousand gas, tens of thousands behind a proxy. An answer longer than 4 KB of data is dropped before it is decoded, and counts as not answered too. A call that runs out of gas counts as not answered: the token's metadata is `failed`, a balance is `unanswered`, and the block goes on |
| `PUBLIC_RPC` | `0` | Set to `1` to serve the public RPC at `POST /rpc`. See [The public RPC](#the-public-rpc). The Etherscan API's `proxy` module and the Contract page's Read calls use `/rpc` and need it |
| `RPC_RATE_PER_MINUTE` | `300` | Calls per client address per minute on `/rpc`. A batch counts each of its calls |
| `RPC_HEAVY_CONCURRENCY`, `RPC_HEAVY_QUEUE` | `8`, `16` | The global limit on heavy `/rpc` calls (all clients together): how many run at once, and how many may wait for a free place. Their sum may be at most 32, or the explorer refuses to start: every running or waiting heavy call holds one of the 64 request places, and the other half is kept for light calls. See [The global cap on heavy calls](#the-global-cap-on-heavy-calls) |
| `TRUSTED_IP_HEADER` | none | The request header that holds the client's address, such as `X-Real-IP`, for a server that sits behind a proxy that writes it. With none, the address of the connection is used |
| `EXPLORER_DATABASE_URL`, or `EXPLORER_DB_PASSWORD_FILE` with its parts | none, and the explorer does not start without it | The explorer's database (see [The database](#the-database)). It holds the chain the indexer writes, which the block and transaction pages read. The tracker and the faucet keep their state in it instead of in their files, only one API instance runs each loop, and `TRACKER_FILE` and `FAUCET_STATE_FILE` are imported once and renamed to `<file>.imported` |
| `TRACKER_FILE` | none | A file in which an earlier version kept the tracker's list. The tracker now keeps its list in the database. If the file exists at start, its entries are imported once and the file is renamed to `<file>.imported`. `run.sh` mounts a writable folder and sets `/var/lib/explorer/tracker.json` |
| `TRACKER_MAX`, `TRACKER_MAX_BYTES`, `TRACKER_PER_SENDER`, `TRACKER_MAX_PENDING_MINUTES` | `10000`, `16777216`, `64`, `60` | The most entries the tracker holds, the most characters of signed transactions it holds for open entries, the most open entries one sender may have, and how many minutes an open entry may stay without a block before it is dropped. See [The transaction tracker](#the-transaction-tracker) |
| `FAUCET_KEY_FILE` | none | The faucet's key. With none, the faucet is off |
| `FAUCET_CLIENT_KEY_FILE` | none | Required with a database and a faucet: 64 hex digits in a file that only its owner can read (`chmod 600`). Client addresses are stored only as an HMAC-SHA-256 of the address (an IPv6 client by its /64) made with this key. The key never goes in the database. Lose it and clients' per-address limits start over |
| `FAUCET_AMOUNT` | `1` | Coins given per request |
| `FAUCET_PER_ADDRESS_SECONDS`, `FAUCET_PER_IP_SECONDS` | `86400`, `600` | One request per address per day, and one per client address (see `TRUSTED_IP_HEADER`) per 10 minutes |
| `FAUCET_MAX_PER_HOUR` | `5000` | The most requests the faucet accepts in any hour, from everyone |
| `FAUCET_BATCH`, `FAUCET_QUEUE_MAX` | `100`, `5000` | The most transfers sent in one batch, and the most requests waiting for a batch. Past the second the faucet answers 503 |
| `FAUCET_STATE_FILE` | none | A file in which an earlier version kept the faucet's limits and waiting requests. The faucet now keeps them in the database. If the file exists at start and a faucet key is set, its requests are imported once, their client addresses as keyed hashes, and the file is renamed to `<file>.imported`. `run.sh` sets `/var/lib/explorer/faucet.json` |
| `CAPTCHA_SECRET` | none | Turns on the human check. With it set, the four settings below are required. With none, there is no check |
| `CAPTCHA_VERIFY_URL`, `CAPTCHA_SCRIPT_URL`, `CAPTCHA_SITE_KEY`, `CAPTCHA_WIDGET_CLASS` | none | Where the explorer verifies a token, the script the page loads, the site key it gives that script, and the class name the script looks for to put its widget in |
| `EXPLORER_INSTANCE` | the host's name | The name under which an API instance writes its health rows (`api/<instance>/reth` and `api/<instance>/canton`). Set it when several instances share one database |

The indexer reads the settings above that it shares with the server (`RETH_RPC_URL`, `RPC_TIMEOUT_MS`, `LEDGER_URL`, `LEDGER_TOKEN_FILE`, `READER_PARTY`, `CHAIN_ID`, `PINS_FILE`, `READ_CALL_GAS` and the database) and these of its own. A wrong value stops it at start, with a message that names the variable.

| Variable | Default | What it is |
|---|---|---|
| `GATEWAY_ADDRESS` | none, required | The gateway contract's address, 0x and 40 hex digits. `run.sh` takes it from `PINS` |
| `GENESIS_FILE` | none, required by `run` | The genesis that reth runs. The indexer seeds the chain's contracts from it at its first start. `run.sh` passes `<state>/genesis.json` |
| `INDEX_DERIVE` | `behind` | `behind` commits stage 2 on its own, so it may fall behind stage 1. `inline` commits it in the same transaction as stage 1 |
| `INDEX_POLL_MS` | `250` | How often the indexer looks for a new record (at least 20) |
| `INDEX_RETH_BEHIND_MS` | `10000` | How long reth may lack a block that a record names before the health says so |
| `INDEX_TRACE_TIMEOUT_MS` | `60000` | How long one `trace_` call to reth may take (at least 1000) |
| `JOURNAL_DIR`, `PRODUCER_STATUS_FILE` | none | The builder's `journal/` folder and its `status.json`, read only. Without them the blocks are still indexed, the lifecycle stays blank and the health says so |
| `INDEX_JOURNAL_MS` | `1000` | How often the journal is read (at least 100) |
| `GATEWAY_PARTY`, `GATEWAY_LEDGER_TOKEN_FILE` | none | Turn on the custody check ([above](#the-custody-check)): the gateway's Canton party, and a 0600 file with a bearer token for a user that can only read as it. Both or neither. `run.sh` mounts the file read-only for the indexer only |
| `CUSTODY_MS` | `30000` | How often the custody is read (at least 1000) |
| `CUSTODY_LIMIT` | `200` | How many contracts the custody read asks Canton for. Keep it at or below the participant's list maximum (Canton's default is 200) and above the number of the gateway's contracts (one GatewayToken per token and one holding per deposit, until they are merged): a list as long as the limit may have been cut, and is refused; Canton 3.6.3 answers 413 for a list past its own maximum, so a limit above it fails closed |

## What it reads from reth

Three fixed lists of methods reach reth, and each reader refuses any method that is not on its list before it makes a call.

- `ALLOWED_METHODS` in `server/reth.ts` is the server's own list: `eth_` reads, `eth_sendRawTransaction` and the fee reads for the faucet, and `trace_transaction` for one transaction's call tree.
- `PUBLIC_METHODS` in `server/public-rpc.ts` is the list for `/rpc`, 20 methods. It includes `net_version`, `web3_clientVersion`, `eth_syncing`, `eth_estimateGas`, `eth_feeHistory` and `eth_getLogs`, which are not on the server's own list. `/rpc` exists only with `PUBLIC_RPC=1`.
- `FINAL_READ_METHODS` in `server/indexer/reads.ts` is the indexer's list: `eth_getBlockByNumber`, `eth_getBlockReceipts`, `trace_replayBlockTransactions` and the reads of state and code.

reth's HTTP port serves `eth`, `net`, `web3` and `trace` (`network/reth/launch.sh`), and no `txpool`, so the explorer cannot list the pool of waiting transactions. It never uses the builder's WebSocket port or the Engine port, and it never starts a node.

## What it reads from Canton

Three calls on the JSON Ledger API of the participant that holds the reader party, and no others (`server/ledger.ts`; the custody check below is a second client with two calls of its own): `GET /v2/state/ledger-end`, `GET /v2/parties/participant-id`, and `POST /v2/updates` for the transactions after the last offset the reader has seen. Every request names only the reader party and the block record template, and asks for the ACS delta. For each block record the explorer keeps the update id, the record time and the record's fields: number, hash, parent hash, header, transactions and proof, and the party ids of the two signers, the chain's operator and confirmer. It reads the builder's and the reader's party ids too, and keeps neither. The reader refuses any call that is not on its list, before it makes it, and that list does not have the custody check's contracts call: each client reads with its own party's rights only.

### The custody check

When `GATEWAY_PARTY` and `GATEWAY_LEDGER_TOKEN_FILE` are both set, the indexer reads the gateway's custody with a second Ledger API client, which makes two calls, `POST /v2/state/active-contracts` and `POST /v2/updates` (for [the Canton side of the swaps](#the-canton-side-of-the-swaps)), as the gateway party and with a token of its own (a Ledger API user whose only right is `CanReadAs` on that party; the explorer's reader token is never used for it, and the reader's client refuses the contracts call, as the custody client refuses the ledger end, the participant's id and the block records, which only the reader's client reads). The gateway party must be hosted on the participant at `LEDGER_URL`, the one the reader reads: the offset the custody is read at is that participant's. That holds on DevNet, where the gateway and the reader are on Rome's participant; the local network keeps the gateway on the operator's participant and the reader on the users participant, so the check is off in the rehearsal (it also has no login to read with).

The custody and the wrapped supply are read at the same block. Each read takes the newest indexed block B and the ledger offset of its Canton record (only if that record is on the participant now read, the one at `LEDGER_URL`; offsets are local to a participant), reads the active contracts as the gateway at that offset (a block's record and its legs are one Canton update, so that is the custody after exactly the legs up to B), and reads each registered token's `totalSupply()` from reth at B. One request asks for two things only: the gateway's registered tokens (its `GatewayToken` contracts) and the token standard's `Holding` interface views. A holding counts only where it is owned by the gateway and the instrument's admin signed it (a template of anyone else's cannot claim the registry). For each registered token the indexer keeps the instrument (admin and id), the sum of the gateway's holdings of that instrument in base units of 10 decimals (locked holdings included), the number of holdings, the supply at B (null if the token did not answer) with B, and the ledger offset and time of the read, in one table (`gateway_tokens`), replaced as a whole by each read every `CUSTODY_MS`. No holding, owner or contract id is kept: the Daml side of each leg stays private, and only the total is public, as the proof that the wrapped supply is backed. A read that fails, or that fills its limit (`CUSTODY_LIMIT`, so a total might be short), writes nothing, is logged once, and leaves the last rows with the time they were read at. With no block indexed yet, nothing is read. After a reader move (`reader-moved`), or with `LEDGER_URL` pointed at another participant, the newest block is still the older participant's, so nothing is read and the last rows stay until the new participant has indexed a block.

`GET /api/tokens/{address}` answers `canton` for a registered token: the instrument, `custody` (with `custodyDecimals`), `holdings`, `supply` and `supplyBlock` (the block both numbers were read at), `ledgerOffset` and `readAt`; for any other token it is null. On DevNet the read has been on since 12:27 UTC on 2026-10-25; at 12:52 UTC that day wTKB read a custody of 12 TKB (`120000000000` at 10 decimals, two holdings) against a supply of 12 wTKB. The token page shows it as "Backed on Canton", the custody next to the supply stored with it, and says by how much the two differ at that block when they do; it never sets the custody against the token's live supply, so a deposit that lands between two reads is in both numbers or neither, and never shows as a difference. A token anyone made through the gateway's public register that has no `GatewayToken` on Canton has no such card. `/api/legs` and `/api/legs/{id}` carry `party`, the Canton party a withdrawal paid (the gateway's Leg event names it, so it was already public), and null on the other kinds; the leg page shows it as the Canton receiver. With no token registered, or before the first custody read, the table is empty, `canton` is null and the token page has no such card; if the read is turned off later, the last rows stay, with the time they were read. With the two settings left out, the explorer makes only the three calls above, as before. The rehearsal (`tests/demo_rehearsal.sh`) names these calls among the ones it allows, and checks that the contracts call and the gateway's updates call are for the gateway party alone and for the registered tokens, the venue trades and the funded claims alone.

### The Canton side of the swaps

With the same two settings the indexer also reads what the gateway party sees of a swap on Canton (Daml 0.4.0): the registered tokens (`GatewayToken`), a venue's trades (`VenueTrade`) and the funded claims that settling a trade leaves (`FundedClaim`). The call is `POST /v2/updates` as the gateway party, filtered to those three templates, for this chain's contracts only (the party sees the contracts of every chain it serves, and the others are dropped), from the cursor (`canton_venue_cursor`, with the participant it belongs to) up to the Canton record of the newest indexed block, after each custody read. A trade is offered before its payment is in a block, and the block's own Canton update creates the claim, so everything a leg of an indexed block can be matched to is at or below that offset. What is kept is what the EVM side knows: for a trade (`canton_venue_trades`) the payment's id, its claim's id, token, payee, the buyer's EVM address, the ERC-20 amount, the Canton update that offered it and, once found, the payment leg that settled it (`payment_block`, `payment_leg_index`); for a claim (`canton_funded_claims`) the claim's id, the buyer's address, the Canton amount in base units of 10 decimals and the Canton update that created it; for each registered token (`canton_gateway_tokens`) its contract id, the EVM token and the instrument. The venue's and the seller's Canton parties are named in a trade and are read and dropped: no table holds them and nothing made from this read serves them (a withdrawal's party, which the gateway's Leg event names on the EVM, is the separate, public field above), and a page that has to say who is on the other side says "a Canton party". A page that fails is not written and the read goes on from the cursor the next time; a trade or claim that cannot be read (a field that is not what the contract says) fails the read and is logged once. `GET /api/blocks/{id}` and `GET /api/txs/{hash}` (and `/api/block/{id}`, `/api/tx/{hash}`) carry `legs`: the gateway legs of the block or the transaction (the first 50 of either), each with its transaction and the block's Canton update id, and, for a payment that settled a venue's trade or a deposit that redeemed its funded claim, `canton` (`role` `venue-trade` or `funded-claim`, the Canton side's `amount` and `instrument`, the update that settled it, the EVM address that claims); null on any other leg, and `amount` null until the claim has been read (the instrument is the registered token's, from the trade, until then). A leg is matched on its terms, as described below. A swap is a payment leg that a venue's trade is behind; a payment that none is behind is only a leg; the swaps list reads the trades by the recorded payment, so a page costs its own rows. A block's answer carries the first 50 of its legs next to `legsCount` (a transaction's answer the first 50 of the legs it caused); `GET /api/blocks/{id}/legs` pages through all of them with the same `canton`. The `offer` of a swap is the Canton update that offered the trade.

A leg is matched the way the builder matches a request, on its terms and not by its id alone (`server/indexer/leg-canton.ts`). A payment (kind 3) settles a trade when it carries the trade's payment id and pays the trade's token, to its payee, for its amount; the venue read records the first such leg on the trade (`payment_block`, `payment_leg_index`), looking in the blocks indexed since its last match (`matched_block` in the cursor) and at the trades it has just written. The gateway spends a payment id once, so a trade a payment has settled is kept: a later offer under the same id does not replace it, while an offer under an id no payment has settled replaces the earlier one. The trade's claim follows from the payment. A deposit (kind 1) redeems the claim of its id only when it is for the claim's recipient, for its amount and in its registered token (any party can sign a deposit under a claim's id, and one for somebody else is a plain deposit); where several claims share an id, the newest one counts, and once a claim is read its recipient is the one served. A matched leg carries the Canton side's amount and instrument (from the claim and the registered token), the buyer's EVM address, and the Canton update that settled the trade, besides its own transaction hash, block and the Canton update of the block. A withdrawal, and a payment or deposit with no Canton trade or claim behind it, has none.

`READER_PARTY` must be set. The local network runs without Ledger API authentication, so it is this code, and its test of what it asks for, that keeps the explorer to the reader party's view. The reader party shares the users participant with other parties, and without Ledger API authentication anyone who can reach that participant can read all of them. Do not give the explorer a public address before that changes. A participant that has a login (an existing participant, `LEDGER_TOKEN_FILE` above) is read with the reader user's token, which can read only what that user's rights allow: set it up with read-only rights on the reader party, as `network/external/setup.py` does for `ostia-reader`. Tokens there last minutes, so write each new one into the same 0600 file, in place.

## What a proof says

`server/proof.ts` reads three facts from the bytes of a block's proof: the program key, the ZisK release and the block hash its public values commit to. It compares the program key and the ZisK release with this explorer's pins, and the block hash with the hash of the block the record is for. Reading a value is not verifying the proof. Canton's confirmers verified it when the block committed, and the Verify button runs that check again, in the visitor's browser (see below).

### Key ranges

A chain that switches program (a Daml `SetProgram`, or a protocol upgrade such as Osaka at a block) has several program keys over its life. A key is the pair `programVK` and `rootC`, and both change with a new guest. The pins file lists the keys with the block each one starts at, and the explorer checks every block's proof under the key for that block's height: a block uses the last key that starts at or before its number. A proof made under another key's pair is not ok, even though that pair is valid for other blocks.

The pins file keeps its form. The `programVK=` and `rootC=` lines are the key from block 0, so a chain that never switched needs no change. Each later key is a pair of lines with the block it starts at after an `@`:

```
programVK=0x<64 hex digits>
rootC=0x<64 hex digits>
programVK@1500=0x<64 hex digits>
rootC@1500=0x<64 hex digits>
programVK@4200=0x<64 hex digits>
rootC@4200=0x<64 hex digits>
```

Each key also names its ZisK release, which picks the verifying key a proof is checked under: `zisk=1.3.1` for the key from block 0 and `zisk@<block>=1.3.2` for a later one (`1.3.1` or `1.3.2`; a trailing `-alpha`, as in ZisK's own tags, is allowed). A key that names none is on ZisK 1.3.1, so a file from before releases were named reads as it always did. For a chain that moves from 1.3.1 to 1.3.2 at block 1500:

```
zisk=1.3.1
programVK=0x<64 hex digits>
rootC=0x<64 hex digits>
zisk@1500=1.3.2
programVK@1500=0x<64 hex digits>
rootC@1500=0x<64 hex digits>
```

The recorded session's file, `prover/fixtures/session.txt`, has `zisk=1.3.2-alpha`, so it is a chain on 1.3.2 from block 0. The explorer refuses to start for a `zisk` value that is not a release it knows, or a `zisk` line given twice.

This chain used the first key for blocks 0 to 1499, the second for blocks 1500 to 4199 and the third from block 4200 on. The ranges come in increasing order of block, and the last one is the current key. The explorer refuses to start (a `ConfigError` that names the line) when a later key has only one of the two lines, a block number is not a whole number above 0, a block number is repeated or does not come after the one before it, a line is given twice, or a value is not `0x` and 64 hex digits.

After a switch, point `PINS_FILE` at a key-range file of its own, whose base lines are the key from block 0. Do not use the run's `state/net/guest.txt` for it: `run.sh` mounts that file by default, but the network scripts (`up.sh`, `restart.sh`) read its `programVK=` line as the key of the guest the sidecars run now. Changing that line to the new key would make the explorer treat the new key as the key from block 0, and the indexer would stop on the pins check.

`/api/status` keeps `pins.programVK`, `pins.rootC` and `pins.file` as the current key, the last range, and adds `pins.keys`, a list of `{ fromBlock, programVK, rootC, zisk }` in order, the first with `fromBlock` 0. The server's check (C7, `/api/block`, the transaction pages) uses the key for the block's height. The block page shows the key the block was checked under in the proof's card (short, with the whole value on hover and a copy button) and the block it starts at. The block page's "ZisK release" row names the release of the block's range (`ZisK 1.3.1` or `ZisK 1.3.2`). The Verify check in the browser is handed the pins and the release for the block's height by the page, and checks the proof under that release's key; the WebAssembly module takes the one pair of pins and a byte for the release.

## Final blocks, from the database

The block and transaction pages read the final blocks from the tables the indexer fills (`server/chain-db.ts`; the tables are in [The database](#the-database)). The server holds no copy of the chain in memory, and it does not walk Canton: the indexer does that, with its checks (reth's hash against the record's hash and the Keccak of its header, block 1 against reth's genesis, the records in order). The server only reads what the indexer wrote.

A block that the indexer has not written yet is shown from reth, with no Canton side. At or below reth's `finalized` block it is `unindexed` (final on Canton, and the page says it is not indexed yet; a transaction in it is `unindexed` too); above it, it is `proving`. The status says `starting` until the indexer has written its first record, goes red with the text of each failed check the indexer keeps, and goes red naming the database when it cannot be read. A check the indexer refreshes every 2 s (C4, C5, `derive_lag`, C10) that has not been looked at for three rounds (6 s) counts as failed ("C5: the indexer has not checked in N s"), so a stopped or crashed indexer turns the status and `/healthz` red instead of leaving its last `ok` rows behind. One of them with no row at all counts as failed too ("C5: the indexer has not checked yet"), as after a rebuild from a records export, or in the first seconds of a new indexer. The home page does not name a block as being proven when reth's `finalized` block already covers it. The routes answer 502 for a database that cannot be read.

The explorer needs the database. Without `EXPLORER_DATABASE_URL` (or `EXPLORER_DB_PASSWORD_FILE` with its parts) `npm start` refuses to start and says so.

## The indexer

The indexer is the only writer of the chain's tables. It never restarts by itself: a check that stops it leaves it stopped, and the explorer answers 503 until a person has read the log and started it again. `node server/indexer/cli.ts` with no command runs it. The same file takes these commands, each of which exits when it is done:

| Command | What it does |
|---|---|
| `reindex <from> [<to>]` | Writes the stage 1 tables again for a range of blocks, from the stored records and reth |
| `reindex --records <file>` | Builds a fresh database from a records export and reth |
| `export-records <file>` | Writes every stored block record to a file |
| `stats-rebuild` | Rolls the stats up again from the facts. See [Stats](#stats) |
| `reset --yes`, `reader-moved <participant id>`, `clear-check C10` | See [A new chain, and a moved reader](#a-new-chain-and-a-moved-reader) |

**Stage 1** makes a block queryable. For each record the reader party can read, it takes the block and its receipts from reth, and writes the block and its proof, the Canton update, the transactions, logs, balance history, addresses and gateway legs in one database transaction together with the reader's cursor (`server/indexer/stage1.ts`). A block that is already there is skipped whole. Four checks run first, and one that fails stops the indexer before anything is written:

| Check | What it compares |
|---|---|
| C1 | reth's hash for the block, the record's hash and the Keccak of the record's header |
| C2 | The records come in order, and block 1 follows reth's genesis |
| C3 | The record's transaction list against reth's transactions, in order, each with its receipt, and then the block's counts against the rows written |
| C7 | The program key and the ZisK release in the proof against this explorer's pins for the block's height (the key range the block falls in). The block hash the proof commits to is recorded (`proofs.matches_block`) and shown on the block page. It does not stop the indexer: C1 is the check that stops a wrong block |

**Stage 2** processes the block's traces (`server/indexer/stage2.ts`) to populate the internal calls, contracts, tokens and token transfers. It writes `tx_traces` (the call count of a transaction and the decoded revert data of a failed one), `internal_calls` (calls that move value, creations and self-destructs), and the contracts, bytecodes, proxies, tokens and token transfers the block made. It runs behind its own cursor (`cursors.stream = 'derive'`). A route that returns something stage 2 writes says it is not derived yet (`derived: false`, with nulls or an empty list) until the cursor has passed the block, and the pages show that.

Each commit sends a `NOTIFY` inside its own transaction, so a listener hears it only for a transaction that committed. The server listens and passes the events to the clients of `GET /api/stream`.

The indexer reads reth with the methods in `FINAL_READ_METHODS` (`eth_` and `trace_`) and Canton with the Ledger API calls listed in [What it reads from Canton](#what-it-reads-from-canton). Every `eth_call` it makes runs with `READ_CALL_GAS`.

The indexer's other work:

- the builder's journal, loaded into the lifecycle tables (see [The lifecycle](#the-lifecycle));
- the stats rollups, run every 10 seconds (see [Stats](#stats));
- the health rows (see [A new chain, and a moved reader](#a-new-chain-and-a-moved-reader) for the checks and their statuses).

## The server and its API

`npm start` runs `server/main.ts`: one process on plain `node:http`. It serves the pages from `dist/` (set `EXPLORER_DIST` to use another folder), gives the home page for any route the pages own, and answers `/api/*`. It reads the final blocks from the database, and reads reth for what the database does not hold: a block still being proven, a transaction waiting in the pool, an address.

| Route | Answer |
|---|---|
| `GET /api/status` and `GET /healthz` | The same answer. The status code is 200 when reth and Canton can be read and the indexer has started and none of its checks is `down` or has stopped being refreshed, and 503 when not. A `degraded` check (the producer's rows with no journal or status file, a failed proof, C8) is named in `problems` and `ok` is false, but the answer stays 200: only a `down` check turns the load balancer's health check red (`db_ids` is one, above 90%). It names the chain, its coin, the pins, the newest final block, the newest ten final blocks (`latest`, newest first, for the home page's list), the block being proven if there is one, and the two signers of the block records |
| `GET /api/health` | Every row of `health_checks` with its status, the value seen, its threshold, `sinceSeconds` (since the status last changed) and `refreshedAt` (when its writer last looked). The overall `status` is `ok` only when every check is; `degraded` (still 200) when something not needed for final data fails; `down` (503) when final data is stale or wrong, reth, Canton or the database cannot be read, the indexer has not started, or an id column has used more than 90% of its range (`db_ids`). A row its writer has not refreshed within three of its intervals is `stale` and counts as failed, so a stopped role cannot leave an old `ok` behind; a quiet chain, where no block is normal, is `ok`. |
| `GET /api/block/:number-or-hash` | The block's EVM side, and its Canton side when it is final: update id, record time, proof facts, whether the three hashes match, and the record's proof, header and transactions as hex. Its status is `final`, `proving`, `unindexed` (final on Canton, not yet written by the indexer) or `genesis` |
| `GET /api/tx/:hash` | The transaction, its receipt, the decoded ERC-20 `transfer` if it is one, and its status: `final`, `proving`, `unindexed` (its block is final on Canton, and the indexer has not written it yet) or `waiting` (in reth's pool, in no block yet). It also carries `state` (`pending`, `proving`, `final`, `replaced`, `dropped`) and `reason`, a plain sentence or null, from the [transaction tracker](#the-transaction-tracker). A transaction that reth no longer holds, but that this chain accepted, still answers with its state instead of 404. A hash that neither reth nor the tracker knows is 404. `lifecycle` is where the transaction has been, from the producer's journal and the API: its state, when it was accepted (and through what), included in a block, proving started and ended, submitted, committed on Canton and final, the number of attempts that held it, the reason it was last left out of a block, and the time to final; its fields are null for a stage that has no time, and the whole of it is null when no row is kept for the transaction |
| `GET /api/in-flight` | The block attempts that are not final yet: cut, built, proving, proved, submitted, or committed on Canton and not indexed yet, with their times, and reth's pool count from the producer's latest sample, and the newest transactions that are not final yet (`transactions`: hash, stage `waiting` or `proving`, and since when). It says `final: false`: nothing here is a fact of the chain until its block is final. It is empty when there is no journal |
| `GET /api/address/:address` | Balance (reth's at its newest block, which can be one that is still being proven), count of sent transactions, whether it is an account, a contract or a token, and the transaction that created it, if a block the database holds did. The address page's richer answer is `/api/addresses/{address}` in [The REST API](#the-rest-api) |
| `GET /api/search?q=` | The page to open for what was typed (a block number, a block or transaction hash, an address or a Canton update id) in `path`, with `matches` empty, or 404. Where the text is the start of a token's name or symbol, or of a verified contract's name, `path` is the first match's page and `matches` lists up to 10, each with its kind, name, symbol, address and path |
| `GET /api/faucet` | Whether the faucet is on, its address, its balance and `balanceBlock` (the final head the balance is read at; null when reth cannot name it, and then the balance is the newest block's), what it gives per request, how long an address and a network address wait between requests, the hourly cap, `queue` (requests waiting), `batch` (the most payouts in one block), `sentToday` (payouts sent since 00:00 UTC), `finalToday` (of those, the final ones) and `beingProven` (payouts in a block being proven now). The last three are null where the faucet keeps no send times, as with a state file |
| `POST /api/faucet` | Takes a request for coin: the address in the body, `{"address": "0x…"}`, and the human check's token as `captcha` when the faucet asks for one. Answers 202 with a ticket. See [The faucet](#the-faucet) |
| `GET /api/faucet/ticket/<id>` | Where a request is: queued (with its place in line), sent (with the transaction hash and the tracker's state), final (with the block), or failed (with the reason) |
| `POST /api/verify` | Queues a contract's source for [verification](#contract-verification); answers 202 with a `guid`, 400 for a body that is wrong, 413 for a source over 500 KB, 429 over the client's hourly limit, and 503 when the verifier role is not running. Registered only where the explorer has a database |
| `GET /api/verify/<guid>` | `guid`, `status` (`pending`, `running`, `pass`, `fail`, `already`) and `result`, a sentence (`Pending in queue` until the job ends); 404 for a GUID that is not known. Never cached |

Amounts are whole numbers as decimal strings, in the coin's smallest unit. Each answer, and each object inside it, carries exactly the fields listed in `FIELDS` in `server/rest/fields.ts`, built one field at a time; the field test gives the server objects with extra fields and checks that none gets through. No raw Canton answer reaches the API, and no party id except the two signers of the block records. A request target that is not a path is a 400, and a route that does not exist is a 404. A failed read of reth or Canton is a 502 with a plain message, and the detail goes to the server's log.

### The REST API

The routes above are the first ones. The pages read these too, and every one of them is in `/api/openapi.json` with its parameters and the fields it answers with (the API page of the explorer, `/docs/api`, is drawn from the same document).

| Routes | What they list |
|---|---|
| `/api/blocks`, `/api/blocks/{id}`, `/api/blocks/{id}/transactions`, `/api/blocks/{id}/legs`, `/api/blocks/{id}/record` | Blocks (`filter=transactions` or `empty`, and `format=csv` for the newest ones as a file), one block, its transactions, its gateway legs, and the record's proof, header and transactions as hex |
| `/api/txs`, `/api/txs/{hash}`, `/api/txs/{hash}/logs`, `/api/txs/{hash}/internal`, `/api/txs/{hash}/token-transfers`, `/api/txs/{hash}/trace` | Transactions (newest first, or oldest first with `order=asc`; `filter=failed` or `calls`; `format=csv` for the newest as a file), one transaction, and what stage 2 worked out for it. `raw=1` on one transaction returns reth's receipt, on its logs the logs without the `decoded` field, and on its trace the frame inputs whole instead of cut. On its internal calls and token transfers it changes only how the answer is cached; the rows are the ones stage 2 derived. Every transaction in a list, a block or an address carries `tokenMoves`: how many token moves its logs hold (`count`, at most 100, with `more` true past that) and the first, with the token's `decimals`; it is null for a block stage 2 has not reached. Every transaction in a list also carries `updateId`, the Canton update that settled its block, and `recordTime`, the time Canton recorded it; `/canton/<updateId>` on the site opens that update. The unfiltered `/api/txs` also carries `total`, the chain's transactions since its first block, exact through the newest final block (`totalAsOfBlock`, `totalAsOf`), read from the rollups and never counted over the transactions; it is null when the rollups cannot say and for a filtered list |
| `/api/addresses`, `/api/addresses/{address}`, and under it `/txs`, `/internal`, `/token-transfers`, `/contracts`, `/tokens`, `/coin-history` | Addresses (by balance or by transactions) and what one address did and holds. The address carries its sent, received, internal and token-transfer counts, the block and time it first appeared and was last active, `createdCount` (the contracts it made, counted up to 100,000, with `createdCountCapped`), `erc20TransferCount` and `nftTransferCount` (each transfer once, counted up to 10,000 and null past that; while `derived` is false the counts cover only the blocks derived so far, so they are exact once `derived` is true) and `fundedBy` (the first successful transaction that sent it value, only when that is in the block the address first appeared in; otherwise null). `/txs` takes `direction` (`all`, `sent` or `received`) and `format=csv` (the newest up to 1,000, with a `direction` column). `/token-transfers` takes `token`, a `standard` filter (ERC-20, ERC-721, ERC-1155, or `nft` for ERC-721 and ERC-1155 together) and `format=csv` (columns tx_hash, block, log_index, batch_index, time, method_id, creation, token, standard, from, to, amount, token_id; `creation` is true when the transaction made a contract). `/contracts` lists the contracts the address made, newest first, and `/tokens` what it holds, with each token's supply and decimals. The balance is reth's at the newest final block |
| `/api/labels?addresses=` | The name of each address asked, 1 to 100 lowercase addresses joined by commas, in the order asked and each once: name and symbol (a token's, else a verified contract's name), kind (`token`, `contract` or `account`), the token's standard and decimals, and whether the source is verified. An address the index knows nothing of has a null kind and no name. The pages use it to show a token or a contract by name |
| `/api/contracts`, `/api/contracts/{address}`, and under it `/source` and `/events` | Contracts (`sort` by `interactions`, `newest` or `oldest`; `verified=true` or `false`; `order=asc` with `after` for the other end), and `total` and `counts` (all, verified, not verified) beside the page. A contract in a list carries `createdAt` and `compilerVersion` (null while unverified). One contract has its code, proxy and verification (`method` says how the source came in, `etherscan` or `api`, and `tool` what sent it), and `eventCount` (counted up to 100,000, with `eventCountCapped`). `/source` is the verified source and ABI. `/events` is the logs it wrote, newest first, each with its block's time, its transaction, the method id and `creation`; `topic0` keeps one event |
| `/api/tokens`, `/api/tokens/{address}`, and under it `/holders` and `/transfers`; `/api/token-transfers` | Tokens (`standard` filter, `gateway=true` for only those the gateway wrapped, `sort` by `holders`, `transfers` or `newest`, `order=asc` with `after` for the other end), with `total`, `counts` for each standard and `gatewayCount` beside the page; each token carries who made it (`creator`, `creationBlock`, `createdAt`, all null for a contract of the genesis state) and whether its source is verified. One token, its holders and its transfers; `/api/token-transfers` is the transfers of every token, newest first, with a `standard` filter. Every transfer carries the transaction's `methodId`, `creation` and `timestamp`, and the token's `standard`. `/api/tokens/{address}/transfers` also comes as a CSV (`format=csv`). `/api/tokens/{address}` also carries `canton` for a token the gateway registered (the instrument and what the gateway holds of it on Canton, see [The custody check](#the-custody-check)), null for any other |
| `/api/legs`, `/api/legs/{id}` | The gateway's legs, each with `party`, the Canton party a withdrawal paid (null on a deposit or a payment) |
| `/api/swaps`, `/api/swaps/{payId}` | The swaps a Canton venue made with the EVM, newest first, and one by its payment's id: `evm` (token, payer, payee, amount), `canton` (amount, instrument, the EVM address that claims, the Canton update that settled it), `payment` (block, transaction, Canton update id and record time), `claim` (the same, null until the buyer has claimed), `offer` (the Canton update that offered the trade) and `status` `settled` or `claimed`. No Canton party is in it |
| `/api/canton/updates`, `/api/canton/updates/{updateId}`, `/api/canton/updates/{updateId}/transactions`, `/api/canton/updates/{updateId}/around` | The Canton updates that carry a block, as the reader party sees them: each with its block and `txCount`, the number of EVM transactions it settled; `/transactions` lists those transactions (paged like a block's); `/around` gives the updates next to one |
| `/api/stats/summary`, `/api/stats/series` | See [Stats](#stats) |
| `/api/openapi.json`, `/api/stream` | The description of the API, and [Live updates](#live-updates) |

Every list pages by key, never by offset, and every page answers `items` and `next`, the key to ask the following page with (null on the last page). Newest-first lists take `?before=<key>&limit=`. Ascending lists (a block's or a transaction's rows, an address's token holdings) take `?after=<key>&limit=`. A key is the sort key of the last row the client has seen, and a page is the rows that sort strictly after it, in the route's own order: newest first for the chain-wide lists, ascending within a block, and by balance or count where the route says so. `/api/txs`, `/api/tokens` and `/api/contracts` can also be read from the other end with `order=asc`, paged with `after`; `before` with `order=asc`, or `after` with the newest-first order, is a 400. To open such a list's last page, ask `order=asc` with `limit` set to `total` modulo the page size (the full page size when that is 0), so that the last page does not repeat rows of the one before, then page on with `after` and the normal size. `format=csv` returns the newest rows as a file, up to 1,000, with no paging. The default `limit` is 25 and the largest is 100 (`server/rest/paging.ts`). A key that the database would refuse is a 400.

Cache headers follow what can change (`server/rest/cache.ts`). A fact that can never change, such as a final block, is `public, max-age=31536000, immutable`. An answer that has fields which arrive later (the lifecycle, stage 2, verification) is `public, max-age=3` with an ETag, and answers `304` to `If-None-Match`. A list is `public, max-age=1`.

### The Etherscan-compatible API

`/api` and `/v2/api` answer the `module` and `action` calls that Foundry, Hardhat and ethers send, in Etherscan's shape: `{status, message, result}`, numbers as decimal strings, addresses in lowercase (`server/rest/etherscan.ts`). HTTP is 200 for everything and a refusal is `status` "0", as on Etherscan. There are no keys: `apikey` is never read, because the tools insist on sending one. A `chainid` parameter that is not the chain's id is refused.

| Module | Actions |
|---|---|
| `account` | `balance`, `balancemulti`, `tokenbalance`, `txlist`, `txlistinternal`, `tokentx`, `tokennfttx`, `token1155tx`, `getminedblocks` |
| `transaction` | `getstatus`, `gettxreceiptstatus` |
| `block` | `getblockreward`, `getblocknobytime`, `getblockcountdown` |
| `logs` | `getLogs` |
| `contract` | `verifysourcecode`, `checkverifystatus`, `getsourcecode`, `getabi`, `getcontractcreation`, `verifyproxycontract`, `checkproxyverification` |
| `token` | `tokeninfo`, `tokenholdercount`, `tokenholderlist` |
| `stats` | `ethsupply`, `tokensupply`, `ethprice` (answers NOTOK: the coin has no price) |
| `gastracker` | `gasoracle`, `gasestimate` |
| `proxy` | The `eth_` calls that Etherscan's proxy module has (`eth_blockNumber`, `eth_getBlockByNumber`, `eth_getTransactionByHash`, `eth_getTransactionReceipt`, `eth_call`, `eth_sendRawTransaction` and others). They go through the public RPC's rules and the JSON-RPC answer is given back as it is, with no `status`. This module works only with `PUBLIC_RPC=1`; without it every call answers NOTOK "not supported on Ostia" |

Only final data is served. Every row is from a final block, a balance is reth's at the newest final block and not the database's copy, and a list that stage 2 writes (internal calls, token transfers) stops at the block stage 2 has reached, so a page is never half written. The limits are in [Rate limits](#rate-limits). The tests hold each action's answer to a recorded Etherscan answer, and the nightly runs Foundry's `forge verify-contract` against it (see [The load tests](#the-load-tests-and-the-nightly)).

### Live updates

`GET /api/stream?topics=blocks,txs` is a server-sent-events stream (`server/rest/stream.ts`). The topics are `blocks`, `txs`, `inflight` and `stats`.

- `block` (topic `blocks`) carries the number, hash, transaction count, record time and update id of a new final block. `txs` carries the number and up to 50 transaction hashes of it, and `more` when there are more. Both use the block number as their event id.
- `derived` says stage 2 has the block. `inflight` carries the block attempts that are not final. `stats` carries the newest block and the time, every 5 seconds. These have no id and are not replayed: a page that reconnects reads their state from the REST routes.
- A client that reconnects with `Last-Event-ID` gets the blocks it missed, from a buffer of the newest 100.
- The server sends a heartbeat every 15 seconds, and tells the browser to retry after 3 seconds.
- A client may hold 4 streams and an instance 5,000. Past that the answer is `429` with `Retry-After`.

### Rate limits

Most limits are per client; the heavy-call cap on `/rpc` covers all clients together (`server/rpc-heavy.ts`, tested in `server/rpc-heavy.test.ts`). A client is the connection's address, or the last address in `TRUSTED_IP_HEADER` behind our own proxy (never read without it). An IPv6 client counts as its whole /64. There are no API keys. The per-client limits are in `server/limits.ts`, and `server/http-limits.test.ts` holds a test for each.

| Surface | Limit | When it is reached |
|---|---|---|
| The pages' REST routes (`/api/...`, including `GET /api/faucet` and the faucet's ticket route, which read from reth) and `/healthz` | 20 a second, bursts of 60 | `429` with `Retry-After` |
| The Etherscan-compatible API (`/api`) | 10 a second and 600 a minute | HTTP 200 with `{"status":"0","message":"NOTOK","result":"Max rate limit reached"}`, as Etherscan answers, and `Retry-After` |
| A `txlist` or `getLogs` page on the Etherscan-compatible API | at most 8 MiB of transaction `input` or log `data` in the page (`MAX_PAGE_BYTES`) | HTTP 200 with `{"status":"0","message":"NOTOK","result":"Result too large; ask for a smaller offset"}`; no `Retry-After` (a smaller `offset` is answered) |
| Verification (`verifysourcecode`, `verifyproxycontract`) | 30 an hour; the source at most 500 KB | HTTP 200 with `status` "0", `message` "NOTOK" and the reason; `Retry-After` for the hourly limit. Any other request to `/api` may carry 8 KB |
| `/rpc` | 300 a minute (`RPC_RATE_PER_MINUTE`) | as in "The public RPC" |
| `/rpc`, the heavy calls (`eth_call`, `eth_estimateGas`, `eth_getLogs`) of all clients together | 8 running at once and 16 waiting (`RPC_HEAVY_CONCURRENCY`, `RPC_HEAVY_QUEUE`) | a call that finds the queue full is refused at once: HTTP 429 with `Retry-After: 1` when it is the whole request, a `-32005` error on that call inside a batch. Light calls never wait |
| `GET /api/stream` | 4 streams for a client, 5,000 for an instance | `429` with `Retry-After` |
| A faucet request (`POST /api/faucet`) | its own limits | as in "The faucet" |

`/healthz` answers the same as `/api/status` (it reads reth and Canton on every call), so it shares the pages' REST rate per client. That rate is far above any proxy's probe, and a client over it cannot reach reth or Canton through `/healthz`.

## Stats

The indexer rolls its facts up into `stats_minute`, `stats_hour` and `stats_day` (migration 0027 added the columns the stats page needs). Every run recomputes the minutes from the earlier of a lookback before its cursor and the earliest fact time any writer touched since the last run, to the open minute, so a run twice changes nothing. Writers leave that time in `stats_dirty` through triggers (blocks, block attempts, lifecycle rows, producer runs and the derive cursor), so a block caught up after an outage, a journal loaded late or the history of a chain that already exists is rolled up by the next run, however old it is. Minute rows are kept 30 days; hours and days are kept. Runs whose settings carry `test = true` are counted in the `test_*` columns and left out of the block, attempt, accepted and lost counts and of the histograms; the live open, stuck and lost lists and the day's address counts do not look at test runs. `node server/indexer/cli.ts stats-rebuild` empties the rows in one transaction and then fills them again from the facts chunk by chunk, so the Stats and Home pages show partial figures until it is done; the loop waits until it is done (an advisory lock), so it is safe to run while the indexer runs. The 1h window of `/api/stats/summary` and `/api/stats/series` is read from the minute rows, so it lags the facts by up to one run (10 seconds), and every time in it (and in every other window) is the edge of a histogram bucket, 5 % wide, not the exact value. `prover.maxBusyRatio10m` and `prover.windowsOver` are worked out over the whole 10-minute windows of the window (the prover's busy time over 600 s, and the number of those above 0.6); `prover.meanBusyRatio` is the mean over the part of the window that has happened. `rule` carries the two numbers of the switching rule of design 2.7 as the rule states them: how many whole hours of the window had a p95 time to final above 20 s (`hoursAbove`, from the hour rows, with the worst hour's `worstHourP95`), and the ten-minute windows above 0.6 for each UTC day (`windowsOverByDay`).

`GET /api/stats/summary?window=` gives the stats over a window (`1h`, `6h`, `24h`, `7d` or `30d`, `24h` when left out), and what is live now: the rate over the last 60 s, what is waiting (with the age of the pool sample), the open transactions by age (normal, slow, stuck, the stuck ones listed; and how many are being proven and how many wait), the lost ones and the dropped ones each listed, the replaced ones counted, the blocks of each size class, the strategy of the newest ordinary producer run, and the faucet's requests (how many, sent, final, failed, the time from request to final, and `turnedAway`: how many requests a limit or the human check turned away, in total and by reason, never by who asked). `turnedAway` is null for a window that starts before `turnedAwaySince`, when the counting began, because a part of a window would read as all of it. `txs.allTime` is the chain's transactions since its first block, exact through the newest final block (`asOfBlock`, `asOf`), null where the rollups cannot say, and the same for every window. `GET /api/stats/series?metric=&window=&step=` gives one metric as a point for each step. Both are listed, with their fields, in `/api/openapi.json`.

**The success rate counts only the chain's own failures** (migrations 0039 and 0040). `txs.successRate` is `txs.acceptedFinal / (txs.acceptedFinal + txs.lost + txs.droppedByChain)`: of the transactions sent through Ostia's RPC or the faucet and settled in the window, the share that became final. All three counts are of those transactions only (`txs.lost` and `txs.droppedByChain` here are the accepted ones; the Reliability card's `lost` and `dropped` count every transaction the producer lost), so traffic that reached reth another way is in none of them, in the numerator or the denominator. Each is counted in the minute it was settled (final, lost or dropped); a transaction the sender replaced and one that is still waiting are in neither count (a lost transaction the sender later replaced at the same nonce counts as replaced), and it is null when none was settled. A dropped transaction is not always the chain's fault, so the tracker stores why it dropped it (`tx_lifecycle.drop_cause`, migration 0040) and only the chain-side drops are in the rate: a transaction that went missing on every resend, or that reth refused on resend because its own pool was full or it failed (`chain`). Not in the rate: a drop the sender caused, when reth refused it for no funds, a nonce gap, a fee or gas limit too low (`sender`); the explorer's own backlog limit (`explorer`); a transaction that only waited in reth's pool for the longest wait with no block, where the sender's fee or nonce and the chain cannot be told apart (`stuck`); and a drop recorded before the cause was kept. A lost transaction (accepted, then gone from reth's pool without being included) is always the chain's. The Reliability card keeps the plain dropped count, whatever the cause, with a note that names the causes; `txs.droppedByChain` is the number in the rate. Migration 0040 renames the rollup column `accepted_dropped` to `accepted_dropped_chain` and asks for a recompute. A revert in the EVM is a normal outcome of a transaction, not a failure of the chain, so it is not in the rate: `txs.reverted` is the count of final transactions whose EVM status is a revert (`txs.failed` is the same number under its old name, deprecated), and the pages do not show it; the status of each transaction stays on its own page and in the lists. A failed proof or a refused or failed attempt does not fail a transaction either: the builder puts the transactions back and they land in a later block. `txs.delayedByRedo` counts every final transaction, whoever sent it, that an earlier attempt that did not commit had carried (refused, failed, not taken, cancelled, restarted, or unknown and never found committed, or a failed proof). `blocks.firstTry` is the share of decided attempts (`attempts.decided` = `committed` + `refused` + `failed` + `unknown`) that committed, not a per-height share: Stats names it Block attempts committed. `attempts.committed` and `attempts.unknown` are the two counts the older fields lacked. The series metric `success_rate` has the same meaning and `delayed_by_redo` is new. Migrations 0039 and 0040 mark the rollups dirty from the first fact, so the next run recomputes every row once to fill the new columns (a drop recorded before the cause was kept counts as not the chain's).

- A window is the last whole buckets of the rows it is read from (1 h and 6 h: minute rows; 24 h and 7 d: hour rows; 30 d: day rows), the open bucket included. Buckets are cut from the epoch in UTC.
- Times are read from histograms whose buckets are 5% apart, so a percentile is never below the truth and at most 5% above it.
- A time or a rate with nothing behind it is `null`, never a guess. A count with nothing behind it is 0. `asOf` is when the rollups last ran, and `dataSince` is the first day with a row.
- A series step is `1m`, `10m`, `1h` or `1d`, as the window allows. `busy_ratio` is drawn in `10m`, `1h` or `1d` only, and the daily address and contract counts in `1d`.

## The public RPC

With `PUBLIC_RPC=1` the server answers `POST /rpc`, the address a wallet adds as its network. It forwards to reth, but it shows only what is final on Canton.

**The guarantee: a receipt from Ostia's RPC means the block is proven and final on Canton.** reth makes a new block its head while the block is still being proven, and goes back if Canton refuses it. The public RPC never shows that block. Its view of the chain ends at reth's finalized block, which is Canton's head.

- `latest`, `safe`, `pending` and `finalized` all mean the finalized block, and `eth_blockNumber` is its number. The one exception is `eth_getTransactionCount` with `pending`, which counts the transactions in the pool, so a wallet picks its next nonce well.
- A block read for a number above the finalized block answers `null`. A state read (balance, code, storage, count, call, estimate) at such a number is an error that says the block is not final yet.
- A block or a receipt looked up by hash answers `null` while its block is above the finalized one. A transaction looked up by hash is shown as pending, with `blockHash`, `blockNumber` and `transactionIndex` all null, while it is in the pool or in a block that is still being proven. It shows its block once that block is final.
- `eth_getLogs` is cut at the finalized block. A filter by block hash for a block that is not final answers an empty list.
- A block, a transaction and a receipt are read after the finalized number, and are shown only when the block is the one reth has at that height. A block that was refused and replaced by another at the same height is never shown.
- A block hash given as a plain 0x string works as a block argument, as it does on reth, and a block that is not final is answered like a number above the finalized one.
- `eth_sendRawTransaction` reads the transaction first: it takes the hash, the sender, the nonce and the chain id, and refuses a transaction signed for another chain. It asks the tracker whether it can follow the transaction, and refuses with -32005 when it cannot (see the limits below). It also reads the sender's pending count from reth, and refuses a transaction whose nonce is ahead of that count with -32000 ("nonce gap"), so the sender is told to send the missing ones first. It also reads the base fee of reth's newest block, and refuses a transaction whose `maxFeePerGas` (or `gasPrice`, for a legacy one) is below it with -32000 ("max fee per gas is below the current base fee"), before the tracker or reth see it: reth would accept such a transaction and park it, never building it, and the tracker would hold a place for it for an hour, so dust-funded senders could fill the tracker's list with them. When reth gives no base fee or cannot be read, nothing is refused on this ground. The sends of one sender are handled one after another, in the order they arrive, so a batch or two overlapping requests that carry the next nonces in turn are all taken. Then it forwards the transaction and returns reth's answer as it is. Every transaction reth accepts is handed to the tracker, and so is one that reth answered "already known" to, or one whose answer did not come in time. If the tracker fails, the send still returns reth's answer.

The methods are `eth_chainId`, `net_version`, `web3_clientVersion`, `eth_syncing`, `eth_blockNumber`, `eth_getBalance`, `eth_getCode`, `eth_getStorageAt`, `eth_getTransactionCount`, `eth_call`, `eth_estimateGas`, `eth_gasPrice`, `eth_maxPriorityFeePerGas`, `eth_feeHistory`, `eth_getBlockByNumber`, `eth_getBlockByHash`, `eth_getTransactionByHash`, `eth_getTransactionReceipt`, `eth_getLogs` and `eth_sendRawTransaction`. Any other method answers -32601.

Limits: a body of at most 256 KiB (413 above it), a batch of at most 20 calls, and a token bucket for each client that holds `RPC_RATE_PER_MINUTE` calls and refills steadily (429 with `Retry-After` when it is empty). An IPv6 client is one client for its whole /64, so changing the last half of an address gives no new bucket. All clients together may have 64 requests being answered at one time, and a request past that gets 503 with `Retry-After: 1`, so that many addresses cannot saturate reth. Heavy calls (`eth_call`, `eth_estimateGas`, `eth_getLogs`) of all clients together are also capped: 8 run at once and 16 wait, and one past that is refused at once: a request whose every call was refused gets 429 with `Retry-After: 1`, and a refused call inside a batch that was partly answered gets a `-32005` error in a 200 answer, with no `Retry-After` (see [The global cap on heavy calls](#the-global-cap-on-heavy-calls)). The client address is the connection's address, or, when `TRUSTED_IP_HEADER` names a header, the last address in that header. Use `TRUSTED_IP_HEADER` only when the port can be reached only through a proxy that you run and that writes the header. If clients can reach the port directly, they can write the header themselves and choose their own bucket. An unexpected error inside `/rpc` is answered as a JSON-RPC error with the CORS headers, so a browser page can read it. A call to reth that takes longer than `RPC_TIMEOUT_MS` is answered with an error, and the detail goes to the log. When the RPC is on (`publicRpc` in `/api/status`), the Faucet page and the API page show an "Add Ostia to your wallet" button and the RPC address, and the footer of every page links to it.

### The global cap on heavy calls

The per-client limits stop one client. They do not stop many clients, each under its own limit, from sending reth more `eth_call`, `eth_estimateGas` and `eth_getLogs` calls than it can answer. These three run the EVM or scan a range of blocks, so one call can hold reth for seconds. `server/rpc-heavy.ts` limits them for all clients together:

- At most `RPC_HEAVY_CONCURRENCY` heavy calls (default `8`) run at one time. A heavy call that finds no free place waits in a queue of at most `RPC_HEAVY_QUEUE` calls (default `16`), and the oldest waiter gets the next free place.
- A heavy call that finds the queue full is refused at once, without waiting: HTTP 429 with `Retry-After: 1` when it is the whole request (or every call of a batch was refused), and a JSON-RPC error `-32005` ("The RPC is busy with other calls of this kind. Try again in 1 s.") on that call when the rest of a batch was answered. These are the codes and the error the public RPC already uses for its other limits.
- Every other method (chain id, block number, balance, nonce, code, storage, gas price, a block, a transaction, a receipt, `eth_sendRawTransaction`) never takes a place and never waits behind a heavy call. A heavy call waits at most for the queue ahead of it, and a call to reth is cut at `RPC_TIMEOUT_MS`, so the longest wait is bounded.
- A call is counted until the explorer stops waiting for it. reth does not cancel a call when the connection drops, so a heavy call that hits `RPC_TIMEOUT_MS` keeps its place for one more `RPC_TIMEOUT_MS` before it is released; abandoned calls that reth may still be running keep counting meanwhile. After that, reth's own bounds (`--rpc.gascap` for the gas of one call, and its limits on the range and the size of an `eth_getLogs` answer) are what end a call that is still running.
- The 64-requests-at-once limit and the per-client limits are unchanged.

**How the defaults were chosen.** They were not measured against reth on a production machine; they are conservative values to be raised after a load test of `/rpc` on the machine that serves it. The reasoning: 8 heavy calls at once leave most of a machine's cores to block building, the other lookups and the explorer. Each call to reth is cut at `RPC_TIMEOUT_MS` (5 s), and a heavy call makes up to four calls to reth in a row (the finalized block, then for a block given by hash the block and its canonical check, then the call itself), so one call can keep its place for about 4 x `RPC_TIMEOUT_MS` (5 x when it ends in a timeout, which holds the place one more), and the last call in a queue of 16 behind 8 running can wait about two such rounds in the slowest possible case. It is well under a second when calls are short. A wallet or a dapp sends a few heavy calls a second at most, so a real user does not meet the cap; a flood does. To change it: raise `RPC_HEAVY_CONCURRENCY` first and keep the queue at about twice it.

**An operator step: the rate-limit rule at the edge.** The explorer cannot stop a flood before it has read the request, so the proxy in front of it carries a rate-limit rule too. This is applied by the operator in the proxy's dashboard (or with an approved API token); it is not part of this repository's code. The rule:

| Setting | Value |
|---|---|
| Name | `rpc per-IP rate` |
| Match | the request's URI path equals `/rpc` (expression `(http.request.uri.path eq "/rpc")`) |
| Counted by | the client's IP address |
| Rate | 100 requests per 10 seconds for each IP. The edge counts a batch as one request, and lets a page's burst through (the Contract Read page reads every view function without inputs, 6 at a time). The sustained rate is held by `RPC_RATE_PER_MINUTE` in the explorer, so the edge rule is only the cut for a flood |
| Action | Block |
| Duration | 10 seconds (the longest the free plan allows; use 1 minute where the plan has it) |

The rule is a first line only: a client that stays under it is still held to `RPC_RATE_PER_MINUTE` by the explorer, and all clients together to the cap above.

## The transaction tracker

The tracker is what stops a transaction that Ostia accepted from being lost without a word. It keeps every accepted transaction with its signed bytes until the transaction is settled, and looks at the open ones every `POLL_MS`.

| State | Meaning |
|---|---|
| `pending` | In reth's pool, in no block |
| `proving` | In a block that Canton has not committed yet |
| `final` | In a block that is final on Canton. The tracker keeps the block and, when the database holds it, the Canton update id |
| `replaced` | Not in the chain, and the finalized nonce of the sender is past it: another transaction took its place |
| `dropped` | It went missing and was sent again `10` times, reth refused it `5` times in a row when it was sent again, or the tracker was full and stopped following it (the reason says which) |

A transaction that is in no block and not in the pool (a block was unwound, or reth forgot it) is sent again from the saved bytes, at most once every five seconds, and the tracker counts the sends. The transaction page says it was sent again.

A wallet's speed-up or cancel puts a new transaction on the same nonce. While that one is in the pool or being proven, reth refuses to take the old one again ("nonce too low" or "replacement transaction underpriced"). The tracker does not count that as a failure. It keeps the old transaction open, and calls it `replaced` when the sender's finalized count passes its nonce. If the other transaction goes away first, the old one is sent again.

The tracker is bounded by count and by size. `TRACKER_MAX_BYTES` limits the signed bytes it holds for open entries, and `TRACKER_PER_SENDER` limits the open entries of one sender, so a few funded accounts cannot fill it with transactions that cannot be mined. A transaction that pays less than the base fee is refused before it reaches the tracker (see `eth_sendRawTransaction` above), so it cannot take a place at all. `eth_sendRawTransaction` asks the tracker before it forwards a transaction, and refuses it when the tracker is full, so a transaction is never accepted and then not followed. `TRACKER_MAX_PENDING_MINUTES` limits how long an open entry may stay without a block: after that it is marked `dropped`, with the reason, and no longer followed, so a transaction that reth keeps without mining cannot hold a slot for ever. `TRACKER_MAX` limits all entries. When it is reached, settled entries go first, oldest first. If the list is still too long, the oldest open entry is marked `dropped`, with the reason, and the server's log names it. It is never forgotten without a word, and the chain may still mine it.

The tracker keeps its list in the database (`tracked_transactions`), so a restart, or another API instance, finds it. A burst of sends is one write, a second or so after the last change, and nothing is written when nothing changed. On SIGTERM or SIGINT the server stops, writes the list and then exits, so the transactions accepted just before a restart are in the database. `run.sh` mounts `<state>/explorer` as the only writable folder of the read-only container. It holds the old `tracker.json` and `faucet.json` until they are imported (see [The tracker and the faucet on the database](#the-tracker-and-the-faucet-on-the-database)).

The Canton update id of a final transaction is filled in when the database holds the block, which can be a poll after reth's finalized number passes it.

## The pages

The pages are a small React app in `src/`, built by Vite into `dist/`, which the server serves. `npm run build` makes the build, and `npm run dev` serves the pages while you work on them, with `/api` and `/healthz` passed on to a server on port 8088. The pages read the REST API, and `/rpc` for a contract's Read calls. `/rpc` exists only when the server runs with `PUBLIC_RPC=1`, and `npm run dev` does not pass it on, so Read calls work only on a built page served by the server. Where a page shows a changing value it follows the live stream (`src/useLive.ts`).

Every page has the same shell. The thin top bar says how many checks pass ("All 16 checks ok", the count being the checks the indexer writes, the same rows `/api/status` counts and not the API's own rows, or how many of them are not ok), the newest final block, the block being proven, the base fee and the chain. The header has the chain's name with the network pill, the pages (Home, Blocks, Transactions, Contracts, Tokens, Canton, Stats, Faucet, API) with the page that owns the open route kept lit, so a block, transaction, contract, token or Canton update page lights its list (address and leg pages have no header entry yet), and a search box (outside the home page) whose `/` key focuses it. On a phone the pages fold behind a menu button, the top bar keeps one line and the search box takes the full width. The footer carries the links About, API, Health, Add Ostia to your wallet and Source code; the sentence about how the explorer reads Canton is on About. The Ostia name, the headings and the big numbers are set in Literata, the text in DM Sans, and numbers use figures of equal width; the fonts are served from `public/fonts` with their licences. The shell's shared pieces are `Cards.tsx` (the card header, with a bold title, a grey subtitle and a line under it, used by every card that has one), `Icon.tsx` (the icon set) and the download button. The name and the id come from `/api/status`; until it has answered, the header says Ostia. Search sends what was typed to `/search?q=`, which asks the server what it is and opens that page, so a search is also a link. Nothing found says so, in the server's own words, and so does a block, transaction or address that does not exist.

| Route | What it shows, and where it comes from |
|---|---|
| `/` | A search box under the intro, with Try chips for the newest block, transaction, sender and Canton update and, when the index holds a token, the one with the most holders (`/api/tokens`; its symbol is the contract's own text, so it is cut short and set apart). The status strip, from `/api/status` and `/api/health`: how many of the indexer's checks pass, then the EVM node, Canton ledger, producer, prover, index lag, faucet, verifier and clock gap, each with its own dot, and the newest final block with how long ago and its time. The number cards: block height (and the block being proven), time to final, proof time and Canton commit time (median and p95 over the last hour), transactions per second (now, and the busiest minute of 24 hours), transactions in 24 hours with the all-time total, the not-final count (with how many are stuck), the Lost card (green while none were lost), the success rate over 24 hours, and the median time to final for each hour of the last 72. The block attempts that are not final yet (`/api/in-flight`). The latest ten final blocks (block, transactions, time to final, Canton update, stage; the time to final runs from the producer's cut of the block to Canton's record time) and the latest ten transactions, each with the token it moved as a chip and the sender and receiver by name (`/api/labels`, asked once for the list); a transaction that is not final yet shows its transfer as a chip when its own page decodes one. A link to About, which says what the explorer can and cannot show. The strip and the health check read the same answer, so they cannot disagree |
| `/blocks`, `/block/:number-or-hash` | The list of final blocks, with All, With transactions and Empty buttons and a CSV download of the newest ones. A block shows its EVM side from reth next to its Canton side: the update id, the commit time, the record and the two parties that signed it, whether reth's hash, the record's hash and the hash of the record's header agree, and the three facts read from the proof (program key, ZisK release, block hash) next to this explorer's pins for the block's height, and the key it was checked under ("Checked under"). A fact that does not match is shown in red with the value that was read, and a proof that is not 1,344 bytes gets one red line instead. It also shows the block's transactions and legs, the record's data with a copy button each, and the Verify panel. Four tiles give the block in numbers (transactions, proof time, Canton commit, cut to final), and a "How this block became final" panel shows the way as a bar and as steps with their times, from the producer's log with Canton's record time last. A block still being proven shows its EVM side and says it is not on Canton yet, and the page looks again until the block is final. Block 0 is shown as Genesis and checked against block 1's record |
| `/txs`, `/tx/:hash` | The list of transactions, under four cards from `/api/stats/summary` (transactions in 24 hours with the all-time total, time to final in the last hour, not final yet with how many are stuck, and the lost ones), with All, Not final yet, Failed and Contract calls buttons and a CSV download. Each row has its method, the token moved as a chip and the sender and receiver by name. The title's counts add up: final, being proven and waiting, each counted once. All has a page count (`Page x of y`, with First and Last): the total is the exact all-time total of `/api/txs`, and the last page is read from the other end with `order=asc`. The filtered lists have no total, so they page newer and older only. A transaction shows its result, its block and Canton update, sender and recipient, the token moved, value, fee, burnt fees, gas, nonce, type and a timeline of its four finality stages, with the timestamp of each from the producer's journal or Canton (a dash for a stage with none). Its input is decoded with the verified ABI of the contract called (a proxy's with its implementation's), or with the standard token ABI when the contract has none, and shows as Decoded or Raw; a log is decoded the same way. The tabs are Overview, Logs, Internal calls (every call the trace holds, not only those that moved value), Call tree and Raw (the receipt as reth gave it); the selected tab is kept in the link (`?tab=`), so a shared link opens the same one. A button checks the block's record in the browser. A transaction that is not final says where it is on the way (Waiting, Being proven, Final, Replaced or Dropped, with the reason in plain words) and its lifecycle times, and the page looks again every two seconds until it is settled. Only a page reached by the transaction's hash can say Waiting |
| `/addresses`, `/address/:address` | The list of addresses, by balance or by transactions, with each balance and the block it is as of. An address shows its balance in the chain's coin from reth's newest final block and the block it was read at, a Token holdings card (each token with its balance, supply and decimals), and a More information card: transactions sent and received, who funded it and in which transaction, when it first appeared, and when it last sent. Tabs: Transactions (All, Sent or Received, with a CSV download), Token transfers (all tokens or one, with a CSV download), NFT transfers (ERC-721 and ERC-1155 together, with a CSV download), Internal calls, Contracts created (with the count beside the Created chip) and Coin history; the selected tab is kept in the link (`?tab=`), so a shared link opens the same one. An address that holds code is shown by the contract page, and a token by the token page. A contract or token that a block the database holds created names the transaction and the block |
| `/contracts`, `/contract/:address` | The list of contracts (verified or not, by most interactions, newest or oldest, with the page count and a Last page read from the other end with `order=asc`), each with its interactions, when it was created and by whom, its code size and its balance. A contract shows an Overview (token tracker link, transactions, internal calls and interactions), its Creation (creator, the block, whether it was destroyed, the code) and its Verification (how the source came in, the proxy and its implementation). Tabs: Transactions, Token transfers, Code (the verified source with the compiler, optimization, EVM version, license and libraries, the ABI, the constructor arguments and the deployed code, or the form to verify it), Read and Write calls built from the ABI (Read goes through `/rpc`, which needs `PUBLIC_RPC=1`; Write goes through the visitor's wallet), and Events (the logs it wrote, newest first, decoded with its ABI, with a count that stops at 100,000). The selected tab is kept in the link (`?tab=`), so a shared link opens the same one |
| `/tokens`, `/token/:address` | The list of tokens, with All, ERC-20, ERC-721, ERC-1155 and From Canton tabs (each with its count), sorted by holders, transfers or newest, with the page count and a Last page read from the other end with `order=asc`; each row carries its standard, its creator and when it was made. Above it, a Latest token transfers card from `/api/token-transfers` (all tokens, ERC-20 or ERC-721). A token shows its information (name, symbol, decimals, standard, how balances are worked out, creator and creation, and a link to its contract page), its holders with their distribution, and its transfers (newest first, with a CSV download) |
| `/legs`, `/leg/:id` | The gateway's legs, and one leg; a withdrawal names the Canton receiver, and the token page of a registered token has a "Backed on Canton" card (what the gateway holds against the wrapped supply) |
| `/about` | What this explorer shows, in short: the chain in a sentence, what is shown and what is not, and where the numbers come from (how the explorer reads Canton). The other pages keep to a title, a number and one short line, and put the rest of their notes behind a small i (`components/Info.tsx`), which shows on hover, on keyboard focus and on a tap, closes on a second tap or Escape, and moves sideways to stay inside the screen |
| `/canton`, `/canton/:updateId` | "Linked to Canton": each Canton update with its block, its number of EVM transactions and its record time, and one update with the transactions it settled and its neighbours. The Transactions list names each final transaction's update |
| `/stats` | The charts and numbers of [Stats](#stats): a window switch (1h, 6h, 24h, 7d, 30d); tiles for time to final, proof time, Canton commit, transactions (with the all-time total), peak rate, success rate, block attempts committed and transactions delayed by a redo; a Reliability card (what became of every transaction Ostia accepted); charts of time to final, proof time, transactions per second and blocks per step; transactions per block; the prover's busy share with its rule; and a Faucet card (requests, sent, turned away by the limits, time to final of the faucet's sends, the faucet's balance) |
| `/docs/api` | The API page, drawn from `/api/openapi.json`: the three APIs (Etherscan-compatible, REST and JSON-RPC), the Etherscan-compatible modules with an example request and answer, the REST routes, the wallet details with a button that asks the wallet to add the network, and the rate limits |
| `/faucet` | The faucet: the form and the limits in plain words, the faucet's address, balance (and the block it is as of), queue, payouts being proven, sent today and how many of those are final, the recent sends, and a request's way to final. See [The faucet page](#the-faucet-page) |
| any other route | "Not found" |

Colours are variables in `src/styles.css`, light by default and dark when the system asks for it. There is no switch and nothing is stored. Times are UTC. Every hash is shown shortened, with a button to copy the whole value and one to read it in full.

The fonts are Literata (500 and its italic: the wordmark, headings and big numbers), DM Sans (text) and IBM Plex Mono (hashes and ids), served by the explorer from `public/fonts` (SIL Open Font License; the licence texts sit next to the files). The pages load nothing from another host, and a test holds them to that.

## Contract verification

A person sends a contract's Solidity source (a single file or standard JSON input) with its compiler version, settings, constructor arguments and libraries, to `POST /api/verify`, and asks `GET /api/verify/{guid}` how it went. The API only queues the request (the source is at most 500 KB, the body of `POST /api/verify` at most 600 KB, the form body of the Etherscan-compatible API at most 1,564 KiB because a form encodes each byte that is not a letter or digit as three, and a client may send 30 an hour); a separate role, `node server/verifier/cli.ts`, takes the jobs one at a time, downloads the compiler named, checks its SHA-256 against the compiler list, runs it in a throwaway container with no network, and compares the result with the code on chain: a full match, a partial match (only the metadata differs), or a similar one for another contract with the same runtime code, when that contract has no verified source of its own and is not the gateway. A contract in the genesis is matched on its runtime code alone. The role writes its state to `health_checks` (`verifier/compilers`, `verifier/queue`), and while no role has done so in the last minute `POST /api/verify` answers 503, "Verification is not running." A partial match carries a note (`matchNote`, on the source answer and on the contract's `verification`): the metadata differs from the compile, so code that reads its own or another contract's code (type(X).creationCode/runtimeCode, codecopy, extcodecopy, address(this).code) may act differently from the source's compile, and only a full match is byte-for-byte. A verified source belongs to the code at an address: a contract made again there with other code is unverified until its new code is verified, and the source of the old code stays with the old code.

The role is off unless you start it: `EXPLORER_VERIFIER=1 SOLC_LIST_URL=<the compiler list> explorer/run.sh start` runs it as its own container (`cze-explorer-verifier`), and `start` without the switch stops one that an earlier run left. It needs the Docker socket, the pinned Docker program (downloaded once and checked), and the pinned sandbox image on the machine (`run.sh` says what to pull). The header of `explorer/run.sh` has the settings.

## The faucet

It gives the chain's own test coin, and nothing else: 1 tROME per request (`FAUCET_AMOUNT`). The coin has no value, so there is no login. What matters is that the faucet keeps answering honestly when many people ask at once, and that it never says a coin was sent when it was not.

**A queue, not a lock.** A valid request is taken at once and answered with a ticket (202), never with "busy". A worker drains the queue in batches of up to `FAUCET_BATCH` transfers. A batch takes consecutive nonces from the faucet's pending count in reth. The whole batch is signed first, and its signed transfers and nonces are written to the database before the first one is sent. Then they are sent one by one, and each is handed to the transaction tracker, so one that is lost from the pool is sent again. The faucet asks the tracker for room before each send, and waits when there is none. The next batch starts when the last one has left the pool. If `FAUCET_QUEUE_MAX` requests are already waiting, the faucet turns the next one away with 503, says so in plain words (nothing was taken, nothing is lost) and gives a `Retry-After`.

**Limits.** All of them are kept in the database (`faucet_requests`, `faucet_daily_counts`) and are written again at shutdown after the batch in hand has ended (the shutdown waits for the send it is in the middle of and sends no more), so a restart keeps them and the requests still waiting. A transfer that was signed before a stop or a crash is never signed again: after a restart its request is sent, and the tracker sends it again only if reth does not have it. So an address is not paid twice by a restart:

- one request per address per 24 hours (`FAUCET_PER_ADDRESS_SECONDS`);
- one request per client address per 10 minutes (`FAUCET_PER_IP_SECONDS`). The client address is the connection's, or the header `TRUSTED_IP_HEADER` names when the explorer sits behind a proxy that sets it. An IPv6 client is one client for its whole /64, and an IPv4 address written as IPv6 is that IPv4 address;
- `FAUCET_MAX_PER_HOUR` requests in any hour, from everyone;
- a balance floor: the faucet counts what it has already promised, and when the balance cannot cover one more transfer and its fee it answers 503 "empty". When the balance runs out under a batch, the requests it cannot pay fail with that reason.

A request that comes to nothing (refused by the chain, or its transfer was replaced, or lost and not in reth) gives the address and the client their turn back. When reth does not answer a send, the faucet does not know whether reth has the transfer, so it counts it as sent, hands it to the tracker and stops that batch. The tracker sends it again if it is missing, and the ticket says what became of it. If the tracker stops following a transfer (its list is full, or the transfer sat in reth's pool for `TRACKER_MAX_PENDING_MINUTES`, as in a long prover outage), the faucet asks reth for it: if reth does not have it, the ticket fails; if reth has it, the ticket stays sent and the address keeps its turn, and the faucet follows the transfer by its hash itself. Each pass it looks at up to 20 such transfers, oldest look first, with one call for the transaction and the finalized block, and, when the transfer is in no block, one for the faucet's count of sent transactions as of the finalized block. The ticket becomes final, with its block, when the transaction is in a finalized block. It fails, with a reason, when that count has passed the transfer's nonce and the transfer is in no finalized block, because another transaction took the nonce. This is kept in the database with the rest, so a restart keeps following it. After two days the faucet stops, and the ticket says that it is no longer followed and to look up the hash.

**The human check (optional).** With `CAPTCHA_SECRET` set, a request must carry a token. The explorer verifies it by posting `secret`, `response` and `remoteip` (form-encoded) to `CAPTCHA_VERIFY_URL` and reading `{"success": true}`. The faucet page loads `CAPTCHA_SCRIPT_URL` and puts its widget, with `CAPTCHA_SITE_KEY`, in the form (`GET /api/faucet` gives the page the script, key and class, never the secret). The names are vendor-neutral: any check that answers this way will do. If the check cannot be reached, the faucet says so and lets nobody in. A client that fails the check 5 times in a minute (a missing token counts) is turned away with 429 (`reason` is `checks`) and a `Retry-After`, without a call to the check, and a client has one check under way at a time. So junk tokens from one client cost the check's service almost nothing and do not fill the places that honest users need. All clients together may have 50 checks under way, and past that a request gets 503 with `Retry-After: 2`. After a request the page draws the widget again, because a token is used once. With no `CAPTCHA_SECRET` the check is off.

**A ticket, and what final means.** `GET /api/faucet/ticket/<id>` says where a request is. A ticket is **final** only when the tracker says its transfer is final on Canton, never before. While the transfer is sent but not final it stays **sent**, with the transaction's hash and the tracker's state (pending or proving). A ticket whose transfer was replaced, or was dropped by the tracker and is not in reth, is **failed**, with the reason. A transfer the tracker stopped following but reth still has stays **sent** (with the state `dropped` while the tracker still holds its entry): it may still land, the faucet keeps following it by hash, and the ticket turns final when the transfer is in a finalized block, or failed when another transaction takes its nonce. The address keeps its turn meanwhile.

| Answer | When |
|---|---|
| 202 | The request is taken. The body has the `ticket`, the place in line (`position`), the address (`to`) and the `amount` in the coin's smallest unit |
| 400 | The body is not JSON, or has no address, or the address is not 0x and 40 hex digits |
| 403 | The human check is on and the token is missing or did not pass (`reason` is `captcha`) |
| 429, with `Retry-After` in seconds | The address (`reason` is `address`), the client (`ip`) or the faucet as a whole (`hour`) has had its share, or the client failed the human check too often or has a check still under way (`checks`) |
| 503, with `Retry-After` | The line is full (`reason` is `queue`), or the faucet is empty (`empty`), or off (no key), or the human check cannot be reached, or 50 checks are already under way across all clients (no `reason`) |
| 413 | The request body is bigger than 8 KB |

Each payout is a plain transfer of 21,000 gas, an EIP-1559 transaction signed with viem. Its nonce is reth's pending count, so if reth refuses one in the middle of a batch, or Canton refuses a block and a payout disappears, the next batch is signed again from reth's count and there is no gap. A transfer reth refuses five times is given up, and its request fails. A block is final on Canton only once its proof is settled: blocks are made only while the chain's builder runs.

**The key.** `faucet-setup.sh` makes a fresh key for each run in `<state>/faucet/key` (readable by its owner only, never printed, never committed) and writes a copy of the run's genesis that also funds it with 1,000,000 coins (`FAUCET_FUND` sets the amount). The genesis it copies is the one `CZE_GENESIS_FILE` names when that is set, and `network/genesis.json` otherwise. Run it before the network starts, because reth starts from the file `CZE_GENESIS_FILE` names; `network/make-state.sh` still refuses a genesis whose chain settings differ, so funding an account cannot change the rules the proof pins.

To run the server directly, use Node 22.18 or newer and the Rust toolchain in `rust-toolchain.toml`. Start the chain and the database from the repository root. For a fresh network, run `faucet-setup.sh` once, before `network/up.sh`: it makes a new faucet key every time it runs and replaces the existing key file, so a second run leaves a running chain with a key its genesis does not fund. For a network that is already running, keep its faucet key and genesis and skip `faucet-setup.sh` and `network/up.sh`.

```sh
(cd explorer && npm ci)
explorer/faucet-setup.sh                           # a fresh network only, once
CZE_GENESIS_FILE=state/faucet/genesis.json network/up.sh   # a fresh network only
network/explorer-db.sh start                       # the explorer's database; its password is in state/explorer-db.env
```

Then run the builder once, as in [Running it](#running-it), so that the chain has a block; run it once per block you want. The chain has no blocks until the builder runs, and the indexer reads the builder's journal folder (`JOURNAL_DIR`), so run the builder before you start the indexer.

In a first terminal, in `explorer/`, build the pages, apply the migrations and run the indexer. `npm run index` does not return, and it never restarts by itself:

```sh
cd explorer
rustup target add wasm32-unknown-unknown
npm run build:verify
npm run build
export EXPLORER_DB_PASSWORD_FILE=../state/explorer-db.env
export READER_PARTY=$(sed -n 's/^READER_PARTY=//p' ../state/canton/parties.env)
export PINS_FILE=../state/net/guest.txt
node server/db/cli.ts migrate
(umask 077; [ -f ../state/faucet/client-key ] || openssl rand -hex 32 > ../state/faucet/client-key)   # the faucet's hash key, made once
GATEWAY_ADDRESS=$(sed -n 's/^GATEWAY_ADDRESS=//p' ../PINS) GENESIS_FILE=../state/genesis.json \
  JOURNAL_DIR=../state/builder/journal PRODUCER_STATUS_FILE=../state/builder/status.json npm run index
```

In a second terminal, in `explorer/`, run the explorer with the same three exports. Add `PUBLIC_RPC=1` for the Contract page's Read calls and the Etherscan `proxy` module:

```sh
cd explorer
export EXPLORER_DB_PASSWORD_FILE=../state/explorer-db.env
export READER_PARTY=$(sed -n 's/^READER_PARTY=//p' ../state/canton/parties.env)
export PINS_FILE=../state/net/guest.txt
FAUCET_KEY_FILE=../state/faucet/key FAUCET_CLIENT_KEY_FILE=../state/faucet/client-key npm start
```

To have the database, the indexer and the explorer started in containers instead, with the same files, use `explorer/run.sh start` (see above).

The example uses the default `state/` folder. Set the file paths to the run's state folder if it differs. The database follows the network's life: for a network made without `CZE_PERSIST`, `network/down.sh` removes it with the chain (and so does `explorer/run.sh stop`), so run `network/explorer-db.sh wipe` yourself if you started it by hand and then stopped the network some other way.

The server reads the key only when `FAUCET_KEY_FILE` is set; without it the faucet is off. A key file that is missing or does not hold 64 hex digits stops the server at start, and the message does not quote the file. Nothing mints and nothing tops the faucet up: the next run makes a new key. The key never appears in an answer or in the log, and the tests check that.

## The database

The explorer keeps its data in a PostgreSQL server of its own, apart from the one Canton uses, so that the explorer's heavy queries do not share Canton's connections, locks or cache. Both servers run on the same host and share its CPU, memory and disk: `network/explorer-db.sh` sets no limits, and no test measures how one affects the other. `network/explorer-db.sh` starts it for a persistent network (see [network/README.md](../network/README.md)). The schema is a set of numbered SQL files in `db/migrations/` (`0001_bookkeeping.sql` upward). There is no ORM, and a migration that has been applied is never edited: a change is a new file.

The tables, by what writes and reads them:

| Group | Tables |
|---|---|
| Bookkeeping | `schema_migrations`, `meta`, `cursors`, `health_checks` |
| Canton's side of a block | `block_records`, `proofs`, `canton_updates`, `canton_participants`, `canton_parties`, `canton_synchronizers`, `canton_templates` |
| The chain, written by stage 1 | `blocks`, `transactions`, `tx_hashes`, `logs`, `gateway_legs`, `coin_balance_history`, `addresses` |
| What stage 2 works out | `tx_traces`, `internal_calls`, `contracts`, `bytecodes`, `proxies`, `abi_fragments`, `tokens`, `token_balances`, `token_transfers`, `nft_owners` |
| The builder's journal | `producer_runs`, `block_attempts`, `attempt_transactions`, `tx_lifecycle`, `pool_samples` |
| The tracker and the faucet | `tracked_transactions`, `faucet_requests`, `faucet_batches`, `faucet_daily_counts`, `faucet_refusals`, `faucet_refusals_since` |
| Verification | `verification_jobs`, `verified_sources` |
| Stats | `stats_minute`, `stats_hour`, `stats_day`, `stats_dirty` |

```sh
# the password file is the one network/explorer-db.sh made in the network's state folder
EXPLORER_DB_PASSWORD_FILE=../state/explorer-db.env node server/db/cli.ts migrate --head 0
```

The command takes `--head N`, which makes the partitions up to block N (default 0) and two more ahead, and `--partition-width N`. `server/db/migrate.ts` applies the files that a database has not seen, each in its own transaction, and records the SHA-256 of each file in `schema_migrations`. It refuses to run, and applies nothing, when an applied file has changed, when a file is missing, or when the numbers skip. Run twice, the second run changes nothing.

### A new chain, and a moved reader

The indexer keeps the update id of block 1's record in `meta` as `chain_instance`. A reset of the network starts a new chain from the same genesis, chain id and pins, so at every look the indexer also checks that (a) reth's block at the indexed head is the indexed one, (b) the reader's ledger end is not below the cursor's offset, and (c) the first record after the cursor is block head + 1 (or an indexed block with the same hash). When one fails it stops with the row `chain_instance` set to `down` and exit code 2, and it wipes nothing. Two commands are the only way on, and each refuses to run while an indexer holds the database (`reset` also refuses while an API instance is up, because its tracker and faucet write to the same tables, and refuses a database that is not the explorer's):

```sh
node server/indexer/cli.ts reset --yes                      # empties the explorer's tables for a new chain (keeps the migrations and the partition width)
node server/indexer/cli.ts reader-moved <participant id>    # the reader party is now hosted by this participant; the indexer reads it from its start
node server/indexer/cli.ts clear-check C10                    # C10 is ok again after a person has looked at the block it names; the row keeps who cleared it
```

The same commands run through npm as `npm run explorer -- reset --yes` (the `--` hands the rest to the command, not to npm). There is no switch that resets by itself when the indexer meets a new chain: a person runs `reset --yes`.

`reader-moved` adds the participant to `canton_participants`, keeps the old one's last offset, records the move in `meta` (`reader_move_N`) and puts the reader cursor at the new participant's start. Do it after hosting the reader on the new participant and letting the indexer read the old one past that moment. If the new participant starts after the next block, the indexer stops and names the gap.

The records export keeps, for each record, the participant it came from and where the indexer began reading it, and nothing of the moves between participants. A database built from an export (`reindex --records`) therefore has every participant it met, but no old participant's last offset, no moved-out time and no `reader_move_N` rows: the audit trail of the moves is not carried across a rebuild, and the indexer carries on correctly without it.

The indexer writes a row of `health_checks` for every check it runs: C1, C2, C3 and C7 are `down` on a failure, C4 (reth's finalized more than one block behind the newest record for over 2 s), C6 (20 random indexed blocks, every 10 minutes, and the whole previous day nightly, fetched again from reth and compared on hash, transaction count, gas used and log count; it names the blocks and follows them until they agree), C10 (the leg hash worked out again differs from `legs[N]`, naming the block; it stays degraded until `clear-check C10`) and `derive_lag` (over 60 s) are `degraded`, and C5 (the index behind the newest record) is `degraded` past 5 s and `down` past 30 s, counted from the record being read, or from the ledger end being ahead of the index when no record can be read. When reth's finalized block cannot be read, C4 is `degraded` with the error, and C5 and `derive_lag` are still written. `db_ids` reads every id column that counts up (an identity or serial column) in the explorer's database and takes the fullest one's use of the largest value its type holds: `ok` up to 50%, `degraded` above 50% (the detail names the table and column and the percent), and `down` above 90%, which turns `/healthz` and the uptime check on `/api/health` red. Its value lists the three fullest columns. It runs every 2 s with the other refreshed checks; a row that is not refreshed counts as `degraded`. When the id columns cannot be read, the row is `degraded` with the error, and the other rows are still written.

The API instances and the verifier write rows too. Each API instance writes `api/<instance>/reth` and `api/<instance>/canton` (`down` when it cannot reach them) every 5 s, and removes the rows of instances that have been gone for 10 minutes. The instance that holds the faucet's lock writes `faucet` (`degraded` when its balance is below one payout, cannot be read, or its queue has not moved for 2 minutes), and the one that holds the tracker's writes `tracker` (`degraded` when it gave up on more than 5 transactions in the last hour). The verifier writes `verifier/compilers` and `verifier/queue` (`degraded` at worst); with no verifier there are no rows and that is not a failure. A row of another API instance is shown but counts at most `degraded` in this instance's answer, so one instance that loses reth does not take the others out of the load balancer. The status each check may reach, and how often its row is refreshed, are in `server/health.ts`; `/api/status` and `/healthz` read the same model for the indexer's rows.

The five large tables (`transactions`, `tx_traces`, `logs`, `internal_calls`, `token_transfers`) are split by block number into partitions of a fixed width, 250,000 blocks. The width is written to `meta` (`partition_width`) on the first run and cannot change afterwards; a later run that names no width uses the recorded one, and one that names another is refused. Two maintenance runs at the same time take turns. `server/db/partitions.ts` makes every partition from block 0 up to the head, and two more ahead of it, so that an insert never meets a block number with no partition. `db/schema.snapshot.txt` describes the schema as the database holds it; the tests compare a fresh database with it, so a change to the schema shows up in review. After a deliberate change, `UPDATE_SNAPSHOT=1` rewrites it.

The database tests need a PostgreSQL, and are skipped when `EXPLORER_TEST_DATABASE_URL` is not set. It names a database on a server where the user may create databases; each test makes one of its own and drops it. CI runs them against the image that `PINS` pins.

## Tests

From the repository root:

```sh
cd explorer
npm ci
npm run typecheck
npm test                         # vitest run
npm run build
```

On a laptop, run vitest with two workers so that the machine stays cool: `npx vitest run --maxWorkers=2`. One file or one test is `npx vitest run server/tracker.test.ts` or `-t '<name>'`. A page test asks for the browser-like environment on its first line (`// @vitest-environment jsdom`); the rest run in Node. `vitest.config.ts` includes `server/`, `src/`, `test/` and `e2e/`.

The page tests (`src/**/*.test.tsx`) render the pages with Testing Library against a fetch that answers as the server's API does; their status answer is held to the fields the server serves. The server tests run against a small fake reth (`test/fake-reth.ts`) and a small fake Ledger API (`test/fake-ledger.ts`), so they need no chain and no GPU. The proof tests read the recorded proof in `demo/results/run1-proof.hex` and check it against the pins in `prover/fixtures/session.txt`. `test/run-sh.test.ts` runs `run.sh` with `EXPLORER_DRY_RUN=1` and checks the Docker commands it prints.

Some tests need something the machine may not have, and are skipped without it:

| Needs | Set | What runs |
|---|---|---|
| A PostgreSQL | `EXPLORER_TEST_DATABASE_URL`: a database on a server where the user may create databases. Each test makes a database of its own and drops it | The database tests: migrations, partitions, the schema snapshot, both stages of the indexer, the REST routes on real rows, the tracker and the faucet stores, the stats rollups |
| A PostgreSQL, and a failure when it is missing | `EXPLORER_TEST_REQUIRE_DATABASE=1` with the URL | The same, but a missing URL fails the run instead of skipping. A CI job that must run them sets it |
| The tracker and the faucet on the database | `EXPLORER_TEST_STORE=database` | The existing tracker and faucet tests, against the database in the files' place |
| Docker and the pinned sandbox image | `EXPLORER_TEST_REQUIRE_SANDBOX=1` makes a missing Docker a failure | The verifier's sandbox, for real: a compile in a container with no network, a memory limit and a time limit |
| Canton's OpenAPI document | `CANTON_OPENAPI`, a JSON copy of it | The explorer's Ledger API requests, field for field, against what Canton says it takes |
| A running explorer and chain | `EXPLORER_URL`, `RUN1_FILE`; for the ethers checks also `CHAIN_ID`, `ETHERSCAN_ADDRESS`, `ETHERSCAN_BALANCE` and `ETHERSCAN_TX` | `e2e/running.test.tsx` and `e2e/etherscan.test.ts`. `tests/demo_rehearsal.sh` sets them |
| A built explorer and a browser | `BASE` (the explorer's address); `BLOCK`, `TX` and `TOKEN` to add a block, a transaction and a token page; `MAIN`, a server with main's build, for the header comparison | `node e2e/layout-check.mjs`, which needs `playwright-core` and a Chromium. It checks: every small i's note at 390, 1280 and 1440 px sits whole inside the screen and closes on a second tap and on Escape; the header's links share one row from 1280 px, and the search shows its whole hint from 768 to 1440 px; no Stats tile runs past its card in any window; an 8-digit count stays inside every count tile on home and Stats from 390 to 1440 px; and, with `MAIN`, the header is no taller than main's at any width from 721 to 1440 px (without `MAIN` that part is left out). It prints each `BAD` and exits non-zero if there is one |

For example, with a PostgreSQL on the loopback:

```sh
EXPLORER_TEST_DATABASE_URL=postgres://<user>:<password>@127.0.0.1:5432/postgres EXPLORER_TEST_REQUIRE_DATABASE=1 npx vitest run --maxWorkers=2 server/db server/indexer
```

`db/schema.snapshot.txt` is compared with the schema a fresh database ends up with. After a deliberate change to the schema, `UPDATE_SNAPSHOT=1` rewrites it.

`check-ledger-api.sh` starts the participants of the pinned Canton and saves the OpenAPI document that Canton writes about its own Ledger API, and `server/ledger.openapi.test.ts` checks the explorer's requests against it and the fake's answers for their shape. CI runs this in the Node image that `PINS` names (`EXPLORER_NODE_IMAGE`). The packages are pinned to exact versions in `package.json` and `package-lock.json`.

`.github/workflows/explorer.yml` runs these jobs on a pull request: `tests` (typecheck, tests and build, in the pinned Node image), `database` (every server test except the verifier's and the contract tools', which `verifier-sandbox` runs, against the PostgreSQL that `PINS` pins, so the database tests, L1 and the REST route tests run on real rows; then the tracker and faucet tests against the database store, and `migrate` twice, to see that the second run applies nothing), `l2` (the scaled L2, 3,000,000 transactions and 120 s), `verifier-sandbox`, `ledger-api` and `verify-wasm`. W1 runs in the rehearsal of `.github/workflows/demo.yml`.

## Verify

`verify/` is a small Rust crate that builds the sidecar's own block check for WebAssembly, and `src/verify/verifier.ts` loads it and runs it on a block's `proofHex`, `headerHex` and `txsHex` and the two pins from `/api/status`. `src/verify/VerifyPanel.tsx` is the card the block page shows: "Verify this block in your browser". It is a component of its own and takes everything as props (the record's three fields, the block's hash from reth, the pins with their file, whether the block is still being proven, and where the `.wasm` is served from), so the page only has to hand it what `/api/block` and `/api/status` give. The block page hands it the record, the block's hash, the key for the block's height from `/api/status` (the pins of the key range the block falls in) and the file's size. It downloads the module when the visitor presses Verify, and not before, once per panel.

The panel has five looks: not run; running; passed, with what was checked; failed, with the check's own reason; and greyed, with its button off, while the block is being proven (there is no record to check yet). A pass counts only if the block hash the proof commits to is the hash reth gives for this block. Passed and failed both show how long the check took in the visitor's browser (the check alone, not the download) and the size of the file that was downloaded. `moduleSize` is optional: give it to say how big the download is before the button is pressed. The block page reads it from the length in the server's answer to a HEAD request for the file, so nothing is downloaded to learn it, and leaves it out when the server does not say. The panel's styles are in `VerifyPanel.css`, scoped to `.verify`, and take their colours from the page's theme variables.

The check holds the page while it runs. In Node on GitHub's CI runners, one check took 8 to 32 ms. The timed check verifies the recorded proof, then refuses a header that does not match it. That is not a successful full-block check or a browser measurement. See [verify/README.md](verify/README.md). The explorer serves the module from `/verify/zk_explorer_verify.wasm`. `npm run build:verify` builds it (it needs Rust's `wasm32-unknown-unknown` target) and puts it in `public/verify/`, which git leaves out; `npm run build` then copies it into `dist/verify/` with the rest of the pages. Without it the Verify button says the check could not be downloaded. The `verify-wasm` job in `.github/workflows/explorer.yml` builds the module, checks that the pages' build serves it, and runs when the sidecar, the verifier or the trie checker change.

### The tracker and the faucet on the database

Set the database and the explorer applies the migrations at start, then runs the tracker and the faucet on it. The behaviour is the one described above; what changes is where it is kept and who runs it.

- **One leader for each loop.** The tracker's loop and the faucet's worker each run on the one API instance that holds that loop's PostgreSQL advisory lock (a lock that belongs to a connection of its own, so it ends with the instance). The other instances take requests, answer from the shared tables and watch the lock. When the leader stops (it gives the lock up at shutdown) or dies (its connection ends), another instance takes the loop within a poll.
- **Limits across instances.** A faucet request is checked against every instance's requests, and written, in one step behind a lock, so two instances never both take an address's last turn. The 1,000-requests-from-1,000-addresses test runs against this store too.
- **A restart in the middle of a batch.** The signed batch is written before the first send. The instance that takes over (after a restart, or when the leader dies) hands the signed transfers that may be in reth to the tracker and signs nothing twice. The new leader reads every queued and sent row in full before it signs anything, a row only moves forward (queued, sent, then final or failed), and a leader that loses the lock leaves its signed batch as it was written instead of rewriting it, so the next leader finds it and hands it to the tracker.
- **Refusals are counted, never attributed.** A request the faucet turns away for its address, its network address, the hourly cap or a failed human check adds 1 to `faucet_refusals` for that UTC minute and reason, and nothing else is stored with it (no address, no client hash, no ticket). The counts are kept 90 days and feed `faucet.turnedAway` in `/api/stats/summary`. A count is added in memory and written about every 5 s by one upsert (and at shutdown), so a refusal never waits for the database and a crash can lose the last few seconds. Not counted: a request refused by the cool-down after repeated failed checks, and one refused because the check could not be reached, so `captcha` reads low during a flood of failed checks; a window that starts before `faucet_refusals_since` has no count, and says so.
- **Client addresses are kept as keyed hashes**, made with `FAUCET_CLIENT_KEY_FILE`. The hash of a request's client is removed after 90 days, and a request's signed bytes when it is final or failed. A transaction's signed bytes are removed 7 days after it settles.
- **Acceptance** is written to `tx_lifecycle` (`accepted_at`, `accepted_via` = `rpc` or `faucet`, with the sender, the nonce and the tracker's state), in the API's own columns. `final` is never overwritten by another word.
- **Moving over.** With the database set, `TRACKER_FILE` and `FAUCET_STATE_FILE` are read once at start, their contents go into the database (rows that exist are left alone, and the faucet's client addresses are hashed on the way in), and each file is renamed to `<file>.imported`. `run.sh` passes the database on: it mounts `EXPLORER_DB_PASSWORD_FILE` and `FAUCET_CLIENT_KEY_FILE` read-only, forwards `EXPLORER_DB_HOST`, `EXPLORER_DB_PORT`, `EXPLORER_DB_USER` and `EXPLORER_DB_NAME`, and takes `EXPLORER_DATABASE_URL` from the environment without putting it on the command.

The tests for these run with `EXPLORER_TEST_DATABASE_URL` set. `EXPLORER_TEST_STORE=database` runs the existing tracker and faucet tests against the database in the files' place.

## The faucet page

`src/faucet/FaucetPage.tsx` is the page's content: the form, and each way a request can end. It sends the address typed (with the human check's token when the faucet asks for one; the check's script runs again each time the form is on the page and after each request, so the widget is always drawn and its token is always new), and then follows the ticket every two seconds until it is final or failed, in plain words:

- taken: "You are number N in line";
- sent: the transaction's link and Waiting or Being proven, with the note that it is not final yet. If the explorer stopped following the transfer, it says that, and that the chain may still take it;
- final: "is final on Canton", with the block. This is the only word of success, and the page says it only when the explorer's ticket says final;
- failed: the reason, and that the address may ask again;
- the address, the client or the faucet as a whole has had its share, or the line is full: the server's own words, with the wait from `Retry-After` (after a full line the button stays off until it is over);
- not an address, or the faucet is empty or cannot reach the chain, in the server's own words. If the explorer cannot be reached while the page follows a request, it says so and keeps asking.

It also says whether the faucet is on. With no key it shows that the faucet is off and no form. It shows the faucet's address and balance from `GET /api/faucet` with the block the balance is as of (or says it is the newest block's, which may not be final), how many requests are waiting and how many payouts are being proven, how many were sent today (since 00:00 UTC) and how many of those are final, and reads the balance again when a request ends. The batch size from the same answer is stated in the limits (up to that many requests in one block). A Recent sends table lists the faucet's last payouts, read from `/api/addresses/{faucet}/txs?direction=sent` and checked again for the sender. The page takes the coin's name and decimals as a prop (the status answer has them), and a client for the routes (`src/faucet/faucet-client.ts`) as another, so a test can give its own.

The Faucet route renders it with the coin from `/api/status`. The page is a component, rendered inside the explorer's router and shell: it draws no header or footer. Its styles are in `src/faucet/faucet.css`, all under `.faucet-page`. Its colours are the explorer's own names and values, set at the lowest weight, so the shell's set wins where it has one.

## The lifecycle

The producer (`builder/`) writes a journal of what it does, and the indexer loads it into `producer_runs`, `block_attempts`, `attempt_transactions`, `tx_lifecycle` and `pool_samples`. `JOURNAL_DIR` is the producer's `journal/` folder (every `YYYY-MM-DD.jsonl` file in it, rotated ones included, read in order from the place the indexer kept in `cursors`) and `PRODUCER_STATUS_FILE` its `status.json`. Both are only read. `INDEX_JOURNAL_MS` (default 1000) is how often the journal is read. `run.sh start` mounts the builder's work folder (`CZE_WORK_DIR`, default `<state>/builder`) read-only for them when it exists.

Applying a journal line twice does not duplicate its effect, and the lines of a run are processed in the order of their numbers, so a line that arrives late finds its attempt. A line whose attempt has no `cut` line, a line of a format the indexer does not know and a line that cannot be read are counted and said in the health, and so is a gap in the numbers (a line the producer could not write): the counts are kept with the cursor and shown for an hour after the last one. A line cut short by a crash is left until it is whole, or dropped and counted when its file is old. The state of a transaction follows one order whoever writes it: `final` is terminal and beats `replaced`, `dropped` and `lost`; `replaced` is set only when another transaction with the same sender and nonce is final; otherwise the newer event wins.

With more than one block in flight the builder may journal the paid traffic of a commit on its own `paid_traffic` line, after the `answered` line of that attempt (which has no traffic then) and perhaps after the next block's `submitted` line. The indexer puts that number on the attempt's `traffic_bytes`, and on the update when the update is joined to the attempt, only where none is known: a traffic that is already there is never overwritten, and a line with no number changes nothing. An attempt that was `cancelled` (built on a block that did not commit) is closed: it is not in `/api/in-flight`. The stats summary's `prover.byProver` lists each prover's busy time in the part of the window that has happened (the time between the journal's `proof_started` and `proof_ended` of its proofs, clipped to the window, whatever their outcome, test runs left out), its proofs and its share (`busyShare`). A proof is booked under the name its journal lines carry: with one prover that is the prove command's file name, and with two or more only a proof that ended `ok` names the pool's prover, while a failed one names the command again, so a block that failed on every prover shows under the command's name; the stats page shows it as "Each prover busy".

The checks that use it are C8 (every attempt the journal says committed has its update in the index within 10 s, and every indexed block has a committed attempt), C9 (the producer's answer time is not before Canton's record time by more than 100 ms) and the rows `producer_alive`, `producer_state` and `prover` from `status.json` and the journal. All are `degraded` when they fail, which `/healthz` names and still answers 200 for. `producer_state` is degraded when the producer is not `running`, when 3 blocks in a row have failed, or when `waitingToBeResolved` in `status.json` (the block whose outcome is not known) has been set for over 60 s; `blocksUnknown` counts since the producer's loop started and is not read for this. C9 and `prover` read the last six hours of attempts. Without a journal or a status file the blocks are still indexed, the lifecycle stays blank, and the health says so. A chain with no new block is `ok`: the producer's liveness is the age of its status file, never the age of its journal.

## The load tests and the nightly

The explorer is held to budgets (below) by six tests, named L1 to L5 and W1. Their method, the machine they ran on and every number measured are in [docs/METRICS.md](../docs/METRICS.md): "The indexer on a real chain (W1)", "The API at scale (L2)", "The nightly load test" and "What CI runs".

| Test | Where | What it does |
|---|---|---|
| L1 | `server/indexer/indexer.test.ts`, tests named `L1:` | Blocks of 0 to 5,000 transactions through both stages of the indexer, on the pinned PostgreSQL |
| W1 | `tests/demo_rehearsal.sh` | The worst-case block that the 30 Mgas cap allows, on the rehearsal's real chain, indexed into a database of its own |
| L2 | `test/l2/` | The API at scale: a seeded database, a mixed load at a fixed rate, live-stream clients and ingestion running. It runs only with `L2=1` and the database URL. `L2_TRANSACTIONS`, `L2_SECONDS`, `L2_RATE`, `L2_SSE` set its size, `L2_RESULTS` names the JSON file for its numbers and `L2_KEEP_DATABASE=1` keeps the seeded database for a look at query plans |
| L3 | `tests/demo_nightly_l3.py` | A flood of blocks of plain transfers through the real builder, timed from the moment the block's record can be read on the reader's participant until the block's row is visible in the explorer's PostgreSQL. The API's first answer after that and the live stream's delivery are reported separately, and page rendering is not timed |
| L4 | `test/l4/` | The pages opened cold in a browser on a slow link: largest contentful paint, script size and calls before the first paint |
| L5 | `test/l5/` | Developers' tools against the Etherscan-compatible API: the proxy module, `forge verify-contract`, `hardhat verify` and `cast` |

`.github/workflows/explorer-nightly.yml` runs them every night at 02:17 UTC and by hand (`workflow_dispatch`, with the sizes as inputs), and never on a pull request. The one exception is a pull request that changes the nightly's own files: it runs a short version of everything, so that a change is seen to run before it merges. A pull request otherwise runs L1 and the scaled L2 in `explorer.yml`, and W1 in the rehearsal of `demo.yml`. Each job keeps its numbers as an artifact and writes a summary to the run.

## Limits and budgets

The limits are stated where each part is described. This table lists them in one place.

| What | Limit |
|---|---|
| REST routes and `/healthz` | 20 a second per client, bursts of 60 (see [Rate limits](#rate-limits)) |
| Etherscan-compatible `/api` | 10 a second and 600 a minute per client; 8 MiB of `input` or `data` in a `txlist` or `getLogs` page |
| Verification | 30 an hour per client; the source at most 500 KB |
| `/rpc` | `RPC_RATE_PER_MINUTE` (300) per client; body at most 256 KiB; batch at most 20; 64 requests answered at once across all clients |
| Live streams | 4 for a client, 5,000 for an instance |
| Pages of a list | 25 by default, 100 at most |
| Transaction tracker | `TRACKER_MAX` entries (10,000), `TRACKER_MAX_BYTES` (16 MiB), `TRACKER_PER_SENDER` open entries (64), `TRACKER_MAX_PENDING_MINUTES` (60) |
| Faucet | `FAUCET_AMOUNT` per request (1), one request per address per day, one per client per 10 minutes, `FAUCET_MAX_PER_HOUR` (5,000), queue of `FAUCET_QUEUE_MAX` (5,000) |
| Indexer reads of reth | `READ_CALL_GAS` (100,000) per `eth_call`; an answer over 4 KB of data is dropped |

The budgets that the load tests hold the explorer to are these. Each is checked by the test named beside it, and the measured figures are in [docs/METRICS.md](../docs/METRICS.md).

| Budget | Limit | Test |
|---|---|---|
| Stage 1 of the worst-case block | at most 2,750 ms (`B1_MS` in `test/budgets.ts`) | L1, W1, L3 |
| Both stages of the worst-case block | at most 12,750 ms (`B2_MS`); on GitHub's shared runner W1 is checked against 16,000 ms (`B2_RUNNER_MS`, 1.25 times `B2_MS`, rounded to 250 ms) | L1, W1 |
| One block, transaction or address through the API | p95 at most 100 ms; an address's page of transactions at most 300 ms; a list page at most 200 ms; search at most 100 ms; `getLogs` at most 500 ms | L2 |
| A new final block to 2,000 stream clients | p95 at most 500 ms, and every block received by the one stream client of L3 | L2, L3 |
| Home, Block and Transaction on a 10 Mbit/s, 100 ms link | largest contentful paint at most 2.0 s, at most 200 KB of gzipped script | L4 |
| Database size | at most 2.5 GB per million transactions | L2, L3 |
| `/api/health` | p97.5 at most 50 ms, and no answer other than 200 | L2 |

