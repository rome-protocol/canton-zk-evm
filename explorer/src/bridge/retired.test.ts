import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { DB_NAME, indexedDbKeyStore } from "./canton/keystore.ts";
import { KEPT_KEYS_DB, forgetKeptKeys } from "./retired.ts";
import { keyFromSignature, storableKey } from "./canton/key.ts";
import { partyOf } from "./canton/topology.ts";

const memory = (): Pick<Storage, "getItem" | "setItem"> & { items: Map<string, string> } => {
  const items = new Map<string, string>();
  return { items, getItem: (k) => items.get(k) ?? null, setItem: (k, v) => void items.set(k, v) };
};
const databases = async (factory: IDBFactory) => (await factory.databases()).map((d) => d.name);

describe("the retired key store", () => {
  it("is the store the key store makes", () => {
    expect(KEPT_KEYS_DB).toBe(DB_NAME);
  });

  it("deletes the database of kept keys, once: a mark says it was done, and a later visit leaves a new database alone", async () => {
    const factory = new IDBFactory(), storage = memory();
    const key = await keyFromSignature("0x" + "01".repeat(32) + "22".repeat(32) + "1b");
    await indexedDbKeyStore(factory).save({ wallet: "0x" + "ab".repeat(20), party: await partyOf(key.publicKey, "rome"), publicKey: key.publicKey, privateKey: storableKey(key)! });
    expect(await databases(factory)).toContain(DB_NAME);
    await forgetKeptKeys(factory, storage);
    expect(await databases(factory)).not.toContain(DB_NAME);
    expect(storage.items.size).toBe(1);
    // Marked: a database made after this (another build of the site, say) is not touched again.
    factory.open(DB_NAME, 1);
    await new Promise((r) => setTimeout(r, 20));
    await forgetKeptKeys(factory, storage);
    expect(await databases(factory)).toContain(DB_NAME);
  });

  it("does nothing, and says nothing, when the browser has no IndexedDB or no storage", async () => {
    await expect(forgetKeptKeys(undefined as unknown as IDBFactory, memory())).resolves.toBeUndefined();
    const broken = { getItem: () => { throw new Error("no storage"); }, setItem: () => { throw new Error("no storage"); } };
    const factory = new IDBFactory();
    await expect(forgetKeptKeys(factory, broken)).resolves.toBeUndefined();
  });
});
