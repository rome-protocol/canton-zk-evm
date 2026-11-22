// Fakes for the tests of the Canton route: the setup and the moves as the server answers them, and the same as the page reads them. Only the tests import this file.
import { claimData, ME, OSTIA_BRIDGE, OSTIA_ID, row, SEPOLIA_BRIDGE, SEPOLIA_ID } from "../other/fakes.ts";
import type { Move, RouteAsset, RouteOn } from "./setup.ts";
import { parseRouteSetup } from "./setup.ts";

export { ME, OSTIA_BRIDGE, OSTIA_ID, SEPOLIA_BRIDGE, SEPOLIA_ID, row };
export const CC = "0x" + "cc".repeat(20);
const CC10 = 10n ** 10n;
export const cc = (n: number): bigint => BigInt(Math.round(n * 1e4)) * (CC10 / 10_000n);
export const asset = (over: Partial<RouteAsset> = {}): RouteAsset => ({ erc20: CC, symbol: "CC", name: "Canton Coin", decimals: 10, feeOut: cc(0.05), claimFee: cc(0.15), minAmount: cc(1), lockCap: cc(10), lockRoom: cc(10), ...over });
export const on = (over: Partial<RouteOn> = {}, a: Partial<RouteAsset> = {}): RouteOn => ({ on: true, route: "open", available: true, unit: 1n, assets: [asset(a)], time: null, notTakenSeconds: 600, ownClaimSeconds: 300, ...over });
const text = (v: bigint | null) => (v === null ? null : v.toString());
/** The setup as the server's JSON. */
export const setupBody = (over: Partial<RouteOn> = {}, a: Partial<RouteAsset> = {}) => {
  const s = on(over, a);
  return {
    on: true, route: s.route, available: s.available, destination: { network: 0, unit: s.unit.toString() }, time: s.time, notTakenSeconds: s.notTakenSeconds, ownClaimSeconds: s.ownClaimSeconds,
    assets: s.assets.map((x) => ({ erc20: x.erc20, symbol: x.symbol, name: x.name, decimals: x.decimals, feeOut: text(x.feeOut), claimFee: text(x.claimFee), minAmount: text(x.minAmount), lockCap: text(x.lockCap), lockRoom: text(x.lockRoom) })),
  };
};
export const parsed = (over: Partial<RouteOn> = {}) => parseRouteSetup(setupBody(over)) as RouteOn;

export const ID = "0x" + "d1".repeat(32);
const base = { id: ID, party: "alice::1220" + "9f".repeat(16), destAddress: ME, block: null, txHash: null, depositCount: null, erc20: null, amount: null, send: null, fee: null, at: null, settleBefore: null };
/** A move Ostia took: 5 CC, fee 0.2, so 4.8 sent. */
export const taken = (over: Partial<Move> = {}): Move => ({ ...base, state: "taken", erc20: CC, amount: cc(5), send: cc(4.8), fee: cc(0.2), depositCount: 7, txHash: "0x" + "ab".repeat(32), block: 88_214, at: "2026-11-22T21:41:00.000Z", ...over });
/** A request Ostia has not taken: 5 CC, signed 21:40, free again from 23:40. */
export const requested = (over: Partial<Move> = {}): Move => ({ ...base, state: "requested", amount: cc(5), at: "2026-11-22T21:40:00.000Z", settleBefore: "2026-11-22T23:40:00.000Z", ...over });
const json = (m: Move) => ({ id: m.id, state: m.state, party: m.party, destAddress: m.destAddress, erc20: m.erc20, amount: text(m.amount), send: text(m.send), fee: text(m.fee), depositCount: m.depositCount, txHash: m.txHash, block: m.block, at: m.at, maxFee: m.state === "requested" ? "2000000000" : null, settleBefore: m.settleBefore });
export const movesBody = (moves: Move[], requestsRead = true) => ({ moves: moves.map(json), requestsRead });
/** The claim of the taken move on Ethereum Sepolia, as the explorer's claim route hands it over. */
export const claimBody = (over: Record<string, unknown> = {}) => ({ network: 75, count: 7, claimed: false, destinationNetwork: 0, chainId: SEPOLIA_ID, to: SEPOLIA_BRIDGE, l1InfoTreeIndex: 1, data: claimData(0, ME, cc(4.8), 7), args: null, ...over });
export const wrongClaim = (over: { amount?: bigint; to?: string; count?: number } = {}) => claimData(0, over.to ?? ME, over.amount ?? cc(4.8), over.count ?? 7);
