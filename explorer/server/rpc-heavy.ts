/**
 * The public RPC's global limit on heavy calls. Per-client limits stop one client; this stops many clients together from
 * saturating reth with calls that cost it real work. A heavy call takes one of `concurrency` slots; when none is free it waits
 * in a queue of at most `queue` calls; when the queue is full it is refused at once, with no wait. Light calls never touch it.
 */

/**
 * The methods that run the EVM or scan a range of blocks, so one call can take reth's time for a while. Every other method in
 * PUBLIC_METHODS is a lookup (chain id, block number, balance, nonce, code, storage, gas price, a block, a transaction, a
 * receipt) or a send, and answers without waiting behind these.
 */
export const HEAVY_METHODS: ReadonlySet<string> = new Set(["eth_call", "eth_estimateGas", "eth_getLogs"]);

/** The most requests the public RPC holds at once, from all clients together; the rest get a 503. */
export const MAX_IN_FLIGHT = 64;
/** Every running or queued heavy call holds one of those places, so heavy concurrency + queue may take at most half of them: the other half is for light calls. */
export const MAX_HEAVY_PLACES = MAX_IN_FLIGHT / 2;

export const isHeavy = (method: string): boolean => HEAVY_METHODS.has(method);

export interface HeavyLimiter {
  /** A release function when the call may run (now, or after waiting in the queue); null when the queue is full. */
  acquire(): Promise<(() => void) | null>;
  /** Calls running now and waiting now. */
  stats(): { running: number; queued: number };
}

export function createHeavyLimiter(concurrency: number, queue: number): HeavyLimiter {
  let running = 0;
  const waiting: Array<(release: () => void) => void> = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next(release); // the slot passes to the oldest waiter
    else running--;
  };
  return {
    acquire() {
      if (running < concurrency) {
        running++;
        return Promise.resolve(release);
      }
      if (waiting.length >= queue) return Promise.resolve(null);
      return new Promise((resolve) => waiting.push(resolve));
    },
    stats: () => ({ running, queued: waiting.length }),
  };
}
