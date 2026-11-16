// A build without the Bridge account (VITE_BRIDGE_ACCOUNT) deletes the key store that an earlier build of this site made in the browser, once. It holds no code of the account: only the store's name, which keystore.ts uses for the same store.

export const KEPT_KEYS_DB = "ostia-bridge-canton";
const DONE = "ostia-bridge-canton-retired";

/** Deletes the browser's database of kept account keys, once per browser (a mark in localStorage says it was done). Never throws: a browser without storage, or a delete another tab holds up, is tried again at the next visit. */
export function forgetKeptKeys(factory?: IDBFactory, storage: Pick<Storage, "getItem" | "setItem"> | null = null): Promise<void> {
  return new Promise((done) => {
    try {
      storage ??= localStorage;
      if (storage.getItem(DONE) === "1") return done();
    } catch { /* no localStorage: the delete is harmless to repeat */ }
    try {
      const request = (factory ?? indexedDB).deleteDatabase(KEPT_KEYS_DB);
      request.onsuccess = () => { try { storage?.setItem(DONE, "1"); } catch { /* no storage */ } done(); };
      request.onerror = () => done();
      request.onblocked = () => done();
    } catch { done(); }
  });
}
