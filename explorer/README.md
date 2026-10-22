# explorer

A block explorer and faucet for Ostia, a Canton zkEVM (chain id 770101). It shows each block next to its record on Canton, and gives out the chain's test coin, tROME.

The explorer combines EVM data from reth with block records from Canton. The block page's Verify button checks the proof in the visitor's browser and is greyed out while a block is being proven.

## Running it

The explorer runs as a container beside the chain it shows, on the same machine. `run.sh` builds the image and starts it:

```sh
explorer/run.sh setup        # the faucet's key for this run, and a genesis that funds it
CZE_GENESIS_FILE=state/faucet/genesis.json network/up.sh
explorer/run.sh start        # then open http://127.0.0.1:8088
explorer/run.sh stop
```

The explorer shows the chain from its own PostgreSQL, which the indexer fills, so `start` does three things before the explorer runs: it starts the database that `network/explorer-db.sh` makes for this state folder (unless it is already up, or `EXPLORER_DATABASE_URL` or `EXPLORER_DB_PASSWORD_FILE` names another), applies the migrations, and starts the indexer as its own container (`cze-explorer-indexer`). The explorer answers 503 on `/healthz` until the indexer has started, and it says so whenever the indexer's checks go stale or one has stopped it. A stopped indexer is not restarted by itself: read its log (`docker logs cze-explorer-indexer`), then `explorer/run.sh start` again. `stop` stops both. The database follows the network's life: when the state folder has no `persist.env` (a network made without `CZE_PERSIST`), `stop` also removes the database that `start` made (`network/explorer-db.sh wipe`), as `network/down.sh` does, so the next chain, made from the same genesis, starts with an empty one and the indexer does not meet the old chain's rows. A persistent network keeps it, and `start` reads the database's container and port from `persist.env`. A database you name yourself is never removed. The faucet's hash key is made once, as `faucet/client-key` in the state folder, when there is a faucet key and `FAUCET_CLIENT_KEY_FILE` names none. The indexer reads reth and Canton where the explorer does, or at `INDEXER_RETH_RPC_URL` and `INDEXER_LEDGER_URL` when those are set; `GATEWAY_ADDRESS` comes from `PINS`, and its genesis is `<state>/genesis.json`, the one reth runs (`GENESIS_FILE` names another): the indexer seeds the chain's contracts from it at its first start, and `start` stops, naming the setting, when there is none.

`setup` comes before the network starts, because reth starts from that genesis (see [The faucet](#the-faucet)). `start` takes what it needs from the run's state folder (`CZE_STATE_DIR`, `./state` by default): the reader party from `canton/parties.env`, the run's own pins from `net/guest.txt` and the faucet's key from `faucet/key`. The caller can set `READER_PARTY`, `PINS_FILE` and `FAUCET_KEY_FILE` instead, and any of the [settings](#settings) below. With no key the faucet is off.

Neither `network/up.sh` nor `run.sh start` runs the builder. A payout waits for the next proven block, so run the builder once per block, as `network/smoke.sh` does: `CZE_LEDGER_USER=builder CZE_BUILDER_PARTY=$(sed -n 's/^BUILDER_PARTY=//p' state/canton/parties.env) CZE_FEE_RECIPIENT=<address> state/venv/bin/python3 builder/builder.py once`. The other settings are in [builder/README.md](../builder/README.md#settings).

The container runs on the host's network, because the explorer reads reth and Canton on the machine's own ports, and it listens on 127.0.0.1 only. It runs as the user who starts it, with a read-only filesystem and no added rights, and it gets the pins file and the key as read-only files. This needs Docker on Linux.

`Dockerfile` has three stages. The first builds the Verify check for WebAssembly with the Rust toolchain that `rust-toolchain.toml` pins. The second builds the pages from the lockfile. The third is the server with the pages and the check's file, and nothing else: no tests and no development packages. Both base images come from `PINS` (`EXPLORER_NODE_IMAGE` and `EXPLORER_RUST_IMAGE`), by digest, and `run.sh` passes them in; the Dockerfile has no image of its own. The recorded session's pins, `prover/fixtures/session.txt`, are in the image, for a run that gives no pins file.

`tests/demo_explorer_static.sh` checks the pins, the Dockerfile and what `run.sh` gives the container, without Docker. The rehearsal in `tests/demo_rehearsal.sh` starts the explorer against the chain it runs, with no GPU. On run 1's block it checks the page (the Canton side, the update id, and that Verify says no, because the rehearsal's proof is a stand-in). It checks that the faucet sends 1 tROME, and refuses the same address a second time. And it checks from a log of the calls that the explorer and its indexer asked Canton only for the ledger end, the updates and the participant id (the updates as the reader party and for the block record alone), and that the explorer asked reth only for `eth_`, `net_` and `web3_` methods (the indexer reads reth directly, and also asks for `trace_` methods). The page checks are in `e2e/running.test.tsx`, which runs only when `EXPLORER_URL` and `RUN1_FILE` are set.

## Settings

The server takes its settings from environment variables. A wrong value stops it at start, with a message that names the variable.

| Variable | Default | What it is |
|---|---|---|
| `EXPLORER_HOST`, `EXPLORER_PORT` | `127.0.0.1`, `8088` | Where the explorer listens |
| `RETH_RPC_URL` | `http://127.0.0.1:8545` | The chain's reth HTTP RPC |
| `LEDGER_URL` | `http://127.0.0.1:7577` | The JSON Ledger API of the participant that holds the reader party |
| `LEDGER_TOKEN_FILE` | none | A file with the bearer token (a JWT) for a participant whose Ledger API needs a login, such as an existing participant on the Canton Network's DevNet. Mode 0600 or the server refuses it (and sends nothing); it is read again on every Ledger API call, so a refreshed file is picked up with no restart; its value is never logged or put in an error. The indexer reads the same setting. With no file, no `Authorization` header is sent, as before. `run.sh` mounts the file read-only, and takes `CZE_TOKEN_FILE_READER` (the `ostia-reader` user's file, see `network/README.md`) when `LEDGER_TOKEN_FILE` is not set |
| `READER_PARTY` | none, required | Canton's id for the reader party. The server stops at start, naming it, when it is not set |
| `PINS_FILE` | `prover/fixtures/session.txt` | A file of `key=value` lines with `programVK` and `rootC`: the proving program and ZisK release this explorer expects. A run's `state/net/guest.txt` has the same form |
| `CHAIN_ID`, `CHAIN_NAME`, `COIN_SYMBOL` | `770101`, `Ostia`, `tROME` | How the chain and its native coin are named on every page |
| `RPC_TIMEOUT_MS`, `POLL_MS` | `5000`, `2000` | How long one call to reth may take, and how often the transaction tracker looks at the transactions it holds |
| `READ_CALL_GAS` | `100000` | The gas limit of every `eth_call` the indexer makes (a token's name, symbol, decimals, total supply and balances, and the proxy reads), so a contract that spends all the gas it gets costs a short read and not a long one; a low limit also bounds the memory reth builds for the answer (memory expansion costs gas), and honest reads cost a few thousand gas, tens of thousands behind a proxy. An answer longer than 4 KB of data is dropped before it is decoded, and counts as not answered too. A call that runs out of gas counts as not answered: the token's metadata is `failed`, a balance is `unanswered`, and the block goes on |
| `PUBLIC_RPC` | `0` | Set to `1` to serve the public RPC at `POST /rpc`. See [The public RPC](#the-public-rpc) |
| `RPC_RATE_PER_MINUTE` | `300` | Calls per client address per minute on `/rpc`. A batch counts each of its calls |
| `TRUSTED_IP_HEADER` | none | The request header that holds the client's address, such as `X-Real-IP`, for a server that sits behind a proxy that writes it. With none, the address of the connection is used |
| `EXPLORER_DATABASE_URL`, or `EXPLORER_DB_PASSWORD_FILE` with its parts | none, and the explorer does not start without it | The explorer's database (see [The database](#the-database)). It holds the chain the indexer writes, which the block and transaction pages read. The tracker and the faucet keep their state in it instead of in their files, only one API instance runs each loop, and `TRACKER_FILE` and `FAUCET_STATE_FILE` are imported once and renamed to `<file>.imported` |
| `TRACKER_FILE` | none | Where the transaction tracker keeps its list across restarts. With none, the list is in memory only. `run.sh` mounts a writable folder for it and sets `/var/lib/explorer/tracker.json` |
| `TRACKER_MAX`, `TRACKER_MAX_BYTES`, `TRACKER_PER_SENDER`, `TRACKER_MAX_PENDING_MINUTES` | `10000`, `16777216`, `64`, `60` | The most entries the tracker holds, the most characters of signed transactions it holds for open entries, the most open entries one sender may have, and how many minutes an open entry may stay without a block before it is dropped. See [The transaction tracker](#the-transaction-tracker) |
| `FAUCET_KEY_FILE` | none | The faucet's key. With none, the faucet is off |
| `FAUCET_CLIENT_KEY_FILE` | none | Required with a database and a faucet: 64 hex digits in a file that only its owner can read (`chmod 600`). Client addresses are stored only as an HMAC-SHA-256 of the address (an IPv6 client by its /64) made with this key. The key never goes in the database. Lose it and clients' per-address limits start over |
| `FAUCET_AMOUNT` | `1` | Coins given per request |
| `FAUCET_PER_ADDRESS_SECONDS`, `FAUCET_PER_IP_SECONDS` | `86400`, `600` | One request per address per day, and one per client address (see `TRUSTED_IP_HEADER`) per 10 minutes |
| `FAUCET_MAX_PER_HOUR` | `5000` | The most requests the faucet accepts in any hour, from everyone |
| `FAUCET_BATCH`, `FAUCET_QUEUE_MAX` | `100`, `5000` | The most transfers sent in one batch, and the most requests waiting for a batch. Past the second the faucet answers 503 |
| `FAUCET_STATE_FILE` | none | Where the faucet keeps its limits and the requests still waiting, across restarts. With none, they are in memory only. `run.sh` sets `/var/lib/explorer/faucet.json` |
| `CAPTCHA_SECRET` | none | Turns on the human check. With it set, the four settings below are required. With none, there is no check |
| `CAPTCHA_VERIFY_URL`, `CAPTCHA_SCRIPT_URL`, `CAPTCHA_SITE_KEY`, `CAPTCHA_WIDGET_CLASS` | none | Where the explorer verifies a token, the script the page loads, the site key it gives that script, and the class name the script looks for to put its widget in |

## What it reads from reth

Only the `eth_` methods listed in `server/reth.ts`. reth's HTTP port serves `eth`, `net` and `web3`, so the explorer cannot list the pool of waiting transactions. It never uses the builder's WebSocket port or the Engine port, and it never starts a node. The reader refuses any method that is not on its list, before it makes a call.

## What it reads from Canton

Two calls on the JSON Ledger API of the participant that holds the reader party, and no others (`server/ledger.ts`): `GET /v2/state/ledger-end`, and `POST /v2/updates` for the transactions after the last offset the explorer has seen. Every request names only the reader party and the block record template, and asks for the ACS delta. For each block record the explorer keeps the update id, the record time and the record's fields: number, hash, parent hash, header, transactions and proof, and the party ids of the two signers, the chain's operator and confirmer. It reads the builder's and the reader's party ids too, and keeps neither. The reader refuses any call that is not on its list, before it makes it.

`READER_PARTY` must be set. The local network runs without Ledger API authentication, so it is this code, and its test of what it asks for, that keeps the explorer to the reader party's view. The reader party shares the users participant with other parties, and without Ledger API authentication anyone who can reach that participant can read all of them. Do not give the explorer a public address before that changes. A participant that has a login (an existing participant, `LEDGER_TOKEN_FILE` above) is read with the reader user's token, which can read only what that user's rights allow: set it up with read-only rights on the reader party, as `network/external/setup.py` does for `ostia-reader`. Tokens there last minutes, so write each new one into the same 0600 file, in place.

## What a proof says

`server/proof.ts` reads three facts from the bytes of a block's proof: the program key, the ZisK release and the block hash its public values commit to. It compares each with this explorer's pins and with the block the record is for. Reading a value is not verifying the proof. Canton's confirmers verified it when the block committed, and the Verify button runs that check again, in the visitor's browser (see below).

## Final blocks, from the database

The block and transaction pages read the final blocks from the tables the indexer fills (`server/chain-db.ts`; the tables are in [The database](#the-database)). The server holds no copy of the chain in memory, and it does not walk Canton: the indexer does that, with its checks (reth's hash against the record's hash and the Keccak of its header, block 1 against reth's genesis, the records in order). The server only reads what the indexer wrote.

A block that the indexer has not written yet is shown from reth, with no Canton side. At or below reth's `finalized` block it is `unindexed` (final on Canton, and the page says it is not indexed yet; a transaction in it is `unindexed` too); above it, it is `proving`. The status says `starting` until the indexer has written its first record, goes red with the text of each failed check the indexer keeps, and goes red naming the database when it cannot be read. A check the indexer refreshes every 2 s (C4, C5, `derive_lag`, C10) that has not been looked at for three rounds (6 s) counts as failed ("C5: the indexer has not checked in N s"), so a stopped or crashed indexer turns the status and `/healthz` red instead of leaving its last `ok` rows behind. One of them with no row at all counts as failed too ("C5: the indexer has not checked yet"), as after a rebuild from a records export, or in the first seconds of a new indexer. The home page does not name a block as being proven when reth's `finalized` block already covers it. The routes answer 502 for a database that cannot be read.

The explorer needs the database. Without `EXPLORER_DATABASE_URL` (or `EXPLORER_DB_PASSWORD_FILE` with its parts) `npm start` refuses to start and says so.

## The server and its API

`npm start` runs `server/main.ts`: one process on plain `node:http`. It serves the pages from `dist/` (set `EXPLORER_DIST` to use another folder), gives the home page for any route the pages own, and answers `/api/*`. It reads the final blocks from the database, and reads reth for what the database does not hold: a block still being proven, a transaction waiting in the pool, an address.

| Route | Answer |
|---|---|
| `GET /api/status` and `GET /healthz` | The same answer. The status code is 200 when reth and Canton can be read and the indexer has started and none of its checks is `down` or has stopped being refreshed, and 503 when not. A `degraded` check (the producer's rows with no journal or status file, a failed proof, C8) is named in `problems` and `ok` is false, but the answer stays 200: only a `down` check turns the load balancer's health check red. It names the chain, its coin, the pins, the newest final block, the newest ten final blocks (`latest`, newest first, for the home page's list), the block being proven if there is one, and the two signers of the block records |
| `GET /api/block/:number-or-hash` | The block's EVM side, and its Canton side when it is final: update id, record time, proof facts, whether the three hashes match, and the record's proof, header and transactions as hex. Its status is `final`, `proving`, `unindexed` (final on Canton, not yet written by the indexer) or `genesis` |
| `GET /api/tx/:hash` | The transaction, its receipt, the decoded ERC-20 `transfer` if it is one, and its status: `final`, `proving`, `unindexed` (its block is final on Canton, and the indexer has not written it yet) or `waiting` (in reth's pool, in no block yet). It also carries `state` (`pending`, `proving`, `final`, `replaced`, `dropped`) and `reason`, a plain sentence or null, from the [transaction tracker](#the-transaction-tracker). A transaction that reth no longer holds, but that this chain accepted, still answers with its state instead of 404. A hash that neither reth nor the tracker knows is 404. `lifecycle` is where the transaction has been, from the producer's journal and the API: its state, when it was accepted (and through what), included in a block, proving started and ended, submitted, committed on Canton and final, the number of attempts that held it, the reason it was last left out of a block, and the time to final; its fields are null for a stage that has no time, and the whole of it is null when no row is kept for the transaction |
| `GET /api/in-flight` | The block attempts that are not final yet: cut, built, proving, proved, submitted, or committed on Canton and not indexed yet, with their times, and reth's pool count from the producer's latest sample. It says `final: false`: nothing here is a fact of the chain until its block is final. It is empty when there is no journal |
| `GET /api/address/:address` | Balance, count of sent transactions, whether it is an account, a contract or a token, and the transaction that created it, if a block the database holds did |
| `GET /api/search?q=` | The page to open for what was typed (a block number, a block or transaction hash, an address or a Canton update id), or 404 |
| `GET /api/faucet` | Whether the faucet is on, its address, its balance, what it gives per request and how long an address waits between requests |
| `POST /api/faucet` | Takes a request for coin: the address in the body, `{"address": "0x…"}`, and the human check's token as `captcha` when the faucet asks for one. Answers 202 with a ticket. See [The faucet](#the-faucet) |
| `GET /api/faucet/ticket/<id>` | Where a request is: queued (with its place in line), sent (with the transaction hash and the tracker's word), final (with the block), or failed (with the reason) |

Amounts are whole numbers as decimal strings, in the coin's smallest unit. Each answer, and each object inside it, carries exactly the fields listed in `FIELDS` in `server/api.ts`, built one field at a time; the field test gives the server objects with extra fields and checks that none gets through. No raw Canton answer reaches the API, and no party id except the two signers of the block records. A request target that is not a path is a 400, and a route that does not exist is a 404. A failed read of reth or Canton is a 502 with a plain message, and the detail goes to the server's log.

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

Limits: a body of at most 256 KiB (413 above it), a batch of at most 20 calls, and a token bucket for each client that holds `RPC_RATE_PER_MINUTE` calls and refills steadily (429 with `Retry-After` when it is empty). An IPv6 client is one client for its whole /64, so changing the last half of an address gives no new bucket. All clients together may have 64 requests being answered at one time, and a request past that gets 503 with `Retry-After: 1`, so that many addresses cannot saturate reth. The client address is the connection's address, or, when `TRUSTED_IP_HEADER` names a header, the last address in that header. Use `TRUSTED_IP_HEADER` only when the port can be reached only through a proxy that you run and that writes the header. If clients can reach the port directly, they can write the header themselves and choose their own bucket. An unexpected error inside `/rpc` is answered as a JSON-RPC error with the CORS headers, so a browser page can read it. A call to reth that takes longer than `RPC_TIMEOUT_MS` is answered with an error, and the detail goes to the log. The pages show an "Add Ostia to your wallet" button and the RPC address on the home page and the faucet page when the RPC is on (`publicRpc` in `/api/status`).

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

With `TRACKER_FILE` set, the list is written to a temporary file that is then renamed over the real one, so a crash never leaves half a file. A burst of sends is one write, a second or so after the last change, and nothing is written when nothing changed. On SIGTERM or SIGINT the server stops, writes the list and then exits, so the transactions accepted just before a restart are in the file. `run.sh` mounts `<state>/explorer` as the only writable folder of the read-only container, and the list lives there.

The Canton update id of a final transaction is filled in when the database holds the block, which can be a poll after reth's finalized number passes it.

## The pages

The pages are a small React app in `src/`, built by Vite into `dist/`, which the server serves. `npm run build` makes the build, and `npm run dev` serves the pages while you work on them, with `/api` passed on to a server on the default port.

Every page has the same header (the chain's name and id, which link home, a search box and a link to the Faucet) and ends with the same line about how the explorer reads Canton. The name and the id come from `/api/status`; until it has answered, the header says Ostia. Search sends what was typed to `/search?q=`, which asks the server what it is and opens that page, so a search is also a link. Nothing found says so, in the server's own words, and so does a block, transaction or address that does not exist.

- **Home** shows the status strip, the newest ten final blocks and a box saying what the explorer can and cannot show. It asks for `/api/status` again every two seconds. The strip and the server's health check read the same answer, so they cannot disagree. The time to commit shown is Canton's record time minus the block's timestamp, rounded to whole seconds. The timestamp comes from the builder's clock, in whole seconds.
- **Block** (`/block/:number-or-hash`) shows the block's EVM side from reth next to its Canton side: the update id, the commit time, the record and the two parties that signed it, whether reth's hash, the record's hash and the hash of the record's header agree, and the three facts read from the proof (program key, ZisK release, block hash) next to this explorer's pins. A fact that does not match is shown in red with the value that was read; a proof that is not 1,344 bytes gets one red line instead. Under the two sides come the line saying Daml legs are not shown (with no count), the same five steps for every block with only the two measured times, the block's transactions, and the record's data (proof, header and transactions, with their sizes and a copy button each). A block that is still being proven shows its EVM side and says it is not on Canton yet; block 0 is shown as Genesis and checked against block 1's record. The page looks again every two seconds until the block is final, and says Not found when Canton refuses a block that was being proven. The Verify panel sits between the transactions and the record's data, and is greyed out while the block is being proven.
- **Transaction** (`/tx/:hash`) shows the result, the block and its Canton update, who sent it and to whom, the decoded ERC-20 transfer, the value, the fee at its price, the gas, the nonce, the type, the input and the logs. A transaction that is not final says so and where it is on the way (Waiting, Being proven, Final, or Replaced or Dropped, with the reason in plain words), and the page looks again every two seconds until it is settled. Only a page reached by the transaction's hash can say Waiting.
- **Address** (`/address/:address` and `/token/:address`, the same page) shows the balance in the chain's coin from reth's newest block and, for an account, the number of transactions it has sent. A token is named by its own name and symbol, and shows its decimals; a contract or token that a block the database holds created names the transaction and the block.
- **Faucet** (`/faucet`) is the faucet page. See [The faucet page](#the-faucet-page).
- A route that no page owns answers "Not found".

Colours are variables in `src/styles.css`, light by default and dark when the system asks for it. There is no switch and nothing is stored. Times are UTC. Every hash is shown shortened, with a button to copy the whole value and one to read it in full.

The fonts are IBM Plex Sans and IBM Plex Mono, served by the explorer from `public/fonts` (SIL Open Font License; the licence texts sit next to the files). The pages load nothing from another host, and a test holds them to that.

## The faucet

It gives the chain's own test coin, and nothing else: 1 tROME per request (`FAUCET_AMOUNT`). The coin has no value, so there is no login. What matters is that the faucet keeps answering honestly when many people ask at once, and that it never says a coin was sent when it was not.

**A queue, not a lock.** A valid request is taken at once and answered with a ticket (202), never with "busy". A worker drains the queue in batches of up to `FAUCET_BATCH` transfers. A batch takes consecutive nonces from the faucet's pending count in reth. The whole batch is signed first, and its signed transfers and nonces are written to `FAUCET_STATE_FILE` before the first one is sent. Then they are sent one by one, and each is handed to the transaction tracker, so one that is lost from the pool is sent again. The faucet asks the tracker for room before each send, and waits when there is none. The next batch starts when the last one has left the pool. If `FAUCET_QUEUE_MAX` requests are already waiting, the faucet turns the next one away with 503, says so in plain words (nothing was taken, nothing is lost) and gives a `Retry-After`.

**Limits.** All of them are written to `FAUCET_STATE_FILE` (through a temporary file and a rename, so a crash never leaves half a file) and are written again at shutdown after the batch in hand has ended (the shutdown waits for the send it is in the middle of and sends no more), so a restart keeps them and the requests still waiting. A transfer that was signed before a stop or a crash is never signed again: after a restart its request is sent, and the tracker sends it again only if reth does not have it. So an address is not paid twice by a restart:

- one request per address per 24 hours (`FAUCET_PER_ADDRESS_SECONDS`);
- one request per client address per 10 minutes (`FAUCET_PER_IP_SECONDS`). The client address is the connection's, or the header `TRUSTED_IP_HEADER` names when the explorer sits behind a proxy that sets it. An IPv6 client is one client for its whole /64, and an IPv4 address written as IPv6 is that IPv4 address;
- `FAUCET_MAX_PER_HOUR` requests in any hour, from everyone;
- a balance floor: the faucet counts what it has already promised, and when the balance cannot cover one more transfer and its fee it answers 503 "empty". When the balance runs out under a batch, the requests it cannot pay fail with that reason.

A request that comes to nothing (refused by the chain, or its transfer was replaced, or lost and not in reth) gives the address and the client their turn back. When reth does not answer a send, the faucet does not know whether reth has the transfer, so it counts it as sent, hands it to the tracker and stops that batch. The tracker sends it again if it is missing, and the ticket says what became of it. If the tracker stops following a transfer (its list is full, or the transfer sat in reth's pool for `TRACKER_MAX_PENDING_MINUTES`, as in a long prover outage), the faucet asks reth for it: if reth does not have it, the ticket fails; if reth has it, the ticket stays sent and the address keeps its turn, and the faucet follows the transfer by its hash itself. Each pass it looks at up to 20 such transfers, oldest look first, with one call for the transaction and the finalized block, and, when the transfer is in no block, one for the faucet's count of sent transactions as of the finalized block. The ticket becomes final, with its block, when the transaction is in a finalized block. It fails, with a reason, when that count has passed the transfer's nonce and the transfer is in no finalized block, because another transaction took the nonce. This is kept in `FAUCET_STATE_FILE` with the rest, so a restart keeps following it. After two days the faucet stops, and the ticket says that it is no longer followed and to look up the hash.

**The human check (optional).** With `CAPTCHA_SECRET` set, a request must carry a token. The explorer verifies it by posting `secret`, `response` and `remoteip` (form-encoded) to `CAPTCHA_VERIFY_URL` and reading `{"success": true}`. The faucet page loads `CAPTCHA_SCRIPT_URL` and puts its widget, with `CAPTCHA_SITE_KEY`, in the form (`GET /api/faucet` gives the page the script, key and class, never the secret). The names are vendor-neutral: any check that answers this way will do. If the check cannot be reached, the faucet says so and lets nobody in. A client that fails the check 5 times in a minute (a missing token counts) is turned away with 429 (`reason` is `checks`) and a `Retry-After`, without a call to the check, and a client has one check under way at a time. So junk tokens from one client cost the check's service almost nothing and do not fill the places that honest users need. All clients together may have 50 checks under way, and past that a request gets 503 with `Retry-After: 2`. After a request the page draws the widget again, because a token is used once. With no `CAPTCHA_SECRET` the check is off.

**A ticket, and what final means.** `GET /api/faucet/ticket/<id>` says where a request is. A ticket is **final** only when the tracker says its transfer is final on Canton, never before. While the transfer is sent but not final it stays **sent**, with the transaction's hash and the tracker's word (pending or proving). A ticket whose transfer was replaced, or was dropped by the tracker and is not in reth, is **failed**, with the reason. A transfer the tracker stopped following but reth still has stays **sent** (with the state `dropped` while the tracker still holds its entry): it may still land, the faucet keeps following it by hash, and the ticket turns final when the transfer is in a finalized block, or failed when another transaction takes its nonce. The address keeps its turn meanwhile.

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

To run the server directly, use Node 22.18 or newer and the Rust toolchain in `rust-toolchain.toml`. From the repository root:

```sh
(cd explorer && npm ci)
explorer/faucet-setup.sh
CZE_GENESIS_FILE=state/faucet/genesis.json network/up.sh
network/explorer-db.sh start                       # the explorer's database; its password is in state/explorer-db.env
cd explorer
rustup target add wasm32-unknown-unknown
npm run build:verify
npm run build
export EXPLORER_DB_PASSWORD_FILE=../state/explorer-db.env
export READER_PARTY=$(sed -n 's/^READER_PARTY=//p' ../state/canton/parties.env)
export PINS_FILE=../state/net/guest.txt
node server/db/cli.ts migrate
(umask 077; [ -f ../state/faucet/client-key ] || openssl rand -hex 32 > ../state/faucet/client-key)   # the faucet's hash key, made once
# In a second terminal (same exports): the indexer, which fills the database. It never restarts by itself.
GATEWAY_ADDRESS=$(sed -n 's/^GATEWAY_ADDRESS=//p' ../PINS) GENESIS_FILE=../state/genesis.json \
  JOURNAL_DIR=../state/builder/journal PRODUCER_STATUS_FILE=../state/builder/status.json npm run index
# In this one: the explorer.
FAUCET_KEY_FILE=../state/faucet/key FAUCET_CLIENT_KEY_FILE=../state/faucet/client-key npm start
```

To have the database, the indexer and the explorer started in containers instead, with the same files, use `explorer/run.sh start` (see above).

The example uses the default `state/` folder. Set the file paths to the run's state folder if it differs. The database follows the network's life: for a network made without `CZE_PERSIST`, `network/down.sh` removes it with the chain (and so does `explorer/run.sh stop`), so run `network/explorer-db.sh wipe` yourself if you started it by hand and then stopped the network some other way.

The server reads the key only when `FAUCET_KEY_FILE` is set; without it the faucet is off. A key file that is missing or does not hold 64 hex digits stops the server at start, and the message does not quote the file. Nothing mints and nothing tops the faucet up: the next run makes a new key. The key never appears in an answer or in the log, and the tests check that.

## The database

The explorer keeps its data in a PostgreSQL of its own, apart from the one Canton uses, so that a heavy query never slows Canton down. `network/explorer-db.sh` starts it for a persistent network (see [network/README.md](../network/README.md)). The schema is a set of numbered SQL files in `db/migrations/`. There is no ORM, and a migration that has been applied is never edited: a change is a new file.

```sh
# the password file is the one network/explorer-db.sh made in the network's state folder
EXPLORER_DB_PASSWORD_FILE=../state/explorer-db.env node server/db/cli.ts migrate --head 0
```

`server/db/migrate.ts` applies the files that a database has not seen, each in its own transaction, and records the SHA-256 of each file in `schema_migrations`. It refuses to run, and applies nothing, when an applied file has changed, when a file is missing, or when the numbers skip. Run twice, the second run changes nothing.

### A new chain, and a moved reader

The indexer keeps the update id of block 1's record in `meta` as `chain_instance`. A reset of the network starts a new chain from the same genesis, chain id and pins, so at every look the indexer also checks that (a) reth's block at the indexed head is the indexed one, (b) the reader's ledger end is not below the cursor's offset, and (c) the first record after the cursor is block head + 1 (or an indexed block with the same hash). When one fails it stops with the row `chain_instance` set to `down` and exit code 2, and it wipes nothing. Two commands are the only way on, and each refuses to run while an indexer holds the database (`reset` also refuses while an API instance is up, because its tracker and faucet write to the same tables, and refuses a database that is not the explorer's):

```sh
node server/indexer/cli.ts reset --yes                      # empties the explorer's tables for a new chain (keeps the migrations and the partition width)
node server/indexer/cli.ts reader-moved <participant id>    # the reader party is now hosted by this participant; the indexer reads it from its start
node server/indexer/cli.ts clear-check C10                    # C10 is ok again after a person has looked at the block it names; the row keeps who cleared it
```

The same commands run through npm as `npm run explorer -- reset --yes` (the `--` hands the rest to the command, not to npm). Not yet built: a switch for a throwaway local run that resets by itself when it meets a new chain (`INDEX_RESET_ON_NEW_CHAIN`, design section 4.4); today a person runs `reset --yes`.

`reader-moved` adds the participant to `canton_participants`, keeps the old one's last offset, records the move in `meta` (`reader_move_N`) and puts the reader cursor at the new participant's start. Do it after hosting the reader on the new participant and letting the indexer read the old one past that moment. If the new participant starts after the next block, the indexer stops and names the gap.

The records export keeps, for each record, the participant it came from and where the indexer began reading it, and nothing of the moves between participants. A database built from an export (`reindex --records`) therefore has every participant it met, but no old participant's last offset, no moved-out time and no `reader_move_N` rows: the audit trail of the moves is not carried across a rebuild, and the indexer carries on correctly without it.

The indexer writes a row of `health_checks` for every check it runs: C1, C2, C3 and C7 are `down` on a failure, C4 (reth's finalized more than one block behind the newest record for over 2 s), C6 (20 random indexed blocks, every 10 minutes, and the whole previous day nightly, fetched again from reth and compared on hash, transaction count, gas used and log count; it names the blocks and follows them until they agree), C10 (the leg hash worked out again differs from `legs[N]`, naming the block; it stays degraded until `clear-check C10`) and `derive_lag` (over 60 s) are `degraded`, and C5 (the index behind the newest record) is `degraded` past 5 s and `down` past 30 s, counted from the record being read, or from the ledger end being ahead of the index when no record can be read. When reth's finalized block cannot be read, C4 is `degraded` with the error, and C5 and `derive_lag` are still written.

The five large tables (`transactions`, `tx_traces`, `logs`, `internal_calls`, `token_transfers`) are split by block number into partitions of a fixed width, 250,000 blocks. The width is written to `meta` (`partition_width`) on the first run and cannot change afterwards; a later run that names no width uses the recorded one, and one that names another is refused. Two maintenance runs at the same time take turns. `server/db/partitions.ts` makes every partition from block 0 up to the head, and two more ahead of it, so that an insert never meets a block number with no partition. `db/schema.snapshot.txt` describes the schema as the database holds it; the tests compare a fresh database with it, so a change to the schema shows up in review. After a deliberate change, `UPDATE_SNAPSHOT=1` rewrites it.

The database tests need a PostgreSQL, and are skipped when `EXPLORER_TEST_DATABASE_URL` is not set. It names a database on a server where the user may create databases; each test makes one of its own and drops it. CI runs them against the image that `PINS` pins.

## Tests

From the repository root:

```sh
cd explorer
npm ci
npm run typecheck
npm test
npm run build
```

The page tests (`src/**/*.test.tsx`) render the pages with Testing Library against a fetch that answers as the server's API does; their status answer is held to the fields the server serves. The tests run against a small fake reth (`test/fake-reth.ts`) and a small fake Ledger API (`test/fake-ledger.ts`), so they need no chain and no GPU. The proof tests read the recorded proof in `demo/results/run1-proof.hex` and check it against the pins in `prover/fixtures/session.txt`.

One more check runs in CI only. `check-ledger-api.sh` starts the participants of the pinned Canton, saves the OpenAPI document that Canton writes about its own Ledger API, and `server/ledger.openapi.test.ts` checks the explorer's requests against it, field for field, and the fake's answers for their shape. Set `CANTON_OPENAPI` to a JSON copy of such a document to run it yourself; without it, those tests are skipped. CI runs them in the Node image that `PINS` names (`EXPLORER_NODE_IMAGE`). The packages are pinned to exact versions in `package.json` and `package-lock.json`.

## Verify

`verify/` is a small Rust crate that builds the sidecar's own block check for WebAssembly, and `src/verify/verifier.ts` loads it and runs it on a block's `proofHex`, `headerHex` and `txsHex` and the two pins from `/api/status`. `src/verify/VerifyPanel.tsx` is the card the block page shows: "Verify this block in your browser". It is a component of its own and takes everything as props (the record's three fields, the block's hash from reth, the pins with their file, whether the block is still being proven, and where the `.wasm` is served from), so the page only has to hand it what `/api/block` and `/api/status` give. The block page hands it the record, the block's hash, the pins from `/api/status` and the file's size. It downloads the module when the visitor presses Verify, and not before, once per panel.

The panel has five looks: not run; running; passed, with what was checked; failed, with the check's own reason; and greyed, with its button off, while the block is being proven (there is no record to check yet). A pass counts only if the block hash the proof commits to is the hash reth gives for this block. Passed and failed both show how long the check took in the visitor's browser (the check alone, not the download) and the size of the file that was downloaded. `moduleSize` is optional: give it to say how big the download is before the button is pressed. The block page reads it from the length in the server's answer to a HEAD request for the file, so nothing is downloaded to learn it, and leaves it out when the server does not say. The panel's styles are in `VerifyPanel.css`, scoped to `.verify`, and take their colours from the page's theme variables.

The check holds the page while it runs. In Node on GitHub's CI runners, one check took 8 to 32 ms. The timed check verifies the recorded proof, then refuses a header that does not match it. That is not a successful full-block check or a browser measurement. See [verify/README.md](verify/README.md). The explorer serves the module from `/verify/zk_explorer_verify.wasm`. `npm run build:verify` builds it (it needs Rust's `wasm32-unknown-unknown` target) and puts it in `public/verify/`, which git leaves out; `npm run build` then copies it into `dist/verify/` with the rest of the pages. Without it the Verify button says the check could not be downloaded. The `verify-wasm` job in `.github/workflows/explorer.yml` builds the module, checks that the pages' build serves it, and runs when the sidecar, the verifier or the trie checker change.

### The tracker and the faucet on the database

Set the database and the explorer applies the migrations at start, then runs the tracker and the faucet on it. The behaviour is the one described above; what changes is where it is kept and who runs it.

- **One leader for each loop.** The tracker's loop and the faucet's worker each run on the one API instance that holds that loop's PostgreSQL advisory lock (a lock that belongs to a connection of its own, so it ends with the instance). The other instances take requests, answer from the shared tables and watch the lock. When the leader stops (it gives the lock up at shutdown) or dies (its connection ends), another instance takes the loop within a poll.
- **Limits across instances.** A faucet request is checked against every instance's requests, and written, in one step behind a lock, so two instances never both take an address's last turn. The 1,000-requests-from-1,000-addresses test runs against this store too.
- **A restart in the middle of a batch.** The signed batch is written before the first send. The instance that takes over (after a restart, or when the leader dies) hands the signed transfers that may be in reth to the tracker and signs nothing twice. The new leader reads every queued and sent row in full before it signs anything, a row only moves forward (queued, sent, then final or failed), and a leader that loses the lock leaves its signed batch as it was written instead of rewriting it, so the next leader finds it and hands it to the tracker.
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

It also says whether the faucet is on. With no key it shows that the faucet is off and no form. It shows the faucet's address and balance from `GET /api/faucet`, how many requests are waiting, and reads the balance again when a request ends. The page takes the coin's name and decimals as a prop (the status answer has them), and a client for the routes (`src/faucet/faucet-client.ts`) as another, so a test can give its own.

The Faucet route renders it with the coin from `/api/status`. The page is a component, rendered inside the explorer's router and shell: it draws no header or footer. Its styles are in `src/faucet/faucet.css`, all under `.faucet-page`. Its colours are the explorer's own names and values, set at the lowest weight, so the shell's set wins where it has one.

## The lifecycle

The producer (`builder/`) writes a journal of what it does, and the indexer loads it into `producer_runs`, `block_attempts`, `attempt_transactions`, `tx_lifecycle` and `pool_samples`. `JOURNAL_DIR` is the producer's `journal/` folder (every `YYYY-MM-DD.jsonl` file in it, rotated ones included, read in order from the place the indexer kept in `cursors`) and `PRODUCER_STATUS_FILE` its `status.json`. Both are only read. `INDEX_JOURNAL_MS` (default 1000) is how often the journal is read. `run.sh start` mounts the builder's work folder (`CZE_WORK_DIR`, default `<state>/builder`) read-only for them when it exists.

Every line is applied again without harm, and the lines of a run are put in the order of their numbers, so a line that arrives late finds its attempt. A line whose attempt has no `cut` line, a line of a format the indexer does not know and a line that cannot be read are counted and said in the health, and so is a gap in the numbers (a line the producer could not write): the counts are kept with the cursor and shown for an hour after the last one. A line cut short by a crash is left until it is whole, or dropped and counted when its file is old. The state of a transaction follows one order whoever writes it: `final` is terminal and beats `replaced`, `dropped` and `lost`; `replaced` is set only when another transaction with the same sender and nonce is final; otherwise the newer event wins.

The checks that use it are C8 (every attempt the journal says committed has its update in the index within 10 s, and every indexed block has a committed attempt), C9 (the producer's answer time is not before Canton's record time by more than 100 ms) and the rows `producer_alive`, `producer_state` and `prover` from `status.json` and the journal. All are `degraded` when they fail, which `/healthz` names and still answers 200 for. `producer_state` is degraded when the producer is not `running`, when 3 blocks in a row have failed, or when `waitingToBeResolved` in `status.json` (the block whose outcome is not known) has been set for over 60 s; `blocksUnknown` counts since the producer's loop started and is not read for this. C9 and `prover` read the last six hours of attempts. Without a journal or a status file the blocks are still indexed, the lifecycle stays blank, and the health says so. A chain with no new block is `ok`: the producer's liveness is the age of its status file, never the age of its journal.
