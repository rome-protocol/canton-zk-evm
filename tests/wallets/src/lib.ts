// The shared parts of the harness: the run folder, the throwaway seed, and the reference (what the Bridge page would derive from a wallet that signs by RFC 6979).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { generateMnemonic, english, mnemonicToAccount } from "viem/accounts";
// The page's own functions, not a copy: the typed data, the normal form, the HKDF and the party made from the key's fingerprint.
import { KEY_TYPED_DATA, keyFromSignature, normaliseSignature, hex } from "../../../explorer/src/bridge/canton/key.ts";
import { partyOf } from "../../../explorer/src/bridge/canton/topology.ts";
import { HERE } from "./paths.ts";
import { scrubber } from "./scrub.ts";

export { KEY_TYPED_DATA, HERE };
export const RUN = join(HERE, "run");
export const sha256hex = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

/** The throwaway seed phrase, made on the first run and kept in the run folder (mode 0600) so that every wallet and the live check use the same account. It is never printed and never leaves the run folder. */
export function seed(): { mnemonic: string; unlock: string } {
  mkdirSync(RUN, { recursive: true });
  const file = join(RUN, "secret.json");
  if (!existsSync(file)) {
    const made = { mnemonic: generateMnemonic(english, 128), unlock: ["Aa1", randomBytes(12).toString("hex")].join("!") };
    writeFileSync(file, JSON.stringify(made), { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

let scrubbing: ((text: string) => string) | null = null;
/** Text with the seed's words and the unlock password taken out: use it on everything that is logged or written to a result. */
export const scrub = (text: string): string => (scrubbing ??= scrubber(seed()))(text);

export interface Reference {
  address: string;
  /** RFC 6979 signature by viem (the form viem gives: low s, v 27 or 28). */
  signature: string;
  normalised: string;
  /** The Canton key the Bridge page derives from it: the public key's fingerprint, and the account name (`rome::1220...`) of the page's namespace hint. */
  publicKey: string;
  fingerprint: string;
  party: string;
}

export const TYPED_JSON = JSON.stringify(KEY_TYPED_DATA);

export async function reference(): Promise<Reference> {
  const account = mnemonicToAccount(seed().mnemonic);   // the first account, m/44'/60'/0'/0/0
  const signature = await account.signTypedData({ domain: KEY_TYPED_DATA.domain, types: KEY_TYPED_DATA.types, primaryType: KEY_TYPED_DATA.primaryType, message: KEY_TYPED_DATA.message });
  const key = await keyFromSignature(signature);
  const party = await partyOf(key.publicKey, "rome");
  return { address: account.address, signature, normalised: normaliseSignature(signature), publicKey: hex(key.publicKey), fingerprint: party.split("::")[1]!, party };
}

/** What a raw signature looks like before the page normalises it. */
export function form(raw: string): { v: string; lowS: boolean } {
  const b = Buffer.from(raw.replace(/^0x/, ""), "hex");
  const s = BigInt("0x" + b.subarray(32, 64).toString("hex"));
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  return { v: "0x" + b[64]!.toString(16).padStart(2, "0"), lowS: s <= N / 2n };
}

export async function fingerprintOf(raw: string): Promise<string> {
  const key = await keyFromSignature(raw);
  return (await partyOf(key.publicKey, "rome")).split("::")[1]!;
}
export { normaliseSignature };
