/**
 * `GET /api/openapi.json` (design 6.1 and 6.7): what each route is, what it takes and which fields it answers with. The fields are the allowlists of
 * fields.ts themselves, so a field cannot be added to an answer and left out here. The text of each route is written by hand below; a test holds that
 * the routes the API registers and the routes described here are the same set.
 */
import { FIELDS, REST_FIELDS as F } from "./fields.ts";
import { BUFFER_BLOCKS, PER_CLIENT, TOPICS, TXS_MAX } from "./stream.ts";
import { MAX_VERIFY_SOURCE, RULES } from "../limits.ts";
import { MAX_LIMIT, DEFAULT_LIMIT, AROUND_MAX, AROUND_DEFAULT } from "./paging.ts";
import { MAX_LABELS, SORTS } from "./account-routes.ts";
import { TOKEN_MOVES_CAP } from "./chain-rest.ts";
import { MODULES } from "./etherscan.ts";
import { MAX_PAGE_BYTES } from "./etherscan-rest.ts";
import { DEFAULT_WINDOW, METRICS, STEPS, WINDOWS, WINDOW_STEPS } from "./stats-routes.ts";

type Fields = readonly string[];
interface Query { name: string; about: string; values?: readonly string[] }
interface Doc {
  summary: string;
  query?: Query[];
  /** The fields of a single object. */
  object?: Fields;
  /** For an object whose `items` are a list of objects: the fields of each item. */
  items?: Fields;
  /** A page: the fields of each item, and whether the page says if stage 2 had reached it (`derived`). */
  page?: { items: Fields; derived: boolean; /** Fields of the page beside its items, each with what it says. */ extra?: Record<string, unknown> };
  /** The route can also answer as a CSV file (`format=csv`): the 200 then lists text/csv beside JSON. */
  csv?: boolean;
  /** For an answer that is not a list of fields. */
  note?: string;
  /** What `{param}` is. */
  param?: string;
  /** The tag of the group in a viewer. */
  tag: string;
  /** The method, when it is not GET. */
  method?: "post";
}

const limit: Query = { name: "limit", about: `How many rows: 1 to ${MAX_LIMIT}, ${DEFAULT_LIMIT} when left out.` };
const before: Query = { name: "before", about: "The `next` of the page before: this page is the rows after that key, newest first. Leave out for the first page." };
const after: Query = { name: "after", about: "The `next` of the page before: this page is the rows after that key, from the list's other end. Leave out for the first page." };
const raw: Query = { name: "raw", about: "1 for the rows as the chain wrote them, without what the explorer decodes from them (an immutable answer).", values: ["1"] };
const sort = (values: readonly string[]): Query => ({ name: "sort", about: `The order of the list; ${values[0]} when left out.`, values });
const blockFilter: Query = { name: "filter", about: "all blocks, only the blocks with transactions, or only the empty ones (genesis is not one); all when left out.", values: ["all", "transactions", "empty"] };
const txFilter: Query = { name: "filter", about: "all transactions, only the reverted ones (`failed`), or only the calls that name a method (`calls`: sent to an address, with at least 4 bytes of input, which is what names the method; a contract creation and a plain value transfer are left out, and the address may be an account as well as a contract); all when left out.", values: ["all", "failed", "calls"] };
const txCsv: Query = { name: "format", about: "csv for the newest transactions as a file with the list's columns (up to 1000, `limit` sets fewer; no paging); left out for JSON.", values: ["csv"] };
const csv: Query = { name: "format", about: "csv for the newest blocks as a file with the list's columns (up to 1000, `limit` sets fewer; no paging); left out for JSON.", values: ["csv"] };
const around: Query = { name: "n", about: `How many updates on each side: 1 to ${AROUND_MAX}, ${AROUND_DEFAULT} when left out.` };
const topic0: Query = { name: "topic0", about: "Only the logs whose first topic (the event's signature hash) is this: 0x and 64 hex digits." };
const direction: Query = { name: "direction", about: "all of the address's transactions, only the ones it sent (it is the sender, `sent`), or only the ones it received (it is the recipient or the contract the transaction created, `received`); all when left out.", values: ["all", "sent", "received"] };
const addressTxCsv: Query = { name: "format", about: "csv for the address's newest transactions as a file with the list's columns and a `direction` column (the `direction` asked, or sent or received per row when it is all; up to 1000, `limit` sets fewer; no paging; `direction` applies); left out for JSON.", values: ["csv"] };
const transferStandard: Query = { name: "standard", about: "Only the transfers of tokens of this standard (read from each transfer's own columns: an ERC-20 transfer has an amount and no id, an ERC-721 transfer an id and no amount, an ERC-1155 transfer both); all when left out.", values: ["ERC-20", "ERC-721", "ERC-1155"] };
const transferToken: Query = { name: "token", about: "Only the transfers of the token at this 0x address; all tokens when left out." };
const TRANSFER_FIELDS = "Each carries the transaction's `methodId` (its input's first four bytes; null for a creation, whose input is code, or for a call with no input), `creation` (true when the transaction made a contract, so a constructor mint can be told from a call with no input) and `timestamp` (its block's time, in seconds), and the token's `standard` (null where the explorer holds no row for the token).";
const addressTransferStandard: Query = { name: "standard", about: "Only the transfers of tokens of this standard (as for the all-token list), or `nft` for ERC-721 and ERC-1155 together in one list with one cursor (every transfer that has a token id); all when left out.", values: ["ERC-20", "ERC-721", "ERC-1155", "nft"] };
const tokenStandard: Query = { name: "standard", about: "Only the tokens of this standard; all when left out. Anything else is a 400.", values: ["ERC-20", "ERC-721", "ERC-1155"] };
const tokenGateway: Query = { name: "gateway", about: "true: only the tokens the gateway wrapped (the list's From Canton tab); left out for all of them. Anything else is a 400.", values: ["true"] };
const tokenOrder: Query = { name: "order", about: "desc (the sort's own order, paged with `before`) or asc (from the other end, paged with `after`: the `next` of the page before; a client opens the list's last page from here, with `limit` = `total` mod the page size, or the full page size when that is 0, so that the last page does not repeat rows of the one before; then it pages on with `after` and the normal size); desc when left out. A `before` with asc, or an `after` with desc, is a 400.", values: ["desc", "asc"] };
const transferCsvAbout = (filters: string) => `csv for the newest transfers as a file with the list's columns (up to 1000, \`limit\` sets fewer; no paging;${filters}); left out for JSON. A file has no \`derived\` field: its \`x-derived\` header is true when stage 2 had reached the chain's head and false when the file may lack the newest rows.`;
const transferCsv: Query = { name: "format", about: transferCsvAbout(" the filters apply"), values: ["csv"] };
const tokenTransferCsv: Query = { name: "format", about: transferCsvAbout(" this token's transfers only"), values: ["csv"] };
const txOrder: Query = { name: "order", about: "desc (newest first, paged with `before`) or asc (oldest first, paged with `after`: the `next` of the page before; a client opens the list's last page from here, with `limit` = `total` mod the page size, or the full page size when that is 0, so that the last page does not repeat rows of the one before; then it pages on with `after` and the normal size); desc when left out. A `before` with asc, or an `after` with desc, is a 400, and so is asc with `format=csv` (the file is the newest transactions).", values: ["desc", "asc"] };
const CONTRACT_TOTALS = {
  total: { type: "integer", description: "How many contracts the list holds: of the `verified` filter asked, or of all of them. Counted over the contracts table, not over the page." },
  counts: { type: "object", description: "How many contracts there are of each filter, whatever `verified` asks: `all`, `verified` and `notVerified`." },
};
const TOKEN_TOTALS = {
  total: { type: "integer", description: "How many tokens the list holds: of the standard and/or the gateway filter asked, or of all of them. Counted over the tokens table, not over the page." },
  counts: { type: "object", description: "How many tokens each standard has, whatever `standard` or `gateway` asks (a standard with none is 0): the keys are ERC-20, ERC-721 and ERC-1155." },
  gatewayCount: { type: "integer", description: "How many of all the tokens the gateway wrapped (the From Canton tab's count), whatever `standard` or `gateway` asks. Counted over the tokens table, in the same query as `counts`." },
};
const TX_TOTAL = {
  total: { type: ["integer", "null"], description: "How many transactions the chain holds, exact through the newest final block (`totalAsOfBlock`), never a count over the transactions. The live ones and the test runs' together, as the list holds both. Null when the rollups cannot say (none has run, they begin after the first block's day, or they trail the newest block by more than an hour, as in a first build or a rebuild), and for a filtered list." },
  totalAsOfBlock: { type: ["integer", "null"], description: "The newest final block that `total` holds; null where total is." },
  totalAsOf: { type: ["string", "null"], description: "The record time of that block (ISO time); null where total is." },
};
const paged = [limit, before], pagedAfter = [limit, after];
const TOKEN_MOVES = `Each carries \`tokenMoves\`: how many token moves its logs hold (\`count\`, at most ${TOKEN_MOVES_CAP}, with \`more\` true past that) and the first (\`first\`: token, amount or tokenId, standard when the token is known), read from stage 2's transfers. A move carries the token's \`decimals\` (null where the token's metadata is not held), which say how to show its amount; its symbol is not in the move, ask /api/labels for it. \`tokenMoves\` is null, not empty, for a block stage 2 has not reached.`;
const DERIVED = "Stage 2 of the indexer may be behind stage 1: `derived` is false for a block it has not reached, and what it writes is then empty or null, not final.";

/** Etherscan's door: one URL, a `module` and an `action`. What it answers, action by action, is in design 6.2; the parameters below are the ones its modules read. */
const ETHERSCAN_QUERY: Query[] = [
  { name: "module", about: "account, contract, transaction, block, logs, token, stats, proxy or gastracker.", values: ["account", "contract", "transaction", "block", "logs", "token", "stats", "proxy", "gastracker"] },
  { name: "action", about: "account: balance, balancemulti, tokenbalance, txlist, txlistinternal, tokentx, tokennfttx, token1155tx, getminedblocks. transaction: getstatus, gettxreceiptstatus. block: getblockreward, getblocknobytime, getblockcountdown. logs: getLogs. token: tokeninfo, tokenholdercount, tokenholderlist. stats: ethsupply, tokensupply, ethprice. proxy: eth_blockNumber, eth_getBlockByNumber, eth_getBlockTransactionCountByNumber, eth_getTransactionByHash, eth_getTransactionByBlockNumberAndIndex, eth_getTransactionCount, eth_sendRawTransaction, eth_getTransactionReceipt, eth_call, eth_getCode, eth_getStorageAt, eth_gasPrice, eth_estimateGas, eth_getUncleByBlockNumberAndIndex (JSON-RPC answers in hex, final blocks only, as /rpc gives them). gastracker: gasoracle, gasestimate. contract: verifysourcecode (a POST), checkverifystatus, getsourcecode, getabi, getcontractcreation, verifyproxycontract, checkproxyverification." },
  { name: "chainid", about: "Optional, and this chain's when given." },
  { name: "apikey", about: "Accepted and ignored." },
  { name: "address", about: "A 0x address (balancemulti: up to 20, comma-separated; getLogs: the contract that emitted the logs; getsourcecode, getabi and verifyproxycontract: the contract)." },
  { name: "contractaddresses", about: "getcontractcreation: up to 5 contract addresses, comma-separated. A contract in the genesis allocation was made by no transaction: as Etherscan answers for such a contract, its contractCreator is GENESIS, its txHash is GENESIS_ and the address (no 0x), and its block is 0." },
  { name: "sourceCode", about: "verifysourcecode (a POST): the source, or for codeformat solidity-standard-json-input the standard JSON input (up to 500 KB)." },
  { name: "codeformat", about: "verifysourcecode: solidity-single-file or solidity-standard-json-input.", values: ["solidity-single-file", "solidity-standard-json-input"] },
  { name: "contractname", about: "verifysourcecode: the contract to verify (for the standard JSON input, path:Name)." },
  { name: "compilerversion", about: "verifysourcecode: the compiler's version, as Etherscan writes it (v0.8.28+commit.7893614a)." },
  { name: "optimizationUsed", about: "verifysourcecode, single file: 1 when the optimizer was on, 0 when off." },
  { name: "runs", about: "verifysourcecode, single file: the optimizer's runs." },
  { name: "constructorArguements", about: "verifysourcecode: the constructor's arguments, hex without 0x (the name is Etherscan's spelling)." },
  { name: "evmversion", about: "verifysourcecode, single file: the EVM version; left out for the compiler's default." },
  { name: "licenseType", about: "verifysourcecode: Etherscan's license number, 1 to 14 (1 no license, 3 MIT, ...); shown as the SPDX name." },
  { name: "tool", about: "verifysourcecode: optional, the tool that sent it: forge or foundry, hardhat, remix; any other text is stored as `unknown`. The tools themselves send none, so the contract then shows the method alone (`etherscan`)." },
  { name: "libraryname1", about: "verifysourcecode, single file: the first library's name (libraryname2 to libraryname10 and libraryaddress1 to libraryaddress10 follow)." },
  { name: "expectedimplementation", about: "verifyproxycontract: the implementation address the caller expects; the answer is NOTOK when the proxy points elsewhere." },
  { name: "guid", about: "checkverifystatus and checkproxyverification: the GUID that verifysourcecode or verifyproxycontract answered with." },
  { name: "contractaddress", about: "A token's 0x address, or for verifysourcecode (a POST) the contract to verify (tokenbalance, tokentx, tokennfttx, token1155tx, tokeninfo, tokenholdercount, tokenholderlist, tokensupply)." },
  { name: "txhash", about: "A transaction's 0x hash (getstatus, gettxreceiptstatus, txlistinternal)." },
  { name: "tag", about: "latest, which is the newest final block (safe and finalized mean the same); the proxy also takes a hex block number (0x...) that is final." },
  { name: "startblock", about: "The first block of a list (txlist, txlistinternal, tokentx and the like)." },
  { name: "endblock", about: "The last block of a list; latest is the newest final block." },
  { name: "page", about: "The page of a list, from 1. page x offset is at most 10,000." },
  { name: "offset", about: "Rows to a page (getLogs: at most 1,000)." },
  { name: "gasprice", about: "In wei (gasestimate); the estimate is the median time to final, whatever the price." },
  { name: "boolean", about: "proxy eth_getBlockByNumber: true for the full transactions, false for their hashes.", values: ["true", "false"] },
  { name: "index", about: "proxy eth_getTransactionByBlockNumberAndIndex and eth_getUncleByBlockNumberAndIndex: the position in the block, hex (0x0)." },
  { name: "hex", about: "proxy eth_sendRawTransaction: the signed transaction, 0x hex (send it by POST when it is long, up to 256 KB)." },
  { name: "to", about: "proxy eth_call and eth_estimateGas: the 0x address called." },
  { name: "from", about: "proxy eth_call and eth_estimateGas: the 0x address the call is from." },
  { name: "data", about: "proxy eth_call and eth_estimateGas: the call's 0x data." },
  { name: "value", about: "proxy eth_call and eth_estimateGas: the value sent, hex." },
  { name: "gas", about: "proxy eth_call and eth_estimateGas: the gas of the call, hex (gasLimit is the same)." },
  { name: "gasLimit", about: "proxy eth_call and eth_estimateGas: the same as gas." },
  { name: "gasPrice", about: "proxy eth_call and eth_estimateGas: the gas price, hex." },
  { name: "maxFeePerGas", about: "proxy eth_call and eth_estimateGas: the fee cap, hex." },
  { name: "maxPriorityFeePerGas", about: "proxy eth_call and eth_estimateGas: the tip cap, hex." },
  { name: "position", about: "proxy eth_getStorageAt: the storage slot, hex." },
  { name: "sort", about: "asc or desc.", values: ["asc", "desc"] },
  { name: "blockno", about: "A block number (getblockreward, getblockcountdown)." },
  { name: "timestamp", about: "Unix seconds (getblocknobytime)." },
  { name: "closest", about: "before or after (getblocknobytime).", values: ["before", "after"] },
  { name: "fromBlock", about: "getLogs: the first block (0 when left out)." },
  { name: "toBlock", about: "getLogs: the last block, or latest. Without an address or a topic0, the range is at most 10,000 blocks." },
  { name: "topic0", about: "getLogs: a 0x topic of 32 bytes. topic1, topic2 and topic3 are the same." },
  { name: "topic0_1_opr", about: "getLogs: and or or between two topics; topicX_Y_opr for any pair (and when left out).", values: ["and", "or"] },
];
const ETHERSCAN_NOTE = "Always HTTP 200: {status, message, result}, status \"1\" or \"0\". Numbers are decimal strings, except in getLogs, whose quantities are hex as Etherscan's are. The proxy answers are JSON-RPC {jsonrpc, id, result|error} in hex, as Etherscan's proxy gives them, and final only as on /rpc. Balances are reth's at the newest final block; nothing that is not final is served. getsourcecode adds MatchType and MatchNote (not Etherscan's fields) for a partial match. Etherscan's own rate limit applies (10 a second, 600 a minute for each client).";

export const DOCS: Record<string, Doc> = {
  "/api/blocks": { tag: "Blocks", summary: "The newest final blocks, with the proof time and the time to final where the producer's journal has them.", query: [...paged, blockFilter, csv], page: { items: F.blockItem, derived: false } },
  "/api/blocks/{id}": { tag: "Blocks", summary: "One block, by number or 0x hash. `legs` are the first 50 of the gateway legs it recorded (`legsCount` has the number; `/api/blocks/{id}/legs` pages through all), each with what Canton shows of the swap it is one side of.", param: "The block's number or its 0x hash.", object: F.blockDetail },
  "/api/blocks/{id}/transactions": { tag: "Blocks", summary: `The transactions of a block, in order. ${TOKEN_MOVES}`, param: "The block's number or its 0x hash.", query: pagedAfter, page: { items: F.txItem, derived: false } },
  "/api/blocks/{id}/legs": { tag: "Blocks", summary: "The gateway legs a block recorded, in order, each with what Canton shows of the swap it is one side of.", param: "The block's number or its 0x hash.", query: pagedAfter, page: { items: F.leg, derived: false } },
  "/api/blocks/{id}/record": { tag: "Blocks", summary: "The Canton record of a block: header, transactions and proof, as hex.", param: "The block's number or its 0x hash.", object: F.record },
  "/api/txs": { tag: "Transactions", summary: `The newest final transactions, each with the Canton update that settled its block (updateId) and the time Canton recorded it (recordTime). ${TOKEN_MOVES}`, query: [limit, before, after, txOrder, txFilter, txCsv], csv: true, page: { items: F.txItem, derived: false, extra: TX_TOTAL } },
  "/api/txs/{hash}": { tag: "Transactions", summary: "One transaction, with the gateway `legs` it caused. Its stage 2 fields are null until its block is derived. `raw=1` is the receipt of a final transaction as reth gave it, which never changes.", param: "The transaction's 0x hash.", query: [raw], object: F.txDetail },
  "/api/txs/{hash}/logs": { tag: "Transactions", summary: "The logs of a transaction, with the events that can be decoded.", param: "The transaction's 0x hash.", query: [...pagedAfter, raw], page: { items: F.log, derived: false } },
  "/api/txs/{hash}/internal": { tag: "Transactions", summary: `The internal calls that moved value. ${DERIVED}`, param: "The transaction's 0x hash.", query: [...pagedAfter, raw], page: { items: F.internal, derived: true } },
  "/api/txs/{hash}/token-transfers": { tag: "Transactions", summary: `The token transfers of a transaction. ${TRANSFER_FIELDS} ${DERIVED}`, param: "The transaction's 0x hash.", query: [...pagedAfter, raw], page: { items: F.transfer, derived: true } },
  "/api/txs/{hash}/trace": { tag: "Transactions", summary: "The call tree of a transaction, as reth traced it. A frame's input is cut at 1,024 bytes (its whole size is `inputSize`); `raw=1` serves it whole. It never changes for a final transaction.", param: "The transaction's 0x hash.", query: [raw], object: F.trace },
  "/api/canton/updates": { tag: "Canton", summary: "The newest Canton updates that carry a block, each with its block number and the number of EVM transactions it settled (`txCount`).", query: paged, page: { items: F.updateItem, derived: false } },
  "/api/canton/updates/{updateId}": { tag: "Canton", summary: "One Canton update, with its block and the number of EVM transactions it settled; `/transactions` lists them.", param: "The update id (1220 and 64 hex digits).", object: F.updateDetail },
  "/api/canton/updates/{updateId}/transactions": { tag: "Canton", summary: `The EVM transactions a Canton update settled: its block's, in order. ${TOKEN_MOVES}`, param: "The update id (1220 and 64 hex digits).", query: pagedAfter, page: { items: F.txItem, derived: false } },
  "/api/canton/updates/{updateId}/around": { tag: "Canton", summary: "The Canton updates around one, newest first: up to n newer, the update itself and up to n older, by the list's own key (record time, update id). `submittedTemplate` and `submittedChoice` are the producer log's; null where the log does not hold them. `txCount` is the block's, null for an update that carries no block.", param: "The update id (1220 and 64 hex digits).", query: [around], note: "An object with `items`, each with the fields in the item list of this route.", object: F.updateAround },
  "/api/addresses": { tag: "Accounts", summary: `Addresses by balance or by transactions. The balance is the database's copy, as of its \`balanceBlock\`. ${DERIVED}`, query: [sort(SORTS.addresses), ...paged], page: { items: F.addressItem, derived: true } },
  "/api/addresses/{address}": { tag: "Accounts", summary: "One address. Its balance is reth's at the newest final block; the counters are the database's. A token's address says so. It also says when its first block and its last were (`firstSeenTimestamp`, `lastActiveTimestamp`, in seconds), how many contracts it made (`createdCount`, counted up to 100,000: `createdCountCapped` is true when it stopped there), how many transfers its token and NFT transfer lists hold (`erc20TransferCount`, `nftTransferCount`: each transfer once, counted up to 10,000, and null past that; while `derived` is false they count only the blocks derived so far, so they are exact once `derived` is true; `tokenTransferCount` counts every standard together), and who funded it (`fundedBy`: the first transaction that sent it value and succeeded, only when that is in the block the address first appeared in; null when the index holds none, or the address was there before it: a genesis balance, a call inside another transaction, or a token transfer that reached it first).", param: "A 0x address.", object: F.addressDetail },
  "/api/addresses/{address}/txs": { tag: "Accounts", summary: `The transactions that an address sent, received or created. ${TOKEN_MOVES}`, param: "A 0x address.", query: [...paged, direction, addressTxCsv], csv: true, page: { items: F.txItem, derived: false } },
  "/api/addresses/{address}/internal": { tag: "Accounts", summary: `The internal calls that moved value to or from an address. ${DERIVED}`, param: "A 0x address.", query: paged, page: { items: F.addressInternal, derived: true } },
  "/api/addresses/{address}/token-transfers": { tag: "Accounts", summary: `The token transfers to or from an address, newest first, of one token and/or one standard when asked. ${TRANSFER_FIELDS} ${DERIVED}`, param: "A 0x address.", query: [...paged, transferToken, addressTransferStandard, transferCsv], csv: true, page: { items: F.tokenTransferItem, derived: true } },
  "/api/addresses/{address}/contracts": { tag: "Accounts", summary: `The contracts an address made (as the direct caller of the creation), newest first by the place of the creation, as the contract list has them. ${DERIVED}`, param: "A 0x address.", query: paged, page: { items: F.contractItem, derived: true } },
  "/api/addresses/{address}/tokens": { tag: "Accounts", summary: `What an address holds, token by token, with each token's \`totalSupply\` and \`decimals\` (null where it has none). ${DERIVED}`, param: "A 0x address.", query: pagedAfter, page: { items: F.holding, derived: true } },
  "/api/addresses/{address}/coin-history": { tag: "Accounts", summary: `An address's balance at the blocks where it changed. ${DERIVED}`, param: "A 0x address.", query: paged, page: { items: F.coinPoint, derived: true } },
  "/api/labels": { tag: "Accounts", summary: `The name of each address asked, for showing a token or a contract by name: its name and symbol (a token's, else a verified contract's name), its kind (token, contract, or account for an address the index has seen), the token standard and decimals (null where the token's metadata is not held) and whether its source is verified. Up to ${MAX_LABELS} addresses, in the order asked and each once; an address the index holds nothing of has a null kind and no name, and nothing is guessed.`, query: [{ name: "addresses", about: `1 to ${MAX_LABELS} lowercase 0x addresses, joined by commas.` }], note: "An object with `items`, each with the fields in the item list of this route.", object: F.labels, items: F.label },
  "/api/contracts": { tag: "Contracts", summary: `Contracts. The balance and the counters are the database's copy, as of \`balanceBlock\`; reth's balance of one is at /api/addresses/{address}. Each item has \`createdAt\` (the creation block's time, ISO; null for a contract from genesis) and \`compilerVersion\` (null while unverified). ${DERIVED}`, query: [sort(SORTS.contracts), { name: "verified", about: "true for the contracts whose source is verified, false for the others.", values: ["true", "false"] }, tokenOrder, ...paged, after], page: { items: F.contractItem, derived: true, extra: CONTRACT_TOTALS } },
  "/api/contracts/{address}": { tag: "Contracts", summary: "One contract, with its code, proxy and verification. \`eventCount\` is how many logs it wrote, counted up to 100,000: \`eventCountCapped\` is true when the count stopped there. \`verification\` is null while nothing is verified; otherwise \`method\` says how the source came in (\`etherscan\` for the Etherscan-compatible API, \`api\` for /api/verify) and \`tool\` the tool it named (forge, hardhat, remix, unknown), null when the submission named none. Its balance and counters are the database's copy, as of `balanceBlock`, not reth's: read the balance at /api/addresses/{address}.", param: "A 0x address.", object: F.contractDetail },
  "/api/contracts/{address}/source": { tag: "Contracts", summary: "The verified source files and ABI of a contract. Every field after `verified` is empty while nothing is verified.", param: "A 0x address.", object: F.source },
  "/api/contracts/{address}/events": { tag: "Contracts", summary: "The logs a contract wrote in final blocks, newest first, each with the \`timestamp\` of its block (seconds), the transaction and its method id (none when the transaction creates a contract, which `creation` says). They are raw: decode them with the contract's ABI.", param: "A 0x address.", query: [...paged, topic0], page: { items: F.contractEvent, derived: false } },
  "/api/tokens": { tag: "Tokens", summary: `Tokens, of one standard and/or only those the gateway wrapped when asked, with the list's total, each standard's count and the count of the gateway's tokens. Each carries who made its contract (\`creator\`, \`creationBlock\`, \`createdAt\`: all null for a contract of the genesis state, which no creation made) and whether its source is \`verified\`. ${DERIVED}`, query: [sort(SORTS.tokens), tokenStandard, tokenGateway, tokenOrder, ...paged, after], page: { items: F.tokenItem, derived: true, extra: TOKEN_TOTALS } },
  "/api/tokens/{address}": { tag: "Tokens", summary: "One token, with its numbers; for a token the gateway registered, `canton` is what the gateway holds of its instrument on Canton (read as the gateway) with the token's supply, both read at the same block (`supplyBlock`), so the two can be set against each other.", param: "A 0x address.", object: F.tokenDetail },
  "/api/tokens/{address}/holders": { tag: "Tokens", summary: `The holders of a token. ${DERIVED}`, param: "A 0x address.", query: paged, page: { items: F.holder, derived: true } },
  "/api/token-transfers": { tag: "Tokens", summary: `The transfers of every token, newest first, of one standard when asked. ${TRANSFER_FIELDS} ${DERIVED}`, query: [...paged, transferStandard], page: { items: F.tokenTransferItem, derived: true } },
  "/api/tokens/{address}/transfers": { tag: "Tokens", summary: `The transfers of a token. ${TRANSFER_FIELDS} ${DERIVED}`, param: "A 0x address.", query: [...paged, tokenTransferCsv], csv: true, page: { items: F.tokenTransferItem, derived: true } },
  "/api/legs": { tag: "Gateway", summary: "The gateway's legs, newest first; `party` is the Canton party a withdrawal paid.", query: paged, page: { items: F.legItem, derived: false } },
  "/api/legs/{id}": { tag: "Gateway", summary: "One gateway leg, by its id.", param: "The leg's 0x id.", object: F.legItem },
  "/api/swaps": { tag: "Gateway", summary: "The swaps a Canton venue made with the EVM, newest first: a venue's trade settled by a payment in a block (`status` settled), or one whose funded claim the buyer has also redeemed (claimed). Each has the `offer` (the Canton update that offered the trade), its two sides (`evm` and `canton`), the `payment` and the `claim`, which is null until redeemed. No Canton party is part of it.", query: paged, page: { items: F.swap, derived: false } },
  "/api/swaps/{payId}": { tag: "Gateway", summary: "One swap, by the id of its payment: the offer's Canton update id, the EVM side (token, payer, payee, amount), the Canton side (amount, instrument, the address that claims, and the update that settled it), the payment's block with its Canton update id and record time, and the claim's block when it was redeemed.", param: "The payment's 0x id.", object: F.swap },
  "/api/search": { tag: "Search", summary: "Where a text leads: a block number or hash, a transaction hash, an address, a Canton update id, or the start of a token's or a verified contract's name.", query: [{ name: "q", about: "The text to look for." }], object: F.search },
  "/api/stats/summary": {
    tag: "Stats", summary: "The numbers of the stats page over a window, and what is live now. A window is the last whole buckets of the rows it is read from (1h and 6h: minutes; 24h and 7d: hours; 30d: days), the open one included; `from` and `to` are the buckets read. Times are seconds, read from buckets 5% apart: a percentile is at most 5% above the truth. A time or a rate with nothing behind it is null. Runs marked as tests are counted in `test` and left out of everything else. `asOf` is when the rollups last ran. `txs.allTime` is the chain's transactions since its first block, exact through the newest final block (`asOfBlock`, with its record time `asOf`); it is null where the rollups cannot say, and it does not depend on the window. `faucet.turnedAway` is how many faucet requests the limits and the human check turned away in the window: `total`, and `byReason` (address: the same address inside its window; ip: the same network address inside its window; hour: the hourly cap for everyone; captcha: the human check failed). Not counted: a request refused by the cool-down after repeated failed checks, and one refused because the check could not be reached, so `captcha` reads low during a flood of failed checks. Only the reason is counted, never who asked. The counting began at `faucet.turnedAwaySince` (ISO time; null when it never did): a window that starts before that has no count (`turnedAway` is null, to be shown as not recorded before that time), because a part of a window would read as all of it. `rule` holds the two numbers of the switching rule (design 2.7): `hoursAbove` of the `hoursCounted` whole hours of the window (from `dataSince` on, when the window starts before it) have a p95 time to final above `slowAboveSeconds` (an hour with no final transaction has no time and is left out of `hoursMeasured`), the worst of them is `worstHourP95` at `worstHourAt`; and `windowsOverByDay` counts, for each UTC `day` of the window, the whole ten-minute windows in which the prover was busy for more than 60% (`windowsOver` of `windowsCounted`). The hours come from the hour rows and the windows from the minute rows, and only hours and windows that have ended count (the windows, `prover.windowsCounted` too, count from `dataSince`: a day before the first recorded one is not listed, never shown as idle); with no hour measured, `hoursAbove` is null (an hour above 20 s is only claimed where a time was measured). `txs.successRate` counts only the chain's own failures: `txs.acceptedFinal` over `txs.acceptedFinal` + `txs.lost` + `txs.droppedByChain`, all three of transactions accepted through the RPC or the faucet and settled in the window (the sender's own replacements and waiting ones are in none; a lost transaction the sender later replaced counts as replaced). `droppedByChain` is only the drops the chain itself caused (a transaction that went missing on every resend, or that reth refused because its pool was full); a drop the sender caused (no funds, a nonce gap, a fee too low), the explorer's own backlog limit, a long wait in reth's pool with no block, and a drop recorded before the cause was kept are not in it. `dropped.window` (the Reliability card) counts every drop, whatever the cause. A revert in the EVM is a normal outcome: `txs.reverted` counts it (`txs.failed` is the same number, deprecated) and it is not in the rate. `txs.delayedByRedo` counts every final transaction, whoever sent it, that an earlier attempt that did not commit had carried; `blocks.firstTry` is the share of decided attempts (committed, refused, failed or unknown) that committed, not a per-height share.",
    query: [{ name: "window", about: `The window: ${Object.keys(WINDOWS).join(", ")}; ${DEFAULT_WINDOW} when left out.`, values: Object.keys(WINDOWS) }], object: F.statsSummary,
  },
  "/api/stats/series": {
    tag: "Stats", summary: `One metric over a window, one point for each step: \`points\` is a list of \`at\` (the start of the step) and \`value\`. A step with no row is 0 for a count and null for a time or a rate. The windows can be drawn in these steps (the first is the default): ${Object.entries(WINDOW_STEPS).map(([w, s]) => `${w}: ${s.join(", ")}`).join("; ")}. \`busy_ratio\` is drawn in 10m, 1h or 1d, and the daily address and contract counts in 1d.`,
    query: [
      { name: "metric", about: `What to draw: ${Object.keys(METRICS).join(", ")}.`, values: Object.keys(METRICS) },
      { name: "window", about: `The window: ${Object.keys(WINDOWS).join(", ")}; ${DEFAULT_WINDOW} when left out.`, values: Object.keys(WINDOWS) },
      { name: "step", about: "The width of a point: 1m, 10m, 1h or 1d, as the window allows.", values: Object.keys(STEPS) },
    ], object: F.statsSeries,
  },
  "/api/status": { tag: "Status", summary: "What the chain and the explorer are doing now.", object: FIELDS.status },
  "/api/health": { tag: "Status", summary: "Every health check with its word (ok, degraded or down), since when, and when its writer last looked; the overall word is down, and the status code 503, only when final data is stale or wrong, or an id column has used more than 90% of its range (db_ids). A check whose writer has stopped counts as failed and says so.", object: FIELDS.health },
  "/api/block/{id}": { tag: "Pages", summary: "A block as its page shows it: a final block, or one still on its way.", param: "The block's number or its 0x hash.", object: FIELDS.block },
  "/api/tx/{hash}": { tag: "Pages", summary: "A transaction as its page shows it, with where it is in its life.", param: "The transaction's 0x hash.", object: FIELDS.tx },
  "/api/address/{address}": { tag: "Pages", summary: "An address as its page shows it.", param: "A 0x address.", object: FIELDS.address },
  "/api/in-flight": { tag: "Status", summary: "The attempts that are not final yet. Nothing here is a fact of the chain until its block is final.", object: FIELDS.inFlight },
  "/api/faucet": { tag: "Faucet", summary: "GET: what the faucet shows about itself: its address and `balance` (wei) as of `balanceBlock`, the final head (reth's finalized block, which Canton holds); when reth cannot name that block `balanceBlock` is null and `balance` is the newest block's, which may not be final. Also `amount` of one payout, the limits, `queue` (requests waiting), `batch` (the most payouts that go in one block, the faucet's own setting), `sentToday` (payouts sent since 00:00 UTC), `finalToday` (of those, how many are final) and `beingProven` (payouts now in a block being proven, from any day: not those still waiting in reth's pool, and not tickets the faucet stopped following); the three are null where the faucet keeps no send times, as with a state file. POST {\"address\": \"0x...\"}: asks for coin, and answers with a ticket.", object: FIELDS.faucetInfo },
  "/api/faucet/ticket/{ticket}": { tag: "Faucet", summary: "Where a faucet request is.", param: "The ticket a request was answered with.", object: FIELDS.faucetTicket },
  "/api/verify": { tag: "Verification", method: "post", summary: "Sends a contract's Solidity source for verification: single file or standard JSON input, with the compiler version, the settings, the constructor arguments and the libraries. Answers 202 with a GUID to ask about. The optional `tool` field names what sent it (forge or foundry, hardhat, remix; any other text is stored as `unknown`, and none as null); the job records it and the contract serves it with the method, `api` for this route.", note: "Queued: the GUID." },
  "/api/verify/{guid}": { tag: "Verification", summary: "Where a verification is: pending, running, or its result (Pass, Fail or Already Verified, with the reason).", param: "The GUID a submission was answered with.", object: FIELDS.verifyJob },
  "/healthz": { tag: "Status", summary: "The same answer as /api/status, for a load balancer: 503 when the explorer is not serving.", object: FIELDS.status },
  "/rpc": { tag: "RPC", method: "post", summary: "The public JSON-RPC: what a wallet or a script sees of the chain, final blocks only. A body is one call or a batch (at most 20 calls, 256 KiB).", note: "JSON-RPC 2.0" },
  "/api": { tag: "Etherscan", summary: "The Etherscan-compatible API: GET or POST (a query or a form). Foundry, Hardhat and ethers can be pointed at it as they are at Etherscan.", query: ETHERSCAN_QUERY, note: ETHERSCAN_NOTE },
  "/v2/api": { tag: "Etherscan", summary: "The same door at Etherscan's v2 path, with `chainid`.", query: ETHERSCAN_QUERY, note: ETHERSCAN_NOTE },
  "/api/openapi.json": { tag: "Status", summary: "This description.", note: "An OpenAPI 3.1 document." },
  "/api/stream": {
    tag: "Live", summary: `A server-sent event stream. Events: \`block\` and \`txs\` (the first ${TXS_MAX} hashes of a new final block's transactions), whose id is the block number, \`derived\` (stage 2 has reached a block), \`inflight\` (an attempt changed step) and \`stats\` (every 5 s). A comment line every 15 s keeps proxies from closing it. A client that reconnects with the \`Last-Event-ID\` header gets the blocks it missed, up to ${BUFFER_BLOCKS}. ${PER_CLIENT} streams a client; a fifth is answered with 429.`,
    query: [{ name: "topics", about: `A comma-separated list of ${TOPICS.join(", ")}; all of them when left out.`, values: TOPICS }], note: "text/event-stream",
  },
};

const object = (fields: Fields, extra: Record<string, unknown> = {}) => ({
  type: "object", additionalProperties: false, properties: Object.fromEntries(fields.map((f) => [f, {}])), required: [...fields], ...extra,
});
const ERROR = { $ref: "#/components/schemas/Error" };
const fail = (description: string) => ({ description, content: { "application/json": { schema: ERROR } } });

function schemaOf(d: Doc): unknown {
  if (d.page) {
    const props: Record<string, unknown> = { items: { type: "array", items: object(d.page.items) }, next: { type: ["string", "null"], description: "The key to pass as the next page's cursor; null on the last page." } };
    Object.assign(props, d.page.extra);
    if (d.page.derived) props.derived = { type: "boolean", description: "True when stage 2 has reached the newest final block." };
    return { type: "object", additionalProperties: false, properties: props, required: Object.keys(props) };
  }
  if (d.object && d.items) return object(d.object, { properties: { items: { type: "array", items: object(d.items) } } });
  return d.object ? object(d.object) : {};
}

/** The document for the paths that are registered, in the order given. A path with no description is left out, and the test of the API fails for it. */
export function buildOpenApi(paths: readonly string[], info: { title: string; limits?: { rpcPerMinute?: number } }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const path of paths) {
    const d = DOCS[path];
    if (!d) continue;
    const parameters = [
      ...(d.param ? [{ name: /\{(\w+)\}/.exec(path)![1], in: "path", required: true, description: d.param, schema: { type: "string" } }] : []),
      ...(d.query ?? []).map((q) => ({ name: q.name, in: "query", required: false, description: q.about, schema: { type: "string", ...(q.values ? { enum: [...q.values] } : {}) } })),
    ];
    if (path === "/api/verify") {
      out[path] = { post: { tags: [d.tag], summary: d.summary, requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["address", "codeFormat", "sourceCode", "contractName", "compilerVersion"] } } } },
        responses: { 202: { description: d.note ?? "Queued.", content: { "application/json": { schema: object(FIELDS.verifyQueued) } } }, 400: fail("The request is wrong; the message says how."), 413: fail("The source is too big."), 429: fail("The limits are reached."), 503: fail("Verification is not running, or the queue is full.") } } };
      continue;
    }
    if (d.method === "post") {
      out[path] = { post: { tags: [d.tag], summary: d.summary, requestBody: { required: true, content: { "application/json": { schema: { type: ["object", "array"] } } } },
        responses: { 200: { description: d.note ?? "The answer.", content: { "application/json": { schema: {} } } }, 413: fail("The body is too big."), 429: fail("Too many requests; Retry-After says when to try again.") } } };
      continue;
    }
    if (path === "/api" || path === "/v2/api") {
      const answer = { description: d.note ?? "The answer.", content: { "application/json": { schema: object(["status", "message", "result"]) } } };
      out[path] = {
        // `x-modules` is what the API page lists for this door; it is built from the same table the door answers from, so it cannot drift. /v2/api is the same door at another path.
        get: { tags: [d.tag], summary: d.summary, parameters, responses: { 200: answer }, ...(path === "/api" ? { "x-modules": Object.fromEntries(Object.entries(MODULES).map(([m, a]) => [m, Object.keys(a)])) } : {}) },
        post: { tags: [d.tag], summary: d.summary, requestBody: { required: false, content: { "application/x-www-form-urlencoded": { schema: { type: "object" } } } }, parameters, responses: { 200: answer } },
      };
      continue;
    }
    const type = path === "/api/stream" ? "text/event-stream" : "application/json";
    const get: Record<string, unknown> = {
      tags: [d.tag], summary: d.summary, parameters,
      responses: {
        200: { description: d.note ?? "The answer.", content: { [type]: { schema: schemaOf(d) }, ...(d.csv ? { "text/csv": { schema: { type: "string", description: "One header row, then a row for each transaction, CRLF-ended." } } } : {}) } },
        ...(parameters.length ? { 400: fail("The request is wrong; the message says how.") } : {}),
        ...(d.param ? { 404: fail("Nothing is held for that.") } : {}),
        429: fail("Too many requests; Retry-After says when to try again."),
        502: fail("The explorer cannot read the chain right now."),
      },
    };
    out[path] = path === "/api/faucet" ? { get, post: { tags: [d.tag], summary: "Asks the faucet for coin.", requestBody: { required: true, content: { "application/json": { schema: object(["address"]) } } }, responses: { 200: { description: "Queued.", content: { "application/json": { schema: object(FIELDS.faucetQueued) } } }, 400: fail("The request is wrong."), 429: fail("The limits are reached.") } } } : { get };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: info.title, version: "1",
      // The limits the server holds, for the API page to show: the numbers come from the same constants and settings the server enforces.
      "x-limits": {
        pageSize: MAX_LIMIT, ...(info.limits?.rpcPerMinute ? { rpcPerMinute: info.limits.rpcPerMinute } : {}),
        rest: { perSecond: RULES.rest[0].perSecond, burst: RULES.rest[0].capacity },
        etherscan: { perSecond: RULES.etherscan[0].perSecond, perMinute: RULES.etherscan[1].capacity, maxPageBytes: MAX_PAGE_BYTES },
        verification: { perHour: RULES.verification[0].capacity, maxBodyKb: MAX_VERIFY_SOURCE / 1024 },
        streams: { perClient: PER_CLIENT },
      },
      description: "Read-only. Every list is a keyset page (`next` is the cursor for the following page). Amounts are decimal strings. Times are ISO 8601 UTC.",
    },
    paths: out,
    components: { schemas: { Error: object(["error"]) } },
  };
}
