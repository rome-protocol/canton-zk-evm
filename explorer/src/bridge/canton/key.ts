// The Canton account's key, derived from one wallet signature. The same wallet makes the same key on any device, and the key is held in memory only.
import type { Eip1193 } from "../../wallet.ts";

export const OSTIA_CHAIN_ID = 770101;   // PINS CHAIN_ID: the wallet must be on this chain, or it refuses to sign typed data for it
export const KEY_INFO = "ostia-bridge canton-key v1";
export const STATEMENT = "Open my Canton account on Ostia. This signature is your Canton key; sign it only on this site.";

/** The EIP-712 request: a signature of it is bound to the name "Ostia bridge" and the chain, so a signature asked for by another site is another one. */
export const keyTypedData = {
  types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }], Open: [{ name: "statement", type: "string" }] },
  primaryType: "Open",
  domain: { name: "Ostia bridge", version: "1", chainId: OSTIA_CHAIN_ID },
  message: { statement: STATEMENT },
} as const;

/** An Ed25519 key that signs and shows its public half. The private half is not readable from it. */
export interface CantonKey {
  readonly publicKey: Uint8Array;   // 32 raw bytes
  sign(message: Uint8Array): Promise<Uint8Array>;   // 64 bytes
}

export const bytesFromHex = (hex: string): Uint8Array => {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(h)) throw new Error("not hex");
  return Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
};
export const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const base64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));
export const fromBase64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** HKDF-SHA256 over the 65-byte signature (no salt), 32 bytes: the Ed25519 private key. */
export async function seedFromSignature(signature: string): Promise<Uint8Array> {
  const sig = bytesFromHex(signature);
  if (sig.length !== 65) throw new Error("a wallet signature is 65 bytes");
  const material = await crypto.subtle.importKey("raw", sig as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(KEY_INFO) }, material, 256);
  return new Uint8Array(bits);
}

const PKCS8_ED25519 = bytesFromHex("302e020100300506032b657004220420");   // the DER prefix of an Ed25519 private key; the 32-byte seed follows

/** WebCrypto's Ed25519 where the browser has it: it takes a key as PKCS#8, and its JWK export gives the public half. */
async function webKey(seed: Uint8Array): Promise<CantonKey | null> {
  try {
    const pkcs8 = new Uint8Array([...PKCS8_ED25519, ...seed]);
    const key = await crypto.subtle.importKey("pkcs8", pkcs8 as BufferSource, { name: "Ed25519" }, true, ["sign"]);
    const jwk = await crypto.subtle.exportKey("jwk", key);
    const publicKey = Uint8Array.from(atob((jwk.x ?? "").replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    if (publicKey.length !== 32) return null;
    return { publicKey, sign: async (m) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, m as BufferSource)) };
  } catch { return null; }
}

/** The fallback: @noble/ed25519 (an audited, dependency-free implementation of RFC 8032), for a browser whose WebCrypto lacks Ed25519. */
async function nobleKey(seed: Uint8Array): Promise<CantonKey> {
  const ed = await import("@noble/ed25519");
  return { publicKey: await ed.getPublicKeyAsync(seed), sign: (m) => ed.signAsync(m, seed) };
}

/** The Canton key of a wallet signature. `useWebCrypto: false` forces the library (the tests check that both make the same key). */
export async function keyFromSignature(signature: string, useWebCrypto = true): Promise<CantonKey> {
  const seed = await seedFromSignature(signature);
  return (useWebCrypto ? await webKey(seed) : null) ?? nobleKey(seed);
}

/** Asks the wallet for the one signature, with no gas and nothing sent, and makes the key. The signature is not kept. */
export async function openKey(wallet: Eip1193, address: string): Promise<CantonKey> {
  const signature = await wallet.request({ method: "eth_signTypedData_v4", params: [address, JSON.stringify(keyTypedData)] });
  if (typeof signature !== "string") throw new Error("the wallet gave no signature");
  return keyFromSignature(signature);
}
