import { readFileSync } from "node:fs";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ConfigError } from "./config.ts";
import { RethError, type Reth } from "./reth.ts";

/** A plain transfer of the native coin costs exactly this much gas. */
export const FAUCET_GAS = 21000n;

const ADDRESS = /^0x[0-9a-f]{40}$/;

export interface FaucetOptions {
  /** The faucet's private key, or null to turn the faucet off. */
  key: Hex | null;
  chainId: number;
  amountWei: bigint;
  perAddressSeconds: number;
  minIntervalMs: number;
  reth: Pick<Reth, "balance" | "nonce" | "gasPrice" | "priorityFee" | "sendRaw">;
  /** The time in milliseconds. A test sets its own. */
  now?: () => number;
}

export interface FaucetAnswer { status: number; body: unknown; headers?: Record<string, string> }

/** What the faucet page shows about the faucet itself. */
export interface FaucetInfo { on: boolean; address: string | null; balance: string | null; amount: string; perAddressSeconds: number }

export interface Faucet {
  readonly on: boolean;
  readonly address: string | null;
  info(): Promise<FaucetInfo>;
  /** Gives the coin to an address, if the limits allow. Never throws: every outcome is an answer. */
  request(address: unknown): Promise<FaucetAnswer>;
  /** How many addresses are waiting out their day. */
  served(): number;
}

/**
 * Reads the faucet's key from the file `FAUCET_KEY_FILE` names: 64 hex digits, with or without 0x. A missing or wrong file stops
 * the server at start. The message names the setting and never quotes the file.
 */
export function loadFaucetKey(file: string | null, read: (path: string) => string = (p) => readFileSync(p, "utf8")): Hex | null {
  if (file === null) return null;
  let text: string;
  try {
    text = read(file);
  } catch {
    throw new ConfigError(`FAUCET_KEY_FILE ${file} cannot be read`);
  }
  const key = text.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(key)) throw new ConfigError(`FAUCET_KEY_FILE ${file} must hold 64 hex digits, with or without 0x`);
  return `0x${key}`;
}

/** A 429 also says which limit was hit, `address` or `busy`, so a page can word it without reading the message. */
const answer = (status: number, error: string, headers?: Record<string, string>, reason?: "address" | "busy"): FaucetAnswer => ({
  status, body: { error, ...(reason ? { reason } : {}) }, ...(headers ? { headers } : {}),
});
const seconds = (ms: number) => String(Math.max(1, Math.ceil(ms / 1000)));
const days = (s: number) => (s % 3600 === 0 ? `${s / 3600} hours` : `${s} seconds`);

export function createFaucet(o: FaucetOptions): Faucet {
  const now = o.now ?? Date.now;
  const account = o.key ? privateKeyToAccount(o.key) : null;
  const address = account ? account.address.toLowerCase() : null;
  const windowMs = o.perAddressSeconds * 1000;
  // Both limits live in memory, so a restart forgets them. `served` is in the order the addresses were served.
  const served = new Map<string, number>();
  let sending = false, lastEnd = -Infinity;

  async function send(to: string): Promise<FaucetAnswer> {
    const [balance, nonce, gasPrice, tip] = await Promise.all([o.reth.balance(address!), o.reth.nonce(address!, "pending"), o.reth.gasPrice(), o.reth.priorityFee()]);
    const maxFeePerGas = gasPrice * 2n;
    if (balance < o.amountWei + FAUCET_GAS * maxFeePerGas) return answer(503, "The faucet is empty.");
    const signed = await account!.signTransaction({
      type: "eip1559", chainId: o.chainId, nonce, to: to as Hex, value: o.amountWei, gas: FAUCET_GAS, maxFeePerGas, maxPriorityFeePerGas: tip < maxFeePerGas ? tip : maxFeePerGas,
    });
    const hash = await o.reth.sendRaw(signed);
    served.set(to, now());
    return { status: 200, body: { hash, to, amount: o.amountWei.toString() } };
  }

  return {
    on: account !== null,
    address,
    served: () => served.size,

    async info() {
      let balance: string | null = null;
      if (address) balance = await o.reth.balance(address).then((b) => b.toString(), () => null);
      return { on: account !== null, address, balance, amount: o.amountWei.toString(), perAddressSeconds: o.perAddressSeconds };
    },

    async request(raw) {
      if (!account) return answer(503, "The faucet is off.");
      const to = typeof raw === "string" ? raw.toLowerCase() : "";
      if (!ADDRESS.test(to)) return answer(400, "That is not an address. An address is 0x and 40 hex digits.");
      const t = now();
      for (const [a, at] of served) { if (at + windowMs > t) break; served.delete(a); }
      const again = served.get(to);
      if (again !== undefined) return answer(429, `This address was given coins in the last ${days(o.perAddressSeconds)}. Try again later.`, { "Retry-After": seconds(again + windowMs - t) }, "address");
      if (sending) return answer(429, "The faucet is sending another request. Try again in a moment.", { "Retry-After": seconds(o.minIntervalMs) }, "busy");
      if (t < lastEnd + o.minIntervalMs) return answer(429, "The faucet sends one request at a time, a little apart. Try again in a moment.", { "Retry-After": seconds(lastEnd + o.minIntervalMs - t) }, "busy");
      sending = true;
      try {
        return await send(to);
      } catch (e) {
        // Only the message of a failed read or send is logged: never the key, never the signing call.
        if (!(e instanceof RethError)) console.error("faucet: the payout failed before it was sent");
        else console.error(`faucet: ${e.message}`);
        return e instanceof RethError && e.answered ? answer(503, "The chain did not accept the faucet's transfer. Try again in a moment.") : answer(503, "The faucet cannot reach the chain right now.");
      } finally {
        sending = false;
        lastEnd = now();
      }
    },
  };
}
