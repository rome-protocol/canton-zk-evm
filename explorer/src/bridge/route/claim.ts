// The person's own claim of a move that is ready: the wallet is put on Ethereum Sepolia and signs the claim the explorer's bridge route handed over, after the page checks that it pays this wallet exactly this
// amount on this chain. Nothing signs on its own. The hash of the claim is kept in this browser, so that a reload does not offer the same claim again while it is on its way.
import type { Hex } from "viem";
import type { StoreLike } from "../moves/state.ts";
import { padGas } from "../evm/adapter.ts";
import { asTransaction, isClaimFor } from "../other/calls.ts";
import { readClaim, ReadError } from "../other/reads.ts";
import { Stop, readStop } from "../other/transfer.ts";
import { ensureOther } from "../other/wire.ts";
import type { Eip1193 } from "../../wallet.ts";
import type { Move } from "./setup.ts";
import { DEST } from "./words.ts";

const key = (id: string) => `ostia-route-claim-${id}`;
/** How long a claim the browser asked for is counted as on its way. */
const KEPT_MS = 10 * 60_000;

export function keptClaim(store: StoreLike | null, id: string, nowMs: number): Hex | null {
  try {
    const v = JSON.parse(store?.getItem(key(id)) ?? "null") as { hash?: unknown; at?: unknown } | null;
    return v && typeof v.hash === "string" && /^0x[0-9a-f]{64}$/i.test(v.hash) && typeof v.at === "number" && nowMs - v.at < KEPT_MS ? (v.hash as Hex) : null;
  } catch { return null; }
}
function keepClaim(store: StoreLike | null, id: string, hash: Hex, nowMs: number): void {
  try { store?.setItem(key(id), JSON.stringify({ hash, at: nowMs })); } catch { /* a browser that keeps nothing asks again after a reload; the estimate stops a claim already paid */ }
}

export interface ClaimOptions { wallet: Eip1193; account: string; move: Move; sepolia: { chainId: number; bridge: string }; ostiaNetwork: number; store: StoreLike | null; now?: () => number }

/** Asks the wallet to claim. Throws a `Stop` (or what the wallet threw) with nothing signed when the claim is not this move's, not ready, or already paid. Returns the hash the wallet gave. */
export async function claimOwn(o: ClaimOptions): Promise<Hex> {
  const { move, sepolia } = o;
  if (move.state !== "taken" || move.depositCount === null || move.send === null) throw new Stop("This move is not ready to claim.");
  let claim;
  try { claim = await readClaim(o.ostiaNetwork, move.depositCount); } catch (e) { throw e instanceof ReadError ? readStop(e) : e; }
  if (claim.claimed) throw new Stop("Already arrived.");
  if (claim.data === null || claim.to.toLowerCase() !== sepolia.bridge.toLowerCase() || claim.chainId !== sepolia.chainId || claim.destinationNetwork !== 0
    || !isClaimFor(claim.data, { destinationNetwork: 0, receiver: move.destAddress, amount: move.send, count: move.depositCount })) {
    throw new Stop("The bridge sent back a claim that is not this move's, so nothing was signed. Try again in a moment.");
  }
  const why = await ensureOther(o.wallet, sepolia.chainId, DEST);
  if (why) throw new Stop(why);
  const call = { to: claim.to, data: claim.data as Hex, value: "0" };
  const gas = padGas(BigInt(String(await o.wallet.request({ method: "eth_estimateGas", params: [asTransaction(o.account, call)] }))));
  const hash = await o.wallet.request({ method: "eth_sendTransaction", params: [asTransaction(o.account, call, gas, sepolia.chainId)] });
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Stop("Your wallet did not give a transaction hash.");
  keepClaim(o.store, move.id, hash as Hex, (o.now ?? Date.now)());
  return hash as Hex;
}
