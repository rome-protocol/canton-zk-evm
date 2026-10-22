/**
 * What the indexer tells the API instances (design 6.4): one channel, and a short text for each thing that happened. It is sent with
 * `pg_notify` inside the transaction that wrote it, so it is delivered when that transaction commits and never for one that rolls back.
 * A notification carries no data, only where to look: the API reads the block from the database.
 */
export const CHANNEL = "explorer_events";

/** `final:<n>` when stage 1 has written block n, `derived:<n>` when stage 2 has, and `inflight` when the producer's journal has new lines. */
export type Event = { kind: "final" | "derived"; number: number } | { kind: "inflight" };

export const textOf = (e: Event): string => (e.kind === "inflight" ? "inflight" : `${e.kind}:${e.number}`);

/** The event a notification's text names, or null for any other text (a stray NOTIFY on the channel is ignored, never trusted). */
export function parseEvent(text: string | undefined): Event | null {
  if (text === "inflight") return { kind: "inflight" };
  const m = /^(final|derived):(0|[1-9][0-9]{0,15})$/.exec(text ?? "");
  const number = m ? Number(m[2]) : NaN;
  return m && Number.isSafeInteger(number) ? { kind: m[1] as "final" | "derived", number } : null;
}

/** Anything that can run a query: a pool, or the client of an open transaction. */
export interface Queryable { query(text: string, values?: unknown[]): Promise<unknown> }

export async function notify(db: Queryable, e: Event): Promise<void> {
  await db.query("select pg_notify($1, $2)", [CHANNEL, textOf(e)]);
}
