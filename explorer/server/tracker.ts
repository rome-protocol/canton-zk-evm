import type { ChainIndex } from "./chain-index.ts";
import { alwaysLeader, type Leader } from "./leader.ts";
import { RethError, type Reth } from "./reth.ts";
import { fileTrackerStore, type TrackerStore } from "./tracker-store.ts";

/**
 * Where an accepted transaction is. Pending: in reth's pool, in no block. Proving: in a block that Canton has not committed.
 * Final: in a block that is final on Canton. Replaced: another transaction from the same sender took its nonce. Dropped: it
 * went missing, and sending it again did not bring it back.
 */
export type TxState = "pending" | "proving" | "final" | "replaced" | "dropped";

/** What the tracker says about one transaction. `reason` is a plain sentence, or null when there is nothing to add. */
export interface Tracked {
  state: TxState;
  reason: string | null;
  from: string;
  nonce: number;
  /** The block that holds it, once one does. */
  block: number | null;
  /** The Canton update of that block, when the index held it at the time. */
  updateId: string | null;
  /** How many times the transaction has been sent to reth: the first time, and each time it was sent again. */
  attempts: number;
}

export interface Entry extends Tracked {
  hash: string;
  /** The signed transaction. Kept until the transaction is settled: final, replaced or dropped. */
  raw: string | null;
  /** The hash of the block that holds it, so the Canton update is looked up for that block and no other. */
  blockHash?: string | null;
  /** Refusals from reth in a row, when sending it again. */
  refused: number;
  addedAt: number;
  lastSendAt: number;
  settledAt: number | null;
  /** Which door the transaction came in by: the public RPC, or the faucet. Written to tx_lifecycle. */
  via?: "rpc" | "faucet";
}

export interface TrackerOptions {
  reth: Pick<Reth, "transaction" | "block" | "rpc" | "sendRaw">;
  index: Pick<ChainIndex, "byNumber">;
  /** Where to keep the list across restarts: a file, or null for memory only. */
  file?: string | null;
  /** Or a store of its own, such as the database. It wins over `file`. */
  store?: TrackerStore | null;
  /** Says whether this instance runs the loop. With one instance, always. With several, the one that holds the lock. */
  leader?: Leader;
  /** The most entries held. Settled ones go first, oldest first. An open one is never forgotten silently: it is marked dropped, with the reason. */
  max?: number;
  /** The most characters of signed transactions held for open entries, in all. */
  maxBytes?: number;
  /** The most open entries one sender may have. */
  maxPerSender?: number;
  /** How long a change waits before it is written to the file, so a burst of sends is one write. */
  saveMs?: number;
  /** The least time between two sends of the same transaction. */
  retryMs?: number;
  /** After this many refusals in a row, a missing transaction is dropped. */
  maxRefusals?: number;
  /** After this many sends in all, a transaction that keeps disappearing is dropped. */
  maxAttempts?: number;
  /** An open entry that has had no block for this long is marked dropped and no longer followed, so a transaction reth keeps without mining cannot hold a slot for ever. */
  maxPendingMs?: number;
  pollMs?: number;
  now?: () => number;
}

export interface Tracker {
  /** Says why a transaction cannot be followed right now, or null when it can. Ask before the transaction goes to reth. */
  admit(raw: string, hash: string, from: string): string | null;
  /** Remembers a transaction that reth accepted, with its signed bytes, so it can be sent again if it goes missing. */
  track(raw: string, hash: string, from: string, nonce: number, via?: "rpc" | "faucet"): void;
  state(hash: string): Tracked | undefined;
  /** One look at every transaction that is not settled. */
  poll(): Promise<void>;
  start(): void;
  stop(): void;
  /** Resolves when everything changed so far is on disk. */
  flush(): Promise<void>;
  /** Resolves when the list has been read from where it is kept. A store that is not a file takes a moment. */
  ready(): Promise<void>;
  /** Stops, writes what changed, and gives up the lead, so another instance takes the loop at once. */
  close(): Promise<void>;
  size(): number;
}

const SETTLED: ReadonlySet<TxState> = new Set(["final", "replaced", "dropped"]);
const KNOWN = /already known|known transaction|already imported|already in the pool/i;
/** reth refuses a transaction while another one holds the same nonce: a speed-up or a cancel, or one that is already in a block. */
const HELD = /nonce too low|nonce is too low|replacement transaction underpriced|transaction underpriced|nonce already used/i;
const hexNumber = (v: unknown): number => (typeof v === "string" && /^0x[0-9a-f]+$/.test(v) ? Number(BigInt(v)) : NaN);

/** What reth said, without the method name and the quoting around it. */
function refusal(e: RethError): string {
  return /answered "(.*)"$/.exec(e.message)?.[1] || "no reason given";
}

export function createTracker(o: TrackerOptions): Tracker {
  const { reth, index, file = null, leader = alwaysLeader, max = 10000, maxBytes = 16 * 1024 * 1024, maxPerSender = 64, saveMs = 1000, retryMs = 5000, maxRefusals = 5, maxAttempts = 10, pollMs = 2000, maxPendingMs = 60 * 60 * 1000, now = Date.now } = o;
  // Oldest first: a Map keeps the order its keys went in.
  const entries = new Map<string, Entry>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let polling: Promise<void> | null = null;
  let writing: Promise<void> = Promise.resolve();
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  const store: TrackerStore | null = o.store ?? (file ? fileTrackerStore(file) : null);
  let loaded: Promise<void> = Promise.resolve();

  function load(): void {
    if (!store) return;
    const adopt = (list: Entry[]): void => {
      for (const e of list) entries.set(e.hash, e);
      makeRoom();
    };
    const got = store.load();
    if (Array.isArray(got)) adopt(got);
    else loaded = got.then(adopt, (e: Error) => { console.error(`tracker: cannot read its list: ${e.message}`); });
  }

  /** The signed bytes held for open entries, in characters. */
  function openBytes(): number {
    let n = 0;
    for (const e of entries.values()) n += e.raw?.length ?? 0;
    return n;
  }

  /** Marks the oldest open entry dropped, and says so. Its bytes go, the entry stays so the explorer can still say what happened. */
  function dropOldestOpen(): void {
    for (const e of entries.values()) {
      if (SETTLED.has(e.state)) continue;
      console.error(`tracker: full, so it stopped following ${e.hash} from ${e.from} (nonce ${e.nonce})`);
      settle(e, "dropped", "The explorer was holding too many unconfirmed transactions, so it stopped following this one. It may still be sent on by the chain.");
      return;
    }
  }

  /**
   * Brings the list back inside its limits: settled entries go first, oldest first. Open ones are marked dropped, never forgotten silently, unless `dropOpen` is
   * off: an instance that does not run the loop (a follower) only lets go of settled entries, because a "dropped" it wrote would reach the leader and the faucets.
   */
  function makeRoom(dropOpen = true): void {
    const before = entries.size;
    while (entries.size > max) {
      let found = false;
      for (const [h, e] of entries) if (SETTLED.has(e.state)) { entries.delete(h); found = true; break; }
      if (!found) { if (!dropOpen) break; dropOldestOpen(); }
    }
    while (dropOpen && openBytes() > maxBytes) dropOldestOpen();
    if (dropOpen || entries.size !== before) dirty = true;
  }

  function admit(raw: string, hash: string, from: string): string | null {
    const known = entries.get(hash.toLowerCase());
    if (known && !SETTLED.has(known.state)) return null; // sent again by the wallet: already followed
    let mine = 0, open = 0, bytes = 0;
    for (const e of entries.values()) {
      if (SETTLED.has(e.state)) continue;
      open++;
      bytes += e.raw?.length ?? 0;
      if (e.from === from.toLowerCase()) mine++;
    }
    if (mine >= maxPerSender) return `This sender has ${mine} transactions waiting to be confirmed. Wait for some of them to be final, then send again.`;
    if (open >= max || bytes + raw.length > maxBytes) return `This explorer is following as many unconfirmed transactions as it can follow right now (the limit is ${max} transactions and ${Math.round(maxBytes / 1024)} KiB). Each one is waiting for a block, so try again in a moment.`;
    return null;
  }

  /** Hands the list to the store. Writes that follow one another are taken in turn. */
  function write(): void {
    if (!store || !dirty) return;
    dirty = false;
    const list = [...entries.values()];
    writing = writing.then(() => store.save(list));
  }

  /** A change is written after a short wait, and a burst of changes is one write. */
  function save(): void {
    if (!store) return;
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = undefined; write(); }, saveMs);
    saveTimer.unref();
  }

  /** The Canton update of a final transaction's block, once the index holds it. The index polls on its own timer, so it can lag the chain. */
  function fillUpdate(e: Entry): boolean {
    if (e.state !== "final" || e.updateId !== null || e.block === null) return false;
    const f = index.byNumber(e.block);
    if (!f || (e.blockHash && f.hash !== e.blockHash)) return false;
    e.updateId = f.updateId;
    return true;
  }

  const settle = (e: Entry, state: TxState, reason: string | null): void => {
    e.state = state; e.reason = reason; e.raw = null; e.settledAt = now();
    save();
  };

  /** Sends a missing transaction again, at most once per `retryMs`. A refusal that says reth has it already counts as accepted. */
  async function resend(e: Entry): Promise<void> {
    if (!e.raw) return;
    if (e.attempts >= maxAttempts) return settle(e, "dropped", `It was sent to the chain ${e.attempts} times and went missing each time.`);
    if (now() - e.lastSendAt < retryMs) { e.state = "pending"; return; }
    e.lastSendAt = now();
    try {
      await reth.sendRaw(e.raw);
    } catch (err) {
      if (!(err instanceof RethError) || !err.answered) throw err; // reth cannot be reached: nothing is learned
      if (HELD.test(err.message)) {
        // Another transaction holds this nonce, such as a speed-up or a cancel. Not a failure: wait until the chain settles it.
        e.state = "pending";
        e.reason = `Another transaction from the same sender holds nonce ${e.nonce}. This one waits until the chain has settled that one.`;
        return;
      }
      if (!KNOWN.test(err.message)) {
        e.refused++;
        e.state = "pending";
        e.reason = `The chain refused it when it was sent again: ${refusal(err)}.`;
        if (e.refused >= maxRefusals) settle(e, "dropped", `The chain refused it ${e.refused} times in a row: ${refusal(err)}.`);
        return;
      }
    }
    e.attempts++;
    e.refused = 0;
    e.state = "pending";
    e.reason = `It had gone missing, so it was sent to the chain again (send ${e.attempts}).`;
  }

  async function look(e: Entry, finalized: number, nonces: Map<string, Promise<number>>): Promise<void> {
    const t = await reth.transaction(e.hash);
    if (t) {
      e.reason = null;
      e.refused = 0;
      if (t.blockNumber === null) {
        if (now() - e.addedAt >= maxPendingMs) return settle(e, "dropped", `It stayed in the chain's waiting list for ${Math.round(maxPendingMs / 60000)} minutes without going into a block, so it is no longer followed. The chain may still mine it.`);
        e.state = "pending";
        return;
      }
      e.block = t.blockNumber;
      e.blockHash = t.blockHash;
      if (t.blockNumber > finalized) { e.state = "proving"; return; }
      settle(e, "final", null);
      fillUpdate(e);
      return;
    }
    // In no block and not in the pool: it was unwound and not put back, evicted, or reth started again.
    e.block = null;
    const key = `${e.from}:${finalized}`;
    let asked = nonces.get(key);
    if (!asked) {
      asked = reth.rpc("eth_getTransactionCount", [e.from, "0x" + finalized.toString(16)]).then(hexNumber);
      nonces.set(key, asked);
    }
    const used = await asked;
    if (used > e.nonce) return settle(e, "replaced", `Another transaction from the same sender took nonce ${e.nonce}.`);
    await resend(e);
  }

  const sig = (e: Entry) => `${e.state}|${e.block}|${e.attempts}|${e.reason}|${e.updateId}`;

  let purged = 0;

  /** What other instances wrote. A follower takes all of it. The leader is the only one that changes what it follows, so it takes only what it did not know. */
  async function adopt(leading: boolean): Promise<void> {
    if (!store?.changes) return;
    write();
    await writing;
    try {
      for (const e of await store.changes()) {
        const held = entries.get(e.hash);
        // The leader's list is the record, so it takes only what it did not hold. The exception is a transaction it holds as settled that a row shows open again:
        // a wallet sent the same bytes once more, through another instance, and it is followed afresh.
        if (!leading || !held || (SETTLED.has(held.state) && !SETTLED.has(e.state))) entries.set(e.hash, e);
      }
      // What other instances add counts against this one's limits too, or an instance that takes no sends itself would grow without bound.
      if (entries.size > max || (leading && openBytes() > maxBytes)) makeRoom(leading);
    } catch (e) {
      console.error(`tracker: cannot read the database: ${(e as Error).message}`);
    }
  }

  async function run(): Promise<void> {
    await loaded;
    const leading = await leader.isLeader();
    await adopt(leading);
    if (!leading) return;
    if (store?.purge && now() - purged >= 3600_000) {
      purged = now();
      await store.purge(now()).catch((e: Error) => console.error(`tracker: cannot clean the database: ${e.message}`));
    }
    let changed = false;
    for (const e of entries.values()) if (fillUpdate(e)) changed = true;
    const open = [...entries.values()].filter((e) => !SETTLED.has(e.state));
    if (open.length) {
      const before = new Map(open.map((e) => [e.hash, sig(e)]));
      try {
        const b = await reth.block("finalized");
        const finalized = b ? b.number : 0;
        const nonces = new Map<string, Promise<number>>();
        for (let i = 0; i < open.length; i += 8) await Promise.all(open.slice(i, i + 8).map((e) => look(e, finalized, nonces)));
      } catch (e) {
        if (!(e instanceof RethError)) throw e;
        console.error(`tracker: ${e.message}`);
      }
      for (const e of open) if (sig(e) !== before.get(e.hash)) changed = true;
    }
    if (changed) save();
  }

  const poll = (): Promise<void> => (polling ??= run().finally(() => { polling = null; }));
  load();

  return {
    track(raw, hash, from, nonce, via) {
      raw = raw.toLowerCase(); hash = hash.toLowerCase(); from = from.toLowerCase();
      const known = entries.get(hash);
      if (known && !SETTLED.has(known.state)) return;
      entries.delete(hash); // a transaction sent again goes to the newest end
      entries.set(hash, { hash, raw, from, nonce, state: "pending", reason: null, block: null, blockHash: null, updateId: null, attempts: 1, refused: 0, addedAt: now(), lastSendAt: now(), settledAt: null, via });
      if (entries.size > max || openBytes() > maxBytes) makeRoom();
      save();
    },
    admit,
    state(hash) {
      const e = entries.get(hash.toLowerCase());
      if (e && fillUpdate(e)) save();
      return e && { state: e.state, reason: e.reason, from: e.from, nonce: e.nonce, block: e.block, updateId: e.updateId, attempts: e.attempts };
    },
    poll,
    start() {
      timer ??= setInterval(() => void poll().catch((e) => console.error(`tracker: ${(e as Error).message}`)), pollMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    flush() {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = undefined;
      write();
      return writing;
    },
    ready: () => loaded,
    async close() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await polling?.catch(() => undefined);
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = undefined;
      write();
      await writing;
      await leader.release();
    },
    size: () => entries.size,
  };
}
