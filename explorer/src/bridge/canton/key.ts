// The Canton account's key, derived from one wallet signature. The same wallet makes the same key on any device, and the key is held in memory only.
// The key signs through one function for each purpose (the account's onboarding, a transaction the page checked, a request to the account service) and has no
// general signing method: the raw signer is private to this module.
import { recoverTypedDataAddress } from "viem";
import type { Eip1193 } from "../../wallet.ts";

export const OSTIA_CHAIN_ID = 770101;   // PINS CHAIN_ID: the wallet must be on this chain, or it refuses to sign typed data for it
export const KEY_INFO = "ostia-bridge canton-key v1";
export const DIFFERENT_SIGNATURES = "this wallet does not sign the same way twice, so it cannot hold a Canton account here";

/** The site's origin, from the page's configuration (`VITE_SITE_ORIGIN`, such as https://ostia.devnet.romeprotocol.xyz): scheme and host, no path. */
export function originFromEnv(env: Record<string, string | undefined>): string {
  const origin = env.VITE_SITE_ORIGIN;
  if (!origin || !/^https?:\/\/[^/\s?#]+$/.test(origin)) throw new Error("VITE_SITE_ORIGIN is not set to an origin (https://host)");
  return origin;
}

/** The words of the signature request name the site, so a person reads where it is meant to be signed. They do not bind the signature to the site: a wallet shows
 * no origin of the page that asks, so a page of another site can ask for the same words. The mainnet account needs a sign-in-with-origin message (the wallet
 * puts the asking origin in it) or a passkey, which only the real site can use. */
export const statement = (origin: string): string => `Open my Canton account on Ostia at ${origin}. This signature is your Canton key; sign it only on ${origin}.`;

/** The EIP-712 request: a signature of it is bound to the name "Ostia bridge" and the chain, so a signature asked for by another site is another one. */
export const keyTypedData = (origin: string) => ({
  types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }], Open: [{ name: "statement", type: "string" }] },
  primaryType: "Open" as const,
  domain: { name: "Ostia bridge", version: "1", chainId: OSTIA_CHAIN_ID },
  message: { statement: statement(origin) },
});

/** An Ed25519 key's public half. What it signs, it signs through `signOnboarding`, `signVerifiedTransaction` and `signRequest`. */
export interface CantonKey {
  readonly publicKey: Uint8Array;   // 32 raw bytes
}
const signers = new WeakMap<CantonKey, (message: Uint8Array) => Promise<Uint8Array>>();
const sign = (key: CantonKey, message: Uint8Array): Promise<Uint8Array> => {
  const signer = signers.get(key);
  if (!signer) throw new Error("not a key made by this library");
  return signer(message);
};

/** The account's onboarding: the multi-hash of its topology (34 bytes: Canton's hash format, 0x12 0x20 and a SHA-256). The caller checks the topology; only that format is signed. */
export function signOnboarding(key: CantonKey, multiHash: Uint8Array): Promise<Uint8Array> {
  if (multiHash.length !== 34 || multiHash[0] !== 0x12 || multiHash[1] !== 0x20) throw new Error("an onboarding signs a 34-byte multi-hash (0x12 0x20 and a SHA-256)");
  return sign(key, multiHash);
}
/** A prepared transaction's hash (32 bytes). Only `signPrepared` (sign.ts) calls this, with a hash it computed itself from a transaction it checked. */
export function signVerifiedTransaction(key: CantonKey, hash: Uint8Array): Promise<Uint8Array> {
  if (hash.length !== 32) throw new Error("a transaction's hash is 32 bytes");
  return sign(key, hash);
}
/** The account-request header's message (accounts.ts): text that starts with the protocol's name, which no hash does. */
export function signRequest(key: CantonKey, message: string): Promise<Uint8Array> {
  if (!message.startsWith("accounts-v1\n")) throw new Error("a request message starts with accounts-v1");
  return sign(key, new TextEncoder().encode(message));
}

export const bytesFromHex = (hex: string): Uint8Array => {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(h)) throw new Error("not hex");
  return Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
};
export const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const base64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));
export const fromBase64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;   // the order of secp256k1

/** One form of one wallet signature: the recovery byte 27 or 28 (a wallet may give 0 or 1), and the low-s form (a wallet may give either of the two that verify). */
export function normaliseSignature(signature: string): `0x${string}` {
  const sig = bytesFromHex(signature);
  if (sig.length !== 65) throw new Error("a wallet signature is 65 bytes");
  let v = sig[64]!;
  if (v < 2) v += 27;
  if (v !== 27 && v !== 28) throw new Error("the recovery byte of the wallet's signature is not 0, 1, 27 or 28");
  let s = BigInt("0x" + hex(sig.slice(32, 64)));
  if (s === 0n || s >= N) throw new Error("the wallet's signature is not a secp256k1 signature");
  if (s > N / 2n) { s = N - s; v = v === 27 ? 28 : 27; }
  return `0x${hex(sig.slice(0, 32))}${s.toString(16).padStart(64, "0")}${v.toString(16)}`;
}

/** HKDF-SHA256 over the normalised 65-byte signature (no salt), 32 bytes: the Ed25519 private key. */
export async function seedFromSignature(signature: string): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey("raw", bytesFromHex(normaliseSignature(signature)) as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(KEY_INFO) }, material, 256);
  return new Uint8Array(bits);
}

const PKCS8_ED25519 = bytesFromHex("302e020100300506032b657004220420");   // the DER prefix of an Ed25519 private key; the 32-byte seed follows

/** WebCrypto's Ed25519 where the browser has it: the private key is imported as PKCS#8 and is not extractable. The public half comes from the seed by the library. */
async function webKey(seed: Uint8Array, publicKey: Uint8Array): Promise<CantonKey | null> {
  try {
    const key = await crypto.subtle.importKey("pkcs8", new Uint8Array([...PKCS8_ED25519, ...seed]) as BufferSource, { name: "Ed25519" }, false, ["sign"]);
    const made: CantonKey = { publicKey };
    signers.set(made, async (m) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, m as BufferSource)));
    return made;
  } catch { return null; }
}

/** The key's public half, and the fallback signer: @noble/ed25519 (an audited, dependency-free implementation of RFC 8032), for a browser whose WebCrypto lacks Ed25519. */
async function nobleKey(seed: Uint8Array, publicKey: Uint8Array): Promise<CantonKey> {
  const ed = await import("@noble/ed25519");
  const made: CantonKey = { publicKey };
  signers.set(made, (m) => ed.signAsync(m, seed));
  return made;
}

/** The Canton key of a wallet signature. `useWebCrypto: false` forces the library (the tests check that both make the same key). */
export async function keyFromSignature(signature: string, useWebCrypto = true): Promise<CantonKey> {
  const seed = await seedFromSignature(signature);
  const publicKey = await (await import("@noble/ed25519")).getPublicKeyAsync(seed);
  return (useWebCrypto ? await webKey(seed, publicKey) : null) ?? nobleKey(seed, publicKey);
}

/** One signature from the wallet (no gas, nothing sent), in its normal form, and checked to be the connected address's: the signer is recovered from it. */
async function walletSignature(wallet: Eip1193, address: string, origin: string): Promise<string> {
  const typed = keyTypedData(origin);
  const given = await wallet.request({ method: "eth_signTypedData_v4", params: [address, JSON.stringify(typed)] });
  if (typeof given !== "string") throw new Error("the wallet gave no signature");
  const signature = normaliseSignature(given);
  const signer = await recoverTypedDataAddress({ domain: typed.domain, types: { Open: [{ name: "statement", type: "string" }] }, primaryType: "Open", message: typed.message, signature });
  if (signer.toLowerCase() !== address.toLowerCase()) throw new Error("the signature is not the connected account's: the wallet signed as another address");
  return signature;
}

/** Asks the wallet for the one signature and makes the key. The signature is not kept. */
export async function openKey(wallet: Eip1193, address: string, origin: string): Promise<CantonKey> {
  return keyFromSignature(await walletSignature(wallet, address, origin));
}

/** On the first account: asks again, and refuses if the wallet signs another way (a wallet that is not deterministic would make another key each time, and lose the account). */
export async function confirmKey(wallet: Eip1193, address: string, origin: string, key: CantonKey): Promise<void> {
  const again = await keyFromSignature(await walletSignature(wallet, address, origin));
  if (!sameBytes(again.publicKey, key.publicKey)) throw new Error(DIFFERENT_SIGNATURES);
}
