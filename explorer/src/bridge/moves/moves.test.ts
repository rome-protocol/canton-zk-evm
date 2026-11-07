import { describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";
import type { ApiTx, BlockLeg } from "../../api.ts";
import type { EvmAdapter } from "../evm/adapter.ts";
import type { BridgeConfig } from "../evm/config.ts";
import { LockRefused } from "../evm/registry.ts";
import { createMove, type CantonAdapter, type Deps } from "./moves.ts";
import { depositIdOf, loadCheckpoint, lockIdOf, releaseIdOf, transition, type MoveState, type StoreLike } from "./state.ts";

const addr = (c: string) => ("0x" + c.repeat(40)) as Address;
const [ME, GATEWAY, VAULT, TKA, WTROME, WCC] = [addr("1"), addr("2"), ("0x" + "cd".repeat(20)) as Address, addr("a"), addr("b"), addr("c")];
const PARTY = "alice::1220" + "ab".repeat(32);
const config: BridgeConfig = {
  chain: { chainId: 770101, chainName: "Ostia", coin: { symbol: "tROME", decimals: 18 } },
  gateway: GATEWAY, vault: VAULT, registryUrl: "https://registry.example/twin-registry", wrapper: WTROME,
  twins: [{ address: TKA, symbol: "TKA", decimals: 18 }, { address: WTROME, symbol: "WtROME", decimals: 18 }],
  wrapped: [{ address: WCC, symbol: "wCC", decimals: 10, instrument: { admin: "admin::1220" + "00".repeat(32), id: "Amulet" } }],
};

const memoryStore = (): StoreLike & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
};
/** A leg of `erc20` (the legs name that field after the token standard). */
const FIELD = "tok" + "en";
const leg = (o: Partial<BlockLeg>, erc20: Address = TKA): BlockLeg => ({ block: 42, legIndex: 0, txIndex: 0, logIndex: 0, kind: "payment", legId: "0x", [FIELD]: erc20, account: ME, amount: "0", txHash: null, updateId: null, canton: null, ...o }) as BlockLeg;
const final = (legs: BlockLeg[], success = true) => ({ status: "final", success, block: { number: 42, hash: null, updateId: null }, legs }) as unknown as ApiTx;
const proving = { status: "proving", legs: [] } as unknown as ApiTx;

/** An EVM adapter that records its sends and answers from a few numbers. */
function fakeEvm(o: { balance?: bigint; native?: bigint; allowance?: bigint; receipt?: (n: number) => boolean } = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  let n = 0, refuse: string | null = null;
  const send = (name: string) => async (...args: unknown[]) => {
    calls.push({ name, args });
    if (refuse === name) throw Object.assign(new Error("x"), { shortMessage: "execution reverted: nope" });
    return ("0x" + String(++n).padStart(64, "0")) as Hex;
  };
  const evm: EvmAdapter = {
    account: ME,
    native: async () => o.native ?? 0n, balanceOf: async () => o.balance ?? 10n ** 21n, allowance: async () => o.allowance ?? 0n,
    wrap: send("wrap"), approve: send("approve"), pay: send("pay"), release: send("release"), claim: send("claim"), withdraw: send("withdraw"),
    waitReceipt: async () => ({ success: o.receipt ? o.receipt(n) : true }),
  };
  return { evm, calls, refuse: (name: string) => { refuse = name; } };
}

function setup(o: { evm?: ReturnType<typeof fakeEvm>; txs?: (ApiTx | null)[]; store?: ReturnType<typeof memoryStore>; maxPolls?: number; lockParts?: Deps["registry"]["lockParts"] } = {}) {
  const evm = o.evm ?? fakeEvm();
  const store = o.store ?? memoryStore();
  const answers = [...(o.txs ?? [])];
  const canton: CantonAdapter & { calls: string[] } = {
    calls: [], party: () => PARTY,
    signRedeem: async () => void canton.calls.push("signRedeem"), waitRedeem: async () => void canton.calls.push("waitRedeem"),
    signDeposit: async () => void canton.calls.push("signDeposit"), waitDeposit: async () => void canton.calls.push("waitDeposit"),
  };
  const lockParts = vi.fn(o.lockParts ?? (async (a: { receiver: string; ref: string }) => ({ lockId: lockIdOf(a.receiver, a.ref), vaults: [VAULT], acceptance: "00ab" })));
  const deps: Deps = {
    config, evm: evm.evm, canton, registry: { lockParts }, store, sleep: async () => {}, newRef: () => "ref-1", maxPolls: o.maxPolls ?? 5,
    api: { tx: async () => (answers.length > 1 ? answers.shift()! : answers[0] ?? null) },
  };
  const move = createMove(deps);
  const phases: string[] = [];
  move.subscribe((s: MoveState) => phases.push(s.phase === "sending-evm" ? `sending-evm:${s.step}` : s.phase));
  return { move, evm, canton, store, phases, lockParts, deps };
}

describe("the state machine", () => {
  it("refuses a transition it does not have", () => {
    expect(() => transition({ phase: "idle" }, { phase: "final", tx: "0x00", block: 1 })).toThrow();
    expect(transition({ phase: "proving", tx: "0x00" }, { phase: "failed", reason: "x", from: "proving" }).phase).toBe("failed");
  });
  it("derives the ids as the chain does", () => {
    expect(lockIdOf(PARTY, "ref-1")).toBe("0xfbc7d6bc0f781cb13c08682c0ae19955851281dd83868167a6f60bebcd0cf59f");
    expect(depositIdOf("bob", "lbl")).toBe("0xfedb8985b789f42e2d41c72c6bddf35ce15a41e68a6c53660a8896472e480546");
    expect(releaseIdOf(VAULT, "r1")).toBe("0x1b9aec81254c39430fb458ed0c8a836557d16b65e03f6252db23a275796552b7");
  });
});

describe("move 1: lock a token with a twin, Ostia to Canton", () => {
  const input = { kind: "lock", asset: TKA, amount: "1.5", receiver: PARTY } as const;
  const lockLeg = () => leg({ kind: "payment", legId: lockIdOf(PARTY, "ref-1") });

  it("takes the lock parts, approves, pays the vault, and is final when the explorer shows the lock's leg", async () => {
    const t = setup({ txs: [proving, final([lockLeg()])] });
    const s = await t.move.start(input);
    expect(s).toEqual({ phase: "final", tx: expect.any(String), block: 42 });
    expect(t.phases).toEqual(["sending-evm:prepare", "sending-evm:approve", "sending-evm:pay", "proving", "final"]);
    expect(t.evm.calls.map((c) => c.name)).toEqual(["approve", "pay"]);
    expect(t.evm.calls[0]!.args).toEqual([TKA, GATEWAY, 15n * 10n ** 17n]);
    expect(t.evm.calls[1]!.args).toEqual([GATEWAY, lockIdOf(PARTY, "ref-1"), TKA, VAULT, 15n * 10n ** 17n]);
    expect(t.lockParts).toHaveBeenCalledWith({ receiver: PARTY, ref: "ref-1" });
    expect(t.store.map.size).toBe(0);
  });
  it("skips the approval when the allowance covers the amount", async () => {
    const t = setup({ evm: fakeEvm({ allowance: 10n ** 30n }), txs: [final([lockLeg()])] });
    await t.move.start(input);
    expect(t.evm.calls.map((c) => c.name)).toEqual(["pay"]);
  });
  it("wraps tROME into WtROME first, for what the wallet lacks", async () => {
    const t = setup({ evm: fakeEvm({ balance: 10n ** 18n, native: 10n ** 20n }), txs: [final([leg({ kind: "payment", legId: lockIdOf(PARTY, "ref-1") }, WTROME)])] });
    await t.move.start({ ...input, asset: WTROME, wrapNative: true });
    expect(t.evm.calls[0]).toEqual({ name: "wrap", args: [WTROME, 5n * 10n ** 17n] });
    expect(t.phases).toContain("sending-evm:wrap");
  });
  it("sends nothing when the registry refuses the lock with 409", async () => {
    const t = setup({ lockParts: async () => { throw new LockRefused("The receiver has not accepted twins yet.", 409); } });
    const s = await t.move.start(input);
    expect(s).toMatchObject({ phase: "failed", reason: expect.stringContaining("accepted twins"), from: "sending-evm" });
    expect(t.evm.calls).toEqual([]);
  });
  it("sends nothing when the registry's lock id is not the one the payer works out", async () => {
    const t = setup({ lockParts: async () => ({ lockId: "0x" + "00".repeat(32) }) });
    expect(await t.move.start(input)).toMatchObject({ phase: "failed", reason: expect.stringContaining("not the one") });
    expect(t.evm.calls).toEqual([]);
  });
  it("fails when the approval reverts, when the pay is refused by the estimate, and when the pay's transaction fails on Ostia", async () => {
    let t = setup({ evm: fakeEvm({ receipt: () => false }) });
    expect(await t.move.start(input)).toMatchObject({ phase: "failed", reason: "The approval failed on Ostia." });
    expect(t.evm.calls.map((c) => c.name)).toEqual(["approve"]);

    const evm = fakeEvm({ allowance: 10n ** 30n });
    evm.refuse("pay");
    t = setup({ evm });
    expect(await t.move.start(input)).toMatchObject({ phase: "failed", reason: "execution reverted: nope" });

    t = setup({ evm: fakeEvm({ allowance: 10n ** 30n }), txs: [final([], false)] });
    expect(await t.move.start(input)).toMatchObject({ phase: "failed", reason: "The transaction failed on Ostia.", from: "proving" });
  });
  it("refuses an amount finer than 10 decimals before anything is asked of the registry or the wallet", async () => {
    const t = setup();
    expect(await t.move.start({ ...input, amount: "0.00000000001" })).toMatchObject({ phase: "failed", reason: expect.stringContaining("at most 10 decimals") });
    expect(t.lockParts).not.toHaveBeenCalled();
    expect(t.evm.calls).toEqual([]);
  });
  it("is picked up after a reload from the transaction kept in session storage", async () => {
    const store = memoryStore();
    const first = setup({ store, txs: [proving], maxPolls: 2, evm: fakeEvm({ allowance: 10n ** 30n }) });
    expect(await first.move.start(input)).toMatchObject({ phase: "failed", reason: expect.stringContaining("took too long") });
    const kept = loadCheckpoint(store)!;
    expect(kept).toMatchObject({ stage: "sent", ref: "ref-1", input });

    const after = setup({ store, txs: [final([lockLeg()])] });
    expect(await after.move.resume()).toMatchObject({ phase: "final", tx: kept.tx });
    expect(after.phases).toEqual(["proving", "final"]);
    expect(after.evm.calls).toEqual([]);
    expect(store.map.size).toBe(0);
  });
  it("does nothing on resume when nothing was kept, and survives storage that throws", async () => {
    expect((await setup().move.resume()).phase).toBe("idle");
    const bad: StoreLike = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    const t = setup({ txs: [final([lockLeg()])] });
    t.deps.store = bad;
    expect((await createMove(t.deps).start(input)).phase).toBe("final");
  });
});

describe("move 2: a twin back, Canton to Ostia", () => {
  const input = { kind: "redeem", asset: TKA, amount: "2" } as const;
  const releaseLeg = () => leg({ kind: "payment", legId: releaseIdOf(VAULT, "ref-1") });

  it("signs the redeem on Canton, waits for it, releases from the vault, and is final on the release leg", async () => {
    const t = setup({ txs: [final([releaseLeg()])] });
    expect(await t.move.start(input)).toMatchObject({ phase: "final", block: 42 });
    expect(t.phases).toEqual(["signing-canton", "waiting-canton", "sending-evm:release", "proving", "final"]);
    expect(t.canton.calls).toEqual(["signRedeem", "waitRedeem"]);
    expect(t.evm.calls).toEqual([{ name: "release", args: [VAULT, "ref-1", TKA, ME, 2n * 10n ** 18n] }]);
  });
  it("fails when the release transaction fails on Ostia", async () => {
    const t = setup({ txs: [final([], false)] });
    expect(await t.move.start(input)).toMatchObject({ phase: "failed", reason: "The transaction failed on Ostia." });
  });
  it("refuses an amount finer than 10 decimals without signing on Canton", async () => {
    const t = setup();
    expect(await t.move.start({ ...input, amount: "1.00000000001" })).toMatchObject({ phase: "failed" });
    expect(t.canton.calls).toEqual([]);
  });
  it("after a reload mid-wait, waits again and releases, without signing a second time", async () => {
    const store = memoryStore();
    store.setItem("bridge-move", JSON.stringify({ input, ref: "ref-1", stage: "canton" }));
    const t = setup({ store, txs: [final([releaseLeg()])] });
    expect(await t.move.resume()).toMatchObject({ phase: "final" });
    expect(t.canton.calls).toEqual(["waitRedeem"]);
    expect(t.phases).toEqual(["waiting-canton", "sending-evm:release", "proving", "final"]);
  });
});

describe("move 3: a Canton token to Ostia", () => {
  const input = { kind: "deposit", asset: WCC, amount: "3.5" } as const;
  const id = depositIdOf(PARTY, "ref-1");

  it("signs the deposit with the derived id, then claims the wrapped token", async () => {
    const t = setup({ txs: [final([leg({ kind: "deposit", legId: id }, WCC)])] });
    expect(await t.move.start(input)).toMatchObject({ phase: "final" });
    expect(t.phases).toEqual(["signing-canton", "waiting-canton", "sending-evm:claim", "proving", "final"]);
    expect(t.canton.calls).toEqual(["signDeposit", "waitDeposit"]);
    expect(t.evm.calls).toEqual([{ name: "claim", args: [GATEWAY, id, WCC, 35n * 10n ** 9n] }]);
  });
  it("fails when the claim is refused, and when Canton's own step fails", async () => {
    const evm = fakeEvm();
    evm.refuse("claim");
    expect(await setup({ evm }).move.start(input)).toMatchObject({ phase: "failed", reason: "execution reverted: nope", from: "sending-evm" });

    const t = setup();
    t.deps.canton.signDeposit = async () => { throw { code: 4001 }; };
    expect(await createMove(t.deps).start(input)).toMatchObject({ phase: "failed", reason: "You declined it in your wallet.", from: "signing-canton" });
  });
  it("refuses an amount finer than 10 decimals", async () => {
    const t = setup();
    expect(await t.move.start({ ...input, amount: "0.00000000001" })).toMatchObject({ phase: "failed" });
    expect(t.canton.calls).toEqual([]);
  });
  it("after a reload with the claim sent, only waits for the explorer", async () => {
    const store = memoryStore();
    store.setItem("bridge-move", JSON.stringify({ input, ref: "ref-1", stage: "sent", tx: "0x" + "09".repeat(32) }));
    const t = setup({ store, txs: [proving, final([leg({ kind: "deposit", legId: id }, WCC)])] });
    expect(await t.move.resume()).toMatchObject({ phase: "final", tx: "0x" + "09".repeat(32) });
    expect(t.evm.calls).toEqual([]);
  });
});

describe("move 4: a wrapped token back to Canton", () => {
  const input = { kind: "withdraw", asset: WCC, amount: "1" } as const;

  it("withdraws to the user's party and is final on the withdrawal leg", async () => {
    const t = setup({ txs: [proving, final([leg({ kind: "withdrawal", account: ME, amount: (10n ** 10n).toString() }, WCC)])] });
    expect(await t.move.start(input)).toMatchObject({ phase: "final" });
    expect(t.phases).toEqual(["sending-evm:withdraw", "proving", "final"]);
    expect(t.evm.calls).toEqual([{ name: "withdraw", args: [GATEWAY, WCC, 10n ** 10n, PARTY] }]);
  });
  it("fails without a send when the wallet holds too little, and when the transaction is dropped", async () => {
    const poor = setup({ evm: fakeEvm({ balance: 1n }) });
    expect(await poor.move.start(input)).toMatchObject({ phase: "failed", reason: "You do not hold enough wCC." });
    expect(poor.evm.calls).toEqual([]);
    const dropped = setup({ txs: [{ status: "dropped", legs: [] } as unknown as ApiTx] });
    expect(await dropped.move.start(input)).toMatchObject({ phase: "failed", reason: expect.stringContaining("dropped") });
  });
  it("refuses an amount finer than 10 decimals, and a token it does not move", async () => {
    expect(await setup().move.start({ ...input, amount: "0.00000000001" })).toMatchObject({ phase: "failed" });
    expect(await setup().move.start({ ...input, asset: addr("9") })).toMatchObject({ phase: "failed", reason: "The bridge does not move this token." });
  });
  it("does not call a final transaction the move's own unless it made the leg", async () => {
    const t = setup({ txs: [final([leg({ kind: "withdrawal", account: addr("7"), amount: (10n ** 10n).toString() }, WCC)])] });
    expect(await t.move.start(input)).toMatchObject({ phase: "failed", reason: expect.stringContaining("no leg") });
  });
});
