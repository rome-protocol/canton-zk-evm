import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { hex, keyFromSignature, keyTypedData, openKey, OSTIA_CHAIN_ID, seedFromSignature, STATEMENT } from "./key.ts";

// A fixed 65-byte signature (r = 0x11.., s = 0x22.., v = 0x1b). The seed is HKDF-SHA256 of it with no salt and the info "ostia-bridge canton-key v1" (made with Python's hmac);
// the public key and the signature of "hello ostia" are those of OpenSSL's Ed25519 for that seed.
const SIGNATURE = "0x" + "11".repeat(32) + "22".repeat(32) + "1b";
const SEED = "198841f7a7418530f09eeaa40fb6d86c9d87ccf7c3f716a5fa36b1e6db9ff9b4";
const PUBLIC = "a864e3e655e746a7115a4bcf4c2a9bf57279c6c92e91bbaa219943692c4d69cd";
const SIGNED = "3ed8af76046c5ab309fe3191589328c0aec7d6e2e9b11c608e8294dc3bb7b006c64a35c99c0370b76b1f19c0b87fff88e6ec4ec7cd6232c852ad30ce2471df04";
const hello = new TextEncoder().encode("hello ostia");

describe("the Canton key from a wallet signature", () => {
  it("makes the same seed, public key and signature from the same wallet signature", async () => {
    expect(hex(await seedFromSignature(SIGNATURE))).toBe(SEED);
    for (const useWebCrypto of [true, false]) {
      const key = await keyFromSignature(SIGNATURE, useWebCrypto);
      expect(hex(key.publicKey)).toBe(PUBLIC);
      expect(hex(await key.sign(hello))).toBe(SIGNED);   // Ed25519 is deterministic, so the browser's own and the library's are the same bytes
    }
  });
  it("makes another key from another signature, and refuses what is not 65 bytes", async () => {
    expect(hex((await keyFromSignature("0x" + "11".repeat(32) + "22".repeat(32) + "1c")).publicKey)).not.toBe(PUBLIC);
    await expect(keyFromSignature("0x1234")).rejects.toThrow("65 bytes");
    await expect(keyFromSignature("0xzz")).rejects.toThrow();
  });
  it("asks the wallet for one EIP-712 signature, bound to the name and the chain, and keeps nothing in browser storage", async () => {
    const request = vi.fn(async () => SIGNATURE);
    const key = await openKey({ request }, "0xabc");
    expect(hex(key.publicKey)).toBe(PUBLIC);
    expect(request).toHaveBeenCalledTimes(1);
    const [call] = request.mock.calls[0] as unknown as [{ method: string; params: [string, string] }];
    expect(call.method).toBe("eth_signTypedData_v4");
    const typed = JSON.parse(call.params[1]);
    expect(typed.domain).toEqual({ name: "Ostia bridge", version: "1", chainId: OSTIA_CHAIN_ID });
    expect(OSTIA_CHAIN_ID).toBe(770101);
    expect(typed.message.statement).toBe(STATEMENT);
    expect(keyTypedData.primaryType).toBe("Open");
    expect(Object.keys(key)).toEqual(["publicKey", "sign"]);   // no seed on the key
  });
  it("has no use of browser storage anywhere in the library", () => {
    const dir = new URL(".", import.meta.url);
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      expect(readFileSync(new URL(file, dir), "utf8"), file).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    }
  });
});
