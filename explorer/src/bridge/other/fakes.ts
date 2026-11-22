// Fakes for the tests of the transfers to and from another chain: a plan (Ostia and Ethereum Sepolia), two chains that hold what the wallet sends, and the bridge's reads. Only the tests import this file.
import { encodeAbiParameters, encodeFunctionData, parseAbi, toEventSelector, zeroAddress, type Hex } from "viem";
import type { Call } from "./calls.ts";
import type { Claim, Deposit, Stage } from "./reads.ts";
import type { Asset, OpenRow, OstiaChain, Setup } from "./setup.ts";
import { NotSent } from "../evm/adapter.ts";
import { WrongChain, type Env, type Plan, type Receipt } from "./transfer.ts";
import type { LocksLike } from "../moves/moves.ts";
import type { StoreLike } from "../moves/state.ts";

export const memoryStore = (): StoreLike & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
};
/** A lock that is held until its callback ends; asked again meanwhile it says it is not available. */
export const memoryLocks = (): LocksLike => {
  const held = new Set<string>();
  return {
    async request<T>(name: string, _o: { ifAvailable: true }, cb: (lock: unknown | null) => Promise<T>): Promise<T> {
      if (held.has(name)) return cb(null);
      held.add(name);
      try { return await cb({}); } finally { held.delete(name); }
    },
  };
};

export const ME = "0x" + "e3".repeat(20);
export const OSTIA_BRIDGE = "0x" + "53".repeat(20), SEPOLIA_BRIDGE = "0x" + "52".repeat(20), WETH = "0x" + "62".repeat(20);
export const OSTIA_ID = 770101, SEPOLIA_ID = 11155111;
export const SIGNATURE = "BridgeEvent(uint8,uint32,address,uint32,address,uint256,bytes,uint32)";
export const TOPIC = toEventSelector(`event ${SIGNATURE}`);
export const ETH: Asset = { symbol: "ETH", name: "Ether", decimals: 18, sepolia: "native", ostia: WETH };
export const ostia: OstiaChain = { chainId: OSTIA_ID, name: "Ostia", networkId: 75, bridge: OSTIA_BRIDGE };
export const row = (over: Partial<OpenRow> = {}): OpenRow => ({
  id: "sepolia", name: "Ethereum Sepolia", open: true, networkId: 0, chainId: SEPOLIA_ID, bridge: SEPOLIA_BRIDGE, available: true, assets: [ETH], times: { in: null, out: null }, claimedForYou: { ostia: false, remote: false }, ...over,
});
export const plan = (over: Partial<OpenRow> = {}): Plan => ({ ostia, other: row(over), topic0: TOPIC });
export const setup = (over: Partial<OpenRow> = {}): Setup => ({
  on: true, chain: ostia, bridgeEvent: { signature: SIGNATURE, topic0: TOPIC },
  routes: [row(over), { id: "hadrian", name: "Hadrian", open: false }, { id: "solana-devnet", name: "Solana devnet", open: false }],
});
/** The same as the server's answer: the setup as JSON the page reads. */
export const setupBody = (over: Partial<OpenRow> = {}) => JSON.parse(JSON.stringify(setup(over)));

/** The deposit event a bridge writes, as a receipt log. */
export function eventLog(o: { bridge: string; dest: number; to?: string; amount: bigint; count: number }) {
  return {
    address: o.bridge, topics: [TOPIC],
    data: encodeAbiParameters(
      [{ type: "uint8" }, { type: "uint32" }, { type: "address" }, { type: "uint32" }, { type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "uint32" }],
      [0, 0, zeroAddress, o.dest, (o.to ?? ME) as Hex, o.amount, "0x", o.count],
    ),
  };
}
const claimAbi = parseAbi(["function claimAsset(bytes32[32] smtProofLocalExitRoot, bytes32[32] smtProofRollupExitRoot, uint256 globalIndex, bytes32 mainnetExitRoot, bytes32 rollupExitRoot, uint32 originNetwork, address originTokenAddress, uint32 destinationNetwork, address destinationAddress, uint256 amount, bytes metadata)"]);
const proof = Array<Hex>(32).fill(("0x" + "00".repeat(32)) as Hex);
export const claimData = (dest: number, to: string, amount: bigint): Hex =>
  encodeFunctionData({ abi: claimAbi, functionName: "claimAsset", args: [proof as never, proof as never, 1n, ("0x" + "01".repeat(32)) as Hex, ("0x" + "02".repeat(32)) as Hex, 0, zeroAddress, dest, to as Hex, amount, "0x"] });

export const hash = (n: number): Hex => ("0x" + n.toString(16).padStart(64, "0")) as Hex;

/** What the fake chains hold and what the wallet was asked. */
export interface World {
  /** Where the wallet is. */
  chain: number;
  /** The wallet's pending transaction count, by chain. */
  pending: Record<number, number>;
  sent: { chainId: number; call: Call; hash: Hex }[];
  /** How the wallet answers the next sends: "ok" (a hash), "refuse" (the person says no, code 4001), "silent" (an error that does not say whether it sent), "estimate" (the estimate fails). A sent call is recorded unless refused or estimated. */
  next: ("ok" | "refuse" | "silent" | "silent-sent" | "estimate")[];
  receipts: Map<string, Receipt>;
  seen: Map<string, { from: string; to: string | null; input: string; value: string }>;
  deposit: Deposit;
  claim: Claim | Error;
  asked: { ensure: number[]; deposit: number; claim: number };
  /** Reads of the Sepolia side fail with WrongChain while the wallet is elsewhere (as a wallet answers only for its own chain). */
  nextHash: number;
}

export const stage = (s: Stage): Deposit => ({ stage: s, sentAt: s === "unknown" ? null : "2026-11-22T21:40:00Z", confirmedAt: ["confirmed", "ready", "claimed"].includes(s) ? "2026-11-22T21:44:00Z" : null, readyAt: ["ready", "claimed"].includes(s) ? "2026-11-22T21:46:00Z" : null });

export function world(over: Partial<World> = {}): World {
  return { chain: SEPOLIA_ID, pending: { [SEPOLIA_ID]: 4, [OSTIA_ID]: 7 }, sent: [], next: [], receipts: new Map(), seen: new Map(), deposit: stage("unknown"), claim: new Error("not ready"), asked: { ensure: [], deposit: 0, claim: 0 }, nextHash: 0x1000, ...over };
}

export function fakeEnv(w: World, o: { plan?: Plan; id?: string; clock?: () => number; locks?: boolean; store?: ReturnType<typeof memoryStore> } = {}): Env & { store: ReturnType<typeof memoryStore> } {
  const store = o.store ?? memoryStore();
  let n = 0;
  return {
    plan: o.plan ?? plan(), account: ME, store, locks: o.locks === false ? null : memoryLocks(), now: o.clock ?? (() => 1_700_000_000_000), newId: () => o.id ?? `t${++n}`,
    async ensure(chainId) { w.asked.ensure.push(chainId); w.chain = chainId; return null; },
    async onChain(chainId) { return w.chain === chainId; },
    async nonces(chainId) { return { pending: w.pending[chainId]!, latest: w.pending[chainId]! }; },
    async send(chainId, call) {
      const how = w.next.shift() ?? "ok";
      if (how === "refuse") throw Object.assign(new Error("User rejected the request."), { code: 4001 });
      if (how === "estimate") throw new NotSent(new Error("execution reverted"));
      const hashOf = hash(w.nextHash++);
      if (how === "silent") throw new Error("The request timed out.");
      w.sent.push({ chainId, call, hash: hashOf });
      w.pending[chainId] = w.pending[chainId]! + 1;
      if (how === "silent-sent") throw new Error("The request timed out.");
      return hashOf;
    },
    async receipt(chainId, h) {
      if (chainId === SEPOLIA_ID && w.chain !== SEPOLIA_ID) throw new WrongChain(chainId);
      return w.receipts.get(h) ?? null;
    },
    async lookup(chainId, h) {
      if (chainId === SEPOLIA_ID && w.chain !== SEPOLIA_ID) throw new WrongChain(chainId);
      return w.seen.get(h) ?? null;
    },
    async deposit() { w.asked.deposit++; return w.deposit; },
    async claim() { w.asked.claim++; if (w.claim instanceof Error) throw w.claim; return w.claim; },
  };
}
