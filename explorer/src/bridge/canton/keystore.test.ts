import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { keyFromSignature, keyFromStored, storableKey } from "./key.ts";
import { DB_NAME, indexedDbKeyStore, STORE, type KeyRecord } from "./keystore.ts";
import { partyOf } from "./topology.ts";

const HINT = "rome";
const sig = (n: number) => "0x" + n.toString(16).padStart(2, "0").repeat(32) + "22".repeat(32) + "1b";
const WALLET = "0x" + "ab".repeat(20), OTHER = "0x" + "cd".repeat(20);

async function record(n: number, wallet = WALLET): Promise<KeyRecord> {
  const key = await keyFromSignature(sig(n));
  return { wallet, party: await partyOf(key.publicKey, HINT), publicKey: key.publicKey, privateKey: storableKey(key)! };
}
/** Everything the browser holds in the store, read straight from IndexedDB. */
async function everything(factory: IDBFactory): Promise<unknown[]> {
  const db: IDBDatabase = await new Promise((done, fail) => { const r = factory.open(DB_NAME, 1); r.onsuccess = () => done(r.result); r.onerror = () => fail(r.error); });
  const rows: unknown[] = await new Promise((done, fail) => { const r = db.transaction(STORE).objectStore(STORE).getAll(); r.onsuccess = () => done(r.result); r.onerror = () => fail(r.error); });
  db.close();
  return rows;
}

describe("the key store in IndexedDB", () => {
  it("keeps a key that cannot be read out: what is put in IndexedDB is a CryptoKey that is not extractable, and no raw private bytes", async () => {
    const factory = new IDBFactory();
    const made = await record(1);
    expect(made.privateKey).toBeInstanceOf(CryptoKey);
    expect(made.privateKey.extractable).toBe(false);
    expect(await indexedDbKeyStore(factory).save(made)).toBe(true);
    const rows = (await everything(factory)) as KeyRecord[];
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual(["party", "privateKey", "publicKey", "wallet"]);
    expect(rows[0]!.privateKey).toBeInstanceOf(CryptoKey);
    expect(rows[0]!.privateKey.extractable).toBe(false);
    expect(rows[0]!.privateKey.type).toBe("private");
    for (const format of ["pkcs8", "jwk"] as const) await expect(crypto.subtle.exportKey(format, rows[0]!.privateKey)).rejects.toThrow();
    // Only the public half is bytes, and it is 32 bytes of the public key.
    expect(rows[0]!.publicKey).toEqual(made.publicKey);
    const bytes = Object.values(rows[0]!).filter((v) => v instanceof Uint8Array || v instanceof ArrayBuffer);
    expect(bytes).toHaveLength(1);
  });
  it("gives back a key that still signs for the same public key, and refuses it for another", async () => {
    const factory = new IDBFactory();
    const made = await record(1);
    await indexedDbKeyStore(factory).save(made);
    const got = (await indexedDbKeyStore(factory).load(WALLET))!;
    const key = await keyFromStored(got.privateKey, got.publicKey);
    expect(key).not.toBeNull();
    expect(key!.publicKey).toEqual(made.publicKey);
    expect(await keyFromStored(got.privateKey, (await record(2)).publicKey)).toBeNull();   // not the pair
  });
  it("never gives one wallet address's key to another address, and keeps one record for an address", async () => {
    const factory = new IDBFactory(), store = indexedDbKeyStore(factory);
    await store.save(await record(1));
    expect(await store.load(OTHER)).toBeNull();
    expect((await store.load(WALLET.toUpperCase().replace("0X", "0x")))?.wallet).toBe(WALLET);   // an address is compared in lower case
    await store.save(await record(2, OTHER));
    await store.save(await record(3));
    expect(await everything(factory)).toHaveLength(2);
    expect((await store.load(WALLET))!.party).toBe(await partyOf((await record(3)).publicKey, HINT));
  });
  it("removes the record of a wallet address, and only that one", async () => {
    const factory = new IDBFactory(), store = indexedDbKeyStore(factory);
    await store.save(await record(1));
    await store.save(await record(2, OTHER));
    await store.remove(WALLET);
    expect(await store.load(WALLET)).toBeNull();
    expect(await store.load(OTHER)).not.toBeNull();
  });
  it("keeps nothing, and says so, where the browser has no IndexedDB; it removes nothing and says that too", async () => {
    const store = indexedDbKeyStore(undefined);
    expect(await store.save(await record(1))).toBe(false);
    expect(await store.load(WALLET)).toBeNull();
    await expect(store.remove(WALLET)).rejects.toThrow();
  });
});

describe("a key that comes back from the store", () => {
  it("is refused unless it is an Ed25519 private key that is not extractable", async () => {
    const made = await record(1);
    expect(await keyFromStored(null, made.publicKey)).toBeNull();
    expect(await keyFromStored(new Uint8Array(32), made.publicKey)).toBeNull();   // raw bytes are never taken
    expect(await keyFromStored(made.privateKey, new Uint8Array(31))).toBeNull();
    const seed = new Uint8Array(32).fill(7);
    const pkcs8 = new Uint8Array([...Buffer.from("302e020100300506032b657004220420", "hex"), ...seed]);
    const publicHalf = await (await import("@noble/ed25519")).getPublicKeyAsync(seed);   // the extractable key's OWN public half: only the extractable check can refuse it
    const extractable = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
    expect(await keyFromStored(extractable, publicHalf)).toBeNull();
    // The same seed and public half with a key that is not extractable is taken, so the refusal above is the extractable check and nothing else.
    const fixed = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
    expect(await keyFromStored(fixed, publicHalf)).not.toBeNull();
  });
});
