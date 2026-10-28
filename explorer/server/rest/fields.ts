import type { TxListItem } from "./chain-rest.ts";

/** The fields of every REST answer and of each object inside one: nothing else is ever sent. The answers are built field by field (`pick`), and the allowlist tests hold every object to these lists. */

/** A copy of an object with the listed fields and no others. */
export const pick = <T extends object, K extends keyof T>(o: T, fields: readonly K[]): Pick<T, K> => Object.fromEntries(fields.map((k) => [k, o[k]])) as Pick<T, K>;

/** The fields of each answer, and of each object inside one. Nothing else is ever sent: the answers are built field by field, and the API field test holds every object to these lists. */
export const FIELDS = {
  status: ["chainId", "chainName", "networkName", "coin", "pins", "ok", "starting", "problems", "evm", "canton", "final", "proving", "latest", "signers", "faucet", "publicRpc", "indexHead", "indexLag", "deriveCursor", "chainInstance"],
  coin: ["symbol", "decimals"],
  /** The answer of /api/health, and one check in it. */
  health: ["status", "instance", "starting", "problems", "checks"],
  healthCheck: ["id", "role", "status", "written", "value", "threshold", "detail", "sinceSeconds", "changedAt", "refreshedAt", "refreshedAgoSeconds", "intervalSeconds", "stale", "elsewhere"],
  /** The current key, as before there were ranges. `keys` is the list of every key and the block it starts at. */
  pins: ["programVK", "rootC", "file", "keys"],
  pinsKey: ["fromBlock", "programVK", "rootC", "zisk"],
  final: ["number", "hash", "timestamp", "recordTime"],
  proving: ["number", "hash", "timestamp"],
  /** One of the newest final blocks, for the home page's list. */
  latest: ["number", "hash", "timestamp", "txCount", "updateId", "recordTime"],
  signers: ["operator", "confirmer"],
  faucet: ["on"],
  /** What the faucet shows about itself, and what it answers a request with. */
  faucetInfo: ["on", "address", "balance", "balanceBlock", "amount", "perAddressSeconds", "perIpSeconds", "maxPerHour", "queue", "batch", "sentToday", "finalToday", "beingProven", "captcha"],
  faucetCaptcha: ["siteKey", "scriptUrl", "widgetClass"],
  /** What a request is answered with: a ticket, and its place in line. */
  faucetQueued: ["ticket", "position", "to", "amount"],
  /** Where a ticket is. */
  faucetTicket: ["ticket", "status", "position", "to", "amount", "hash", "state", "block", "reason"],
  /** What a submission for verification is answered with, and where a verification is. */
  verifyQueued: ["guid"],
  verifyJob: ["guid", "status", "result"],
  block: ["status", "number", "hash", "parentHash", "timestamp", "txCount", "gasUsed", "gasLimit", "baseFee", "miner", "stateRoot", "genesisReferenced", "canton", "transactions", "legs"],
  /** A gateway leg inside a block or a transaction, with what Canton shows of the swap it is one side of (`canton`, null on a leg that is not): no Canton party is ever part of it. */
  blockLeg: ["block", "legIndex", "txIndex", "logIndex", "kind", "legId", "token", "account", "amount", "txHash", "updateId", "canton"],
  legCanton: ["role", "amount", "instrument", "settledUpdateId", "recipient"],
  legInstrument: ["admin", "id"],
  canton: ["updateId", "recordTime", "template", "proofBytes", "proof", "hashesMatch", "headerHex", "txsHex", "proofHex"],
  /** The proof's three facts, each of which is a {value, ok} pair. */
  proof: ["programVK", "rootC", "blockHash"],
  fact: ["value", "ok"],
  blockTx: ["hash", "from", "to", "success", "transfer"],
  transfer: ["symbol", "decimals", "to", "value"],
  txBlock: ["number", "hash", "updateId"],
  log: ["address", "topics", "data"],
  /** Where a transaction has been, from the producer's journal and the API: null when no row is kept for it. */
  lifecycle: ["state", "reason", "acceptedAt", "acceptedVia", "includedAt", "attempts", "leftOutReason", "proofStartedAt", "proofEndedAt", "submittedAt", "committedAt", "finalAt", "finalBlock", "timeToFinalMs"],
  /** The attempts that are not final, and reth's pool count from the producer's latest sample. */
  inFlight: ["final", "attempts", "poolWaiting", "transactions"],
  inFlightTx: ["hash", "stage", "at"],
  inFlightAttempt: ["number", "strategy", "cutReason", "stage", "txCount", "poolWaiting", "cutAt", "builtAt", "proofStartedAt", "proofEndedAt", "submittedAt", "answeredAt", "outcome"],
  poolSample: ["waiting", "at"],
  tx: ["hash", "status", "state", "reason", "lifecycle", "block", "from", "to", "value", "nonce", "type", "gas", "gasUsed", "gasPrice", "fee", "success", "input", "logs", "transfer", "toToken", "created", "legs"],
  address: ["address", "kind", "balance", "nonce", "token", "createdBy"],
  token: ["name", "symbol", "decimals"],
  createdBy: ["txHash", "block"],
} as const;

export const REST_FIELDS = {
  /** A page of a list whose rows come from stage 1 alone. */
  page: ["items", "next"],
  /** A page of a list that stage 2 fills: `derived` is false while the derive cursor has not reached the block, and the list is then empty, not final. */
  derivedPage: ["derived", "items", "next"],
  /** The token list: the page, the list's own total and each standard's count. */
  tokenPage: ["derived", "items", "next", "total", "counts", "gatewayCount"],
  /** The newest transactions: a page, with how many the chain holds (from the rollups; null when they cannot say, and for a filtered list) and when that was counted to. */
  txPage: ["items", "next", "total", "totalAsOfBlock", "totalAsOf"],
  blockItem: ["number", "hash", "timestamp", "txCount", "gasUsed", "gasLimit", "miner", "legsCount", "baseFee", "updateId", "recordTime", "proofSeconds", "finalSeconds", "commitSeconds"],
  /** One block: what the pages already have, with the legs count, whether stage 2 has derived it, and the producer's times. */
  blockDetail: [...FIELDS.block.filter((f) => f !== "transactions"), "legsCount", "derived", "lifecycle"],
  /** The Canton side of a block as its page shows it: the record's hex is served by /record. */
  cantonSummary: ["updateId", "recordTime", "template", "proofBytes", "proof", "hashesMatch"],
  blockLifecycle: ["strategy", "cutReason", "cutAt", "builtAt", "proofStartedAt", "proofEndedAt", "submittedAt", "answeredAt"],
  txItem: ["hash", "block", "index", "timestamp", "from", "to", "value", "nonce", "type", "gasUsed", "gasPrice", "success", "created", "methodId", "tokenMoves", "updateId", "recordTime"],
  /** What a transaction in a list moved in tokens: how many moves (counted to a cap, `more` past it) and the first; the whole object is null while stage 2 has not reached the block. */
  tokenMoves: ["count", "more", "first"],
  /** `amount` is in the token's base units; `decimals` (null where the token's metadata is not held) says how to show it. */
  tokenMove: ["token", "amount", "tokenId", "standard", "decimals"],
  /** What is known of an address for showing it by name: nothing here is guessed, and an address nothing is known of has a null name and symbol. */
  label: ["address", "name", "symbol", "kind", "standard", "decimals", "verified"],
  labels: ["items"],
  /** One transaction: what the pages already have, with the stage 2 fields (null until the block is derived), its place in its block, and the fee caps the sender signed. */
  txDetail: [...FIELDS.tx.filter((f) => f !== "logs"), "derived", "callCount", "revertReason", "index", "maxFeePerGas", "maxPriorityFeePerGas"],
  leg: ["legIndex", "txIndex", "logIndex", "kind", "gateway", "legId", "token", "account", "amount", "canton"],
  record: ["number", "hash", "contractId", "header", "txs", "proof"],
  /** `logIndex` is the log's place in its block, as Ethereum counts it; `position` is its place among this transaction's logs. Both are 0-based. */
  log: ["logIndex", "position", "address", "topics", "data", "decoded"],
  rawLog: ["logIndex", "address", "topics", "data"],
  internal: ["traceAddress", "callType", "from", "to", "value", "gas", "gasUsed", "selector", "inputSize", "error"],
  transfer: ["logIndex", "batchIndex", "methodId", "creation", "timestamp", "token", "standard", "from", "to", "amount", "tokenId"],
  trace: ["frames", "truncated"],
  frame: ["traceAddress", "type", "callType", "from", "to", "value", "gas", "gasUsed", "input", "inputSize", "error", "created"],
  updateItem: ["updateId", "recordTime", "effectiveAt", "participant", "offset", "synchronizer", "block", "txCount"],
  updateDetail: ["updateId", "recordTime", "effectiveAt", "participant", "offset", "synchronizer", "block", "txCount", "template", "contractId", "blockHash", "signatories", "producerRecord"],
  updateAround: ["items"],
  updateAroundItem: ["updateId", "recordTime", "effectiveAt", "participant", "offset", "synchronizer", "block", "submittedTemplate", "submittedChoice", "txCount"],
  updateTemplate: ["packageId", "packageName", "module", "entity"],
  signatory: ["role", "party"],
  producerRecord: ["template", "choice", "commandId", "argumentBytes", "trafficBytes"],
  /** The addresses list: the database's copy of the balance, as of `balanceBlock`. */
  addressItem: ["address", "kind", "balance", "balanceBlock", "txCount"],
  /** One address: the balance is reth's at the final head (`balanceBlock`); the counters, the times of the first and last block, the creation count, the funder and the kind are the database's. */
  addressDetail: ["address", "kind", "balance", "balanceBlock", "sentCount", "receivedCount", "internalCount", "tokenTransferCount", "erc20TransferCount", "nftTransferCount", "firstSeenBlock", "firstSeenTimestamp", "lastActiveBlock", "lastActiveTimestamp", "createdCount", "createdCountCapped", "fundedBy", "token", "createdBy", "derived"],
  /** The first incoming transaction with value, when the index can say it funded the address. */
  funding: ["from", "txHash", "block", "timestamp", "value"],
  /** An address's internal calls: the call, and the transaction it is in. */
  addressInternal: ["txHash", "block", "txIndex", "traceAddress", "callType", "from", "to", "value", "gas", "gasUsed", "selector", "inputSize", "error"],
  /** A log a contract wrote: the log, the transaction it is in, and that transaction's method id. */
  contractEvent: ["txHash", "block", "txIndex", "logIndex", "timestamp", "address", "topics", "data", "method", "creation"],
  /** A token transfer of an address or of a token, with the transaction it is in. */
  tokenTransferItem: ["txHash", "block", "txIndex", "logIndex", "batchIndex", "methodId", "creation", "timestamp", "token", "standard", "from", "to", "amount", "tokenId"],
  /** What an address holds of one token (or of one id of an ERC-1155), as of the block it last moved. */
  holding: ["token", "standard", "name", "symbol", "decimals", "totalSupply", "tokenId", "value", "updatedBlock"],
  coinPoint: ["block", "balance"],
  /** The contract list: the page, the list's own total and the count of each filter (all, verified, not verified), whatever is asked. */
  contractPage: ["derived", "items", "next", "total", "counts"],
  contractItem: ["address", "name", "origin", "creator", "creationBlock", "createdAt", "compilerVersion", "interactionCount", "verified", "matchType", "codeSize", "destroyedBlock", "standard", "balance", "balanceBlock", "txCount", "internalCount"],
  contractDetail: [
    "address", "name", "origin", "creator", "creationBlock", "createdAt", "compilerVersion", "interactionCount", "verified", "matchType", "codeSize", "destroyedBlock", "standard", "balance", "balanceBlock", "txCount", "internalCount",
    "creationTxHash", "lastInteractionBlock", "eventCount", "eventCountCapped", "codeHash", "code", "proxy", "verification", "derived",
  ],
  proxy: ["kind", "implementation", "beacon", "checkedBlock"],
  verification: ["language", "compilerVersion", "codeFormat", "contractPath", "contractName", "optimizerEnabled", "optimizerRuns", "evmVersion", "license", "verifiedAt", "matchNote", "method", "tool"],
  /** The verified source and ABI; every field after `verified` is empty (null, or an empty list) while nothing is verified. */
  source: [
    "address", "verified", "matchType", "language", "compilerVersion", "codeFormat", "contractPath", "contractName", "optimizerEnabled", "optimizerRuns", "evmVersion",
    "license", "settings", "files", "abi", "constructorArgs", "libraries", "verifiedAt", "matchNote", "method", "tool",
  ],
  sourceFile: ["path", "content"],
  tokenItem: ["address", "standard", "name", "symbol", "decimals", "totalSupply", "holderCount", "transferCount", "firstTransferBlock", "gatewayWrapped", "metadataStatus", "creator", "creationBlock", "createdAt", "verified"],
  tokenDetail: [
    "address", "standard", "name", "symbol", "decimals", "totalSupply", "holderCount", "transferCount", "firstTransferBlock", "gatewayWrapped", "metadataStatus", "creator", "creationBlock", "createdAt", "verified",
    "totalSupplyBlock", "balanceMode", "derived", "canton", "twin",
  ],
  /** What the gateway holds on Canton of a registered token's instrument and the token's supply, both read at one block (the custody at the ledger offset of its record): the instrument is public, no holding, owner or contract is. */
  cantonCustody: ["instrumentAdmin", "instrumentId", "custody", "custodyDecimals", "holdings", "supply", "supplyBlock", "ledgerOffset", "readAt"],
  /** The Canton twin of an ERC-20 a registered vault holds: what the twin has in issue (locks less releases, null when the token has too many legs to total) next to what the vaults hold, both in the token's base units. */
  twinSupply: ["supply", "vaultBalance", "locks", "releases", "through"],
  holder: ["holder", "tokenId", "value", "updatedBlock"],
  /** A gateway leg in a list: where it is, and what the EVM recorded of it. `party` is the Canton party a withdrawal paid (its EVM event names it), null on the other kinds. */
  legItem: ["block", "txHash", "legIndex", "txIndex", "logIndex", "kind", "gateway", "twin", "legId", "token", "account", "amount", "party"],
  /** A swap a Canton venue made with the EVM: both sides, the payment that settled it and the claim that redeemed it, if one did. */
  swap: ["payId", "claimId", "status", "offer", "evm", "canton", "payment", "claim"],
  swapOffer: ["updateId"],
  swapEvm: ["token", "symbol", "decimals", "payer", "payee", "amount"],
  swapCanton: ["amount", "instrument", "recipient", "updateId"],
  swapPayment: ["block", "txHash", "legIndex", "updateId", "recordTime"],
  swapClaim: ["block", "txHash", "legIndex", "updateId", "recordTime"],
  /** What a search found: the page to open, and, for a name, the matches (at most ten). */
  search: ["path", "matches"],
  searchMatch: ["kind", "name", "symbol", "address", "path"],
  /** /api/stats/summary: the numbers of design section 8 over a window, and what is live now. Each nested object has the list below it. */
  statsSummary: [
    "window", "rows", "from", "to", "asOf", "dataSince", "tps", "blockTime", "timeToFinal", "proofTime", "commitTime", "served", "txsPerBlock", "blocks", "txs", "attempts", "fullness",
    "canton", "prover", "rule", "quality", "test", "today", "waiting", "acceptedNotFinal", "lost", "dropped", "replaced", "cutting", "faucet",
  ],
  statsTps: ["now", "peak", "peakAt"],
  /** A time as its middle and its 95th percentile, in seconds, and how many facts it is read from. */
  statsSpread: ["median", "p95", "samples", "capped"],
  statsProof: ["median", "p95", "samples", "capped", "bySize"],
  statsSize: ["size", "median", "p95", "samples", "capped"],
  statsTxsPerBlock: ["mean", "median", "max", "nonEmptyMean", "nonEmptyMedian"],
  statsBlocks: ["count", "empty", "busy", "firstTry", "bySize"],
  statsBlockSize: ["size", "count"],
  statsTxs: ["count", "failed", "reverted", "successRate", "accepted", "acceptedFinal", "lost", "droppedByChain", "delayedByRedo", "allTime"],
  /** The chain's transactions since its first block, exact through the newest final block `asOfBlock` (its record time is `asOf`); null where the rollups cannot say. */
  statsAllTime: ["total", "asOfBlock", "asOf"],
  statsAttempts: ["total", "committed", "unknown", "decided", "refused", "failed", "notTaken", "refusedShare", "failedShare", "notTakenShare"],
  statsCanton: ["argumentBytesPerBlock", "argumentBytesPerTx", "trafficBytesPerBlock", "trafficReported"],
  statsProver: ["maxBusyRatio10m", "windowsOver", "windowsCounted", "windowSeconds", "loadedAbove", "meanBusyRatio", "busyMs", "byProver"],
  /** One prover's busy time in the window (ms), its proofs, and its share of the window that has happened (a prover's name is empty where the journal named none). */
  statsProverShare: ["prover", "busyMs", "proofs", "busyShare"],
  /** The switching rule's two numbers: the hours whose p95 time to final is above `slowAboveSeconds`, and the ten-minute windows above 0.6 of one prover for each UTC day. */
  statsRule: ["slowAboveSeconds", "hoursCounted", "hoursMeasured", "hoursAbove", "worstHourP95", "worstHourAt", "windowsOverByDay"],
  statsRuleDay: ["day", "windowsOver", "windowsCounted"],
  statsQuality: ["withoutAcceptanceTime", "clockSkew"],
  /** What the runs marked as tests did: counted apart, and left out of every other number. */
  statsTest: ["blocks", "txs", "attempts", "proverBusyMs"],
  statsToday: ["date", "activeAddresses", "newAddresses", "newContracts", "verifiedContracts", "countedAt"],
  statsWaiting: ["open", "pool"],
  statsPool: ["waiting", "at", "ageSeconds"],
  statsOpen: ["normal", "slow", "stuck", "beingProven", "waiting", "noAcceptanceTime", "slowAfterSeconds", "stuckAfterSeconds", "listed"],
  statsStuckItem: ["txHash", "state", "ageSeconds", "acceptedAt"],
  statsLost: ["window", "total", "listed"],
  statsLostItem: ["txHash", "state", "reason", "at"],
  statsReplaced: ["window", "total"],
  statsCutting: ["strategy", "since"],
  statsFaucet: ["requests", "sent", "final", "failed", "timeToFinal", "turnedAway", "turnedAwaySince"],
  /** The requests the faucet turned away in the window, and the reasons that add up to it. */
  statsTurnedAway: ["total", "byReason"],
  statsTurnedAwayReasons: ["address", "ip", "hour", "captcha"],
  /** /api/stats/series: one metric, one point for each step of the window. */
  statsSeries: ["metric", "unit", "window", "step", "from", "to", "asOf", "points"],
  statsPoint: ["at", "value"],
} as const;

/** A transaction of a list in the fields of the allowlist, with the token moves inside it held to theirs. */
export const pickTx = (t: TxListItem): Record<string, unknown> => {
  const m = t.tokenMoves;
  return { ...pick(t, REST_FIELDS.txItem), tokenMoves: m === null ? null : { ...pick(m, ["count", "more"]), first: m.first === null ? null : pick(m.first, REST_FIELDS.tokenMove) } };
};
