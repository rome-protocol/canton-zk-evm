import { describe, expect, it, vi } from "vitest";
import { onShutdown } from "./shutdown.ts";

function parts() {
  const log: string[] = [];
  const handlers = new Map<string, () => void>();
  let release!: () => void;
  const written = new Promise<void>((ok) => { release = ok; });
  return {
    log, handlers, release,
    p: {
      stop: [() => log.push("timer stopped")],
      server: { close: () => log.push("server closed"), closeIdleConnections: () => log.push("idle closed") },
      tracker: { flush: () => { log.push("flush asked"); return written.then(() => { log.push("flushed"); }); } },
      process: { on: (signal: string, h: () => void) => { handlers.set(signal, h); return process; } } as never,
      exit: (code: number) => log.push(`exit ${code}`),
    },
  };
}

describe("the shutdown", () => {
  it("stops the server, waits for the tracker's last write, and only then exits", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { p, log, handlers, release } = parts();
    onShutdown(p);
    expect([...handlers.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
    handlers.get("SIGTERM")!();
    await new Promise((ok) => setTimeout(ok, 20));
    expect(log).toEqual(["timer stopped", "server closed", "idle closed", "flush asked"]); // not gone yet
    release();
    await new Promise((ok) => setTimeout(ok, 20));
    expect(log.slice(-2)).toEqual(["flushed", "exit 0"]);
    vi.restoreAllMocks();
  });

  it("does the work once when a second signal comes", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { p, log, handlers, release } = parts();
    onShutdown(p);
    handlers.get("SIGINT")!();
    handlers.get("SIGTERM")!();
    release();
    await new Promise((ok) => setTimeout(ok, 20));
    expect(log.filter((l) => l === "flush asked")).toHaveLength(1);
    expect(log.filter((l) => l.startsWith("exit"))).toEqual(["exit 0"]);
    vi.restoreAllMocks();
  });

  it("still exits when the write fails", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { p, log } = parts();
    p.tracker.flush = () => Promise.reject(new Error("disk"));
    const leave = onShutdown(p);
    await leave("SIGTERM").catch(() => {});
    expect(log.at(-1)).toBe("exit 0");
    vi.restoreAllMocks();
  });

  it("also waits for the faucet's last write", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { p, log, handlers, release } = parts();
    let faucetDone = false;
    onShutdown({ ...p, also: [{ flush: async () => { await new Promise((ok) => setTimeout(ok, 30)); faucetDone = true; log.push("faucet written"); } }] });
    handlers.get("SIGINT")!();
    release();
    await new Promise((ok) => setTimeout(ok, 10));
    expect(log).not.toContain("exit 0");
    await new Promise((ok) => setTimeout(ok, 60));
    expect(faucetDone).toBe(true);
    expect(log.at(-1)).toBe("exit 0");
  });
});
