/** The fields of every REST answer and of each object inside one: nothing else is ever sent. The answers are built field by field (`pick`), and the allowlist tests hold every object to these lists. */

/** A copy of an object with the listed fields and no others. */
export const pick = <T extends object, K extends keyof T>(o: T, fields: readonly K[]): Pick<T, K> => Object.fromEntries(fields.map((k) => [k, o[k]])) as Pick<T, K>;

/** The fields of each answer, and of each object inside one. Nothing else is ever sent: the answers are built field by field, and the API field test holds every object to these lists. */
export const FIELDS = {
  status: ["chainId", "chainName", "coin", "pins", "ok", "starting", "problems", "evm", "canton", "final", "proving", "latest", "signers", "faucet", "publicRpc"],
  coin: ["symbol", "decimals"],
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
  inFlight: ["final", "attempts", "poolWaiting"],
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
  blockItem: ["number", "hash", "timestamp", "txCount", "gasUsed", "gasLimit", "miner", "legsCount", "updateId", "recordTime"],
  /** One block: what the pages already have, with the legs count, whether stage 2 has derived it, and the producer's times. */
  blockDetail: [...FIELDS.block, "legsCount", "derived", "lifecycle"],
  blockLifecycle: ["strategy", "cutReason", "cutAt", "builtAt", "proofStartedAt", "proofEndedAt", "submittedAt", "answeredAt"],
  txItem: ["hash", "block", "index", "timestamp", "from", "to", "value", "nonce", "type", "gasUsed", "gasPrice", "success", "created"],
  /** One transaction: what the pages already have, with the stage 2 fields (null until the block is derived). */
  txDetail: [...FIELDS.tx, "derived", "callCount", "revertReason"],
  leg: ["legIndex", "txIndex", "logIndex", "kind", "legId", "token", "account", "amount"],
  record: ["number", "hash", "contractId", "header", "txs", "proof"],
  log: ["logIndex", "address", "topics", "data", "decoded"],
  rawLog: ["logIndex", "address", "topics", "data"],
  internal: ["traceAddress", "callType", "from", "to", "value", "gas", "gasUsed", "selector", "inputSize", "error"],
  transfer: ["logIndex", "batchIndex", "token", "from", "to", "amount", "tokenId"],
  trace: ["frames", "truncated"],
  frame: ["traceAddress", "type", "callType", "from", "to", "value", "gas", "gasUsed", "input", "error", "created"],
  updateItem: ["updateId", "recordTime", "effectiveAt", "participant", "offset", "synchronizer", "block"],
  updateDetail: ["updateId", "recordTime", "effectiveAt", "participant", "offset", "synchronizer", "block", "template", "contractId", "blockHash", "signatories", "producerRecord"],
  updateTemplate: ["packageId", "packageName", "module", "entity"],
  signatory: ["role", "party"],
  producerRecord: ["template", "choice", "commandId", "argumentBytes", "trafficBytes", "completionOffset"],
} as const;
