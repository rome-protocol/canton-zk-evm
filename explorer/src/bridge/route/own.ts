// The person's own transactions on Ostia for a coin on its way to Canton: the claim, "Send on to Canton" and "Send back". Each is one call of the router, signed in any EVM wallet with a little tROME, and
// each is safe to ask for twice (the bridge's claimed bitmap, an empty inbox and a clock that has not ended all make the second one revert at the estimate, before the wallet is asked). The hash is kept in this browser
// for a while, so that a reload does not offer the same step again while it is on its way.
import type { Hex } from "viem";
import { padGas } from "../evm/adapter.ts";
import { ensureOstia } from "../evm/network.ts";
import type { StoreLike } from "../moves/state.ts";
import { asTransaction, type Call } from "../other/calls.ts";
import { Stop } from "../other/transfer.ts";
import type { Eip1193 } from "../../wallet.ts";
import { plainText } from "../words.ts";
import type { KeptAct } from "./back.ts";

const key = (id: string) => `ostia-in-act-${id}`;
/** How long a step the browser asked for is kept. */
const KEPT_MS = 24 * 3_600_000;

export function keptAct(store: StoreLike | null, id: string, nowMs: number): KeptAct | null {
  try {
    const v = JSON.parse(store?.getItem(key(id)) ?? "null") as Partial<KeptAct> | null;
    const ok = v && (v.kind === "claim" || v.kind === "forward" || v.kind === "refund") && typeof v.hash === "string" && /^0x[0-9a-f]{64}$/i.test(v.hash) && typeof v.at === "number" && nowMs - v.at < KEPT_MS;
    return ok ? { kind: v.kind!, hash: v.hash!, at: v.at! } : null;
  } catch { return null; }
}
function keepAct(store: StoreLike | null, id: string, act: KeptAct): void {
  try { store?.setItem(key(id), JSON.stringify(act)); } catch { /* a browser that keeps nothing may offer the step again after a reload; the estimate stops one that is already done */ }
}

export interface OwnOptions {
  wallet: Eip1193;
  account: string;
  ostia: { chainId: number; chainName: string; coin: { symbol: string; decimals: number } };
  id: string;
  kind: KeptAct["kind"];
  call: Call;
  store: StoreLike | null;
  now?: () => number;
}

/** Puts the wallet on Ostia, estimates the call (a call that would revert stops here, with nothing signed) and asks the wallet to send it. Returns the hash the wallet gave. */
export async function signOwn(o: OwnOptions): Promise<Hex> {
  const put = await ensureOstia(o.wallet, o.ostia);
  if (!put.ok) throw new Stop(plainText(put.message) ?? `Your wallet is not on ${o.ostia.chainName} yet.`);
  let gas: bigint;
  try { gas = padGas(BigInt(String(await o.wallet.request({ method: "eth_estimateGas", params: [asTransaction(o.account, o.call)] })))); }
  catch { throw new Stop(`${o.ostia.chainName} would not take this now. It may already be done. Nothing was sent.`); }
  const hash = await o.wallet.request({ method: "eth_sendTransaction", params: [asTransaction(o.account, o.call, gas, o.ostia.chainId)] });
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Stop("Your wallet did not give a transaction hash.");
  keepAct(o.store, o.id, { kind: o.kind, hash, at: (o.now ?? Date.now)() });
  return hash as Hex;
}
