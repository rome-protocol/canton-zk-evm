import { keccak256 } from "viem";
import type { Pins } from "./config.ts";
import type { BlockRecord, Ledger } from "./ledger.ts";
import { checkProofFacts, readProofFacts, type ProofCheck } from "./proof.ts";
import type { Reth, TokenInfo } from "./reth.ts";

/** A block that Canton has committed: reth's side, the record's side, and the record's own bytes, which the Verify button needs. */
export interface IndexedBlock {
  number: number;
  /** reth's hash, which is the one pages and links use. */
  hash: string;
  parentHash: string;
  timestamp: number;
  txCount: number;
  gasUsed: number;
  updateId: string;
  recordTime: string;
  /** The proof's facts next to this explorer's pins, or null when the proof is not 1,344 bytes. */
  proof: ProofCheck | null;
  headerHex: string;
  txsHex: string;
  proofHex: string;
  /** reth's hash, the record's hash and the hash of the record's header are one and the same. */
  hashesMatch: boolean;
}

export interface IndexStatus {
  /** False when a check failed or the last look at reth or Canton went wrong. This is what the health check reports. */
  ok: boolean;
  problems: string[];
  /** True while this run has had no complete look, no look has failed and no check has failed: the explorer is still reading up to the newest block, for the first time or after a new run. `ok` is false meanwhile. A failed check or a failed look is never "starting". */
  starting: boolean;
  /** Why the last look failed, or null. */
  error: string | null;
  /** The Canton offset of the newest block record the index holds; 0 while it holds none. */
  offset: number;
  /** When the last complete look at reth and Canton finished (milliseconds since 1970), or null while this run has had none. Until then `ok` is false. */
  lastLookAt: number | null;
  /** Counts the runs seen: it goes up each time the index drops everything and starts again. */
  run: number;
  genesisHash: string | null;
  /** True once block 1's record has been seen naming reth's genesis as its parent. */
  genesisReferenced: boolean;
  /** The party ids of the two signers of the block records. */
  signers: { operator: string; confirmer: string } | null;
}

interface State {
  blocks: Map<number, IndexedBlock>;
  byHash: Map<string, number>;
  byUpdate: Map<string, number>;
  txs: Map<string, { block: number; index: number }>;
  contracts: Map<string, { txHash: string; block: number }>;
  /** Only for contracts a block created; null for one that is not an ERC-20 token. */
  tokens: Map<string, TokenInfo | null>;
  last: number;
  offset: number;
  genesisHash: string | null;
  genesisReferenced: boolean;
  signers: IndexStatus["signers"];
  problems: string[];
  lookedAt: number | null;
}

const emptyState = (): State => ({
  blocks: new Map(), byHash: new Map(), byUpdate: new Map(), txs: new Map(), contracts: new Map(), tokens: new Map(),
  last: 0, offset: 0, genesisHash: null, genesisReferenced: false, signers: null, problems: [], lookedAt: null,
});

/**
 * What the explorer keeps in memory: the final blocks, up to Canton's head, found by number, hash or update id, with each block's
 * transactions, created contracts and tokens. A block still being proven is not here; a page that asks for one reads reth.
 */
export function createChainIndex(reth: Reth, ledger: Ledger, pins: Pins, pollMs: number) {
  let st = emptyState();
  let run = 1;
  let error: string | null = null;
  let working: Promise<void> | null = null;

  const head = () => st.blocks.get(st.last);

  /** A new run began: the old blocks are not this chain's any more. */
  function startAgain() {
    st = emptyState();
    error = null;
    run++;
  }

  /** Reads an ERC-20 token's name, symbol and decimals once, for a contract the walk has just seen created; a contract that is not a token is remembered as null. */
  async function readToken(address: string): Promise<void> {
    const key = address.toLowerCase();
    if (!st.tokens.has(key)) st.tokens.set(key, await reth.token(key));
  }

  async function add(r: BlockRecord): Promise<void> {
    if (r.number !== st.last + 1) throw new Error(`Canton's next block record is not this one, the next block is ${st.last + 1}`);
    const b = await reth.block(r.number);
    if (!b) throw new Error("reth has no such block, which Canton has committed");
    const receipts = b.transactions.length === 0 ? [] : await reth.blockReceipts(r.number);
    if (!receipts) throw new Error("reth has no receipts for it");
    const created = receipts.flatMap((x) => (x.contractAddress && b.transactions.includes(x.transactionHash) ? [{ address: x.contractAddress, txHash: x.transactionHash }] : []));
    for (const c of created) await readToken(c.address);

    const headerHash = keccak256(`0x${r.headerHex}`);
    const hashesMatch = b.hash === r.blockHash && b.hash === headerHash;
    if (!hashesMatch) st.problems.push(`block ${r.number}: reth's hash is ${b.hash}, the record's hash is ${r.blockHash} and the header's hash is ${headerHash}`);
    if (r.number === 1) {
      st.genesisReferenced = r.parentHash === st.genesisHash;
      if (!st.genesisReferenced) st.problems.push(`block 1: the record's parent is ${r.parentHash}, not reth's genesis ${st.genesisHash}`);
    }

    const facts = readProofFacts(r.proofHex);
    st.blocks.set(r.number, {
      number: r.number, hash: b.hash, parentHash: b.parentHash, timestamp: b.timestamp, txCount: b.transactions.length, gasUsed: b.gasUsed,
      updateId: r.updateId, recordTime: r.recordTime, proof: facts && checkProofFacts(facts, pins, b.hash),
      headerHex: r.headerHex, txsHex: r.txsHex, proofHex: r.proofHex, hashesMatch,
    });
    st.byHash.set(b.hash, r.number);
    st.byUpdate.set(r.updateId, r.number);
    b.transactions.forEach((h, index) => st.txs.set(h, { block: r.number, index }));
    for (const c of created) st.contracts.set(c.address, { txHash: c.txHash, block: r.number });
    st.signers ??= { operator: r.operator, confirmer: r.confirmer };
    st.last = r.number;
    st.offset = r.offset;
  }

  /** Starts again when reth's genesis is not the one the index began with, or when its newest block is not reth's block of that number. */
  async function checkRun(): Promise<void> {
    const genesis = await reth.block(0);
    if (!genesis) throw new Error("reth has no genesis block");
    if (st.genesisHash !== null && genesis.hash !== st.genesisHash) startAgain();
    const newest = head();
    if (newest && (await reth.block(newest.number))?.hash !== newest.hash) startAgain();
    st.genesisHash = genesis.hash;
  }

  async function step(): Promise<void> {
    try {
      await checkRun();
      const end = await ledger.ledgerEnd();
      if (end < st.offset) {
        const genesisHash = st.genesisHash;
        startAgain();
        st.genesisHash = genesisHash;
      }
      for (const r of await ledger.records(st.offset, end)) {
        try { await add(r); } catch (e) { throw new Error(`block ${r.number}: ${(e as Error).message}`); }
      }
      // st.offset stays at the newest record's offset, never at the ledger end: with no block held, the next look reads from 0 again,
      // so a new run whose ledger has already passed the old end is not missed.
      st.lookedAt = Date.now();
      error = null;
    } catch (e) {
      error = (e as Error).message;
    }
  }

  /** One look at reth and Canton. It never throws: a failure is kept in the status, and the next look starts where this one stopped. */
  function sync(): Promise<void> {
    working ??= step().finally(() => { working = null; });
    return working;
  }

  /** Follows the Canton head every `pollMs` until the returned function is called. */
  function start(): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined, stopped = false;
    const tick = async () => {
      await sync();
      if (!stopped) timer = setTimeout(tick, pollMs);
    };
    void tick();
    return () => { stopped = true; clearTimeout(timer); };
  }

  function status(): IndexStatus {
    const { problems, offset, genesisHash, genesisReferenced, signers, lookedAt } = st;
    return { ok: lookedAt !== null && problems.length === 0 && error === null, starting: lookedAt === null && error === null && problems.length === 0, problems: [...problems], error, offset, lastLookAt: lookedAt, run, genesisHash, genesisReferenced, signers };
  }

  return {
    sync, start, status, head,
    byNumber: (n: number) => st.blocks.get(n),
    byHash: (h: string) => { const n = st.byHash.get(h.toLowerCase()); return n === undefined ? undefined : st.blocks.get(n); },
    byUpdate: (id: string) => { const n = st.byUpdate.get(id); return n === undefined ? undefined : st.blocks.get(n); },
    /** The newest `count` final blocks, newest first. */
    latest: (count: number) => Array.from({ length: Math.min(count, st.last) }, (_, i) => st.blocks.get(st.last - i)!),
    /** A token that a block created, by address; null for any other address. */
    token: (address: string) => st.tokens.get(address.toLowerCase()) ?? null,
    tx: (hash: string) => st.txs.get(hash.toLowerCase()),
    contract: (address: string) => st.contracts.get(address.toLowerCase()),
  };
}

export type ChainIndex = ReturnType<typeof createChainIndex>;
