import { describe, expect, it } from "vitest";
import { createFinalBlocks } from "./chain-db.ts";

const flush = () => new Promise<void>((ok) => setTimeout(ok, 0));
type Final = { hash: string; updateId: string };

/** A database that answers from a table the test changes, and counts the reads. */
function fakeDb(rows: Map<number, Final>) {
  const reads: number[] = [];
  return { reads, finalOf: async (n: number) => { reads.push(n); return rows.get(n); } };
}

describe("the tracker's look at final blocks", () => {
  it("answers once it has read the block, and reads it only once", async () => {
    const db = fakeDb(new Map([[5, { hash: "0xaa", updateId: "u5" }]]));
    const blocks = createFinalBlocks(db);
    expect(blocks.byNumber(5)).toBeUndefined();
    await flush();
    expect(blocks.byNumber(5)).toEqual({ hash: "0xaa", updateId: "u5" });
    expect(blocks.byNumber(5, "0xaa")).toEqual({ hash: "0xaa", updateId: "u5" });
    expect(db.reads).toEqual([5]);
  });

  it("reads a block again when the caller expects another hash: the chain was reset, or is a new one, while this process kept running", async () => {
    const rows = new Map<number, Final>([[5, { hash: "0xaa", updateId: "u5" }]]);
    const db = fakeDb(rows);
    const blocks = createFinalBlocks(db);
    blocks.byNumber(5, "0xaa");
    await flush();
    expect(blocks.byNumber(5, "0xaa")?.updateId).toBe("u5");
    // A new chain: block 5 has another hash and another update.
    rows.set(5, { hash: "0xbb", updateId: "new5" });
    expect(blocks.byNumber(5, "0xbb")).toBeUndefined(); // the old entry is dropped, never handed out for the new hash
    await flush();
    expect(blocks.byNumber(5, "0xbb")).toEqual({ hash: "0xbb", updateId: "new5" });
    expect(db.reads).toEqual([5, 5]);
  });

  it("does not read again and again for a hash that the database does not hold", async () => {
    let t = 0;
    const db = fakeDb(new Map([[5, { hash: "0xaa", updateId: "u5" }]]));
    const blocks = createFinalBlocks(db, { now: () => t, mismatchMs: 30_000 });
    for (let i = 0; i < 5; i++) { blocks.byNumber(5, "0xcc"); await flush(); t += 2000; }
    expect(db.reads.length).toBe(1);
    t += 30_000;
    blocks.byNumber(5, "0xcc");
    await flush();
    expect(db.reads.length).toBe(2);
  });
});
