import { describe, expect, it } from "vitest";
import { BUFFER_BLOCKS, TXS_MAX, clientKey, createStreamHub, lastIdOf, topicsOf, type BlockEvent, type Sink, type Topic } from "./stream.ts";

const block = (n: number): BlockEvent => ({ number: n, hash: "0x" + n.toString(16).padStart(64, "0"), txCount: n, recordTime: "2026-10-22T10:00:00Z", updateId: "1220" + "ab".repeat(32) });
const hashes = (n: number) => Array.from({ length: n }, (_, i) => "0x" + (i + 1).toString(16).padStart(64, "0"));
const all = new Set<Topic>(["blocks", "txs", "inflight", "stats"]);
function client(backlog = 0): Sink & { text: string; ended: boolean } {
  const s = { text: "", ended: false, write(c: string) { s.text += c; }, backlog: () => backlog, end() { s.ended = true; } };
  return s;
}
/** The events of a stream's text: [id, name, data]. */
const events = (text: string) => text.split("\n\n").filter((f) => f && !f.startsWith(":")).map((f) => {
  const l = Object.fromEntries(f.split("\n").map((x) => [x.slice(0, x.indexOf(": ")), x.slice(x.indexOf(": ") + 2)]));
  return [l.id ?? null, l.event, JSON.parse(l.data!)] as const;
});

describe("the stream hub", () => {
  it("tells a block as a block event and a txs event with the block number as their id, in order", () => {
    const hub = createStreamHub();
    const c = client();
    expect(hub.attach("1.1.1.1", all, null, c).ok).toBe(true);
    hub.publishBlock(block(5), hashes(2));
    hub.publishBlock(block(6), hashes(0));
    const e = events(c.text);
    expect(e.map((x) => [x[0], x[1]])).toEqual([["5", "block"], ["5", "txs"], ["6", "block"], ["6", "txs"]]);
    expect(e[0]![2]).toEqual({ number: 5, hash: block(5).hash, txCount: 5, recordTime: "2026-10-22T10:00:00Z", updateId: block(5).updateId });
    expect(e[1]![2]).toEqual({ number: 5, hashes: hashes(2), more: false });
  });

  it("sends only the topics a client asked for, and at most 50 hashes", () => {
    const hub = createStreamHub();
    const blocks = client(), txs = client(), other = client();
    hub.attach("a", new Set<Topic>(["blocks"]), null, blocks);
    hub.attach("b", new Set<Topic>(["txs"]), null, txs);
    hub.attach("c", new Set<Topic>(["inflight"]), null, other);
    hub.publishBlock(block(1), hashes(TXS_MAX + 7));
    hub.publish("inflight", "inflight", { changed: true });
    expect(events(blocks.text).map((x) => x[1])).toEqual(["block"]);
    const t = events(txs.text)[0]![2];
    expect(t.hashes).toHaveLength(TXS_MAX);
    expect(t.more).toBe(true);
    expect(events(other.text).map((x) => [x[0], x[1]])).toEqual([[null, "inflight"]]);
  });

  it("resumes after Last-Event-ID from the buffer, in order, and then goes on live", () => {
    const hub = createStreamHub();
    for (let n = 1; n <= 5; n++) hub.publishBlock(block(n), hashes(1));
    const c = client();
    hub.attach("x", new Set<Topic>(["blocks"]), 3, c);
    expect(events(c.text).map((x) => x[0])).toEqual(["4", "5"]);
    hub.publishBlock(block(6), []);
    expect(events(c.text).map((x) => x[0])).toEqual(["4", "5", "6"]);
    // A client that is current gets nothing old; one ahead of the instance gets nothing either.
    const current = client(), ahead = client();
    hub.attach("y", all, 6, current);
    hub.attach("z", all, 99, ahead);
    expect(current.text).toBe("");
    expect(ahead.text).toBe("");
  });

  it("cuts a client whose backlog is over the bound after a resume replay, and frees its slot", () => {
    const hub = createStreamHub();
    for (let n = 1; n <= 5; n++) hub.publishBlock(block(n), hashes(1));
    const slow = client(10 * (1 << 20));
    expect(hub.attach("s", all, 0, slow).ok).toBe(true);
    expect(slow.ended).toBe(true);
    expect(hub.count()).toBe(0);
  });

  it("keeps the newest 100 blocks, and a seeded buffer resumes a client without telling anyone", () => {
    const hub = createStreamHub();
    const live = client();
    hub.attach("l", all, null, live);
    hub.seed(Array.from({ length: BUFFER_BLOCKS + 20 }, (_, i) => ({ block: block(i + 1), txs: [] })));
    expect(live.text).toBe("");
    const c = client();
    hub.attach("m", new Set<Topic>(["blocks"]), 0, c);
    const ids = events(c.text).map((x) => Number(x[0]));
    expect(ids).toHaveLength(BUFFER_BLOCKS);
    expect(ids[0]).toBe(21);
    expect(ids.at(-1)).toBe(BUFFER_BLOCKS + 20);
  });

  it("does not tell a block twice, or an older one", () => {
    const hub = createStreamHub();
    const c = client();
    hub.attach("a", all, null, c);
    expect(hub.publishBlock(block(4), [])).toBe(true);
    expect(hub.publishBlock(block(4), [])).toBe(false);
    expect(hub.publishBlock(block(3), [])).toBe(false);
    expect(events(c.text)).toHaveLength(2);
  });

  it("refuses a fifth stream from one client (an IPv6 client is its /64) and one over the instance's limit, and frees a slot when one closes", () => {
    const hub = createStreamHub({ perInstance: 6 });
    const held = [1, 2, 3, 4].map(() => hub.attach("2001:db8:1:2:aaaa::1", all, null, client()));
    expect(held.every((h) => h.ok)).toBe(true);
    const fifth = hub.attach("2001:db8:1:2:bbbb:cccc:dddd:1", all, null, client());
    expect(fifth).toMatchObject({ ok: false });
    expect(hub.attach("2001:db8:1:3::1", all, null, client()).ok).toBe(true);
    if (held[0]!.ok) held[0]!.detach();
    expect(hub.attach("2001:db8:1:2::9", all, null, client()).ok).toBe(true);
    expect(hub.attach("9.9.9.9", all, null, client()).ok).toBe(true);
    expect(hub.attach("9.9.9.8", all, null, client())).toMatchObject({ ok: false }); // 6 are open: the instance is full
    expect(hub.count()).toBe(6);
  });

  it("sends a keep-alive comment and the stats event, and stops writing to a client that left", () => {
    const hub = createStreamHub({ now: () => Date.parse("2026-10-22T10:00:00Z") });
    const c = client(), gone = client();
    hub.attach("a", all, null, c);
    const g = hub.attach("b", all, null, gone);
    hub.publishBlock(block(2), []);
    if (g.ok) g.detach();
    hub.heartbeat();
    hub.stats();
    expect(c.text).toContain(": keep-alive\n\n");
    expect(events(c.text).at(-1)).toEqual([null, "stats", { finalBlock: 2, at: "2026-10-22T10:00:00.000Z" }]);
    expect(gone.text).not.toContain("keep-alive");
  });

  it("drops a client that is too slow, and one whose write fails", () => {
    const hub = createStreamHub();
    const slow = client(10 * (1 << 20)), broken: Sink = { write() { throw new Error("gone"); }, backlog: () => 0, end() { /* nothing */ } }, fine = client();
    hub.attach("s", all, null, slow);
    hub.attach("b", all, null, broken);
    hub.attach("f", all, null, fine);
    hub.publishBlock(block(1), []);
    expect(slow.ended).toBe(true);
    expect(hub.count()).toBe(1);
    hub.close();
    expect(fine.ended).toBe(true);
    expect(hub.count()).toBe(0);
  });

  it("destroys a slow client that can be destroyed, and counts it until it detaches", () => {
    const hub = createStreamHub();
    let destroyed = 0;
    const slow = { ...client(10 * (1 << 20)), destroy: () => { destroyed++; } };
    const got = hub.attach("s", all, null, slow);
    hub.publishBlock(block(1), []);
    hub.publishBlock(block(2), []);
    expect(destroyed).toBe(1);
    expect(slow.ended).toBe(false);
    expect(hub.count()).toBe(1);
    if (got.ok) got.detach();
    expect(hub.count()).toBe(0);
  });
});

describe("the request's parts", () => {
  it("reads topics, and refuses a name that is not one", () => {
    expect([...topicsOf(null)!]).toEqual(["blocks", "txs", "inflight", "stats"]);
    expect([...topicsOf("blocks,txs")!]).toEqual(["blocks", "txs"]);
    expect(topicsOf("blocks,nope")).toBeNull();
    expect(topicsOf("blocks,")).toBeNull();
  });
  it("reads Last-Event-ID as a block number only", () => {
    expect(lastIdOf("12")).toBe(12);
    expect(lastIdOf(["7"])).toBe(7);
    for (const v of [undefined, "", "-1", "1.5", "abc", "012", "99999999999999999"]) expect(lastIdOf(v)).toBeNull();
  });
  it("counts an IPv6 client by its /64", () => {
    expect(clientKey("1.2.3.4")).toBe("1.2.3.4");
    expect(clientKey("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(clientKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe(clientKey("2001:DB8:1:2::1"));
    expect(clientKey("2001:db8:1:2::1")).not.toBe(clientKey("2001:db8:1:3::1"));
    expect(clientKey("::1")).toBe("0000:0000:0000:0000::/64");
  });
});
