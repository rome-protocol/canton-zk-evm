/**
 * The two ways the indexer's work for a block does not finish.
 *
 * A stop is a fact about the data: a check failed, so the indexer stays at that block, writes the check's row of health_checks as `down`
 * and does nothing more until a person looks. A wait is a fact about timing (reth does not have the block yet) and is retried.
 */
export class IndexerStop extends Error {
  /** The row of health_checks this stop is written to: C1, C2, C3, C7, or another name for a problem no numbered check covers. */
  readonly check: string;
  readonly block: number | null;
  /** What was seen, for the check's row. */
  readonly seen: Record<string, unknown>;
  constructor(check: string, message: string, block: number | null, seen: Record<string, unknown> = {}) {
    super(message);
    this.check = check;
    this.block = block;
    this.seen = seen;
  }
}

export class RethBehind extends Error {
  readonly block: number;
  constructor(block: number, what: string) {
    super(`reth has no ${what} for block ${block} yet`);
    this.block = block;
  }
}

/** A `Leg` event of the gateway that cannot be decoded. Not a stop: the block is indexed without its legs, and C10 says `degraded`, naming the block (design section 4.5). */
export class LegUndecodable extends Error {
  readonly block: number;
  constructor(block: number, message: string) {
    super(message);
    this.block = block;
  }
}

/** A reindex holds the database: the indexer's step is not taken, and is tried again on the next turn. Not an error. */
export class Paused extends Error {
  constructor() {
    super("a reindex is running");
  }
}
