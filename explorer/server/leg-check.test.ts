import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createLegCheck, type CheckedCall } from "./leg-check.ts";

const CALL: CheckedCall = { from: "0x" + "a1".repeat(20), to: "0x" + "c9".repeat(20), data: "0x1234", value: "0x0", gas: "0x5208" };

let server: Server | undefined;
afterEach(async () => { await new Promise<void>((ok) => (server ? server.close(() => ok()) : ok())); server = undefined; });

/** A stand-in for the builder's service: answers each request with `answer(body)` and records what it was asked. */
async function serve(answer: (body: unknown, path: string) => { status?: number; text?: string; body?: unknown; delayMs?: number }): Promise<{ url: string; seen: { path: string; method: string; body: unknown }[] }> {
  const seen: { path: string; method: string; body: unknown }[] = [];
  server = createServer((req, res) => {
    let text = "";
    req.on("data", (c) => (text += c));
    req.on("end", () => {
      const body = text ? JSON.parse(text) : undefined;
      seen.push({ path: req.url ?? "", method: req.method ?? "", body });
      const a = answer(body, req.url ?? "");
      setTimeout(() => res.writeHead(a.status ?? 200, { "content-type": "application/json" }).end(a.text ?? JSON.stringify(a.body ?? {})), a.delayMs ?? 0);
    });
  });
  await new Promise<void>((ok) => server!.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

describe("the leg check client", () => {
  it("asks POST /v1/leg-check with the call, and returns the reason of a no", async () => {
    const s = await serve(() => ({ body: { ok: false, reason: "its deposit leg has no Canton side: x", legs: [] } }));
    expect(await createLegCheck(s.url + "/")(CALL)).toBe("its deposit leg has no Canton side: x");
    expect(s.seen).toEqual([{ path: "/v1/leg-check", method: "POST", body: CALL }]);
  });

  it("returns nothing for a yes, for a yes that says it does not know, and for an answer that is not a clear no", async () => {
    for (const body of [{ ok: true }, { ok: true, unknown: "the call does not run now" }, { ok: false }, { ok: false, reason: "" }, { ok: "no", reason: "x" }, { reason: "x" }, [], null, "text"]) {
      const s = await serve(() => ({ body }));
      expect(await createLegCheck(s.url)(CALL), JSON.stringify(body)).toBeNull();
      await new Promise<void>((ok) => server!.close(() => ok()));
      server = undefined;
    }
  });

  it("says nothing when the service is busy, fails, answers what is not JSON, is too slow or is not there", async () => {
    for (const a of [{ status: 503 }, { status: 400 }, { status: 500, body: { ok: false, reason: "x" } }, { text: "<html>" }, { delayMs: 400, body: { ok: false, reason: "x" } }]) {
      const s = await serve(() => a);
      expect(await createLegCheck(s.url, 100)(CALL)).toBeNull();
      await new Promise<void>((ok) => server!.close(() => ok()));
      server = undefined;
    }
    expect(await createLegCheck("http://127.0.0.1:1", 100)(CALL)).toBeNull();
  });

  it("keeps a reason to a sensible length", async () => {
    const s = await serve(() => ({ body: { ok: false, reason: "x".repeat(5000) } }));
    expect((await createLegCheck(s.url)(CALL))!.length).toBe(600);
  });
});
