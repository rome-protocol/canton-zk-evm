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
  pins: ["programVK", "rootC", "file"],
  final: ["number", "hash", "timestamp", "recordTime"],
  proving: ["number", "hash", "timestamp"],
  /** One of the newest final blocks, for the home page's list. */
  latest: ["number", "hash", "timestamp", "txCount", "updateId", "recordTime"],
  signers: ["operator", "confirmer"],
  faucet: ["on"],
  /** What the faucet shows about itself, and what it answers a request with. */
  faucetInfo: ["on", "address", "balance", "amount", "perAddressSeconds", "perIpSeconds", "maxPerHour", "queue", "captcha"],
  faucetCaptcha: ["siteKey", "scriptUrl", "widgetClass"],
  /** What a request is answered with: a ticket, and its place in line. */
  faucetQueued: ["ticket", "position", "to", "amount"],
  /** Where a ticket is. */
  faucetTicket: ["ticket", "status", "position", "to", "amount", "hash", "state", "block", "reason"],
  /** What a submission for verification is answered with, and where a verification is. */
  verifyQueued: ["guid"],
  verifyJob: ["guid", "status", "result"],
  block: ["status", "number", "hash", "parentHash", "timestamp", "txCount", "gasUsed", "gasLimit", "baseFee", "miner", "stateRoot", "genesisReferenced", "canton", "transactions"],
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
  tx: ["hash", "status", "state", "reason", "lifecycle", "block", "from", "to", "value", "nonce", "type", "gas", "gasUsed", "gasPrice", "fee", "success", "input", "logs", "transfer", "toToken", "created"],
  address: ["address", "kind", "balance", "nonce", "token", "createdBy"],
  token: ["name", "symbol", "decimals"],
  createdBy: ["txHash", "block"],
} as const;

export const REST_FIELDS = {
  /** A page of a list whose rows come from stage 1 alone. */
  page: ["items", "next"],
  /** A page of a list that stage 2 fills: `derived` is false while the derive cursor has not reached the block, and the list is then empty, not final. */
  derivedPage: ["derived", "items", "next"],
  blockItem: ["number", "hash", "timestamp", "txCount", "gasUsed", "gasLimit", "miner", "legsCount", "baseFee", "updateId", "recordTime", "proofSeconds", "finalSeconds", "commitSeconds"],
  /** One block: what the pages already have, with the legs count, whether stage 2 has derived it, and the producer's times. */
  blockDetail: [...FIELDS.block.filter((f) => f !== "transactions"), "legsCount", "derived", "lifecycle"],
  /** The Canton side of a block as its page shows it: the record's hex is served by /record. */
  cantonSummary: ["updateId", "recordTime", "template", "proofBytes", "proof", "hashesMatch"],
  blockLifecycle: ["strategy", "cutReason", "cutAt", "builtAt", "proofStartedAt", "proofEndedAt", "submittedAt", "answeredAt"],
  txItem: ["hash", "block", "index", "timestamp", "from", "to", "value", "nonce", "type", "gasUsed", "gasPrice", "success", "created", "methodId"],
  /** One transaction: what the pages already have, with the stage 2 fields (null until the block is derived), its place in its block, and the fee caps the sender signed. */
  txDetail: [...FIELDS.tx.filter((f) => f !== "logs"), "derived", "callCount", "revertReason", "index", "maxFeePerGas", "maxPriorityFeePerGas"],
  leg: ["legIndex", "txIndex", "logIndex", "kind", "legId", "token", "account", "amount"],
  record: ["number", "hash", "contractId", "header", "txs", "proof"],
  /** `logIndex` is the log's place in its block, as Ethereum counts it; `position` is its place among this transaction's logs. Both are 0-based. */
  log: ["logIndex", "position", "address", "topics", "data", "decoded"],
  rawLog: ["logIndex", "address", "topics", "data"],
  internal: ["traceAddress", "callType", "from", "to", "value", "gas", "gasUsed", "selector", "inputSize", "error"],
  transfer: ["logIndex", "batchIndex", "token", "from", "to", "amount", "tokenId"],
  trace: ["frames", "truncated"],
  frame: ["traceAddress", "type", "callType", "from", "to", "value", "gas", "gasUsed", "input", "inputSize", "error", "created"],
  updateItem: ["updateId", "recordTime", "effectiveAt", "participant", "offset", "synchronizer", "block"],
  updateDetail: ["updateId", "recordTime", "effectiveAt", "participant", "offset", "synchronizer", "block", "template", "contractId", "blockHash", "signatories", "producerRecord"],
  updateAround: ["items"],
  updateAroundItem: ["updateId", "recordTime", "effectiveAt", "participant", "offset", "synchronizer", "block", "submittedTemplate", "submittedChoice", "txCount"],
  updateTemplate: ["packageId", "packageName", "module", "entity"],
  signatory: ["role", "party"],
  producerRecord: ["template", "choice", "commandId", "argumentBytes", "trafficBytes"],
  /** The addresses list: the database's copy of the balance, as of `balanceBlock`. */
  addressItem: ["address", "kind", "balance", "balanceBlock", "txCount"],
  /** One address: the balance is reth's at the final head (`balanceBlock`); the counters and the kind are the database's. */
  addressDetail: ["address", "kind", "balance", "balanceBlock", "sentCount", "receivedCount", "internalCount", "tokenTransferCount", "firstSeenBlock", "lastActiveBlock", "token", "createdBy", "derived"],
  /** An address's internal calls: the call, and the transaction it is in. */
  addressInternal: ["txHash", "block", "txIndex", "traceAddress", "callType", "from", "to", "value", "gas", "gasUsed", "selector", "inputSize", "error"],
  /** A log a contract wrote: the log, the transaction it is in, and that transaction's method id. */
  contractEvent: ["txHash", "block", "txIndex", "logIndex", "address", "topics", "data", "method", "creation"],
  /** A token transfer of an address or of a token, with the transaction it is in. */
  tokenTransferItem: ["txHash", "block", "txIndex", "logIndex", "batchIndex", "token", "from", "to", "amount", "tokenId"],
  /** What an address holds of one token (or of one id of an ERC-1155), as of the block it last moved. */
  holding: ["token", "standard", "name", "symbol", "decimals", "tokenId", "value", "updatedBlock"],
  coinPoint: ["block", "balance"],
  contractItem: ["address", "name", "origin", "creator", "creationBlock", "interactionCount", "verified", "matchType", "codeSize", "destroyedBlock", "standard", "balance", "balanceBlock", "txCount", "internalCount"],
  contractDetail: [
    "address", "name", "origin", "creator", "creationBlock", "interactionCount", "verified", "matchType", "codeSize", "destroyedBlock", "standard", "balance", "balanceBlock", "txCount", "internalCount",
    "creationTxHash", "lastInteractionBlock", "codeHash", "code", "proxy", "verification", "derived",
  ],
  proxy: ["kind", "implementation", "beacon", "checkedBlock"],
  verification: ["language", "compilerVersion", "codeFormat", "contractPath", "contractName", "optimizerEnabled", "optimizerRuns", "evmVersion", "license", "verifiedAt", "matchNote"],
  /** The verified source and ABI; every field after `verified` is empty (null, or an empty list) while nothing is verified. */
  source: [
    "address", "verified", "matchType", "language", "compilerVersion", "codeFormat", "contractPath", "contractName", "optimizerEnabled", "optimizerRuns", "evmVersion",
    "license", "settings", "files", "abi", "constructorArgs", "libraries", "verifiedAt", "matchNote",
  ],
  sourceFile: ["path", "content"],
  tokenItem: ["address", "standard", "name", "symbol", "decimals", "totalSupply", "holderCount", "transferCount", "firstTransferBlock", "gatewayWrapped", "metadataStatus"],
  tokenDetail: [
    "address", "standard", "name", "symbol", "decimals", "totalSupply", "holderCount", "transferCount", "firstTransferBlock", "gatewayWrapped", "metadataStatus",
    "totalSupplyBlock", "balanceMode", "derived",
  ],
  holder: ["holder", "tokenId", "value", "updatedBlock"],
  /** A gateway leg in a list: where it is, and what the EVM recorded of it. */
  legItem: ["block", "txHash", "legIndex", "txIndex", "logIndex", "kind", "legId", "token", "account", "amount"],
  /** What a search found: the page to open, and, for a name, the matches (at most ten). */
  search: ["path", "matches"],
  searchMatch: ["kind", "name", "symbol", "address", "path"],
  /** /api/stats/summary: the numbers of design section 8 over a window, and what is live now. Each nested object has the list below it. */
  statsSummary: [
    "window", "rows", "from", "to", "asOf", "dataSince", "tps", "blockTime", "timeToFinal", "proofTime", "commitTime", "served", "txsPerBlock", "blocks", "txs", "attempts", "fullness",
    "canton", "prover", "quality", "test", "today", "waiting", "acceptedNotFinal", "lost", "dropped", "replaced", "cutting", "faucet",
  ],
  statsTps: ["now", "peak", "peakAt"],
  /** A time as its middle and its 95th percentile, in seconds, and how many facts it is read from. */
  statsSpread: ["median", "p95", "samples", "capped"],
  statsProof: ["median", "p95", "samples", "capped", "bySize"],
  statsSize: ["size", "median", "p95", "samples", "capped"],
  statsTxsPerBlock: ["mean", "median", "max", "nonEmptyMean", "nonEmptyMedian"],
  statsBlocks: ["count", "empty", "busy", "bySize"],
  statsBlockSize: ["size", "count"],
  statsTxs: ["count", "failed", "successRate", "accepted"],
  statsAttempts: ["total", "refused", "failed", "notTaken", "refusedShare", "failedShare", "notTakenShare"],
  statsCanton: ["argumentBytesPerBlock", "argumentBytesPerTx", "trafficBytesPerBlock", "trafficReported"],
  statsProver: ["maxBusyRatio10m", "windowsOver", "windowsCounted", "windowSeconds", "loadedAbove", "meanBusyRatio", "busyMs"],
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
  statsFaucet: ["requests", "sent", "final", "failed", "timeToFinal", "turnedAway"],
  /** /api/stats/series: one metric, one point for each step of the window. */
  statsSeries: ["metric", "unit", "window", "step", "from", "to", "asOf", "points"],
  statsPoint: ["at", "value"],
} as const;
