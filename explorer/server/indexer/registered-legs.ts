import type { Pool } from "pg";
import type { FinalReads, FinalLog } from "./reads.ts";
import { decodeLeg, legsSlot, LEG_TOPIC } from "./legs.ts";
import { LegUndecodable } from "./errors.ts";
import { checkLegs, type Stage1Input } from "./stage1.ts";

const hex = (b: Buffer): string => "0x" + b.toString("hex");
const bytea = (h: string): Buffer => Buffer.from(h.replace(/^0x/, ""), "hex");

/** The most blocks one pass takes for one gateway, so that a gateway registered long ago is caught up over several passes and no pass holds a transaction for long. */
export const BATCH_BLOCKS = 500;

/**
 * The legs of every registered Gateway of the chain record (`canton_registry`), indexed the way the first gateway's are: for each block after the gateway's `legs_cursor` up to the newest indexed block,
 * the gateway's `Leg` logs (read back from `logs`, which stage 1 wrote for every contract) are decoded, their running hash is checked against `legs[N]` as reth stores it (C10, naming the gateway),
 * and they are written to `gateway_legs` with the gateway's address, after the block's first-gateway legs in the leg index. A leg that cannot be read is not a stop (C10 says degraded), as for the first gateway.
 * The cursor moves in the same transaction as the rows, so a pass that stops anywhere is run again from the cursor. Returns the legs written and the blocks passed over, for every gateway together.
 */
export async function registeredLegsOnce(pool: Pick<Pool, "connect" | "query">, reads: Pick<FinalReads, "storageAt">, batch = BATCH_BLOCKS): Promise<{ legs: number; blocks: number }> {
  const head = Number((await pool.query("select coalesce(max(number), 0) as n from blocks")).rows[0].n);
  const gateways = (await pool.query("select address, legs_cursor from canton_registry where kind = 'gateway' order by address")).rows as { address: Buffer; legs_cursor: string }[];
  let legs = 0, blocks = 0;
  for (const g of gateways) {
    const from = Number(g.legs_cursor), to = Math.min(head, from + batch);
    if (to <= from) continue;
    const address = hex(g.address);
    const found = (await pool.query(
      "select block_number, tx_index, log_index, topic0, data from logs where address = $1 and topic0 = $2 and block_number > $3 and block_number <= $4 order by block_number, log_index",
      [g.address, bytea(LEG_TOPIC), from, to],
    )).rows as { block_number: string; tx_index: number; log_index: number; topic0: Buffer; data: Buffer }[];
    const byBlock = new Map<number, typeof found>();
    for (const r of found) byBlock.set(Number(r.block_number), [...(byBlock.get(Number(r.block_number)) ?? []), r]);
    const decoded: { n: number; legs: Stage1Input["legs"]; hash: string | null; problem: LegUndecodable | null }[] = [];
    for (const [n, rows] of byBlock) {
      const list: Stage1Input["legs"] = [];
      let problem: LegUndecodable | null = null;
      rows.forEach((r, index) => {
        const log: FinalLog = { address, topics: [hex(r.topic0)], data: hex(r.data) };
        try {
          list.push({ leg: decodeLeg(log, n), index, txIndex: r.tx_index, logIndex: r.log_index });
        } catch (e) {
          if (!(e instanceof LegUndecodable)) throw e;
          problem ??= e;
        }
      });
      decoded.push({ n, legs: list, hash: await reads.storageAt(address, legsSlot(n), n), problem });
    }
    const c = await pool.connect();
    try {
      await c.query("begin");
      for (const d of decoded) {
        await c.query("delete from gateway_legs where block_number = $1 and gateway = $2", [d.n, g.address]);
        if (d.legs.length > 0) {
          await c.query(
            `insert into gateway_legs (block_number, leg_index, tx_index, log_index, kind, leg_id, token, account, amount, party, gateway)
             select $1::bigint, base.next + t.i, t.tx, t.log, t.kind, t.id, t.token, t.account, t.amount, t.party, $11::bytea
               from (select greatest(coalesce((select b.legs_count from blocks b where b.number = $1), 0), coalesce((select max(leg_index) + 1 from gateway_legs where block_number = $1), 0)) as next) as base,
                 unnest($2::int[], $3::int[], $4::int[], $5::smallint[], $6::bytea[], $7::bytea[], $8::bytea[], $9::numeric[], $10::text[]) as t(i, tx, log, kind, id, token, account, amount, party)`,
            [d.n, d.legs.map((l) => l.index), d.legs.map((l) => l.txIndex), d.legs.map((l) => l.logIndex), d.legs.map((l) => l.leg.kind), d.legs.map((l) => bytea(l.leg.id)),
              d.legs.map((l) => bytea(l.leg.token)), d.legs.map((l) => bytea(l.leg.account)), d.legs.map((l) => l.leg.amount.toString()), d.legs.map((l) => (l.leg.kind === 2 ? l.leg.party : null)), g.address],
          );
          legs += d.legs.length;
        }
        await checkLegs(c, d.n, d.legs, d.hash, d.problem, address);
      }
      await c.query("update canton_registry set legs_cursor = $2 where address = $1", [g.address, to]);
      await c.query("commit");
    } catch (e) {
      await c.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    blocks += to - from;
  }
  return { legs, blocks };
}
