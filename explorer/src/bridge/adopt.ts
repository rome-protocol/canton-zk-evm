// A move that was started in another browser (or whose record here is gone) is still open on Canton. This builds the record this browser needs to carry it on, from what Canton says is open:
// the move library then picks it up like any kept move, never asks the wallet before the person says go, and releases or claims from a vault it picks again. Nothing here signs or sends.
import type { Address } from "viem";
import { parseAmount } from "./amounts.ts";
import type { AllocationView, OpenRequest, OpenState } from "./canton/accounts.ts";
import type { BridgeConfig } from "./evm/config.ts";
import { depositIdOf, keptMoves, saveCheckpoint, sameId, type Checkpoint, type StoreLike } from "./moves/state.ts";

/** Thrown when a request that was listed as open is not open any more when its move is about to be kept. */
export class NoLongerOpen extends Error {
  constructor() { super("This move is no longer open on Canton."); }
}

/** Whether the request is still among the account's open requests (redeem or deposit), by its contract. */
export const stillOpen = (request: OpenRequest, open: Pick<OpenState, "redeemRequests" | "depositRequests">): boolean =>
  [...open.redeemRequests, ...open.depositRequests].some((r) => r.contractId === request.contractId);

const bare = (t: string) => t.replace(/^0x/, "").toLowerCase();
const HEX40 = /^[0-9a-f]{40}$/;
const str = (x: unknown): string | null => (typeof x === "string" && x.length > 0 && x.length <= 128 ? x : null);

/** Canton's 10-decimal amount as it is typed: "1.5000000000" is "1.5", "3.0000000000" is "3". */
export const typedAmount = (canton: string): string => canton.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");

/** The redeem an open request stands for, when this build moves its token and the request is the account's own. */
export function redeemRecord(r: OpenRequest, o: { account: Address; party: string; config: BridgeConfig }): Checkpoint | null {
  const a = r.arguments, ref = str(a.ref), amount = typeof a.amount === "string" ? typedAmount(a.amount) : null;
  const erc20 = typeof a.token === "string" ? bare(a.token) : "", recipient = typeof a.recipient === "string" ? bare(a.recipient) : "";
  if (ref === null || amount === null || !HEX40.test(recipient) || (typeof a.holder === "string" && a.holder !== o.party)) return null;
  const twin = o.config.twins.find((t) => bare(t.address) === erc20);
  if (!twin) return null;
  try { parseAmount(amount, twin.decimals); } catch { return null; }
  const to = `0x${recipient}` as Address;
  return { input: { kind: "redeem", asset: twin.address, amount, to }, ref, account: o.account, party: o.party, vault: o.config.vault, to, stage: "canton", at: Date.now() };
}

/** The deposit an open request stands for: its token and amount come from the allocation the account made under the request's label. Null when the allocation is not there any more or its token is not one this build moves. */
export async function depositRecord(r: OpenRequest, o: { account: Address; party: string; config: BridgeConfig; allocations(): Promise<AllocationView[]> }): Promise<Checkpoint | null> {
  const a = r.arguments, label = str(a.label), id = a.depositId;
  if (label === null || !sameId(depositIdOf(o.party, label), id) || (typeof a.depositor === "string" && a.depositor !== o.party)) return null;
  const held = (await o.allocations()).find((x) => x.allocation.settlement.settlementRef.id === label);
  const leg = held?.allocation.transferLeg;
  if (!leg) return null;
  const wrapped = o.config.wrapped.find((w) => w.instrument?.admin === leg.instrumentId.admin && w.instrument.id === leg.instrumentId.id);
  if (!wrapped) return null;
  const amount = typedAmount(leg.amount);
  try { parseAmount(amount, wrapped.decimals); } catch { return null; }
  return { input: { kind: "deposit", asset: wrapped.address, amount }, ref: label, account: o.account, party: o.party, vault: o.config.vault, stage: "canton", at: Date.now() };
}

/**
 * Keeps a record for an open request this browser has no record of. Null when this build cannot carry the request on. The open requests are read again just before the record is kept: a request that is
 * not open any more keeps nothing and throws NoLongerOpen. A record that is kept already is the person's own and is never overwritten. Returns the record's ref.
 */
export async function adoptRecord(kind: "redeem" | "deposit", request: OpenRequest, o: {
  account: Address; party: string; config: BridgeConfig; allocations(): Promise<AllocationView[]>; openRequests(): Promise<OpenState>; store: StoreLike | null;
}): Promise<string | null> {
  const record = kind === "redeem" ? redeemRecord(request, o) : await depositRecord(request, o);
  if (record === null) return null;
  if (!stillOpen(request, await o.openRequests())) throw new NoLongerOpen();
  if (!keptMoves(o.store).some((c) => c.ref === record.ref)) saveCheckpoint(o.store, record);
  return record.ref;
}
