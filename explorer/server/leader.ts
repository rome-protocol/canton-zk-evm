import { Client, type ClientConfig } from "pg";

/**
 * Which API instance runs a loop that only one may run: the tracker's, or the faucet's worker. Without a database there is one
 * instance, and it leads. With one, the instance that holds the loop's advisory lock leads. The lock belongs to a connection of its
 * own, so it ends with the connection: an instance that dies, or loses its database, gives the lead up without saying so, and the
 * next instance to ask takes it.
 */
export interface Leader {
  /** True when this instance leads. Asks the database, and takes the lock if nobody holds it. Never throws: a database that cannot be reached means "not leading". */
  isLeader(): Promise<boolean>;
  /** Gives the lead up at once, so another instance does not wait for the connection to time out. */
  release(): Promise<void>;
}

export const alwaysLeader: Leader = { isLeader: async () => true, release: async () => undefined };

/** The first number of the advisory lock pair. The second says which loop. The migration runner and the partition maintenance use single-number locks, which never match a pair. */
const LOCKS = 0x45585031;
export const TRACKER_LOCK = 1;
export const FAUCET_LOCK = 2;

export function advisoryLeader(config: ClientConfig, which: number): Leader {
  let client: Client | null = null;
  let connecting: Promise<boolean> | null = null;

  const drop = (c: Client): void => {
    if (client === c) client = null;
    void c.end().catch(() => undefined);
  };

  async function take(): Promise<boolean> {
    const c = new Client(config);
    c.on("error", () => drop(c));
    try {
      await c.connect();
      const { rows } = await c.query<{ got: boolean }>("select pg_try_advisory_lock($1, $2) as got", [LOCKS, which]);
      if (rows[0]?.got) { client = c; return true; }
    } catch { /* not reachable: not leading */ }
    drop(c);
    return false;
  }

  return {
    async isLeader() {
      const held = client;
      if (held) {
        try {
          await held.query("select 1"); // the lock lives as long as this connection answers
          return client === held;
        } catch {
          drop(held);
          return false;
        }
      }
      return (connecting ??= take().finally(() => { connecting = null; }));
    },
    async release() {
      await connecting?.catch(() => undefined);
      const held = client;
      client = null;
      if (!held) return;
      await held.query("select pg_advisory_unlock($1, $2)", [LOCKS, which]).catch(() => undefined);
      await held.end().catch(() => undefined);
    },
  };
}

/** The faucet's limits are checked and a request is written in one step, behind this lock, so two instances never both take the last turn of an address. */
export const CLAIM_LOCK = 3;
export const LOCK_CLASS = LOCKS;
