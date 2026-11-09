// What this browser keeps of an open Canton account, so a reload does not ask the wallet to sign again. It keeps the key's non-extractable WebCrypto CryptoKey in IndexedDB (a structured
// clone of it stays non-extractable: no page code, this one included, can read the key's bytes out), the key's public half and the account's address, under the wallet's address and the
// account's address. The key's raw bytes are never written anywhere. A browser without IndexedDB, or without Ed25519 in WebCrypto, keeps nothing and asks for the signature after a reload.

/** What is kept. `wallet` is the wallet's address on Ostia (lower case), `party` the account's Canton address. */
export interface KeyRecord {
  wallet: string;
  party: string;
  publicKey: Uint8Array;   // 32 bytes, public
  privateKey: CryptoKey;   // Ed25519, not extractable
}

export interface KeyStore {
  /** The record kept for exactly this wallet address, or null. Another address's record is never returned. */
  load(wallet: string): Promise<KeyRecord | null>;
  /** Keeps the record (it replaces any other record of the same wallet address). false when the browser cannot keep it: the account then works for this visit only. */
  save(record: KeyRecord): Promise<boolean>;
  /** Removes every record of this wallet address. Rejects when it cannot, so that the page does not say it is removed when it is not. */
  remove(wallet: string): Promise<void>;
}

export const DB_NAME = "ostia-bridge-canton";
export const STORE = "accounts";

const settle = <T>(r: IDBRequest<T>) => new Promise<T>((done, fail) => { r.onsuccess = () => done(r.result); r.onerror = () => fail(r.error); });
const finished = (t: IDBTransaction) => new Promise<void>((done, fail) => { t.oncomplete = () => done(); t.onerror = () => fail(t.error); t.onabort = () => fail(t.error); });
/** The keys of this wallet address's records. The store holds a few records at most, so it is read whole (no key range, which only the browser's own global has). */
const keysOf = async (s: IDBObjectStore, wallet: string) => ((await settle(s.getAllKeys())) as [string, string][]).filter((k) => k[0] === wallet);
const forget = async (s: IDBObjectStore, wallet: string) => { for (const k of await keysOf(s, wallet)) await settle(s.delete(k)); };

function opened(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((done, fail) => {
    const r = factory.open(DB_NAME, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore(STORE, { keyPath: ["wallet", "party"] }); };
    r.onsuccess = () => done(r.result);
    r.onerror = () => fail(r.error);
    r.onblocked = () => fail(new Error("the browser's store is blocked"));
  });
}

/** The store in IndexedDB. `factory` is the browser's, when there is one. Records are keyed by [wallet address, account address]. */
export function indexedDbKeyStore(factory: IDBFactory | undefined = typeof indexedDB === "undefined" ? undefined : indexedDB): KeyStore {
  const use = async <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => Promise<T>): Promise<T> => {
    if (!factory) throw new Error("this browser has no IndexedDB");
    const db = await opened(factory);
    try {
      const t = db.transaction(STORE, mode);
      const done = finished(t);
      // If `run` fails the transaction is left to abort and `done` is never awaited: its rejection is taken here so it is not reported as unhandled.
      done.catch(() => {});
      const result = await run(t.objectStore(STORE));
      await done;
      return result;
    } finally { db.close(); }
  };
  return {
    async load(wallet) {
      try {
        const w = wallet.toLowerCase();
        const found = (await use("readonly", (s) => settle(s.getAll()))) as KeyRecord[];
        return found.find((r) => r.wallet === w) ?? null;
      } catch { return null; }
    },
    async save(record) {
      try {
        const kept: KeyRecord = { wallet: record.wallet.toLowerCase(), party: record.party, publicKey: record.publicKey, privateKey: record.privateKey };
        await use("readwrite", async (s) => { await forget(s, kept.wallet); await settle(s.put(kept)); });
        return true;
      } catch { return false; }
    },
    remove: (wallet) => use("readwrite", (s) => forget(s, wallet.toLowerCase())),
  };
}

/** The browser's own store. */
export const browserKeyStore = (): KeyStore => indexedDbKeyStore();
