import { describe, expect, it } from "vitest";
import { ReadError } from "./reads.ts";
import { loadTransfer, saveTransfer, type Transfer } from "./record.ts";
import { adopt, advance, askingOf, giveUp, look, resendSend, signClaim, startSend, Stop, Unsure, watchAsking } from "./transfer.ts";
import { claimData, ETH, eventLog, fakeEnv, hash, ME, memoryLocks, memoryStore, OSTIA_BRIDGE, OSTIA_ID, SEPOLIA_BRIDGE, SEPOLIA_ID, stage, WETH, world } from "./fakes.ts";

const AMOUNT = 2_000_000_000_000_000n;
const OTHER = "0x" + "e4".repeat(20);

describe("starting a send", () => {
  it("into Ostia: puts the wallet on Sepolia, writes the record with the nonce before the wallet is asked, then writes the hash", async () => {
    const w = world({ chain: OSTIA_ID });
    const env = fakeEnv(w);
    const wasAsked: (Transfer | null)[] = [];
    const send = env.send;
    env.send = async (chainId, call) => { wasAsked.push(loadTransfer(env.store, "t1")); return send(chainId, call); };
    const t = await startSend(env, { dir: "in", asset: ETH, amount: AMOUNT });
    expect(w.asked.ensure).toEqual([SEPOLIA_ID]);
    expect(wasAsked[0]!.send).toMatchObject({ chainId: SEPOLIA_ID, to: SEPOLIA_BRIDGE, value: AMOUNT.toString(), nonce: 4, tx: null });   // the record was there, with the nonce, when the wallet was asked
    expect(t.send).toMatchObject({ tx: w.sent[0]!.hash, nonce: 4 });
    expect(loadTransfer(env.store, "t1")).toEqual(t);
    expect(w.sent).toHaveLength(1);
    expect(t).toMatchObject({ account: ME, dir: "in", symbol: "ETH", native: true, amount: AMOUNT.toString(), count: null, claim: null });
  });
  it("keeps what a look wrote while the wallet was being asked (the step is added to the record, which is not written over)", async () => {
    const w = world();
    const env = fakeEnv(w);
    const send = env.send;
    env.send = async (chainId, call) => {
      const hash = await send(chainId, call);
      saveTransfer(env.store, { ...loadTransfer(env.store, "t1")!, count: 9 });   // a look of the page finds the deposit while the pop-up is open
      return hash;
    };
    const t = await startSend(env, { dir: "in", asset: ETH, amount: AMOUNT });
    expect(t.count).toBe(9);
    expect(loadTransfer(env.store, "t1")).toMatchObject({ count: 9, send: { tx: w.sent[0]!.hash } });
  });
  it("sends nothing, and puts the wallet nowhere, when the browser keeps no record: no store, writes that are dropped, or writes that throw", async () => {
    const dropped = { ...memoryStore(), setItem: () => {} };
    const full = { ...memoryStore(), setItem: () => { throw new Error("quota"); } };
    for (const store of [null, dropped, full]) {
      const w = world();
      const env = fakeEnv(w, { store: store as never });
      env.store = store as never;
      await expect(startSend(env, { dir: "in", asset: ETH, amount: AMOUNT })).rejects.toThrow(/does not keep data for this site.*Nothing was sent/);
      expect(w.sent).toEqual([]);
      expect(w.asked.ensure).toEqual([]);
    }
  });
  it("sends nothing when the step cannot be read back after it is written (the storage fills up between the probe and the record)", async () => {
    const w = world();
    const store = memoryStore();
    const env = fakeEnv(w, { store });
    const set = store.setItem;
    store.setItem = (k, v) => { if (k.startsWith("agglayer-transfer:")) return; set(k, v); };
    await expect(startSend(env, { dir: "in", asset: ETH, amount: AMOUNT })).rejects.toThrow(/does not keep data for this site/);
    expect(w.sent).toEqual([]);
  });
  it("is known as asked in this tab only while the wallet is being asked, and tells a watcher when that changes", async () => {
    const w = world();
    const env = fakeEnv(w);
    const seen: (string | null)[] = [];
    const stop = watchAsking(() => seen.push(askingOf("t1")));
    const send = env.send;
    let during: string | null = null;
    env.send = async (chainId, call) => { during = askingOf("t1"); return send(chainId, call); };
    await startSend(env, { dir: "in", asset: ETH, amount: AMOUNT });
    stop();
    expect(during).toBe("send");
    expect(askingOf("t1")).toBeNull();
    expect(seen[0]).toBe("send");
    expect(seen.at(-1)).toBeNull();
    // A wallet that does not answer clears it too: the step is then one the wallet left open.
    const w2 = world({ next: ["silent"] });
    const env2 = fakeEnv(w2);
    await expect(startSend(env2, { dir: "in", asset: ETH, amount: AMOUNT })).rejects.toBeInstanceOf(Unsure);
    expect(askingOf("t1")).toBeNull();
  });
  it("out of Ostia: sends the wrapped ether to the Ostia bridge, for Ethereum, with no value", async () => {
    const w = world({ chain: SEPOLIA_ID });
    const env = fakeEnv(w);
    const t = await startSend(env, { dir: "out", asset: ETH, amount: 5n });
    expect(w.asked.ensure).toEqual([OSTIA_ID]);
    expect(w.sent[0]!.call).toMatchObject({ to: OSTIA_BRIDGE, value: "0" });
    expect(t.send!.chainId).toBe(OSTIA_ID);
  });
  it("leaves no record when the person says no, or the estimate fails: nothing was sent", async () => {
    const w = world({ next: ["refuse", "estimate"] });
    const env = fakeEnv(w);
    await expect(startSend(env, { dir: "in", asset: ETH, amount: AMOUNT })).rejects.toMatchObject({ code: 4001 });
    expect(loadTransfer(env.store, "t1")).toBeNull();
    await expect(startSend(env, { dir: "in", asset: ETH, amount: AMOUNT })).rejects.toThrow("execution reverted");
    expect(loadTransfer(env.store, "t2")).toBeNull();
    expect(w.sent).toEqual([]);
  });
  it("keeps the record and says Unsure when the wallet's answer does not say whether it sent", async () => {
    const w = world({ next: ["silent"] });
    const env = fakeEnv(w);
    await expect(startSend(env, { dir: "in", asset: ETH, amount: AMOUNT })).rejects.toBeInstanceOf(Unsure);
    expect(loadTransfer(env.store, "t1")!.send).toMatchObject({ tx: null, nonce: 4 });
  });
  it("refuses an amount of nothing, and stops when the wallet cannot be put on the chain", async () => {
    const w = world();
    const env = fakeEnv(w);
    await expect(startSend(env, { dir: "in", asset: ETH, amount: 0n })).rejects.toBeInstanceOf(Stop);
    env.ensure = async () => "Your wallet is not on Ethereum Sepolia yet.";
    await expect(startSend(env, { dir: "in", asset: ETH, amount: 1n })).rejects.toThrow("Your wallet is not on Ethereum Sepolia yet.");
    expect(w.sent).toEqual([]);
    expect(loadTransfer(env.store, "t1")).toBeNull();
  });
  it("needs a lock, and says so when the transfer is open in another tab", async () => {
    const w = world();
    await expect(startSend(fakeEnv(w, { locks: false }), { dir: "in", asset: ETH, amount: 1n })).rejects.toThrow(/cannot run the bridge/);
    const env = fakeEnv(w, { id: "same" });
    const locks = memoryLocks();
    env.locks = locks;
    const second = startSend({ ...env, locks }, { dir: "in", asset: ETH, amount: 1n });
    const third = startSend({ ...env, locks }, { dir: "in", asset: ETH, amount: 1n });
    const results = await Promise.allSettled([second, third]);
    expect(results.filter((r) => r.status === "rejected" && /another tab/.test(String((r.reason as Error).message)))).toHaveLength(1);
    expect(w.sent).toHaveLength(1);   // the same transfer is asked of the wallet once
  });
});

describe("a send the wallet did not answer", () => {
  const unsure = async (w = world({ next: ["silent"] })) => {
    const env = fakeEnv(w);
    await expect(startSend(env, { dir: "in", asset: ETH, amount: AMOUNT })).rejects.toBeInstanceOf(Unsure);
    return { w, env };
  };
  it("is not asked of the wallet again while it is open: asking again is refused", async () => {
    const { w, env } = await unsure();
    await expect(resendSend(env, "t1")).rejects.toThrow(/already asked for/);
    expect(w.sent).toEqual([]);
  });
  it("may be asked again once the wallet's count shows nothing was sent: and then it is sent once", async () => {
    const { w, env } = await unsure();
    expect(await look(env, "t1", "send")).toBe("not-sent");
    expect(loadTransfer(env.store, "t1")!.send).toBeNull();
    const t = await resendSend(env, "t1");
    expect(w.sent).toHaveLength(1);
    expect(t.send!.tx).toBe(w.sent[0]!.hash);
    await expect(resendSend(env, "t1")).rejects.toThrow(/already asked for/);
  });
  it("stays open when the wallet's count moved: the send may be there", async () => {
    const { w, env } = await unsure(world({ next: ["silent-sent"] }));
    expect(w.sent).toHaveLength(1);
    expect(await look(env, "t1", "send")).toBe("unknown");
    await expect(resendSend(env, "t1")).rejects.toThrow(/already asked for/);
  });
  it("is not judged when the wallet gives no count, or the record has no count to compare with: the page says only that it cannot tell", async () => {
    const a = await unsure(world({ next: ["silent-sent"] }));
    a.w.noCount = true;
    expect(await look(a.env, "t1", "send")).toBe("no-count");
    const b = await unsure(world({ next: ["silent"], noCount: true }));   // the wallet gave no count when the step was written, so the record has no nonce
    expect(loadTransfer(b.env.store, "t1")!.send!.nonce).toBeNull();
    b.w.noCount = false;
    expect(await look(b.env, "t1", "send")).toBe("no-count");
    await expect(resendSend(b.env, "t1")).rejects.toThrow(/already asked for/);   // and the step stays open
  });
  it("cannot be looked at while the wallet is on another chain", async () => {
    const { w, env } = await unsure(world({ next: ["silent"] }));
    w.chain = OSTIA_ID;
    expect(await look(env, "t1", "send")).toBe("elsewhere");
  });
  it("is taken up from a hash the person pastes, when the chain shows exactly this call", async () => {
    const { w, env } = await unsure(world({ next: ["silent-sent"] }));
    const sent = w.sent[0]!;
    await expect(adopt(env, "t1", "send", "0x12")).rejects.toThrow(/64 letters/);
    await expect(adopt(env, "t1", "send", hash(9))).rejects.toThrow(/not this one/);   // the chain has no such transaction
    w.seen.set(hash(9), { from: OTHER, to: sent.call.to, input: sent.call.data, value: sent.call.value });
    await expect(adopt(env, "t1", "send", hash(9))).rejects.toThrow(/not this one/);   // somebody else's
    w.seen.set(hash(9), { from: ME, to: sent.call.to, input: sent.call.data, value: "1" });
    await expect(adopt(env, "t1", "send", hash(9))).rejects.toThrow(/not this one/);   // another value
    w.seen.set(sent.hash, { from: ME.toUpperCase().replace("0X", "0x"), to: sent.call.to, input: sent.call.data, value: sent.call.value });
    const t = await adopt(env, "t1", "send", sent.hash);
    expect(t.send!.tx).toBe(sent.hash);
    expect(await look(env, "t1", "send")).toBe("sent");
  });
  it("asks to put the wallet on the chain when a pasted hash cannot be read", async () => {
    const { w, env } = await unsure(world({ next: ["silent"] }));
    w.chain = OSTIA_ID;
    await expect(adopt(env, "t1", "send", hash(9))).rejects.toThrow(/Put your wallet on the chain/);
  });
  it("can be given up: the record goes, nothing is sent", async () => {
    const { w, env } = await unsure();
    giveUp(env, "t1");
    expect(loadTransfer(env.store, "t1")).toBeNull();
    expect(w.sent).toEqual([]);
  });
});

describe("a record with no send", () => {
  it("is asked of the wallet when the person presses Send again", async () => {
    const w = world();
    const env = fakeEnv(w);
    const t: Transfer = { id: "r1", account: ME, at: 1, route: "sepolia", dir: "in", symbol: "ETH", decimals: 18, native: true, amount: AMOUNT.toString(), send: null, count: null, claim: null };
    saveTransfer(env.store, t);
    const done = await resendSend(env, "r1");
    expect(done.send!.tx).toBe(w.sent[0]!.hash);
    expect(w.sent[0]!.call.value).toBe(AMOUNT.toString());
  });
  it("is not sent for a token that the route no longer offers", async () => {
    const w = world();
    const env = fakeEnv(w);
    saveTransfer(env.store, { id: "r1", account: ME, at: 1, route: "sepolia", dir: "in", symbol: "DAI", decimals: 18, native: false, amount: "5", send: null, count: null, claim: null });
    await expect(resendSend(env, "r1")).rejects.toThrow(/not offered here any more/);
    expect(w.sent).toEqual([]);
  });
});

describe("one look at a transfer", () => {
  const started = async (dir: "in" | "out" = "in", w = world()) => {
    const env = fakeEnv(w);
    const t = await startSend(env, { dir, asset: ETH, amount: AMOUNT });
    return { w, env, t, bridge: dir === "in" ? SEPOLIA_BRIDGE : OSTIA_BRIDGE, dest: dir === "in" ? 75 : 0 };
  };
  it("signs nothing, and asks nothing of the bridge before the send is in a block", async () => {
    const { w, env } = await started();
    const before = w.sent.length;
    const r = await advance(env, "t1");
    expect(r.transfer!.count).toBeNull();
    expect(r.live).toEqual({ deposit: null, wrongChain: null, unreadable: false });
    expect(w.sent).toHaveLength(before);
    expect(w.asked.deposit).toBe(0);
  });
  it("takes the deposit number from the receipt, and then reads the deposit", async () => {
    const { w, env, t, bridge, dest } = await started();
    w.receipts.set(t.send!.tx!, { ok: true, logs: [eventLog({ bridge, dest, amount: AMOUNT, count: 12 })] });
    w.deposit = stage("confirmed");
    const r = await advance(env, "t1");
    expect(r.transfer!.count).toBe(12);
    expect(loadTransfer(env.store, "t1")!.count).toBe(12);
    expect(r.live.deposit!.stage).toBe("confirmed");
  });
  it("says the wallet must be on Sepolia to read the send there, and keeps what it knew", async () => {
    const { w, env, t } = await started();
    w.chain = OSTIA_ID;
    w.receipts.set(t.send!.tx!, { ok: true, logs: [] });
    const r = await advance(env, "t1");
    expect(r.live.wrongChain).toBe(SEPOLIA_ID);
    expect(r.transfer!.lost).toBeUndefined();
  });
  it("reads a send on Ostia with the wallet on any chain", async () => {
    const { w, env, t, bridge, dest } = await started("out");
    w.chain = SEPOLIA_ID;
    w.receipts.set(t.send!.tx!, { ok: true, logs: [eventLog({ bridge, dest, amount: AMOUNT, count: 3 })] });
    expect((await advance(env, "t1")).transfer!.count).toBe(3);
  });
  it("marks a send whose transaction failed as lost, and one whose deposit cannot be read as unreadable", async () => {
    const a = await started();
    a.w.receipts.set(a.t.send!.tx!, { ok: false, logs: [] });
    expect((await advance(a.env, "t1")).transfer!.lost).toBe("failed");
    const b = await started();
    b.w.receipts.set(b.t.send!.tx!, { ok: true, logs: [eventLog({ bridge: b.bridge, dest: b.dest, amount: 1n, count: 1 })] });
    expect((await advance(b.env, "t1")).transfer!.lost).toBe("unreadable");
  });
  it("is done when the deposit is paid out, by a claim of this page or one made elsewhere", async () => {
    const { w, env, t, bridge, dest } = await started();
    w.receipts.set(t.send!.tx!, { ok: true, logs: [eventLog({ bridge, dest, amount: AMOUNT, count: 1 })] });
    w.deposit = stage("claimed");
    const r = await advance(env, "t1");
    expect(r.transfer!.done).toBe(1_700_000_000_000);
    expect(w.sent).toHaveLength(1);   // and nothing was sent
    expect((await advance(env, "t1")).live.deposit).toBeNull();   // a finished transfer is not looked at again
  });
  it("for a send to a Canton account's address: sends to that address, reads the deposit made to it, and is not done when the deposit is claimed (the router says when it arrived)", async () => {
    const w = world(), INBOX = "0x" + "1b".repeat(20);
    const env = fakeEnv(w);
    const t = await startSend(env, { dir: "in", asset: ETH, amount: AMOUNT, to: { receiver: INBOX.toUpperCase().replace("0X", "0x"), party: "alice::1220ab", route: "canton-in" } });
    expect(t).toMatchObject({ route: "canton-in", receiver: INBOX, party: "alice::1220ab", account: ME });
    expect(w.sent[0]!.call.data.toLowerCase()).toContain(INBOX.slice(2));   // the deposit's receiver is the address, not the wallet
    expect(w.sent[0]!.call.data.toLowerCase()).not.toContain(ME.slice(2));
    const bridge = SEPOLIA_BRIDGE, dest = 75;
    w.receipts.set(t.send!.tx!, { ok: true, logs: [eventLog({ bridge, dest, to: INBOX, amount: AMOUNT, count: 5 })] });
    w.deposit = stage("claimed");
    const r = await advance(env, "t1");
    expect(r.transfer).toMatchObject({ count: 5 });
    expect(r.transfer!.done).toBeUndefined();
    expect(r.live.deposit!.stage).toBe("claimed");
  });
  it("reports a read that failed, and tries again next time", async () => {
    const { w, env, t, bridge, dest } = await started();
    w.receipts.set(t.send!.tx!, { ok: true, logs: [eventLog({ bridge, dest, amount: AMOUNT, count: 1 })] });
    const deposit = env.deposit;
    env.deposit = async () => { throw new ReadError("no", 503); };
    expect((await advance(env, "t1")).live.unreadable).toBe(true);
    env.deposit = deposit;
    expect((await advance(env, "t1")).live.unreadable).toBe(false);
  });
});

describe("the claim", () => {
  /** A transfer into Ostia whose deposit is ready. */
  async function ready(over: Partial<Transfer> = {}) {
    const w = world();
    const env = fakeEnv(w);
    const t = await startSend(env, { dir: "in", asset: ETH, amount: AMOUNT });
    saveTransfer(env.store, { ...t, count: 12, ...over });
    w.deposit = stage("ready");
    w.claim = { claimed: false, chainId: OSTIA_ID, to: OSTIA_BRIDGE, destinationNetwork: 75, data: claimData(75, ME, AMOUNT, 12) };
    return { w, env };
  }
  it("is signed on the destination chain after the server says it is ready and the claim is this wallet's: the record is written before the wallet is asked", async () => {
    const { w, env } = await ready();
    const send = env.send;
    let seenBefore: Transfer | null = null;
    env.send = async (chainId, call) => { seenBefore = loadTransfer(env.store, "t1"); return send(chainId, call); };
    const t = await signClaim(env, "t1");
    expect(w.asked.ensure.at(-1)).toBe(OSTIA_ID);
    expect(seenBefore!.claim).toMatchObject({ chainId: OSTIA_ID, to: OSTIA_BRIDGE, tx: null, nonce: 7 });
    expect(t.claim!.tx).toBe(w.sent[1]!.hash);
    expect(w.sent[1]!.call).toMatchObject({ to: OSTIA_BRIDGE, value: "0" });
  });
  it("is not asked of the wallet a second time", async () => {
    const { w, env } = await ready();
    await signClaim(env, "t1");
    await expect(signClaim(env, "t1")).rejects.toThrow(/already asked for/);
    expect(w.sent).toHaveLength(2);
  });
  it("is refused, with nothing signed, when it pays someone else, another amount, another network, or is for another bridge or chain", async () => {
    for (const bad of [
      { data: claimData(75, OTHER, AMOUNT, 12) }, { data: claimData(75, ME, AMOUNT + 1n, 12) }, { data: claimData(0, ME, AMOUNT, 12) }, { data: claimData(75, ME, AMOUNT, 11) },
      { to: SEPOLIA_BRIDGE }, { chainId: SEPOLIA_ID }, { destinationNetwork: 0 }, { data: null },
    ]) {
      const { w, env } = await ready();
      w.claim = { ...(w.claim as object), ...bad } as never;
      await expect(signClaim(env, "t1")).rejects.toThrow(/not yours/);
      expect(w.sent).toHaveLength(1);   // only the send
      expect(loadTransfer(env.store, "t1")!.claim).toBeNull();
    }
  });
  it("says it has arrived, and signs nothing, when the server says it is paid out", async () => {
    const { w, env } = await ready();
    w.claim = { claimed: true, chainId: OSTIA_ID, to: OSTIA_BRIDGE, destinationNetwork: 75, data: null };
    await expect(signClaim(env, "t1")).rejects.toThrow("Already arrived.");
    expect(loadTransfer(env.store, "t1")!.done).toBeDefined();
    expect(w.sent).toHaveLength(1);
  });
  it("says in words when it is not ready, when the bridge cannot be read, and when asked too often", async () => {
    const { w, env } = await ready();
    for (const [status, words] of [[404, /not ready to claim yet/], [503, /cannot be read right now/], [429, /Too many requests/]] as const) {
      w.claim = new ReadError("x", status);
      await expect(signClaim(env, "t1")).rejects.toThrow(words);
    }
    expect(w.sent).toHaveLength(1);
  });
  it("is not made for a transfer that has no deposit number yet, or that was lost, or is done", async () => {
    for (const over of [{ count: null }, { lost: "failed" as const }, { done: 5 }]) {
      const { w, env } = await ready(over);
      await expect(signClaim(env, "t1")).rejects.toBeInstanceOf(Stop);
      expect(w.asked.claim).toBe(0);
    }
  });
  it("on Sepolia: signs on Sepolia for an Ostia send", async () => {
    const w = world();
    const env = fakeEnv(w);
    const t = await startSend(env, { dir: "out", asset: ETH, amount: AMOUNT });
    saveTransfer(env.store, { ...t, count: 3 });
    w.claim = { claimed: false, chainId: SEPOLIA_ID, to: SEPOLIA_BRIDGE, destinationNetwork: 0, data: claimData(0, ME, AMOUNT, 3) };
    await signClaim(env, "t1");
    expect(w.asked.ensure.at(-1)).toBe(SEPOLIA_ID);
  });
  it("that did not end well is cleared, and may be made again; one that is final makes the transfer done", async () => {
    const { w, env } = await ready();
    const t = await signClaim(env, "t1");
    w.receipts.set(t.claim!.tx!, { ok: false, logs: [] });
    const r = await advance(env, "t1");
    expect(r.transfer!.claim).toBeNull();
    expect(r.transfer!.claimFailed).toBe(true);
    const again = await signClaim(env, "t1");
    expect(again.claimFailed).toBeUndefined();
    w.receipts.set(again.claim!.tx!, { ok: true, logs: [] });
    expect((await advance(env, "t1")).transfer!.done).toBeDefined();
  });
  it("whose answer the wallet did not give is looked up like a send", async () => {
    const { w, env } = await ready();
    w.next.push("silent");
    await expect(signClaim(env, "t1")).rejects.toBeInstanceOf(Unsure);
    await expect(signClaim(env, "t1")).rejects.toThrow(/already asked for/);
    w.chain = OSTIA_ID;
    expect(await look(env, "t1", "claim")).toBe("not-sent");
    await signClaim(env, "t1");
    expect(w.sent).toHaveLength(2);
  });
});
