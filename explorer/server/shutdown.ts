/**
 * On SIGTERM or SIGINT: stop taking new work, write the tracker's list, then leave. Without this the process would exit while
 * the last write was still waiting, and the transactions accepted just before a stop would be missing after the restart.
 */
export interface ShutdownParts {
  /** Stops what runs on a timer. */
  stop: Array<() => void>;
  server: { close(): unknown; closeIdleConnections?(): void };
  tracker: { flush(): Promise<void> };
  /** Others with something to write before the exit, such as the faucet's limits and waiting requests. */
  also?: Array<{ flush(): Promise<void> }>;
  process?: Pick<NodeJS.Process, "on">;
  exit?: (code: number) => void;
}

/** Returns the handler too, so a test can call it without sending a signal. */
export function onShutdown(p: ShutdownParts): (signal: string) => Promise<void> {
  const exit = p.exit ?? ((c: number) => process.exit(c));
  let leaving: Promise<void> | undefined;
  const leave = (signal: string): Promise<void> => (leaving ??= (async () => {
    console.log(`explorer: ${signal}, writing what it keeps before it stops`);
    for (const stop of p.stop) stop();
    p.server.close();
    p.server.closeIdleConnections?.();
    try {
      await Promise.all([p.tracker, ...(p.also ?? [])].map((w) => w.flush()));
    } finally {
      exit(0);
    }
  })());
  const on = p.process ?? process;
  on.on("SIGTERM", () => void leave("SIGTERM"));
  on.on("SIGINT", () => void leave("SIGINT"));
  return leave;
}
