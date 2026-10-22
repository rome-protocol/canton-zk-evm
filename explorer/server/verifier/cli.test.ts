import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

function run(env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    const p = spawn("node", ["server/verifier/cli.ts"], { env: { PATH: process.env.PATH ?? "", ...env }, cwd: new URL("../..", import.meta.url).pathname });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { out += d; });
    p.on("close", (code) => done({ code, out }));
  });
}

const digest = `busybox@sha256:${"a".repeat(64)}`;

describe("the verifier role's command", () => {
  it("refuses to start without its settings, and names the one that is missing", async () => {
    const r = await run({});
    expect(r.code).toBe(1);
    expect(r.out).toContain("SOLC_LIST_URL");
    const r2 = await run({ SOLC_LIST_URL: "https://example.invalid/list.json", OUTSIDE_USER_AGENT: "x", SOLC_CACHE_DIR: "/tmp/x", SANDBOX_IMAGE: "busybox:latest" });
    expect(r2.code).toBe(1);
    expect(r2.out).toContain("by digest");
  });

  it("refuses to start without a database setting, before it takes any job", async () => {
    const r = await run({ SOLC_LIST_URL: "https://example.invalid/list.json", OUTSIDE_USER_AGENT: "x", SOLC_CACHE_DIR: "/tmp/x", SANDBOX_IMAGE: digest });
    expect(r.code).toBe(1);
    expect(r.out).toContain("EXPLORER_DATABASE_URL");
  });
});
