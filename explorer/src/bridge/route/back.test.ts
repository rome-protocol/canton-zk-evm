import { describe, expect, it } from "vitest";
import type { Transfer } from "../other/record.ts";
import { stage } from "../other/fakes.ts";
import { episodes, rowsOf, viewOfRow, type InCtx, type KeptAct } from "./back.ts";
import { shortParty } from "./in.ts";
import { asset, cc, CC, forwarded, held, inFlow, INBOX, ME, on, opened, PARTY, refunded } from "./fakes.ts";

const T0 = Date.parse("2026-11-22T21:40:00Z");
const hash = "0x" + "77".repeat(32);
const record = (over: Partial<Transfer> = {}): Transfer => ({
  id: "r1", account: ME, at: T0, route: "canton-in", dir: "in", symbol: "CC", decimals: 10, native: false, amount: cc(4.8).toString(),
  send: { chainId: 11155111, to: "0x" + "52".repeat(20), data: "0x", value: "0", nonce: 1, tx: hash as `0x${string}` }, count: 7, claim: null, receiver: INBOX, party: PARTY, ...over,
});
const a = asset({ feeIn: cc(0.1), feeRefund: cc(0.05) });
const setup = on({ in: inFlow() }, { feeIn: cc(0.1), feeRefund: cc(0.05) });
const ctx = (over: Partial<InCtx> = {}): InCtx => ({ setup, asset: a, wallet: ME, deposit: null, accepts: true, checkIn: true, kept: null, coin: "tROME", now: T0 + 60_000, ...over });
const dep = (s: Parameters<typeof stage>[0], readyAt?: string) => ({ ...stage(s), ...(readyAt ? { readyAt } : {}) });
const kept = (kind: KeptAct["kind"], at: number): KeptAct => ({ kind, hash, at });
const minutes = (n: number) => T0 + n * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

describe("the episodes of a coin in an address", () => {
  it("starts one at a hold, joins a later hold of a running clock, and ends it at a payout or a send back", () => {
    const e = episodes([forwarded({ at: iso(minutes(30)) }), held({ at: iso(minutes(20)), balance: cc(9) }), held({ at: iso(minutes(10)) }), opened()]);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ state: "arrived", heldAt: minutes(10), amount: cc(4.7), fee: cc(0.1), balance: cc(9) });
  });
  it("is one of its own for a payout with no hold, and keeps what is still held, newest first", () => {
    const e = episodes([held({ at: iso(minutes(50)), block: 3 }), refunded({ at: iso(minutes(40)) }), forwarded({ at: iso(minutes(30)) })]);
    expect(e.map((x) => x.state)).toEqual(["held", "refunded", "arrived"]);
    expect(e[1]).toMatchObject({ depositCount: 9, amount: cc(4.6) });
  });
  it("keeps one clock for each address and token", () => {
    const e = episodes([held({ at: iso(minutes(20)), inbox: "0x" + "2c".repeat(20) }), forwarded({ at: iso(minutes(15)) }), held({ at: iso(minutes(10)) })]);
    expect(e.map((x) => `${x.inbox.slice(2, 4)}:${x.state}`).sort()).toEqual(["1b:arrived", "2c:held"]);
  });
});

describe("the rows", () => {
  it("joins a send to the first later episode of its address, and gives an episode with no send a row of its own", () => {
    const rows = rowsOf([record()], [forwarded({ at: iso(minutes(12)) }), opened(), held({ at: iso(minutes(-600)), refundAt: iso(minutes(-300)), inbox: "0x" + "2c".repeat(20) })]);
    expect(rows.map((r) => [r.record?.id ?? null, r.episode?.state])).toEqual([["r1", "arrived"], [null, "held"]]);
  });
  it("lets a second send take the next episode, not the first again", () => {
    const rows = rowsOf([record(), record({ id: "r2", at: minutes(60) })], [held({ at: iso(minutes(80)) }), forwarded({ at: iso(minutes(10)) })]);
    expect(rows.map((r) => [r.record?.id, r.episode?.state])).toEqual([["r2", "held"], ["r1", "arrived"]]);
  });
  const both = [record(), record({ id: "r2", at: minutes(5) })];
  const heldBoth = held({ at: iso(minutes(10)), balance: cc(9.6) });
  it("gives two sends into one held clock one row, the sends listed under it, and ends it with the payout", () => {
    const rows = rowsOf(both, [heldBoth]);
    expect(rows.map((r) => [r.id, r.sends.map((x) => x.id), r.episode?.state])).toEqual([["r1", ["r1", "r2"], "held"]]);
    expect(rows[0]!.at).toBe(minutes(5));
    const ended = rowsOf(both, [forwarded({ at: iso(minutes(30)), amount: cc(9.5) }), heldBoth]);
    expect(ended.map((r) => [r.id, r.sends.map((x) => x.id), r.episode?.state])).toEqual([["r1", ["r1", "r2"], "arrived"]]);
  });
  it("gives a send no episode whose total cannot hold its coin: another send's end is never its own", () => {
    // r1 is held alone (4.8); r2 is sent into the same address and not claimed yet; r1's coin is then paid on or sent back.
    for (const end of [forwarded({ at: iso(minutes(30)) }), refunded({ at: iso(minutes(30)), amount: cc(4.6), fee: cc(0.2) })]) {
      const rows = rowsOf(both, [end, held({ at: iso(minutes(10)) })]);
      expect(rows.map((r) => [r.id, r.sends.map((x) => x.id), r.episode?.state ?? null]), end.kind).toEqual([["r1", ["r1"], end.kind === "forwarded" ? "arrived" : "refunded"], ["r2", ["r2"], null]].reverse());
    }
    const r2 = rowsOf(both, [forwarded({ at: iso(minutes(30)) }), held({ at: iso(minutes(10)) })]).find((r) => r.id === "r2")!;
    expect(viewOfRow(r2, ctx({ deposit: dep("ready", iso(T0)), now: T0 + 700_000 })).actions.map((x) => x.kind)).toEqual(["claim"]);
  });
  it("gives r2 an episode of its own once its coin is claimed after the first ended", () => {
    const rows = rowsOf(both, [held({ at: iso(minutes(50)) }), forwarded({ at: iso(minutes(30)) }), held({ at: iso(minutes(10)) })]);
    expect(rows.map((r) => [r.id, r.episode?.state])).toEqual([["r2", "held"], ["r1", "arrived"]]);
  });
  it("joins no send that is not yet a deposit", () => {
    expect(rowsOf([record({ count: null })], [forwarded({ at: iso(minutes(12)) })]).map((r) => [r.record?.id ?? null, r.episode?.state ?? null]).sort()).toEqual([[null, "arrived"], ["r1", null]]);
  });
  it("offers one way on for a shared held episode, on its one row, and lists both sends", () => {
    const [row] = rowsOf(both, [heldBoth]);
    const v = viewOfRow(row!, ctx({ deposit: dep("claimed"), setup: on({ in: inFlow({ payout: { paused: false, pausedUntil: null, assets: {} } }) }), now: minutes(10) + 601_000 }));
    expect(v.title).toBe("9.6 CC is held on Ostia for Canton account " + shortParty(PARTY));
    expect(v.sends).toEqual(["4.8 CC sent Sun 22 Nov 21:40 UTC", "4.8 CC sent Sun 22 Nov 21:45 UTC"]);
    expect(v.actions.filter((x) => x.kind === "forward")).toHaveLength(1);
  });
  it("names the party and the way back from the opening, or from the send", () => {
    expect(rowsOf([], [held(), opened()])[0]).toMatchObject({ party: PARTY, refundAddress: ME });
    expect(rowsOf([record()], [])[0]).toMatchObject({ party: PARTY, refundAddress: ME });
  });
});

describe("a send that is not yet a deposit", () => {
  const row = (t: Partial<Transfer>) => rowsOf([record(t)], [])[0]!;
  it("offers the send again when the wallet was never asked", () => {
    const v = viewOfRow(row({ send: null, count: null }), ctx());
    expect(v).toMatchObject({ phase: "unsent", open: true, claimable: false });
    expect(v.actions.map((x) => x.kind)).toEqual(["send-again"]);
  });
  it("says the wallet did not answer, and that the send did not go through, without any button", () => {
    expect(viewOfRow(row({ send: { ...record().send!, tx: null }, count: null }), ctx())).toMatchObject({ phase: "unsure", actions: [], notes: [{ bad: true }] });
    expect(viewOfRow(row({ lost: "failed", count: null }), ctx())).toMatchObject({ phase: "lost", open: false, notes: [{ text: "This send did not go through on Ethereum Sepolia. Nothing was lost." }] });
  });
  it("shows the send as sent while its deposit number is not read yet", () => {
    const v = viewOfRow(row({ count: null }), ctx());
    expect(v).toMatchObject({ phase: "sending", word: "Sent" });
    expect(v.steps[0]).toMatchObject({ state: "now", detail: "Confirming…" });
  });
});

describe("a deposit on its way into Ostia", () => {
  const row = rowsOf([record()], [])[0]!;
  it("waits at Ready on Ostia until Ostia has the root, with its steps and no button", () => {
    const v = viewOfRow(row, ctx({ deposit: dep("confirmed") }));
    expect(v.phase).toBe("waiting");
    expect(v.title).toBe("Sending 4.8 CC to Canton");
    expect(v.steps.map((s) => [s.label, s.state])).toEqual([["Sent from Ethereum Sepolia", "done"], ["Ready on Ostia", "now"], ["Through Ostia to Canton", "todo"], ["Arrived in the Canton account", "todo"]]);
    expect(v.actions).toEqual([]);
    expect(v.open).toBe(true);
  });
  it("is ready at once, but offers the person's own claim only after the set time", () => {
    const readyAt = iso(T0 + 10_000);
    const early = viewOfRow(row, ctx({ deposit: dep("ready", readyAt), now: T0 + 10_000 + 599_000 }));
    expect(early).toMatchObject({ phase: "ready", actions: [], word: "Ready on Ostia" });
    expect(early.steps[1]!.state).toBe("done");
    const late = viewOfRow(row, ctx({ deposit: dep("ready", readyAt), now: T0 + 10_000 + 601_000 }));
    expect(late.notes).toEqual([{ text: "Ready on Ostia. You can claim it now with any EVM wallet.", bad: false }]);
    expect(late.actions).toEqual([{ kind: "claim", label: "Claim on Ostia", notes: ["The 0.1 CC fee is still taken from the amount.", "Your wallet signs on Ostia (a little tROME)."] }]);
    expect(late).toMatchObject({ claimable: true, claimPays: true });
  });
  it("says a claim only holds the coin when Canton cannot pay or the router would not take a claim-and-pay", () => {
    const late = (over: Partial<InCtx>) => viewOfRow(row, ctx({ deposit: dep("ready", iso(T0)), now: T0 + 700_000, ...over }));
    for (const over of [{ accepts: false }, { checkIn: false }, { checkIn: null }, { setup: on({ in: inFlow({ payout: { paused: true, pausedUntil: null, assets: {} } }) }) }] as Partial<InCtx>[]) {
      const v = late(over);
      expect(v.claimPays, JSON.stringify(Object.keys(over))).toBe(false);
      expect(v.actions[0]!.notes).toContain("Canton cannot pay this account right now. Claiming holds it on Ostia, and you can send it back 3 days after that.");
    }
  });
  it("offers no claim of their own while the switch for it is off", () => {
    const s = on({ in: inFlow({ claimOstia: null }) });
    expect(viewOfRow(row, ctx({ setup: s, deposit: dep("ready", iso(T0)), now: T0 + 900_000 })).actions).toEqual([]);
  });
  it("shows a claim this browser asked for as claiming, with its marks, and the line for one that is in no block after the set time", () => {
    const d = dep("ready", iso(T0));
    const soon = viewOfRow(row, ctx({ deposit: d, kept: kept("claim", T0 + 30_000), now: T0 + 90_000 }));
    expect(soon).toMatchObject({ phase: "claiming", word: "Claiming", actions: [], marksOf: hash });
    const lost = viewOfRow(row, ctx({ deposit: d, kept: kept("claim", T0 + 30_000), now: T0 + 30_000 + 1_201_000 }));
    expect(lost.notes).toContainEqual({ text: "Canton did not pay this out. Cancel that transaction in your wallet, or use another EVM wallet, then claim to hold it on Ostia.", bad: true });
    expect(lost.actions.map((x) => x.kind)).toEqual(["claim"]);
    expect(lost.claimPays).toBe(false);
  });
  it("keeps showing the marks of a claim that is in a block, and never the left-out line for it", () => {
    const seen = viewOfRow(row, ctx({ deposit: dep("ready", iso(T0)), kept: kept("claim", T0 + 30_000), keptSeen: true, now: T0 + 30_000 + 1_201_000 }));
    expect(seen).toMatchObject({ phase: "claiming", actions: [], marksOf: hash });
    expect(JSON.stringify(seen.notes)).not.toContain("did not pay");
  });
  it("offers no claim at Claimed when no router event is there, and no send again in the claim count", () => {
    expect(viewOfRow(row, ctx({ deposit: dep("claimed", iso(T0)), now: T0 + 900_000 })).actions).toEqual([]);
    const unsent = viewOfRow(rowsOf([record({ send: null, count: null })], [])[0]!, ctx());
    expect(unsent.actions.map((x) => x.kind)).toEqual(["send-again"]);
    expect(unsent.claimable).toBe(false);
  });
});

describe("a coin held on Ostia", () => {
  const row = (t: Partial<Transfer> = {}) => rowsOf([record(t)], [held({ at: iso(minutes(5)) })])[0]!;
  const held5 = (over: Partial<InCtx> = {}) => viewOfRow(row(), ctx({ deposit: dep("claimed"), now: minutes(5) + 1000, ...over }));
  it("says why Canton cannot pay, when it can pay again and from when the coin can go back", () => {
    const p = inFlow().payout!;
    const v = held5({ setup: on({ in: inFlow({ payout: { ...p, assets: { [CC]: { left: 0n, renewsAt: "2026-11-22T14:05:00.000Z" } } } }) }) });
    expect(v).toMatchObject({ phase: "held", word: "Held on Ostia", open: true });
    expect(v.steps[2]).toMatchObject({ label: "Held on Ostia", state: "now" });
    expect(v.notes[0]!.text).toBe("Canton cannot pay this account right now: today's limit is reached. Canton can pay out again from 14:05 UTC. From Wed 25 Nov 21:45 UTC you can send it back.");
    expect(v.actions).toEqual([]);
  });
  it("gives the other two reasons in words", () => {
    expect(held5({ accepts: false }).notes[0]!.text).toContain("this account no longer takes transfers from Ostia.");
    expect(held5({ setup: on({ in: inFlow({ payout: { paused: true, pausedUntil: null, assets: {} } }) }) }).notes[0]!.text).toContain("payouts to Canton are paused.");
  });
  it("offers Send on to Canton once Canton can pay again and the set time has passed since it was held", () => {
    const early = held5({ now: minutes(5) + 599_000 });
    expect(early.notes[0]!.text).toBe("Canton can pay this account again.");
    expect(early.actions).toEqual([]);
    const late = held5({ now: minutes(5) + 601_000 });
    expect(late.actions).toEqual([{ kind: "forward", label: "Send on to Canton", notes: ["The 0.1 CC fee is still taken from the amount.", "Your wallet signs on Ostia (a little tROME)."] }]);
    expect(late.claimable).toBe(true);
  });
  it("offers Send back from the end of the clock, whatever Canton can pay, with the fee and the way back, and not before", () => {
    const before = held5({ accepts: false, now: Date.parse("2026-11-25T21:44:59Z") });
    expect(before.actions).toEqual([]);
    const after = held5({ accepts: false, now: Date.parse("2026-11-25T21:45:01Z") });
    expect(after.notes.map((n) => n.text)).toContain("Held on Ostia since Sun 22 Nov 21:45 UTC. It can go back now.");
    expect(after.actions).toEqual([{ kind: "refund", label: "Send back to Ethereum Sepolia", notes: [`Goes back to ${ME.slice(0, 6)}…${ME.slice(-4)}. The 0.2 CC fee is still taken from the amount.`, "Your wallet signs on Ostia (a little tROME)."] }]);
    const switchOff = held5({ accepts: false, now: Date.parse("2026-11-25T21:45:01Z"), setup: on({ in: inFlow({ claimOstia: null }) }) });
    expect(switchOff.actions.map((x) => x.kind)).toEqual(["refund"]);   // a held coin can always go home
  });
  it("shows a move on or a send back that this browser asked for, with the left-out line after the set time", () => {
    const now = minutes(5) + 700_000;
    const sending = held5({ now, kept: kept("forward", now - 1000) });
    expect(sending.notes.map((n) => n.text)).toContain("Sending on to Canton…");
    expect(sending.actions).toEqual([]);
    expect(sending.marksOf).toBe(hash);
    const out = held5({ now, kept: kept("forward", now - 1_300_000) });
    expect(out.notes).toContainEqual({ text: "Canton did not pay this out. It is still held on Ostia. Cancel that transaction in your wallet, or use another EVM wallet.", bad: true });
    expect(out.actions.map((x) => x.kind)).toEqual(["forward"]);
  });
  it("leaves out Send on to Canton while the router would not take a claim-and-pay", () => {
    expect(held5({ now: minutes(5) + 601_000, checkIn: false }).actions).toEqual([]);
    expect(held5({ now: minutes(5) + 601_000, checkIn: null }).actions.map((x) => x.kind)).toEqual(["forward"]);
  });
  it("keeps showing the marks of a move on that is in a block, and never the left-out line for it", () => {
    const now = minutes(5) + 700_000;
    const v = held5({ now, kept: kept("forward", now - 1_300_000), keptSeen: true });
    expect(v.marksOf).toBe(hash);
    expect(JSON.stringify(v.notes)).not.toContain("did not pay");
    expect(v.actions.map((x) => x.kind)).not.toContain("forward");
  });
  it("is a row of its own, named by the account, when this browser made no send", () => {
    const v = viewOfRow(rowsOf([], [opened(), held({ at: iso(minutes(5)) })])[0]!, ctx({ now: minutes(6) }));
    expect(v.title).toBe("4.8 CC is held on Ostia for Canton account alice::1220…9f9f");
  });
});

describe("a coin paid on or sent back", () => {
  it("is Arrived once Canton has paid it, with every step done", () => {
    const v = viewOfRow(rowsOf([record()], [forwarded({ at: iso(minutes(12)) })])[0]!, ctx({ deposit: dep("claimed") }));
    expect(v).toMatchObject({ phase: "arrived", word: "Arrived", open: false, claimable: false });
    expect(v.title).toBe("Arrived. 4.7 CC is in Canton account alice::1220…9f9f.");
    expect(v.steps.every((s) => s.state === "done")).toBe(true);
  });
  it("walks a send back through Confirmed on Ethereum Sepolia to Arrived back, with the claim there after the set time", () => {
    const r = rowsOf([record()], [refunded({ at: iso(minutes(4000)) })])[0]!;
    const confirmed = viewOfRow(r, ctx({ deposit: dep("confirmed"), now: minutes(4001) }));
    expect(confirmed).toMatchObject({ phase: "refunded", word: "Sent back", open: true });
    expect(confirmed.steps.map((s) => [s.label, s.state])).toEqual([["Sent back from Ostia", "done"], ["Confirmed on Ethereum Sepolia", "done"], ["Arrived back", "todo"]]);
    const readyAt = iso(minutes(4002));
    expect(viewOfRow(r, ctx({ deposit: dep("ready", readyAt), now: minutes(4002) + 100_000 })).actions).toEqual([]);
    const late = viewOfRow(r, ctx({ deposit: dep("ready", readyAt), now: minutes(4002) + 301_000 }));
    expect(late.actions).toEqual([{ kind: "claim-sepolia", label: "Claim on Ethereum Sepolia", notes: ["Your wallet switches to Ethereum Sepolia. Its fee is paid in Sepolia ETH."] }]);
    const done = viewOfRow(r, ctx({ deposit: dep("claimed", readyAt) }));
    expect(done).toMatchObject({ phase: "back-arrived", open: false });
    expect(done.title).toBe("Arrived back. 4.6 CC is in your wallet on Ethereum Sepolia.");
  });
  it("is finished when the whole balance went to the fee, and reads no deposit for it", () => {
    const v = viewOfRow(rowsOf([], [opened(), refunded({ amount: 0n })])[0]!, ctx({ deposit: dep("ready", iso(T0)), now: minutes(5000) }));
    expect(v).toMatchObject({ phase: "refunded", open: false, actions: [] });
    expect(v.title).toContain("nothing goes back");
  });
  it("does not say who sent the coin back", () => {
    const text = JSON.stringify(viewOfRow(rowsOf([], [opened(), refunded()])[0]!, ctx({ deposit: dep("sent") })));
    expect(text).not.toMatch(/Rome|worker|relayer/i);
  });
});

describe("the words of every row", () => {
  it("never say pending, Receive, gas, other chains or builder words", () => {
    const rows = [
      rowsOf([record()], [])[0]!, rowsOf([record()], [held({ at: iso(minutes(5)) })])[0]!, rowsOf([record()], [forwarded({ at: iso(minutes(5)) })])[0]!, rowsOf([record()], [refunded({ at: iso(minutes(5)) })])[0]!,
    ];
    for (const r of rows) for (const d of [dep("sent"), dep("ready", iso(T0)), dep("claimed")]) for (const now of [minutes(2), minutes(20), minutes(5000)]) {
      const text = JSON.stringify(viewOfRow(r, ctx({ deposit: d, now })));
      expect(text).not.toMatch(/pending|receive|\bgas\b|other chains|inbox|relayer|proof|certificate/i);
    }
  });
});
