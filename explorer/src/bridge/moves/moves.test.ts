import { afterEach, describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";
import type { ApiTx, BlockLeg } from "../../api.ts";
import { approveCall, withdrawCall, type EvmAdapter } from "../evm/adapter.ts";
import type { BridgeConfig } from "../evm/config.ts";
import { LockRefused } from "../evm/registry.ts";
import { createMove, explorerLeg, explorerSentSince, explorerTx, Waited, type CantonAdapter, type Deps, type LocksLike } from "./moves.ts";
import { depositIdOf, keptMoves, listMoves, loadCheckpoint, lockIdOf, releaseIdOf, saveCheckpoint, transition, type Checkpoint, type MoveState, type StoreLike } from "./state.ts";

const addr = (c: string) => ("0x" + c.repeat(40)) as Address;
const [ME, GATEWAY, VAULT, TKA, WTROME, WCC] = [addr("1"), addr("2"), ("0x" + "cd".repeat(20)) as Address, addr("a"), addr("b"), addr("c")];
const VAULT2 = addr("d");
const PARTY = "alice::1220" + "ab".repeat(32);
const config: BridgeConfig = {
  chain: { chainId: 770101, chainName: "Ostia", coin: { symbol: "tROME", decimals: 18 } },
  gateway: GATEWAY, vault: VAULT, vaults: [VAULT], registryUrl: "https://registry.example/twin-registry", wrapper: WTROME,
  twins: [{ address: TKA, symbol: "TKA", decimals: 18 }, { address: WTROME, symbol: "WtROME", decimals: 18 }],
  wrapped: [{ address: WCC, symbol: "wCC", decimals: 10, instrument: { admin: "admin::1220" + "00".repeat(32), id: "Amulet" } }],
};

const memoryStore = (): StoreLike & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
};
/** A record kept in session storage, as a reload finds it. */
const keep = (store: StoreLike, c: Pick<Checkpoint, "input" | "stage"> & Partial<Checkpoint>) =>
  saveCheckpoint(store, { ref: "ref-1", account: ME, party: PARTY, vault: VAULT, ...(c.input.kind === "redeem" ? { to: ME } : {}), ...c });
/** A leg of `erc20` (the legs name that field after the token standard). */
const FIELD = "tok" + "en";
const leg = (o: Partial<BlockLeg>, erc20: Address = TKA): BlockLeg => ({ block: 42, legIndex: 0, txIndex: 0, logIndex: 0, kind: "payment", legId: "0x", [FIELD]: erc20, account: ME, amount: "0", txHash: null, updateId: null, canton: null, ...o }) as BlockLeg;
const final = (legs: BlockLeg[], success = true) => ({ status: "final", success, block: { number: 42, hash: null, updateId: null }, legs }) as unknown as ApiTx;
const proving = { status: "proving", legs: [] } as unknown as ApiTx;
const replaced = { status: "replaced", legs: [] } as unknown as ApiTx;
/** A final transaction of ME that makes exactly `call`, with the legs it made. */
const made = (call: { to: Address; data: Hex; value?: string }, legs: BlockLeg[] = []) => ({ ...final(legs), from: ME, to: call.to, input: call.data, value: call.value ?? "0", nonce: 7 }) as unknown as ApiTx;
const hashOf = (n: number) => ("0x" + String(n).padStart(64, "0")) as Hex;
const OTHER = ("0x" + "ee".repeat(32)) as Hex;

/** Web Locks as the browser keeps them: one holder per name, never waited for. Tabs share one object. */
const memoryLocks = (): LocksLike => {
  const held = new Set<string>();
  return {
    async request<T>(name: string, _o: { ifAvailable: true }, cb: (lock: unknown | null) => Promise<T>): Promise<T> {
      if (held.has(name)) return cb(null);
      held.add(name);
      try { return await cb({}); } finally { held.delete(name); }
    },
  };
};

interface EvmOptions {
  balance?: bigint; native?: bigint; allowance?: bigint; receipt?: (n: number) => boolean; nonce?: number;
  holdSend?: Promise<void>; wallet?: { pending: number; latest: number } | null; used?: (id: Hex) => boolean; vaultBalance?: Record<string, bigint>; beforeSend?: (name: string) => void; approveSticks?: boolean;
}
/** An EVM adapter that records its sends and answers from a few numbers. The nonce moves on with each send that goes through. */
function fakeEvm(o: EvmOptions = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  let n = 0, nonce = o.nonce ?? 7, allowance = o.allowance ?? 0n, refuse: string | null = null;
  const nonces = new Map<Hex, number>();
  /** What the wallet itself says of its pending sends: nothing pending unless a test says so. */
  let wallet: { pending: number; latest: number } | null | undefined = o.wallet;
  const send = (name: string) => async (...args: unknown[]) => {
    calls.push({ name, args });
    o.beforeSend?.(name);
    await o.holdSend;
    if (refuse === name) throw Object.assign(new Error("x"), { shortMessage: "execution reverted: nope" });
    if (name === "approve" && o.approveSticks !== false) allowance = args[2] as bigint;
    nonces.set(hashOf(n + 1), nonce);
    nonce++;
    return hashOf(++n);
  };
  const evm: EvmAdapter = {
    account: ME,
    native: async () => o.native ?? 0n,
    balanceOf: async (_t, holder) => (holder ? o.vaultBalance?.[holder.toLowerCase()] ?? 10n ** 21n : o.balance ?? 10n ** 21n),
    nonce: async () => nonce, sentNonce: async (h) => nonces.get(h) ?? null, walletNonces: async () => (wallet === undefined ? { pending: nonce, latest: nonce } : wallet), used: async (_g, id) => o.used?.(id) ?? false, allowance: async () => allowance,
    wrap: send("wrap"), approve: send("approve"), pay: send("pay"), release: send("release"), claim: send("claim"), withdraw: send("withdraw"),
    waitReceipt: async () => ({ success: o.receipt ? o.receipt(n) : true }),
  };
  return { evm, calls, refuse: (name: string | null) => { refuse = name; }, setWallet: (w: { pending: number; latest: number } | null) => { wallet = w; } };
}

interface SetupOptions {
  evm?: ReturnType<typeof fakeEvm>; txs?: (ApiTx | null)[]; store?: ReturnType<typeof memoryStore>; maxPolls?: number; lockParts?: Deps["registry"]["lockParts"];
  tx?: Deps["api"]["tx"]; legOf?: Deps["leg"]; sentSince?: Deps["sentSince"]; locks?: LocksLike | null; config?: BridgeConfig; newRef?: () => string;
}
function setup(o: SetupOptions = {}) {
  const evm = o.evm ?? fakeEvm();
  const store = o.store ?? memoryStore();
  const answers = [...(o.txs ?? [])];
  const canton: CantonAdapter & { calls: string[]; args: unknown[] } = {
    calls: [], args: [], party: () => PARTY,
    signRedeem: async (a) => void (canton.calls.push("signRedeem"), canton.args.push(a)), waitRedeem: async () => void canton.calls.push("waitRedeem"),
    allocateDeposit: async (a) => void (canton.calls.push("allocateDeposit"), canton.args.push(a)),
    signDeposit: async (a) => void (canton.calls.push("signDeposit"), canton.args.push(a)), waitDeposit: async () => void canton.calls.push("waitDeposit"),
  };
  const lockParts = vi.fn(o.lockParts ?? (async (a: { receiver: string; ref: string }) => ({ lockId: lockIdOf(a.receiver, a.ref), vaults: [VAULT], acceptance: "00ab" })));
  const deps: Deps = {
    config: o.config ?? config, evm: evm.evm, canton, registry: { lockParts }, store, locks: "locks" in o ? o.locks! : memoryLocks(), sleep: async () => {}, newRef: o.newRef ?? (() => "ref-1"), maxPolls: o.maxPolls ?? 5,
    api: { tx: o.tx ?? (async () => (answers.length > 1 ? answers.shift()! : answers[0] ?? null)) },
    leg: o.legOf ?? (async () => null), sentSince: o.sentSince ?? (async () => []),
  };
  const move = createMove(deps);
  const phases: string[] = [];
  move.subscribe((s: MoveState) => phases.push(s.phase === "sending-evm" ? `sending-evm:${s.step}` : s.phase));
  return { move, evm, canton, store, phases, lockParts, deps };
}

describe("the state machine", () => {
  it("refuses a transition it does not have", () => {
    expect(() => transition({ phase: "idle" }, { phase: "final", tx: "0x00", block: 1 })).toThrow();
    expect(transition({ phase: "proving", tx: "0x00" }, { phase: "failed", reason: "x", from: "proving", kept: true }).phase).toBe("failed");
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
    expect(listMoves(t.store)).toEqual([]);
  });
  it("skips the approval when the allowance covers the amount", async () => {
    const t = setup({ evm: fakeEvm({ allowance: 10n ** 30n }), txs: [final([lockLeg()])] });
    await t.move.start(input);
    expect(t.evm.calls.map((c) => c.name)).toEqual(["pay"]);
  });
  it("wraps tROME into WtROME first, for what the wallet lacks", async () => {
    const t = setup({ evm: fakeEvm({ balance: 10n ** 18n, native: 10n ** 20n, allowance: 10n ** 30n }), txs: [final([leg({ kind: "payment", legId: lockIdOf(PARTY, "ref-1") }, WTROME)])] });
    await t.move.start({ ...input, asset: WTROME, wrapNative: true });
    expect(t.evm.calls[0]).toEqual({ name: "wrap", args: [WTROME, 5n * 10n ** 17n] });
    expect(t.phases).toContain("sending-evm:wrap");
  });
  it("sends nothing and keeps nothing when the registry refuses the lock with 409", async () => {
    const t = setup({ lockParts: async () => { throw new LockRefused("The receiver has not accepted twins yet.", 409); } });
    const s = await t.move.start(input);
    expect(s).toMatchObject({ phase: "failed", reason: expect.stringContaining("accepted twins"), from: "sending-evm", kept: false });
    expect(t.evm.calls).toEqual([]);
    expect(listMoves(t.store)).toEqual([]);
  });
  it("sends nothing when the registry's lock id is not the one the payer works out", async () => {
    const t = setup({ lockParts: async () => ({ lockId: "0x" + "00".repeat(32) }) });
    expect(await t.move.start(input)).toMatchObject({ phase: "failed", reason: expect.stringContaining("not the one") });
    expect(t.evm.calls).toEqual([]);
  });
  it("fails when the approval reverts, when the pay is refused by the estimate, and when the pay's transaction fails on Ostia", async () => {
    let t = setup({ evm: fakeEvm({ receipt: () => false }) });
    expect(await t.move.start(input)).toMatchObject({ phase: "paused", note: expect.stringContaining("The approval failed on Ostia") });
    expect(t.evm.calls.map((c) => c.name)).toEqual(["approve"]);

    const evm = fakeEvm({ allowance: 10n ** 30n });
    evm.refuse("pay");
    t = setup({ evm });
    expect(await t.move.start(input)).toMatchObject({ phase: "failed", reason: "execution reverted: nope" });

    t = setup({ evm: fakeEvm({ allowance: 10n ** 30n }), txs: [final([], false)] });
    expect(await t.move.start(input)).toMatchObject({ phase: "paused", note: "The transaction failed on Ostia; nothing moved. Continue to try again." });
    expect(loadCheckpoint(t.store)).toMatchObject({ stage: "start" });
    expect(loadCheckpoint(t.store)!.tx).toBeUndefined();
  });
  it("L9: a failed approval returns the move to the start and pauses, and the person's continue tries it again", async () => {
    const t = setup({ evm: fakeEvm({ receipt: (n) => n !== 1 }), txs: [final([lockLeg()])] });
    expect(await t.move.start(input)).toMatchObject({ phase: "paused" });
    expect(loadCheckpoint(t.store)).toMatchObject({ stage: "start" });
    expect(loadCheckpoint(t.store)!.step).toBeUndefined();
    expect(await t.move.proceed()).toMatchObject({ phase: "final" });
    expect(t.evm.calls.map((c) => c.name)).toEqual(["approve", "pay"]);
  });
  it("L9: a failed wrap pauses the same way", async () => {
    const t = setup({ evm: fakeEvm({ balance: 0n, native: 10n ** 20n, allowance: 10n ** 30n, receipt: () => false }) });
    expect(await t.move.start({ ...input, asset: WTROME, wrapNative: true })).toMatchObject({ phase: "paused", note: expect.stringContaining("The wrap failed on Ostia") });
    expect(loadCheckpoint(t.store)).toMatchObject({ stage: "start" });
  });
  it("M8: refuses to wrap when no wrapper is pinned for this deployment, or when the asset is not the pinned one, and sends nothing", async () => {
    const none = setup({ config: { ...config, wrapper: null } });
    expect(await none.move.start({ ...input, asset: WTROME, wrapNative: true })).toMatchObject({ phase: "failed", reason: expect.stringContaining("not set up"), kept: false });
    expect(none.evm.calls).toEqual([]);
    const other = setup();
    expect(await other.move.start({ ...input, wrapNative: true })).toMatchObject({ phase: "failed", reason: expect.stringContaining("not set up") });
    expect(other.evm.calls).toEqual([]);
    expect(listMoves(other.store)).toEqual([]);
  });
  it("refuses an amount finer than 10 decimals before anything is asked of the registry or the wallet", async () => {
    const t = setup();
    expect(await t.move.start({ ...input, amount: "0.00000000001" })).toMatchObject({ phase: "failed", reason: expect.stringContaining("at most 10 decimals") });
    expect(t.lockParts).not.toHaveBeenCalled();
    expect(t.evm.calls).toEqual([]);
    expect(listMoves(t.store)).toEqual([]);
  });
  it("is picked up after a reload from the transaction kept in session storage", async () => {
    const store = memoryStore();
    const first = setup({ store, txs: [proving], maxPolls: 2, evm: fakeEvm({ allowance: 10n ** 30n }) });
    expect(await first.move.start(input)).toMatchObject({ phase: "failed", reason: expect.stringContaining("took too long"), kept: true });
    const kept = loadCheckpoint(store)!;
    expect(kept).toMatchObject({ stage: "sent", ref: "ref-1", input, account: ME, party: PARTY });

    const after = setup({ store, txs: [final([lockLeg()])] });
    expect(await after.move.resume()).toMatchObject({ phase: "final", tx: kept.tx });
    expect(after.phases).toEqual(["proving", "final"]);
    expect(after.evm.calls).toEqual([]);
    expect(listMoves(store)).toEqual([]);
  });
  it("does nothing on resume when nothing was kept, and survives storage that throws", async () => {
    expect((await setup().move.resume()).phase).toBe("idle");
    const bad: StoreLike = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    const t = setup({ txs: [final([lockLeg()])] });
    t.deps.store = bad;
    expect((await createMove(t.deps).start(input)).phase).toBe("final");
  });
  it("L7: a wrapped token that is not 10 decimals is refused", async () => {
    const odd = { ...config, wrapped: [{ ...config.wrapped[0]!, decimals: 18 }] };
    const t = setup({ config: odd });
    expect(await t.move.start({ kind: "withdraw", asset: WCC, amount: "1" })).toMatchObject({ phase: "failed", reason: expect.stringContaining("10 decimals") });
    expect(t.evm.calls).toEqual([]);
  });
  it("refuses a move id that is empty or longer than 128 characters", async () => {
    for (const ref of ["", "x".repeat(129)]) {
      const t = setup({ newRef: () => ref });
      expect(await t.move.start(input)).toMatchObject({ phase: "failed", reason: expect.stringContaining("id") });
      expect(t.evm.calls).toEqual([]);
    }
  });
});

describe("move 2: a twin back, Canton to Ostia", () => {
  const input = { kind: "redeem", asset: TKA, amount: "2" } as const;
  const releaseLeg = () => leg({ kind: "payment", legId: releaseIdOf(VAULT, "ref-1") });

  it("signs the redeem on Canton with an exact 10-decimal amount, waits for it, releases from the vault, and is final on the release leg", async () => {
    const t = setup({ txs: [final([releaseLeg()])] });
    expect(await t.move.start(input)).toMatchObject({ phase: "final", block: 42 });
    expect(t.phases).toEqual(["signing-canton", "waiting-canton", "sending-evm:release", "proving", "final"]);
    expect(t.canton.calls).toEqual(["signRedeem", "waitRedeem"]);
    expect(t.canton.args[0]).toEqual({ asset: TKA, amount: "2.0000000000", recipient: ME, ref: "ref-1" });
    expect(t.evm.calls).toEqual([{ name: "release", args: [VAULT, "ref-1", TKA, ME, 2n * 10n ** 18n] }]);
  });
  it("fails when the release transaction fails on Ostia", async () => {
    const t = setup({ txs: [final([], false)] });
    expect(await t.move.start(input)).toMatchObject({ phase: "paused", note: expect.stringContaining("nothing moved") });
    expect(loadCheckpoint(t.store)).toMatchObject({ stage: "evm", vault: VAULT });
  });
  it("refuses an amount finer than 10 decimals without signing on Canton", async () => {
    const t = setup();
    expect(await t.move.start({ ...input, amount: "1.00000000001" })).toMatchObject({ phase: "failed" });
    expect(t.canton.calls).toEqual([]);
  });
  it("after a reload mid-wait, waits again, stops before the send, and releases only when the person continues; it never signs a second time", async () => {
    const store = memoryStore();
    keep(store, { input, stage: "canton" });
    const t = setup({ store, txs: [final([releaseLeg()])] });
    expect(await t.move.resume()).toMatchObject({ phase: "paused" });
    expect(t.canton.calls).toEqual(["waitRedeem"]);
    expect(t.evm.calls).toEqual([]);
    expect(await t.move.proceed()).toMatchObject({ phase: "final" });
    expect(t.canton.calls).toEqual(["waitRedeem"]);
    expect(t.evm.calls.map((c) => c.name)).toEqual(["release"]);
  });
  it("L6: signs for a vault that holds the amount, not the first one", async () => {
    const two = { ...config, vaults: [VAULT, VAULT2] };
    const evm = fakeEvm({ vaultBalance: { [VAULT]: 1n, [VAULT2]: 10n ** 21n } });
    const t = setup({ config: two, evm, txs: [final([leg({ kind: "payment", legId: releaseIdOf(VAULT2, "ref-1") })])] });
    expect(await t.move.start(input)).toMatchObject({ phase: "final" });
    expect(t.evm.calls).toEqual([{ name: "release", args: [VAULT2, "ref-1", TKA, ME, 2n * 10n ** 18n] }]);
    expect(loadCheckpoint(t.store)).toBeNull();
  });
  it("L6: signs nothing on Canton when no vault holds the amount", async () => {
    const t = setup({ evm: fakeEvm({ vaultBalance: { [VAULT]: 1n } }) });
    expect(await t.move.start(input)).toMatchObject({ phase: "failed", reason: expect.stringContaining("vault does not hold"), kept: false });
    expect(t.canton.calls).toEqual([]);
  });
});

describe("move 3: a Canton token to Ostia", () => {
  const input = { kind: "deposit", asset: WCC, amount: "3.5" } as const;
  const id = depositIdOf(PARTY, "ref-1");
  const depositLeg = () => leg({ kind: "deposit", legId: id }, WCC);

  it("allocates, sends the deposit request with the derived id, then claims the wrapped token", async () => {
    const t = setup({ txs: [final([depositLeg()])] });
    expect(await t.move.start(input)).toMatchObject({ phase: "final" });
    expect(t.phases).toEqual(["signing-canton", "waiting-canton", "sending-evm:claim", "proving", "final"]);
    expect(t.canton.calls).toEqual(["allocateDeposit", "signDeposit", "waitDeposit"]);
    expect(t.canton.args).toEqual([
      { instrument: config.wrapped[0]!.instrument, amount: "3.5000000000", label: "ref-1" },
      { instrument: config.wrapped[0]!.instrument, amount: "3.5000000000", label: "ref-1", depositId: id, recipient: ME },
    ]);
    expect(t.evm.calls).toEqual([{ name: "claim", args: [GATEWAY, id, WCC, 35n * 10n ** 9n] }]);
  });
  it("fails when the claim is refused, and when Canton's own step fails", async () => {
    const evm = fakeEvm();
    evm.refuse("claim");
    expect(await setup({ evm }).move.start(input)).toMatchObject({ phase: "failed", reason: "execution reverted: nope", from: "sending-evm" });

    const t = setup();
    t.deps.canton.signDeposit = async () => { throw { code: 4001 }; };
    expect(await createMove(t.deps).start(input)).toMatchObject({ phase: "failed", reason: "You declined it in your wallet.", from: "signing-canton", kept: true });
  });
  it("keeps a checkpoint between the two Canton steps: a failed request resumes at the request, not the allocation", async () => {
    const t = setup({ txs: [final([depositLeg()])] });
    let declined = true;
    const sign = t.deps.canton.signDeposit;
    t.deps.canton.signDeposit = async (a) => { if (declined) throw { code: 4001 }; return sign(a); };
    const move = createMove(t.deps);
    await move.start(input);
    expect(loadCheckpoint(t.store)).toMatchObject({ stage: "allocated" });
    declined = false;
    expect(await move.proceed()).toMatchObject({ phase: "final" });
    expect(t.canton.calls).toEqual(["allocateDeposit", "signDeposit", "waitDeposit"]);
  });
  it("refuses an amount finer than 10 decimals", async () => {
    const t = setup();
    expect(await t.move.start({ ...input, amount: "0.00000000001" })).toMatchObject({ phase: "failed" });
    expect(t.canton.calls).toEqual([]);
  });
  it("after a reload with the claim sent, only waits for the explorer", async () => {
    const store = memoryStore();
    keep(store, { input, stage: "sent", tx: ("0x" + "09".repeat(32)) as Hex });
    const t = setup({ store, txs: [proving, final([depositLeg()])] });
    expect(await t.move.resume()).toMatchObject({ phase: "final", tx: "0x" + "09".repeat(32) });
    expect(t.evm.calls).toEqual([]);
  });
  it("H2: a claim declined after the deposit is on Canton keeps the record, and the person's continue finishes it without signing on Canton again", async () => {
    const evm = fakeEvm();
    evm.refuse("claim");
    const t = setup({ evm, txs: [final([depositLeg()])] });
    expect(await t.move.start(input)).toMatchObject({ phase: "failed", kept: true });
    expect(loadCheckpoint(t.store)).toMatchObject({ stage: "evm", ref: "ref-1", party: PARTY, account: ME });
    evm.refuse(null);
    expect(await t.move.proceed()).toMatchObject({ phase: "final" });
    expect(t.canton.calls).toEqual(["allocateDeposit", "signDeposit", "waitDeposit"]);
    expect(listMoves(t.store)).toEqual([]);
  });
  it("H2: the same for a redeem whose release fails, and abandon removes the record", async () => {
    const evm = fakeEvm();
    evm.refuse("release");
    const t = setup({ evm });
    expect(await t.move.start({ kind: "redeem", asset: TKA, amount: "2" })).toMatchObject({ phase: "failed", kept: true });
    expect(loadCheckpoint(t.store)).toMatchObject({ stage: "evm", vault: VAULT, to: ME });
    await t.move.abandon();
    expect(listMoves(t.store)).toEqual([]);
    expect(t.move.state.phase).toBe("idle");
  });
  it("L5: refuses to resume under another EVM account or another Canton party, and keeps the record", async () => {
    const store = memoryStore();
    keep(store, { input, stage: "evm" });
    const other = setup({ store });
    other.deps.evm = { ...other.evm.evm, account: addr("9") };
    expect(await createMove(other.deps).resume("ref-1")).toMatchObject({ phase: "failed", reason: expect.stringContaining("another wallet account"), kept: true });
    const party = setup({ store });
    party.deps.canton.party = () => "bob::1220" + "cd".repeat(32);
    expect(await createMove(party.deps).resume("ref-1")).toMatchObject({ phase: "failed", reason: expect.stringContaining("another wallet account") });
    expect(party.canton.calls).toEqual([]);
    expect(loadCheckpoint(store)).toMatchObject({ stage: "evm" });
  });
});

describe("move 4: a wrapped token back to Canton", () => {
  const input = { kind: "withdraw", asset: WCC, amount: "1" } as const;
  const withdrawLeg = () => leg({ kind: "withdrawal", account: ME, amount: (10n ** 10n).toString() }, WCC);

  it("withdraws to the user's party and is final on the withdrawal leg", async () => {
    const t = setup({ txs: [proving, final([withdrawLeg()])] });
    expect(await t.move.start(input)).toMatchObject({ phase: "final" });
    expect(t.phases).toEqual(["sending-evm:withdraw", "proving", "final"]);
    expect(t.evm.calls).toEqual([{ name: "withdraw", args: [GATEWAY, WCC, 10n ** 10n, PARTY] }]);
  });
  it("fails without a send when the wallet holds too little, and keeps the move when the transaction is dropped", async () => {
    const poor = setup({ evm: fakeEvm({ balance: 1n }) });
    expect(await poor.move.start(input)).toMatchObject({ phase: "failed", reason: "You do not hold enough wCC." });
    expect(poor.evm.calls).toEqual([]);
    const dropped = setup({ txs: [{ status: "dropped", legs: [] } as unknown as ApiTx] });
    expect(await dropped.move.start(input)).toMatchObject({ phase: "failed", reason: expect.stringContaining("dropped"), kept: true });
    expect(loadCheckpoint(dropped.store)).toMatchObject({ stage: "wallet", step: "withdraw", nonce: 7 });
  });
  it("refuses an amount finer than 10 decimals, and a token it does not move", async () => {
    expect(await setup().move.start({ ...input, amount: "0.00000000001" })).toMatchObject({ phase: "failed" });
    expect(await setup().move.start({ ...input, asset: addr("9") })).toMatchObject({ phase: "failed", reason: "The bridge does not move this token." });
  });
  it("does not call a final transaction the move's own unless it made the leg", async () => {
    const t = setup({ txs: [final([leg({ kind: "withdrawal", account: addr("7"), amount: (10n ** 10n).toString() }, WCC)])] });
    expect(await t.move.start(input)).toMatchObject({ phase: "paused", note: expect.stringContaining("no leg") });
    expect(loadCheckpoint(t.store)).toMatchObject({ stage: "start" });
    expect(loadCheckpoint(t.store)!.tx).toBeUndefined();
  });
});

describe("a move survives a reload, a double mount and a wallet speed-up", () => {
  const withdraw = { kind: "withdraw", asset: WCC, amount: "1" } as const;
  const lock = { kind: "lock", asset: TKA, amount: "1", receiver: PARTY } as const;
  const withdrawLeg = () => leg({ kind: "withdrawal", account: ME, amount: (10n ** 10n).toString() }, WCC);
  const call = withdrawCall(GATEWAY, WCC, 10n ** 10n, PARTY);
  const UNRELATED = ("0x" + "dd".repeat(32)) as Hex;

  it("M4: two resume() calls at once are one promise and send nothing; two proceed() calls send once", async () => {
    const store = memoryStore();
    keep(store, { input: withdraw, stage: "start" });
    const t = setup({ store, txs: [final([withdrawLeg()])] });
    const a = t.move.resume(), b = t.move.resume();
    expect(a).toBe(b);
    expect(await a).toMatchObject({ phase: "paused" });
    expect(t.evm.calls).toEqual([]);
    const [x, y] = await Promise.all([t.move.proceed(), t.move.proceed()]);
    expect(x).toBe(y);
    expect(t.evm.calls.map((c) => c.name)).toEqual(["withdraw"]);
  });
  it("M4: start() is refused while a move runs and while one is paused, and each move has its own record", async () => {
    const t = setup({ txs: [final([withdrawLeg()])] });
    const first = t.move.start(withdraw);
    await expect(t.move.start(withdraw)).rejects.toThrow("not finished");
    await first;
    const store = memoryStore();
    keep(store, { input: withdraw, stage: "start" });
    keep(store, { input: lock, stage: "start", ref: "ref-2" });
    expect(listMoves(store)).toEqual(["ref-1", "ref-2"]);
    const paused = setup({ store });
    await paused.move.resume("ref-1");
    await expect(paused.move.start(withdraw)).rejects.toThrow("not finished");
    expect(loadCheckpoint(store, "ref-2")).toMatchObject({ input: lock });
    expect(loadCheckpoint(store)).toMatchObject({ ref: "ref-2" });
  });
  it("M9: resume() picks the newest record of the current account and party, and kept() lists only those", async () => {
    const store = memoryStore();
    keep(store, { input: withdraw, stage: "start", ref: "mine-old" });
    keep(store, { input: withdraw, stage: "start", ref: "other-account", account: addr("9") });
    keep(store, { input: withdraw, stage: "start", ref: "mine-new" });
    keep(store, { input: withdraw, stage: "start", ref: "other-party", party: "bob::1220" + "cd".repeat(32) });
    const t = setup({ store });
    expect(t.move.kept().map((c) => c.ref)).toEqual(["mine-new", "mine-old"]);
    expect(await t.move.resume()).toMatchObject({ phase: "paused" });
    await t.move.abandon();
    expect(listMoves(store)).toEqual(["mine-old", "other-account", "other-party"]);
  });
  it("M9: start() is refused while a move of this account is kept, and works again once it is given up", async () => {
    const store = memoryStore();
    keep(store, { input: withdraw, stage: "evm" });
    const t = setup({ store, txs: [final([withdrawLeg()])] });
    await expect(t.move.start(withdraw)).rejects.toThrow("is kept");
    await t.move.abandon("ref-1");
    expect(await t.move.start(withdraw)).toMatchObject({ phase: "final" });
  });
  it("M9: abandon() while a move runs rejects instead of returning silently", async () => {
    const t = setup({ txs: [final([withdrawLeg()])] });
    const first = t.move.start(withdraw);
    await expect(t.move.abandon()).rejects.toThrow("running");
    expect(await first).toMatchObject({ phase: "final" });
  });
  it("M5: the step and the account's nonce are saved before the wallet is asked", async () => {
    const store = memoryStore();
    let seen: Checkpoint | null = null;
    const t = setup({ store, txs: [final([withdrawLeg()])], evm: fakeEvm({ nonce: 7, beforeSend: () => { seen = loadCheckpoint(store); } }) });
    await t.move.start(withdraw);
    expect(seen).toMatchObject({ stage: "wallet", step: "withdraw", nonce: 7, call });
  });
  it("M5: a reload between the prompt and the hash, with the nonce unmoved, sends nothing until the person continues", async () => {
    const store = memoryStore();
    keep(store, { input: withdraw, stage: "wallet", step: "withdraw", nonce: 7 });
    const t = setup({ store, txs: [final([withdrawLeg()])], evm: fakeEvm({ nonce: 7 }) });
    expect(await t.move.resume()).toMatchObject({ phase: "paused" });
    expect(t.evm.calls).toEqual([]);
    expect(await t.move.proceed()).toMatchObject({ phase: "final" });
    expect(t.evm.calls.map((c) => c.name)).toEqual(["withdraw"]);
  });
  it("M5: a reload after the wallet sent (the nonce moved) finds the account's transaction that makes exactly the saved call, and sends nothing", async () => {
    const store = memoryStore();
    keep(store, { input: withdraw, stage: "wallet", step: "withdraw", nonce: 7, call });
    const sentSince = vi.fn(async () => [OTHER]);
    const t = setup({ store, sentSince, tx: async () => made(call, [withdrawLeg()]), evm: fakeEvm({ nonce: 8 }) });
    expect(await t.move.resume()).toMatchObject({ phase: "final", tx: OTHER });
    expect(sentSince).toHaveBeenCalledWith(ME, 7);
    expect(t.evm.calls).toEqual([]);
  });
  it("H3: an unrelated transaction at the saved nonce is not taken for the withdrawal: nothing is adopted, and the person's continue sends it", async () => {
    const store = memoryStore();
    keep(store, { input: withdraw, stage: "wallet", step: "withdraw", nonce: 7, call });
    const unrelated = { ...final([]), from: ME, to: addr("9"), input: "0x1234", value: "0", nonce: 7 } as unknown as ApiTx;
    const t = setup({ store, sentSince: async () => [UNRELATED], tx: async (h) => (h === UNRELATED ? unrelated : made(call, [withdrawLeg()])), evm: fakeEvm({ nonce: 8 }) });
    expect(await t.move.resume()).toMatchObject({ phase: "paused" });
    expect(loadCheckpoint(store)).toMatchObject({ stage: "start" });
    expect(t.evm.calls).toEqual([]);
    expect(await t.move.proceed()).toMatchObject({ phase: "final" });
    expect(t.evm.calls.map((c) => c.name)).toEqual(["withdraw"]);
  });
  it("H3: a deposit whose claim was never sent is not stranded by an unrelated transaction at its nonce: the id decides, and the claim can still be sent", async () => {
    const store = memoryStore();
    const id = depositIdOf(PARTY, "ref-1");
    keep(store, { input: { kind: "deposit", asset: WCC, amount: "1" }, stage: "wallet", step: "claim", nonce: 7 });
    const sentSince = vi.fn(async () => [UNRELATED]);
    const t = setup({ store, sentSince, evm: fakeEvm({ nonce: 8 }), tx: async (h) => (h === UNRELATED ? (final([]) as ApiTx) : final([leg({ kind: "deposit", legId: id }, WCC)])) });
    expect(await t.move.resume()).toMatchObject({ phase: "paused" });
    expect(sentSince).not.toHaveBeenCalled();
    expect(loadCheckpoint(store)).toMatchObject({ stage: "evm" });
    expect(t.evm.calls).toEqual([]);
    expect(await t.move.proceed()).toMatchObject({ phase: "final" });
    expect(t.evm.calls.map((c) => c.name)).toEqual(["claim"]);
  });
  it("H3: when the wallet returns the hash, the transaction's own nonce is saved, whatever the guess was", async () => {
    const store = memoryStore();
    const t = setup({ store, tx: async () => proving, maxPolls: 1, evm: fakeEvm({ nonce: 7 }) });
    t.deps.evm = { ...t.evm.evm, sentNonce: async () => 12 };
    await createMove(t.deps).start(withdraw);
    expect(loadCheckpoint(store)).toMatchObject({ stage: "sent", nonce: 12 });
  });
  it("a send still pending in the wallet blocks a resend, and the move adopts it once it is final", async () => {
    const store = memoryStore();
    keep(store, { input: withdraw, stage: "wallet", step: "withdraw", nonce: 7, call });
    let sent: Hex[] = [];
    const evm = fakeEvm({ nonce: 7, wallet: { pending: 8, latest: 7 } });
    const t = setup({ store, evm, sentSince: async () => sent, tx: async () => made(call, [withdrawLeg()]) });
    // The explorer shows nothing yet (only final blocks), but the wallet says its pending count is above its final count and above the saved nonce.
    expect(await t.move.resume()).toMatchObject({ phase: "paused", note: expect.stringContaining("speed it up or cancel it in your wallet") });
    expect(loadCheckpoint(store)).toMatchObject({ stage: "wallet", step: "withdraw", nonce: 7 });
    expect(await t.move.proceed()).toMatchObject({ phase: "paused", note: expect.stringContaining("still waiting") });
    expect(t.evm.calls).toEqual([]);
    // It becomes final: the exact-call matching adopts it, and nothing is sent.
    sent = [OTHER];
    evm.setWallet({ pending: 8, latest: 8 });
    expect(await t.move.proceed()).toMatchObject({ phase: "final", tx: OTHER });
    expect(t.evm.calls).toEqual([]);
  });
  it("with nothing pending in the wallet, the resend goes ahead when the person continues, also when an unrelated send has finalized past the saved nonce", async () => {
    for (const wallet of [{ pending: 7, latest: 7 }, { pending: 8, latest: 8 }, null]) {
      const store = memoryStore();
      keep(store, { input: withdraw, stage: "wallet", step: "withdraw", nonce: 7, call });
      const t = setup({ store, evm: fakeEvm({ nonce: 7, wallet }), txs: [final([withdrawLeg()])] });
      expect(await t.move.resume()).toMatchObject({ phase: "paused", note: expect.stringContaining("Continue to ask your wallet") });
      expect(t.evm.calls).toEqual([]);
      expect(await t.move.proceed()).toMatchObject({ phase: "final" });
      expect(t.evm.calls.map((c) => c.name)).toEqual(["withdraw"]);
    }
  });
  it("a pending approval blocks a resend the same way", async () => {
    const store = memoryStore();
    keep(store, { input: lock, stage: "wallet", step: "approve", nonce: 7, call: approveCall(TKA, GATEWAY, 10n ** 18n) });
    const t = setup({ store, evm: fakeEvm({ nonce: 7, wallet: { pending: 8, latest: 7 } }) });
    expect(await t.move.resume()).toMatchObject({ phase: "paused", note: expect.stringContaining("still waiting") });
    expect(t.evm.calls).toEqual([]);
    expect(t.lockParts).not.toHaveBeenCalled();
  });
  it("M5: a resumed move at the start never prompts the wallet by itself", async () => {
    const store = memoryStore();
    keep(store, { input: withdraw, stage: "start" });
    const t = setup({ store });
    expect(await t.move.resume()).toMatchObject({ phase: "paused" });
    expect(t.evm.calls).toEqual([]);
  });
  it("M5: an id the gateway has already used is proved from its leg, not sent again", async () => {
    const store = memoryStore();
    keep(store, { input: lock, stage: "start" });
    const id = lockIdOf(PARTY, "ref-1");
    const t = setup({ store, evm: fakeEvm({ used: (i) => i === id }), legOf: async () => ({ txHash: OTHER }), tx: async () => final([leg({ kind: "payment", legId: id })]) });
    expect(await t.move.resume()).toMatchObject({ phase: "final", tx: OTHER });
    expect(t.evm.calls).toEqual([]);
    expect(t.lockParts).not.toHaveBeenCalled();
  });
  it("M6: a pay replaced in the wallet is followed by the move's id, and the move still ends final", async () => {
    const id = lockIdOf(PARTY, "ref-1");
    const t = setup({
      evm: fakeEvm({ allowance: 10n ** 30n }), legOf: async () => ({ txHash: OTHER }),
      tx: async (h) => (h === hashOf(1) ? replaced : final([leg({ kind: "payment", legId: id })])),
    });
    expect(await t.move.start(lock)).toMatchObject({ phase: "final", tx: OTHER });
    expect(listMoves(t.store)).toEqual([]);
  });
  it("M6: a withdrawal replaced in the wallet is followed by the transaction that makes the same call", async () => {
    const sentSince = vi.fn(async () => [OTHER]);
    const t = setup({ sentSince, tx: async (h) => (h === hashOf(1) ? replaced : made(call, [withdrawLeg()])) });
    expect(await t.move.start(withdraw)).toMatchObject({ phase: "final", tx: OTHER });
    expect(sentSince).toHaveBeenCalledWith(ME, 7);
  });
  it("M6: a replaced transaction that is not found keeps the progress and does not fail the move for good", async () => {
    const t = setup({ evm: fakeEvm({ allowance: 10n ** 30n }), tx: async () => replaced });
    expect(await t.move.start(lock)).toMatchObject({ phase: "failed", reason: expect.stringContaining("replaced or dropped"), kept: true });
    expect(loadCheckpoint(t.store)).toMatchObject({ stage: "wallet", step: "pay" });
  });
  it("M6: a replaced approval is not taken as done: the allowance is read again and the move stops with a clear message", async () => {
    const t = setup({ evm: fakeEvm({ approveSticks: false }) });
    expect(await t.move.start(lock)).toMatchObject({ phase: "paused", note: expect.stringContaining("did not give the gateway") });
    expect(loadCheckpoint(t.store)).toMatchObject({ stage: "start" });
    expect(t.evm.calls.map((c) => c.name)).toEqual(["approve"]);
  });
});

describe("two tabs, sends still pending, and a move that is already done", () => {
  const withdraw = { kind: "withdraw", asset: WCC, amount: "1" } as const;
  const lock = { kind: "lock", asset: TKA, amount: "1", receiver: PARTY } as const;
  const deposit = { kind: "deposit", asset: WCC, amount: "1" } as const;
  const withdrawLeg = () => leg({ kind: "withdrawal", account: ME, amount: (10n ** 10n).toString() }, WCC);
  const call = withdrawCall(GATEWAY, WCC, 10n ** 10n, PARTY);
  const unrelated = { ...final([]), from: ME, to: addr("9"), input: "0x1234", value: "0", nonce: 7 } as unknown as ApiTx;

  it("H5: two tabs on one record: the second continue reads the record again and, the first having sent, only waits for the explorer", async () => {
    const store = memoryStore(), locks = memoryLocks(), evm = fakeEvm();
    keep(store, { input: withdraw, stage: "start" });
    const a = setup({ store, locks, evm, tx: async () => proving, maxPolls: 1 }), b = setup({ store, locks, evm, txs: [final([withdrawLeg()])] });
    expect((await a.move.resume()).phase).toBe("paused");
    expect((await b.move.resume()).phase).toBe("paused");
    expect(await a.move.proceed()).toMatchObject({ phase: "failed", kept: true });
    expect(await b.move.proceed()).toMatchObject({ phase: "final" });
    expect(evm.calls.map((c) => c.name)).toEqual(["withdraw"]);
  });
  it("H5: while one tab is in the wallet step, the other is refused by the move's lock and sends nothing", async () => {
    const store = memoryStore(), locks = memoryLocks();
    let release!: () => void, entered!: () => void;
    const hold = new Promise<void>((r) => { release = r; }), inSend = new Promise<void>((r) => { entered = r; });
    const evm = fakeEvm({ holdSend: hold, beforeSend: () => entered() });
    keep(store, { input: withdraw, stage: "start" });
    const a = setup({ store, locks, evm, txs: [final([withdrawLeg()])] }), b = setup({ store, locks, evm, txs: [final([withdrawLeg()])] });
    await a.move.resume();
    await b.move.resume();
    const first = a.move.proceed();
    await inSend;
    expect(await b.move.proceed()).toMatchObject({ phase: "paused", note: expect.stringContaining("another tab") });
    await expect(b.move.abandon("ref-1")).rejects.toThrow("another tab");
    release();
    expect(await first).toMatchObject({ phase: "final" });
    expect(evm.calls.map((c) => c.name)).toEqual(["withdraw"]);
  });
  it("H5: the other tab finishing the move leaves nothing for this one to send", async () => {
    const store = memoryStore(), locks = memoryLocks(), evm = fakeEvm();
    keep(store, { input: withdraw, stage: "start" });
    const a = setup({ store, locks, evm, txs: [final([withdrawLeg()])] }), b = setup({ store, locks, evm });
    await a.move.resume();
    await b.move.resume();
    expect(await a.move.proceed()).toMatchObject({ phase: "final" });
    expect((await b.move.proceed()).phase).toBe("idle");
    expect(evm.calls.map((c) => c.name)).toEqual(["withdraw"]);
  });
  it("H5: without Web Locks nothing runs: start is refused and a kept move only pauses", async () => {
    const store = memoryStore();
    const none = setup({ store, locks: null });
    await expect(none.move.start(withdraw)).rejects.toThrow("Web Locks");
    keep(store, { input: withdraw, stage: "start" });
    expect(await none.move.resume()).toMatchObject({ phase: "paused", note: expect.stringContaining("Web Locks") });
    expect(none.evm.calls).toEqual([]);
  });
  it("M11: a claim still pending after a reload is not sent again, and once it has landed the move is proved from its leg", async () => {
    const store = memoryStore();
    const id = depositIdOf(PARTY, "ref-1");
    keep(store, { input: deposit, stage: "wallet", step: "claim", nonce: 7 });
    let landed = false;
    const evm = fakeEvm({ nonce: 7, wallet: { pending: 8, latest: 7 }, used: () => landed });
    const t = setup({ store, evm, legOf: async () => (landed ? { txHash: OTHER } : null), tx: async () => final([leg({ kind: "deposit", legId: id }, WCC)]) });
    expect(await t.move.resume()).toMatchObject({ phase: "paused", note: expect.stringContaining("still waiting") });
    expect(await t.move.proceed()).toMatchObject({ phase: "paused", note: expect.stringContaining("still waiting") });
    expect(t.evm.calls).toEqual([]);
    landed = true;
    evm.setWallet({ pending: 8, latest: 8 });
    expect(await t.move.proceed()).toMatchObject({ phase: "final", tx: OTHER });
    expect(t.evm.calls).toEqual([]);
  });
  it("M11: a pay or release pending in the wallet blocks a resend as well", async () => {
    for (const [input, step] of [[lock, "pay"], [{ kind: "redeem", asset: TKA, amount: "2" } as const, "release"]] as const) {
      const store = memoryStore();
      keep(store, { input, stage: "wallet", step, nonce: 7 });
      const t = setup({ store, evm: fakeEvm({ nonce: 7, wallet: { pending: 8, latest: 7 } }) });
      expect(await t.move.resume()).toMatchObject({ phase: "paused", note: expect.stringContaining("still waiting") });
      expect(t.evm.calls).toEqual([]);
    }
  });
  it("M11: a second claim that reverted over the first does not fail the move: the transaction that made the leg is proved instead", async () => {
    const id = lockIdOf(PARTY, "ref-1");
    let landed = false;
    const reverted = final([], false);
    const t = setup({
      evm: fakeEvm({ allowance: 10n ** 30n, used: () => landed }), legOf: async () => (landed ? { txHash: OTHER } : null),
      tx: async (h) => { if (h === hashOf(1)) { landed = true; return reverted; } return final([leg({ kind: "payment", legId: id })]); },
    });
    expect(await t.move.start(lock)).toMatchObject({ phase: "final", tx: OTHER });
    expect(listMoves(t.store)).toEqual([]);
  });
  it("M11: with the id used and the leg's transaction not yet in the explorer, the move keeps waiting and stays recoverable", async () => {
    const t = setup({ evm: fakeEvm({ allowance: 10n ** 30n, used: () => true }), tx: async () => final([], false), legOf: async () => null });
    // The id is already used before any send, so the move is proved from its leg instead of being sent.
    expect(await t.move.start(lock)).toMatchObject({ phase: "failed", kept: true, reason: expect.stringContaining("not shown its transaction") });
    expect(t.evm.calls).toEqual([]);
  });
  it("L18: a final successful withdrawal that is exactly the saved call is done: without its leg the move waits, it is never reset to a resend", async () => {
    let legs: BlockLeg[] = [];
    const t = setup({ tx: async () => made(call, legs) });
    expect(await t.move.start(withdraw)).toMatchObject({ phase: "failed", kept: true, reason: expect.stringContaining("does not show the leg yet") });
    expect(loadCheckpoint(t.store)).toMatchObject({ stage: "sent", tx: hashOf(1) });
    legs = [withdrawLeg()];
    expect(await t.move.proceed()).toMatchObject({ phase: "final", tx: hashOf(1) });
    expect(t.evm.calls.map((c) => c.name)).toEqual(["withdraw"]);
  });
  it("L16: the search for the call stops as soon as the explorer's list covers every nonce up to the final count and none is the call", async () => {
    const store = memoryStore();
    keep(store, { input: withdraw, stage: "wallet", step: "withdraw", nonce: 7, call });
    const complete = vi.fn(async () => [OTHER]);
    const one = setup({ store, sentSince: complete, tx: async () => unrelated, evm: fakeEvm({ nonce: 8 }), maxPolls: 50 });
    expect(await one.move.resume()).toMatchObject({ phase: "paused" });
    expect(complete).toHaveBeenCalledTimes(1);

    // Final count 9 but only one of the two sends listed yet: look again, and stop when the list is whole.
    const store2 = memoryStore();
    keep(store2, { input: withdraw, stage: "wallet", step: "withdraw", nonce: 7, call });
    const lists: Hex[][] = [[OTHER], [OTHER, hashOf(77)]];
    const growing = vi.fn(async () => lists.length > 1 ? lists.shift()! : lists[0]!);
    const two = setup({ store: store2, sentSince: growing, tx: async () => unrelated, evm: fakeEvm({ nonce: 9 }), maxPolls: 50 });
    expect(await two.move.resume()).toMatchObject({ phase: "paused" });
    expect(growing).toHaveBeenCalledTimes(2);
  });
  it("L19: abandon() with no ref and no move of its own refuses, and a record that belongs to another account is not given up", async () => {
    const store = memoryStore();
    keep(store, { input: withdraw, stage: "evm" });
    keep(store, { input: withdraw, stage: "evm", ref: "theirs", account: addr("9") });
    const t = setup({ store });
    await expect(t.move.abandon()).rejects.toThrow("Say which move");
    await expect(t.move.abandon("theirs")).rejects.toThrow("another account");
    expect(listMoves(store)).toEqual(["ref-1", "theirs"]);
  });
  it("L19: records more than 30 days old are not listed, and are removed", () => {
    const store = memoryStore(), now = Date.UTC(2026, 10, 7), day = 24 * 60 * 60 * 1000;
    keep(store, { input: withdraw, stage: "evm", ref: "old", at: now - 31 * day });
    keep(store, { input: withdraw, stage: "evm", ref: "recent", at: now - 29 * day });
    keep(store, { input: withdraw, stage: "evm", ref: "undated" });
    expect(keptMoves(store, undefined, now).map((c) => c.ref).sort()).toEqual(["recent", "undated"]);
    expect(listMoves(store).sort()).toEqual(["recent", "undated"]);
  });
});

describe("a failed release, a drained vault, a lock re-read, and waits that run out", () => {
  const redeem = { kind: "redeem", asset: TKA, amount: "2" } as const;
  const withdraw = { kind: "withdraw", asset: WCC, amount: "1" } as const;
  const deposit = { kind: "deposit", asset: WCC, amount: "1" } as const;
  const withdrawLeg = () => leg({ kind: "withdrawal", account: ME, amount: (10n ** 10n).toString() }, WCC);
  const call = withdrawCall(GATEWAY, WCC, 10n ** 10n, PARTY);
  const reverted = final([], false);

  it("M12: a release that reverted with its id unused goes back before the send and pauses; the person's continue sends it again and the move finishes", async () => {
    const store = memoryStore();
    keep(store, { input: redeem, stage: "sent", step: "release", nonce: 8, tx: OTHER });
    const t = setup({ store, tx: async (h) => (h === OTHER ? reverted : final([leg({ kind: "payment", legId: releaseIdOf(VAULT, "ref-1") })])) });
    expect(await t.move.resume()).toMatchObject({ phase: "paused", note: "The transaction failed on Ostia; nothing moved. Continue to try again." });
    expect(loadCheckpoint(store)).toMatchObject({ stage: "evm" });
    expect(loadCheckpoint(store)!.tx).toBeUndefined();
    expect(t.evm.calls).toEqual([]);
    expect(await t.move.proceed()).toMatchObject({ phase: "final" });
    expect(t.evm.calls.map((c) => c.name)).toEqual(["release"]);
    expect(t.canton.calls).toEqual([]);
  });
  it("M12: a withdrawal that failed on Ostia (nothing burnt) is sent again on continue", async () => {
    const t = setup({ tx: async (h) => (h === hashOf(1) ? reverted : made(call, [withdrawLeg()])) });
    expect(await t.move.start(withdraw)).toMatchObject({ phase: "paused", note: expect.stringContaining("nothing moved") });
    expect(await t.move.proceed()).toMatchObject({ phase: "final" });
    expect(t.evm.calls.map((c) => c.name)).toEqual(["withdraw", "withdraw"]);
  });
  it("M12: the vault drained since the redeem was signed: the release comes from another vault, and its id and the saved vault follow", async () => {
    const store = memoryStore();
    keep(store, { input: redeem, stage: "evm" });
    const two = { ...config, vaults: [VAULT, VAULT2] };
    const t = setup({ store, config: two, evm: fakeEvm({ vaultBalance: { [VAULT]: 1n, [VAULT2]: 10n ** 21n } }), tx: async () => final([leg({ kind: "payment", legId: releaseIdOf(VAULT2, "ref-1") })]) });
    expect(await t.move.resume()).toMatchObject({ phase: "paused" });
    expect(await t.move.proceed()).toMatchObject({ phase: "final" });
    expect(t.evm.calls).toEqual([{ name: "release", args: [VAULT2, "ref-1", TKA, ME, 2n * 10n ** 18n] }]);
  });
  it("M12: no vault holds the amount: nothing is sent, and the move stays kept to try again", async () => {
    const store = memoryStore();
    keep(store, { input: redeem, stage: "evm" });
    const t = setup({ store, evm: fakeEvm({ vaultBalance: { [VAULT]: 1n } }) });
    await t.move.resume();
    expect(await t.move.proceed()).toMatchObject({ phase: "failed", kept: true, reason: expect.stringContaining("vault does not hold") });
    expect(t.evm.calls).toEqual([]);
  });
  it("L20: the record is read again inside the lock: a tab that moved it on between the check and the lock leaves this tab nothing to send", async () => {
    const store = memoryStore(), locks = memoryLocks(), evm = fakeEvm();
    keep(store, { input: withdraw, stage: "start" });
    const t = setup({ store, locks, evm, txs: [final([withdrawLeg()])] });
    await t.move.resume();
    // Another tab sends and saves its progress just before this tab gets the lock.
    const racing: LocksLike = { request: async (name, o, cb) => { keep(store, { input: withdraw, stage: "sent", tx: OTHER, step: "withdraw", nonce: 7, call }); return locks.request(name, o, cb); } };
    t.deps.locks = racing;
    expect(await t.move.proceed()).toMatchObject({ phase: "final", tx: OTHER });
    expect(evm.calls).toEqual([]);
  });
  it("L20: the wallet's pending count is checked before every send, also at the start of a move", async () => {
    const store = memoryStore();
    keep(store, { input: deposit, stage: "evm" });
    const t = setup({ store, evm: fakeEvm({ nonce: 7, wallet: { pending: 8, latest: 7 } }) });
    expect(await t.move.resume()).toMatchObject({ phase: "paused" });
    expect(await t.move.proceed()).toMatchObject({ phase: "paused", note: expect.stringContaining("still waiting") });
    expect(t.evm.calls).toEqual([]);
    const fresh = setup({ evm: fakeEvm({ nonce: 7, wallet: { pending: 9, latest: 7 } }) });
    expect(await fresh.move.start(withdraw)).toMatchObject({ phase: "paused", note: expect.stringContaining("speed it up or cancel it in your wallet") });
    expect(fresh.evm.calls).toEqual([]);
  });
  it("L22: a wait on Canton that runs out keeps the move, and the person's continue waits again", async () => {
    const t = setup({ txs: [final([leg({ kind: "payment", legId: releaseIdOf(VAULT, "ref-1") })])] });
    let attempts = 0;
    t.deps.canton.waitRedeem = async () => { if (++attempts === 1) throw new Waited("Canton has not shown the command yet."); };
    const move = createMove(t.deps);
    expect(await move.start(redeem)).toMatchObject({ phase: "failed", kept: true, reason: "Canton has not shown the command yet." });
    expect(loadCheckpoint(t.store)).toMatchObject({ stage: "canton" });
    expect(await move.proceed()).toMatchObject({ phase: "final" });
    expect(t.canton.calls).toEqual(["signRedeem"]);
  });
  it("L23: without Web Locks, abandon() says the browser cannot run the bridge", async () => {
    const store = memoryStore();
    keep(store, { input: withdraw, stage: "evm" });
    const t = setup({ store, locks: null });
    await expect(t.move.abandon("ref-1")).rejects.toThrow("cannot run the bridge");
    await expect(t.move.start(withdraw)).rejects.toThrow("cannot run the bridge");
  });
});

describe("the explorer reads the moves make", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("carry a timeout", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ items: [], status: "final", txHash: null }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    await explorerTx("0xab" as Hex);
    await explorerLeg("0xab" as Hex);
    await explorerSentSince(ME, 1);
    expect(f).toHaveBeenCalledTimes(3);
    for (const c of f.mock.calls as unknown as [string, RequestInit][]) expect(c[1].signal).toBeInstanceOf(AbortSignal);
  });
});
