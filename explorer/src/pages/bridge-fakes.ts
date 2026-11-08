// Fakes for the tests of the Bridge page: a chain's configuration, an Ostia account, a Canton adapter, and a session built on the real move library. Only the tests import this file.
import { vi } from "vitest";
import type { Address, Hex } from "viem";
import type { ApiTx, BlockLeg } from "../api.ts";
import type { EvmAdapter } from "../bridge/evm/adapter.ts";
import type { BridgeConfig } from "../bridge/evm/config.ts";
import { createMove, type CantonAdapter, type LocksLike } from "../bridge/moves/moves.ts";
import { lockIdOf, type StoreLike } from "../bridge/moves/state.ts";
import { adoptRecord } from "../bridge/adopt.ts";
import { track } from "../bridge/activity.ts";
import type { AllocationView, OpenState } from "../bridge/canton/accounts.ts";
import type { Session } from "../bridge/session.ts";

const addr = (c: string) => ("0x" + c.repeat(40)) as Address;
export const ME = addr("1"), GATEWAY = addr("2"), VAULT = ("0x" + "cd".repeat(20)) as Address, TKA = addr("a"), WTROME = addr("b"), WCC = addr("c");
export const PARTY = "alice::1220" + "ab".repeat(32);
export const GATEWAY_PARTY = "gateway::1220" + "03".repeat(32);
export const CC_ADMIN = "DSO::1220" + "cd".repeat(32);
export const config: BridgeConfig = {
  chain: { chainId: 770101, chainName: "Ostia", coin: { symbol: "tROME", decimals: 18 } },
  gateway: GATEWAY, vault: VAULT, vaults: [VAULT], registryUrl: "registry.example/twin-registry", wrapper: WTROME,
  twins: [{ address: TKA, symbol: "TKA", decimals: 18 }, { address: WTROME, symbol: "WtROME", decimals: 18 }],
  wrapped: [{ address: WCC, symbol: "wCC", decimals: 10, instrument: { admin: CC_ADMIN, id: "Amulet" } }],
};

export const memoryStore = (): StoreLike & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
};
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

/** The name of the ERC-20 field of a leg and of a redeem request (the token standard word, written in two parts). */
export const FIELD = "tok" + "en";
/** A leg of a move, as the explorer lists it (the legs name the ERC-20 field after the token standard). */
export const leg = (o: Partial<BlockLeg>, erc20: Address): BlockLeg => ({ block: 42, legIndex: 0, txIndex: 0, logIndex: 0, kind: "payment", legId: "0x", [FIELD]: erc20, account: ME, amount: "0", txHash: null, updateId: null, canton: null, ...o }) as BlockLeg;
export const finalTx = (legs: BlockLeg[]) => ({ status: "final", success: true, block: { number: 42, hash: null, updateId: null }, legs }) as unknown as ApiTx;
const hashOf = (n: number) => ("0x" + String(n).padStart(64, "0")) as Hex;

export interface EvmOptions { balance?: bigint; native?: bigint; allowance?: bigint }
/** An Ostia account that records its sends and answers from a few numbers. */
export function fakeEvm(o: EvmOptions = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  let n = 0, nonce = 7, allowance = o.allowance ?? 0n;
  const send = (name: string) => async (...args: unknown[]) => {
    calls.push({ name, args });
    if (name === "approve") allowance = args[2] as bigint;
    nonce++;
    return hashOf(++n);
  };
  const evm: EvmAdapter = {
    account: ME,
    native: async () => o.native ?? 10n ** 20n,
    balanceOf: async (_t, holder) => (holder ? 10n ** 21n : o.balance ?? 20n * 10n ** 18n),
    nonce: async () => nonce, sentNonce: async () => null, walletNonces: async () => ({ pending: nonce, latest: nonce }), used: async () => false,
    allowance: async () => allowance,
    wrap: send("wrap"), approve: send("approve"), pay: send("pay"), release: send("release"), claim: send("claim"), withdraw: send("withdraw"),
    waitReceipt: async () => ({ success: true }),
  };
  return { evm, calls };
}

export function fakeCanton(): CantonAdapter & { calls: string[]; deadline: number | null } {
  const calls: string[] = [];
  const canton: CantonAdapter & { calls: string[]; deadline: number | null } = {
    calls, deadline: Date.now() + 90 * 60_000, party: () => PARTY,
    signRedeem: async () => void calls.push("signRedeem"), waitRedeem: async () => void calls.push("waitRedeem"), cancelRedeem: async () => void calls.push("cancelRedeem"), appeared: async (a) => "redeem" in a,
    allocateDeposit: async () => void calls.push("allocateDeposit"), signDeposit: async () => void calls.push("signDeposit"), waitDeposit: async () => void calls.push("waitDeposit"),
    depositDeadline: async () => canton.deadline, recoverDeposit: async () => void calls.push("recoverDeposit"),
  };
  return canton;
}

/** A session on the real move library: `legs` is what the explorer shows as final for the move's transaction. */
export function fakeSession(o: { evm?: ReturnType<typeof fakeEvm>; legs: (ref: string) => BlockLeg[]; store?: ReturnType<typeof memoryStore>; canton?: ReturnType<typeof fakeCanton>; cantonBalance?: bigint; open?: OpenState; allocations?: AllocationView[]; holdings?: string[]; tx?: (hash: Hex) => ApiTx } = { legs: () => [] }) {
  const evm = o.evm ?? fakeEvm();
  const canton = o.canton ?? fakeCanton();
  const store = o.store ?? memoryStore();
  const move = createMove({
    config, evm: evm.evm, canton, registry: { lockParts: async (a) => ({ lockId: lockIdOf(a.receiver, a.ref).slice(2), acceptance: "00" + "ac".repeat(33), vaults: [VAULT] }) }, store, locks: memoryLocks(), sleep: async () => {}, newRef: () => "ref-1", maxPolls: 5,
    api: { tx: async (h) => o.tx?.(h) ?? finalTx(o.legs("ref-1")) }, leg: async () => null, sentSince: async () => [],
  });
  const stop = track(move, store);
  const session: Session = {
    move, evm: evm.evm, party: PARTY, cantonBalance: vi.fn(async () => o.cantonBalance ?? 20n * 10n ** 10n), kept: () => move.kept(),
    open: vi.fn(async () => o.open ?? { depositRequests: [], redeemRequests: [], twinAcceptance: null, withdrawalAcceptance: null }), close: stop,
    holdingIds: vi.fn(async () => new Set<string>(o.holdings ?? [])), removeRedeem: vi.fn(async () => {}),
    adopt: vi.fn((kind, request) => adoptRecord(kind, request, { account: evm.evm.account, party: PARTY, config, store, allocations: async () => o.allocations ?? [], openRequests: () => session.open() })),
  };
  return { session, evm, canton, store, move };
}
