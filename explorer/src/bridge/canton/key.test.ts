import { readdirSync, readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import {
  base64, bytesFromHex, confirmKey, DIFFERENT_SIGNATURES, hex, keyFromSignature, keyTypedData, normaliseSignature, openKey, originFromEnv, OSTIA_CHAIN_ID, seedFromSignature, signOnboarding, signRequest,
  signVerifiedTransaction, statement, type CantonKey,
} from "./key.ts";

// A fixed 65-byte signature (r = 0x11.., s = 0x22.., v = 0x1b). The seed is HKDF-SHA256 of it with no salt and the info "ostia-bridge canton-key v1" (made with Python's hmac);
// the public key and the signature of "hello ostia" are those of OpenSSL's Ed25519 for that seed.
const SIGNATURE = "0x" + "11".repeat(32) + "22".repeat(32) + "1b";
const SEED = "198841f7a7418530f09eeaa40fb6d86c9d87ccf7c3f716a5fa36b1e6db9ff9b4";
const PUBLIC = "a864e3e655e746a7115a4bcf4c2a9bf57279c6c92e91bbaa219943692c4d69cd";
const SIGNED = "3ed8af76046c5ab309fe3191589328c0aec7d6e2e9b11c608e8294dc3bb7b006c64a35c99c0370b76b1f19c0b87fff88e6ec4ec7cd6232c852ad30ce2471df04";
const hello = new TextEncoder().encode("hello ostia");
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const ORIGIN = "https://ostia.devnet.romeprotocol.xyz";

const verifies = async (publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array) =>
  crypto.subtle.verify({ name: "Ed25519" }, await crypto.subtle.importKey("raw", publicKey as BufferSource, { name: "Ed25519" }, false, ["verify"]), signature as BufferSource, message as BufferSource);
const REQUEST = "accounts-v1\nGET\n/accounts/v1/holdings/x\n" + "00".repeat(32) + "\n1800000000";

// A real wallet signature of the request, made with a fixed secp256k1 key (RFC 6979: the same every time).
const account = privateKeyToAccount(`0x${"ab".repeat(32)}`);
const walletSignature = await account.signTypedData({ domain: keyTypedData(ORIGIN).domain, types: { Open: [{ name: "statement", type: "string" }] }, primaryType: "Open", message: keyTypedData(ORIGIN).message });
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
    const multi = new Uint8Array([0x12, 0x20, ...new Uint8Array(32).fill(5)]);
    expect(await verifies(key.publicKey, multi, await signOnboarding(key, multi))).toBe(true);
    expect(() => signOnboarding(key, new Uint8Array(32).fill(5))).toThrow("34-byte");   // a transaction's hash is not an onboarding
    expect(() => signOnboarding(key, new Uint8Array(34).fill(5))).toThrow("34-byte");
    const hash = new Uint8Array(32).fill(7);
    expect(await verifies(key.publicKey, hash, await signVerifiedTransaction(key, hash))).toBe(true);
    expect(() => signVerifiedTransaction(key, multi)).toThrow("32 bytes");
    expect(() => signRequest(key, "hello")).toThrow("accounts-v1");
    expect(() => signOnboarding({ publicKey: key.publicKey } as CantonKey, multi)).toThrow("not a key made by this library");   // a look-alike has no signer
  });
  it("names the origin in the request, and keeps the chain and the name in the domain", () => {
    expect(statement(ORIGIN)).toContain(ORIGIN);
    expect(keyTypedData(ORIGIN).domain).toEqual({ name: "Ostia bridge", version: "1", chainId: OSTIA_CHAIN_ID });
    expect(OSTIA_CHAIN_ID).toBe(770101);
    expect(keyTypedData(ORIGIN).primaryType).toBe("Open");
    expect(originFromEnv({ VITE_SITE_ORIGIN: ORIGIN })).toBe(ORIGIN);
    for (const bad of [undefined, "", "ostia.example", "https://ostia.example/", "https://ostia.example/path"]) expect(() => originFromEnv({ VITE_SITE_ORIGIN: bad })).toThrow("VITE_SITE_ORIGIN");
  });
  it("asks the wallet for one EIP-712 signature, checks it is the connected address's, and keeps nothing in browser storage", async () => {
    const request = asked(walletSignature);
    const key = await openKey({ request }, account.address, ORIGIN);
    expect(request).toHaveBeenCalledTimes(1);
    const [call] = request.mock.calls[0] as unknown as [{ method: string; params: [string, string] }];
    expect(call.method).toBe("eth_signTypedData_v4");
    const typed = JSON.parse(call.params[1]);
    expect(typed.domain).toEqual({ name: "Ostia bridge", version: "1", chainId: OSTIA_CHAIN_ID });
    expect(typed.message.statement).toBe(statement(ORIGIN));
    expect(hex(key.publicKey)).toBe(hex((await keyFromSignature(walletSignature)).publicKey));
    // the other forms of the wallet's signature make the same key
    expect(hex((await openKey({ request: asked(flipped(walletSignature)) }, account.address, ORIGIN)).publicKey)).toBe(hex(key.publicKey));
    // a wallet that signs as another address, or gives no signature, makes no key
    await expect(openKey({ request: asked(walletSignature) }, privateKeyToAccount(`0x${"cd".repeat(32)}`).address, ORIGIN)).rejects.toThrow("another address");
    await expect(openKey({ request: asked(await account.signTypedData({ domain: keyTypedData(ORIGIN).domain, types: { Open: [{ name: "statement", type: "string" }] }, primaryType: "Open", message: { statement: "another words" } })) }, account.address, ORIGIN)).rejects.toThrow("another address");
    await expect(openKey({ request: vi.fn(async () => null) }, account.address, ORIGIN)).rejects.toThrow("no signature");
  });
  it("asks again on a first account, and refuses a wallet that does not sign the same way twice", async () => {
    const key = await openKey({ request: asked(walletSignature) }, account.address, ORIGIN);
    const request = asked(walletSignature);
    await expect(confirmKey({ request }, account.address, ORIGIN, key)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
    const other = await keyFromSignature(SIGNATURE);   // the key the first signature made, where the second made another
    await expect(confirmKey({ request: asked(walletSignature) }, account.address, ORIGIN, other)).rejects.toThrow(DIFFERENT_SIGNATURES);
    expect(DIFFERENT_SIGNATURES).toContain("does not sign the same way twice");
  });
  it("has no use of browser storage anywhere in the library, and each signing function has one caller", () => {
    const dir = new URL(".", import.meta.url);
    const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    for (const file of sources) expect(readFileSync(new URL(file, dir), "utf8"), file).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    const users = (name: string) => sources.filter((f) => f !== "key.ts" && readFileSync(new URL(f, dir), "utf8").includes(name));
    expect(users("signVerifiedTransaction")).toEqual(["sign.ts"]);
    expect(users("signOnboarding")).toEqual([]);   // no caller until the page can read the topology it would sign (topology.ts, OnboardingNotChecked)
    expect(users("signRequest")).toEqual(["accounts.ts"]);
    expect(base64(new Uint8Array([1]))).toBe("AQ==");
  });
});
