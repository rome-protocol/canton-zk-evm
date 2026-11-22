// The two reads of a transfer that is under way: where its deposit is, and the claim receipt. Both are GETs of the explorer's own API (the server reads, the person's wallet signs).

export type Stage = "unknown" | "sent" | "confirmed" | "ready" | "claimed";
const STAGES: readonly string[] = ["unknown", "sent", "confirmed", "ready", "claimed"];

export interface Deposit {
  stage: Stage;
  /** ISO times, null before their stage. */
  sentAt: string | null; confirmedAt: string | null; readyAt: string | null;
}
export interface Claim {
  claimed: boolean;
  chainId: number; to: string; destinationNetwork: number;
  /** The call of `claimAsset`; null when the deposit is already paid out. */
  data: string | null;
  /** The arguments that call is made of (what the router's claim takes), or null when the answer has none. */
  args?: ClaimArgs | null;
}
export interface ClaimArgs {
  smtProofLocalExitRoot: string[]; smtProofRollupExitRoot: string[]; globalIndex: bigint; mainnetExitRoot: string; rollupExitRoot: string;
  originNetwork: number; originTokenAddress: string; destinationNetwork: number; destinationAddress: string; amount: bigint; metadata: string;
}

/** A read that failed: `status` is the server's (0 when it could not be reached). 404 on the claim is "not ready yet", 429 is "slow down", 503 is "cannot be read right now". */
export class ReadError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.name = "ReadError"; this.status = status; }
}

const obj = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const time = (v: unknown): string | null => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);

async function get(path: string, signal?: AbortSignal): Promise<unknown> {
  let res: Response;
  try { res = await fetch(path, { headers: { accept: "application/json" }, signal }); } catch { throw new ReadError("The explorer cannot be reached.", 0); }
  const body: unknown = await res.json().catch(() => null);
  if (res.status !== 200) throw new ReadError(typeof obj(body)?.error === "string" ? (obj(body)!.error as string) : "The bridge cannot be read right now.", res.status);
  return body;
}

const query = (network: number, count: number) => `network=${network}&count=${count}`;

export async function readDeposit(network: number, count: number, signal?: AbortSignal): Promise<Deposit> {
  const b = obj(await get(`/api/agglayer/deposit?${query(network, count)}`, signal));
  if (!b || typeof b.stage !== "string" || !STAGES.includes(b.stage)) throw new ReadError("The bridge cannot be read right now.", 503);
  return { stage: b.stage as Stage, sentAt: time(b.sentAt), confirmedAt: time(b.confirmedAt), readyAt: time(b.readyAt) };
}

const hex32 = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
const addr = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const dec = (v: unknown): bigint | null => (typeof v === "string" && /^\d{1,78}$/.test(v) ? BigInt(v) : null);
const net = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v < 2 ** 32;
function claimArgs(v: unknown): ClaimArgs | null {
  const a = obj(v);
  if (!a) return null;
  const [globalIndex, amount] = [dec(a.globalIndex), dec(a.amount)];
  const proofs = (p: unknown): p is string[] => Array.isArray(p) && p.length === 32 && p.every(hex32);
  if (!proofs(a.smtProofLocalExitRoot) || !proofs(a.smtProofRollupExitRoot) || globalIndex === null || amount === null || !hex32(a.mainnetExitRoot) || !hex32(a.rollupExitRoot)) return null;
  if (!net(a.originNetwork) || !net(a.destinationNetwork) || !addr(a.originTokenAddress) || !addr(a.destinationAddress) || typeof a.metadata !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(a.metadata)) return null;
  return { smtProofLocalExitRoot: a.smtProofLocalExitRoot, smtProofRollupExitRoot: a.smtProofRollupExitRoot, globalIndex, mainnetExitRoot: a.mainnetExitRoot, rollupExitRoot: a.rollupExitRoot, originNetwork: a.originNetwork, originTokenAddress: a.originTokenAddress, destinationNetwork: a.destinationNetwork, destinationAddress: a.destinationAddress, amount, metadata: a.metadata };
}

export async function readClaim(network: number, count: number, signal?: AbortSignal): Promise<Claim> {
  const b = obj(await get(`/api/agglayer/claim?${query(network, count)}`, signal));
  if (!b || typeof b.claimed !== "boolean" || typeof b.chainId !== "number" || typeof b.to !== "string" || typeof b.destinationNetwork !== "number") throw new ReadError("The bridge cannot be read right now.", 503);
  return { claimed: b.claimed, chainId: b.chainId, to: b.to, destinationNetwork: b.destinationNetwork, data: typeof b.data === "string" ? b.data : null, args: claimArgs(b.args) };
}
