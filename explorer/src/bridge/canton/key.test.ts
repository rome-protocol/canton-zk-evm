import { readdirSync, readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import {
  base64, bytesFromHex, confirmKey, DIFFERENT_SIGNATURES, hex, keyFromSignature, KEY_TYPED_DATA, normaliseSignature, openKey, originFromEnv, OSTIA_CHAIN_ID, seedFromSignature, signRequest,
  signVerifiedTransaction, STATEMENT, type CantonKey,
} from "./key.ts";

// A fixed 65-byte signature (r = 0x11.., s = 0x22.., v = 0x1b). The seed is HKDF-SHA256 of it with no salt and the info "ostia-bridge canton-key v1" (made with Python's hmac);
// the public key and the signature of "hello ostia" are those of OpenSSL's Ed25519 for that seed.
const SIGNATURE = "0x" + "11".repeat(32) + "22".repeat(32) + "1b";
const SEED = "198841f7a7418530f09eeaa40fb6d86c9d87ccf7c3f716a5fa36b1e6db9ff9b4";
const PUBLIC = "a864e3e655e746a7115a4bcf4c2a9bf57279c6c92e91bbaa219943692c4d69cd";
const SIGNED = "3ed8af76046c5ab309fe3191589328c0aec7d6e2e9b11c608e8294dc3bb7b006c64a35c99c0370b76b1f19c0b87fff88e6ec4ec7cd6232c852ad30ce2471df04";
const hello = new TextEncoder().encode("hello ostia");
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const ORIGIN = "https://ostia.devnet.romeprotocol.xyz";   // the site's origin is shown on the page; it is no input of the key

const verifies = async (publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array) =>
  crypto.subtle.verify({ name: "Ed25519" }, await crypto.subtle.importKey("raw", publicKey as BufferSource, { name: "Ed25519" }, false, ["verify"]), signature as BufferSource, message as BufferSource);
const REQUEST = "accounts-v1\nGET\n/accounts/v1/holdings/x\n" + "00".repeat(32) + "\n1800000000";

// A real wallet signature of the fixed request, made with a fixed secp256k1 key (RFC 6979: the same every time), and the Canton key it makes. These two are pinned: the request's words, its
// domain and KEY_INFO must never change, because a change makes another key for every user (made with eth_account and OpenSSL's Ed25519, apart from this code).
const account = privateKeyToAccount(`0x${"ab".repeat(32)}`);
const WALLET_SIGNATURE = "0x505ce9b36032b8a7411b5b2fca12f6d3a8d0c50812e617e129a2c398f8ab06f95c9f27220b13fdf3cb8d7577ce2295acfad3743cb8225fc1111de2f99b1230091b";
const WALLET_PUBLIC = "d3452f037fe03fca0326c2014b4ea288dda2c1b7cba9be8077d0c4ea985dc38a";
const walletSignature = await account.signTypedData({ domain: KEY_TYPED_DATA.domain, types: { Open: [{ name: "statement", type: "string" }] }, primaryType: "Open", message: KEY_TYPED_DATA.message });
const asked = (signature: string) => vi.fn(async (_a: { method: string; params?: unknown[] }): Promise<unknown> => signature);
/** The other form of the same signature: high s, and the other recovery byte. */
const flipped = (signature: string) => {
  const sig = bytesFromHex(signature);
  const s = N - BigInt("0x" + hex(sig.slice(32, 64)));
  return `0x${hex(sig.slice(0, 32))}${s.toString(16).padStart(64, "0")}${(sig[64] === 27 ? 28 : 27).toString(16)}`;
};

describe("the Canton key from a wallet signature", () => {
  it("makes the same seed, public key and signature from the same wallet signature", async () => {
    expect(hex(await seedFromSignature(SIGNATURE))).toBe(SEED);
    const signed: string[] = [];
    for (const useWebCrypto of [true, false]) {
      const key = await keyFromSignature(SIGNATURE, useWebCrypto);
      expect(hex(key.publicKey)).toBe(PUBLIC);
      signed.push(hex(await signRequest(key, REQUEST)));   // Ed25519 is deterministic, so the browser's own and the library's are the same bytes
      expect(await verifies(key.publicKey, new TextEncoder().encode(REQUEST), bytesFromHex(signed.at(-1)!))).toBe(true);
    }
    expect(signed[0]).toBe(signed[1]);
    expect(await verifies(bytesFromHex(PUBLIC), hello, bytesFromHex(SIGNED))).toBe(true);   // OpenSSL's signature of "hello ostia" is the pinned key's
  });
  it("makes another key from another signature, and refuses what is not 65 bytes", async () => {
    expect(hex((await keyFromSignature("0x" + "11".repeat(32) + "22".repeat(32) + "1c")).publicKey)).not.toBe(PUBLIC);
    await expect(keyFromSignature("0x1234")).rejects.toThrow("65 bytes");
    await expect(keyFromSignature("0xzz")).rejects.toThrow();
    await expect(keyFromSignature("0x" + "11".repeat(32) + "22".repeat(32) + "05")).rejects.toThrow("recovery byte");
    await expect(keyFromSignature("0x" + "11".repeat(32) + "00".repeat(32) + "1b")).rejects.toThrow("secp256k1");
  });
  it("makes one key of the forms of a signature that verify alike: the recovery byte 0/1 or 27/28, and high or low s", async () => {
    const base = hex((await keyFromSignature(SIGNATURE)).publicKey);
    expect(normaliseSignature(SIGNATURE.slice(0, -2) + "00")).toBe(SIGNATURE);
    expect(normaliseSignature(SIGNATURE)).toBe(SIGNATURE);
    const high = flipped(SIGNATURE);
    expect(high.endsWith("1c")).toBe(true);
    expect(normaliseSignature(high)).toBe(SIGNATURE);
    expect(hex((await keyFromSignature(high)).publicKey)).toBe(base);
    expect(hex((await keyFromSignature(high.slice(0, -2) + "01")).publicKey)).toBe(base);
  });
  it("has no signing method on the key, and each purpose signs only its own kind of bytes", async () => {
    const key = await keyFromSignature(SIGNATURE);
    expect(Object.keys(key)).toEqual(["publicKey"]);   // no seed, and no signer to call
    expect(Object.isFrozen(key) || !("sign" in key)).toBe(true);
    const multi = new Uint8Array([0x12, 0x20, ...new Uint8Array(32).fill(5)]);   // signOnboarding signs only a multi-hash it computed from a checked topology (topology.test.ts)
    const hash = new Uint8Array(32).fill(7);
    expect(await verifies(key.publicKey, hash, await signVerifiedTransaction(key, hash))).toBe(true);
    expect(() => signVerifiedTransaction(key, multi)).toThrow("32 bytes");
    expect(() => signRequest(key, "hello")).toThrow("accounts-v1");
    expect(() => signVerifiedTransaction({ publicKey: key.publicKey } as CantonKey, hash)).toThrow("not a key made by this library");   // a look-alike has no signer
  });
  it("signs fixed words, with no origin in them, and keeps the chain and the name in the domain", () => {
    expect(STATEMENT).toBe("Open my Canton account on Ostia. This signature is your Canton key: sign it only on the Ostia bridge page you trust.");
    expect(JSON.stringify(KEY_TYPED_DATA)).not.toMatch(/https?:|\.xyz|\.com/);
    expect(KEY_TYPED_DATA.domain).toEqual({ name: "Ostia bridge", version: "1", chainId: OSTIA_CHAIN_ID });
    expect(OSTIA_CHAIN_ID).toBe(770101);
    expect(KEY_TYPED_DATA.primaryType).toBe("Open");
    expect(originFromEnv({ VITE_SITE_ORIGIN: ORIGIN })).toBe(ORIGIN);   // the page shows the origin; it is read from the configuration, as before
    for (const bad of [undefined, "", "ostia.example", "https://ostia.example/", "https://ostia.example/path"]) expect(() => originFromEnv({ VITE_SITE_ORIGIN: bad })).toThrow("VITE_SITE_ORIGIN");
  });
  it("makes one pinned key from the fixed request: a fixed wallet key gives a fixed signature, and a fixed signature a fixed public key", async () => {
    expect(walletSignature).toBe(WALLET_SIGNATURE);
    expect(hex((await keyFromSignature(walletSignature)).publicKey)).toBe(WALLET_PUBLIC);
  });
  it("asks the wallet for one EIP-712 signature, checks it is the connected address's, and keeps nothing in browser storage", async () => {
    const request = asked(walletSignature);
    const key = await openKey({ request }, account.address);
    expect(request).toHaveBeenCalledTimes(1);
    const [call] = request.mock.calls[0] as unknown as [{ method: string; params: [string, string] }];
    expect(call.method).toBe("eth_signTypedData_v4");
    const typed = JSON.parse(call.params[1]);
    expect(typed.domain).toEqual({ name: "Ostia bridge", version: "1", chainId: OSTIA_CHAIN_ID });
    expect(typed.message.statement).toBe(STATEMENT);
    expect(hex(key.publicKey)).toBe(hex((await keyFromSignature(walletSignature)).publicKey));
    // the other forms of the wallet's signature make the same key
    expect(hex((await openKey({ request: asked(flipped(walletSignature)) }, account.address)).publicKey)).toBe(hex(key.publicKey));
    // a wallet that signs as another address, or gives no signature, makes no key
    await expect(openKey({ request: asked(walletSignature) }, privateKeyToAccount(`0x${"cd".repeat(32)}`).address)).rejects.toThrow("another address");
    await expect(openKey({ request: asked(await account.signTypedData({ domain: KEY_TYPED_DATA.domain, types: { Open: [{ name: "statement", type: "string" }] }, primaryType: "Open", message: { statement: "another words" } })) }, account.address)).rejects.toThrow("another address");
    await expect(openKey({ request: vi.fn(async () => null) }, account.address)).rejects.toThrow("no signature");
  });
  it("asks again on a first account, and refuses a wallet that does not sign the same way twice", async () => {
    const key = await openKey({ request: asked(walletSignature) }, account.address);
    const request = asked(walletSignature);
    await expect(confirmKey({ request }, account.address, key)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
    const other = await keyFromSignature(SIGNATURE);   // the key the first signature made, where the second made another
    await expect(confirmKey({ request: asked(walletSignature) }, account.address, other)).rejects.toThrow(DIFFERENT_SIGNATURES);
    expect(DIFFERENT_SIGNATURES).toContain("does not sign the same way twice");
  });
  it("has no use of browser storage anywhere in the library, and each signing function has one caller", () => {
    const dir = new URL(".", import.meta.url);
    const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    for (const file of sources) expect(readFileSync(new URL(file, dir), "utf8"), file).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    const users = (name: string) => sources.filter((f) => f !== "key.ts" && readFileSync(new URL(f, dir), "utf8").includes(name));
    expect(users("signVerifiedTransaction")).toEqual(["sign.ts"]);
    expect(users("signOnboarding")).toEqual(["accounts.ts"]);   // it checks the topology itself (topology.ts)
    expect(users("signRequest")).toEqual(["accounts.ts"]);
    expect(base64(new Uint8Array([1]))).toBe("AQ==");
  });
});
