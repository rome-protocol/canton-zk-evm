import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import type { Eip1193 } from "../wallet.ts";
import { AccountsClient } from "./canton/accounts.ts";
import { keyFromSignature, KEY_TYPED_DATA, signRequest, storableKey } from "./canton/key.ts";
import type { KeyRecord, KeyStore } from "./canton/keystore.ts";
import { partyOf } from "./canton/topology.ts";
import { closeAccount, openAccount, reopenAccount } from "./account.ts";
import type { Settings } from "./settings.ts";

const wallet = privateKeyToAccount(`0x${"11".repeat(32)}`), other = privateKeyToAccount(`0x${"22".repeat(32)}`);
const chain = { operator: "o::1220" + "01".repeat(32), confirmer: "c::1220" + "02".repeat(32), gateway: "g::1220" + "03".repeat(32), builder: "b::1220" + "04".repeat(32), chainId: 770101 };
const HINT = "rome";
const settings = { chain, participant: "PAR::p::1220" + "05".repeat(32), partyHint: HINT, accountsBase: "/accounts", origin: "http://x" } as Settings;
const acceptance = { contractId: "00aa", arguments: {} };
const nowallet = vi.fn(async (): Promise<unknown> => { throw new Error("the wallet must not be asked"); });

/** A wallet that signs the key request, and counts how often it was asked. */
function signing(account = wallet) {
  const asked = vi.fn(async (a: { method: string; params?: unknown[] }): Promise<unknown> => {
    const typed = KEY_TYPED_DATA;
    return account.signTypedData({ domain: typed.domain, types: { Open: [{ name: "statement", type: "string" }] }, primaryType: "Open", message: typed.message });
  });
  return { request: asked } as Eip1193 & { request: typeof asked };
}
/** The account service as it answers once the account is there with both acceptances. `known` is whether it knows the account. */
function service(known = true) {
  const client = {
    open: vi.fn(async (key: { publicKey: Uint8Array }) => partyOf(key.publicKey, HINT)),
    find: vi.fn(async (publicKey: Uint8Array) => (known ? partyOf(publicKey, HINT) : null)),
    openRequests: vi.fn(async () => ({ depositRequests: [], redeemRequests: [], twinAcceptance: acceptance, withdrawalAcceptance: acceptance })),
  };
  return client as typeof client & AccountsClient;
}
/** A store in memory that keeps what it was given, as it was given. */
function memory(): KeyStore & { rows: KeyRecord[] } {
  const rows: KeyRecord[] = [];
  return {
    rows,
    load: async (w) => rows.find((r) => r.wallet === w.toLowerCase()) ?? null,
    save: async (r) => { rows.splice(0, rows.length, ...rows.filter((x) => x.wallet !== r.wallet), r); return true; },
    remove: async (w) => { rows.splice(0, rows.length, ...rows.filter((x) => x.wallet !== w.toLowerCase())); },
  };
}

describe("an account that stays open", () => {
  it("is kept when it is Ready: a non-extractable CryptoKey, the public half and the addresses, and no raw key", async () => {
    const store = memory();
    const account = await openAccount(signing(), wallet.address, settings, undefined, service(), undefined, store);
    expect(account.kept).toBe(true);
    expect(store.rows).toHaveLength(1);
    const row = store.rows[0]!;
    expect(row.wallet).toBe(wallet.address.toLowerCase());
    expect(row.party).toBe(account.party);
    expect(row.privateKey).toBeInstanceOf(CryptoKey);
    expect(row.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("pkcs8", row.privateKey)).rejects.toThrow();
    expect(Object.values(row).filter((v) => v instanceof Uint8Array)).toEqual([account.key.publicKey]);
  });
  it("is kept only when it is Ready", async () => {
    const store = memory();
    const client = service();
    client.openRequests = vi.fn(async () => ({ depositRequests: [], redeemRequests: [], twinAcceptance: null, withdrawalAcceptance: null })) as never;
    await expect(openAccount(signing(), wallet.address, settings, undefined, client, undefined, store)).rejects.toThrow();
    expect(store.rows).toHaveLength(0);
  }, 30_000);
  it("reopens from the kept key with no signature of the wallet, and the key still signs the account's requests", async () => {
    const store = memory();
    const first = signing();
    const opened = await openAccount(first, wallet.address, settings, undefined, service(), undefined, store);
    expect(first.request).toHaveBeenCalledTimes(1);
    const client = service();
    const again = await reopenAccount(wallet.address, settings, undefined, client, undefined, store);
    expect(again).not.toBeNull();
    expect(again!.party).toBe(opened.party);
    expect(again!.kept).toBe(true);
    expect(client.find).toHaveBeenCalledWith(opened.key.publicKey, HINT);   // the service is asked whether it knows the account, and the account is not made again
    expect(client.open).not.toHaveBeenCalled();
    expect(client.openRequests).toHaveBeenCalled();   // both acceptances are read back before it is Ready
    const message = "accounts-v1\nGET\n/x\n" + "00".repeat(32) + "\n1";
    expect(await signRequest(again!.key, message)).toEqual(await signRequest(opened.key, message));
  });
  it("never uses another wallet address's key", async () => {
    const store = memory();
    await openAccount(signing(), wallet.address, settings, undefined, service(), undefined, store);
    const client = service();
    expect(await reopenAccount(other.address, settings, undefined, client, undefined, store)).toBeNull();
    expect(client.find).not.toHaveBeenCalled();
    // A record that names another address than the one asked for is not used either.
    const wrong = memory();
    wrong.rows.push({ ...store.rows[0]!, wallet: wallet.address.toLowerCase() });
    wrong.load = async () => wrong.rows[0]!;
    expect(await reopenAccount(other.address, settings, undefined, client, undefined, wrong)).toBeNull();
  });
  it("does not reopen, and removes the record, when the account address is not the fingerprint of the kept key", async () => {
    const store = memory();
    await openAccount(signing(), wallet.address, settings, undefined, service(), undefined, store);
    store.rows[0] = { ...store.rows[0]!, party: "rome::1220" + "ee".repeat(32) };
    const client = service();
    expect(await reopenAccount(wallet.address, settings, undefined, client, undefined, store)).toBeNull();
    expect(client.find).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(0);
  });
  it("does not reopen under another account name than this build's, and removes the record", async () => {
    const store = memory();
    await openAccount(signing(), wallet.address, settings, undefined, service(), undefined, store);
    const client = service();
    expect(await reopenAccount(wallet.address, { ...settings, partyHint: "bridge" }, undefined, client, undefined, store)).toBeNull();
    expect(client.find).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(0);
  });
  it("does not reopen with a key that is not the pair of its public half, and removes it", async () => {
    const store = memory();
    await openAccount(signing(), wallet.address, settings, undefined, service(), undefined, store);
    const stranger = await keyFromSignature("0x" + "33".repeat(32) + "22".repeat(32) + "1b");
    store.rows[0] = { ...store.rows[0]!, publicKey: stranger.publicKey, party: await partyOf(stranger.publicKey, HINT) };
    expect(await reopenAccount(wallet.address, settings, undefined, service(), undefined, store)).toBeNull();
    expect(store.rows).toHaveLength(0);
  });
  it("does not reopen an account the service does not know, and signs nothing", async () => {
    const store = memory();
    await openAccount(signing(), wallet.address, settings, undefined, service(), undefined, store);
    const client = service(false);
    expect(await reopenAccount(wallet.address, settings, undefined, client, undefined, store)).toBeNull();
    expect(client.open).not.toHaveBeenCalled();
    expect(client.openRequests).not.toHaveBeenCalled();
  });
  it("lets the account go when the wallet's account changed while it was reopening", async () => {
    const store = memory();
    await openAccount(signing(), wallet.address, settings, undefined, service(), undefined, store);
    let live = true;
    const client = service();
    client.find = vi.fn(async (publicKey: Uint8Array) => { live = false; return partyOf(publicKey, HINT); }) as never;
    await expect(reopenAccount(wallet.address, settings, undefined, client, () => live, store)).rejects.toMatchObject({ code: "account_closed" });
    expect(client.openRequests).not.toHaveBeenCalled();
  });
  it("is closed on this browser by Close: the kept key is deleted, the account does nothing more, and a reopen finds nothing", async () => {
    const store = memory();
    const account = await openAccount(signing(), wallet.address, settings, undefined, service(), undefined, store);
    await closeAccount(account, wallet.address, store);
    expect(store.rows).toHaveLength(0);
    expect(account.closed).toBe(true);
    expect(await reopenAccount(wallet.address, settings, undefined, service(), undefined, store)).toBeNull();
  });
  it("stays open, and says so, when the browser cannot remove the key", async () => {
    const store = memory();
    const account = await openAccount(signing(), wallet.address, settings, undefined, service(), undefined, store);
    store.remove = async () => { throw new Error("blocked"); };
    await expect(closeAccount(account, wallet.address, store)).rejects.toThrow("blocked");
    expect(account.closed).toBe(false);
  });
  it("is not kept, and signs again after a reload, where WebCrypto has no Ed25519 (the library signs instead)", async () => {
    const real = crypto.subtle.importKey.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, "importKey").mockImplementation(((format: string, data: unknown, alg: unknown, ...rest: unknown[]) => {
      if ((alg as { name?: string })?.name === "Ed25519") return Promise.reject(new Error("Ed25519 is not supported"));
      return (real as (...a: unknown[]) => Promise<CryptoKey>)(format, data, alg, ...rest);
    }) as never);
    try {
      const store = memory();
      const account = await openAccount(signing(), wallet.address, settings, undefined, service(), undefined, store);
      expect(storableKey(account.key)).toBeNull();
      expect(account.kept).toBeFalsy();
      expect(store.rows).toHaveLength(0);   // nothing, and above all no raw bytes, is stored
      expect(await reopenAccount(wallet.address, settings, undefined, service(), undefined, store)).toBeNull();
    } finally { spy.mockRestore(); }
  });
  it("opens without being kept where the browser cannot store (the account is still Ready for this visit)", async () => {
    const store = memory();
    store.save = async () => false;
    const account = await openAccount(signing(), wallet.address, settings, undefined, service(), undefined, store);
    expect(account.kept).toBe(false);
    expect(nowallet).not.toHaveBeenCalled();
  });
});
