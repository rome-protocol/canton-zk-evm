import type { TwinCanton, TwinLeg, TwinLine, TwinsOverview } from "../api.ts";
import { addr, hash } from "../test-utils.tsx";

/** A pinned twin: 500 TKA in issue (3 locks, 1 release), and the vaults hold the same. */
export const twinLine = (over: Partial<TwinLine> = {}): TwinLine => ({
  token: addr(0xb1), symbol: "TKA", name: "Token A", decimals: 6, supply: "500000000", vaultBalance: "500000000", matched: true, locks: 3, releases: 1, through: 21, ...over,
});
/** A Canton token on Ostia: wTKB, 123 in custody on Canton (10 decimals) against 123 wrapped (6 decimals). */
export const twinCanton = (over: Partial<TwinCanton> = {}): TwinCanton => ({
  token: addr(0xd1), symbol: "wTKB", name: "Wrapped TKB", decimals: 6, instrumentAdmin: "registry::1220" + "ff".repeat(32), instrumentId: "TKB", custody: "1230000000000", custodyDecimals: 10, holdings: 3,
  supply: "123000000", supplyBlock: 21, matched: true, ledgerOffset: 4242, readAt: "2026-10-25T10:00:00.000Z", ...over,
});
export const twinLeg = (n: number, over: Partial<TwinLeg> = {}): TwinLeg => ({
  block: 20 + n, txHash: hash(n), legId: hash(0x70 + n), twin: "lock", token: addr(0xb1), symbol: "TKA", amount: "100000000", updateId: "1220" + n.toString(16).padStart(2, "0").repeat(32), ...over,
});
export const twinsOverview = (over: Partial<TwinsOverview> = {}): TwinsOverview => ({
  through: 21, registryService: null, vaults: [{ address: addr(0xc1), codeHash: hash(0x0c) }], twins: [twinLine()], canton: [twinCanton()], legs: [twinLeg(2), twinLeg(1, { twin: "release", amount: "40000000" })], ...over,
});
