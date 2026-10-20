import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const RUN = resolve(import.meta.dirname, "../run.sh");
let state: string;
beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "run-sh-"));
  mkdirSync(join(state, "canton"), { recursive: true });
  writeFileSync(join(state, "canton", "parties.env"), "READER_PARTY=reader::1220abcd\n");
});
afterEach(() => rmSync(state, { recursive: true, force: true }));

/** The Docker command `run.sh start` would run. Nothing is run: EXPLORER_DRY_RUN=1 prints it. */
function start(env: Record<string, string> = {}): string {
  const r = spawnSync("bash", [RUN, "start"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", EXPLORER_DRY_RUN: "1", CZE_STATE_DIR: state, ...env },
  });
  expect(r.status, `${r.error ?? ""} ${r.signal ?? ""} ${r.stderr}`).toBe(0);
  return r.stdout.split("\n").find((l) => l.startsWith("docker run -d")) ?? "";
}

// The tests run in the pinned Node image, which has no bash. Where bash is missing the checks are skipped here, and tests/demo_explorer_static.sh runs the same dry runs on a host that has it.
const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;

describe.skipIf(!hasBash)("explorer/run.sh start", () => {
  it("passes the public RPC's and the tracker's settings to the container when they are set", () => {
    const cmd = start({
      PUBLIC_RPC: "1", RPC_RATE_PER_MINUTE: "120", TRUSTED_IP_HEADER: "x-real-ip", TRACKER_MAX: "500", TRACKER_MAX_BYTES: "4096", TRACKER_PER_SENDER: "8",
    });
    for (const flag of ["PUBLIC_RPC=1", "RPC_RATE_PER_MINUTE=120", "TRUSTED_IP_HEADER=x-real-ip", "TRACKER_MAX=500", "TRACKER_MAX_BYTES=4096", "TRACKER_PER_SENDER=8"]) {
      expect(cmd).toContain(` -e ${flag}`);
    }
  });

  it("leaves them out when they are not set, so the explorer's own defaults and the RPC being off stand", () => {
    const cmd = start();
    for (const name of ["PUBLIC_RPC", "RPC_RATE_PER_MINUTE", "TRUSTED_IP_HEADER", "TRACKER_MAX", "TRACKER_MAX_BYTES", "TRACKER_PER_SENDER"]) {
      expect(cmd).not.toContain(`-e ${name}=`);
    }
  });

  it("keeps the filesystem read-only and gives the tracker one writable folder in the state, with TRACKER_FILE inside it", () => {
    const cmd = start();
    expect(cmd).toContain("--read-only");
    expect(cmd).toContain(` -v ${state}/explorer:/var/lib/explorer `);
    expect(cmd).toContain(" -e TRACKER_FILE=/var/lib/explorer/tracker.json");
    expect(cmd).not.toContain(":ro -e TRACKER_FILE"); // not a read-only mount
    expect(existsSync(join(state, "explorer"))).toBe(false); // a dry run makes nothing
  });

  it("takes the caller's TRACKER_FILE when one is given", () => {
    expect(start({ TRACKER_FILE: "/var/lib/explorer/list.json" })).toContain(" -e TRACKER_FILE=/var/lib/explorer/list.json");
  });

  it("stops the old container gracefully before it starts the new one, never with rm -f (SIGKILL)", () => {
    const r = spawnSync("bash", [RUN, "start"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", EXPLORER_DRY_RUN: "1", CZE_STATE_DIR: state },
    });
    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.split("\n").filter((l) => l.startsWith("docker "));
    const stopAt = lines.findIndex((l) => /^docker stop -t 30 /.test(l));
    const runAt = lines.findIndex((l) => l.startsWith("docker run -d"));
    expect(stopAt).toBeGreaterThanOrEqual(0);
    expect(stopAt).toBeLessThan(runAt);
    expect(lines.some((l) => /^docker rm /.test(l) && !/ -f/.test(l))).toBe(true);
    expect(lines.some((l) => /^docker rm .*-f/.test(l))).toBe(false);
  });
});

describe.skipIf(!hasBash)("explorer/run.sh stop", () => {
  it("lets the explorer finish (docker stop -t 30), then removes the container without -f", () => {
    const r = spawnSync("bash", [RUN, "stop"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", EXPLORER_DRY_RUN: "1", CZE_STATE_DIR: state },
    });
    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.split("\n").filter((l) => l.startsWith("docker "));
    expect(lines).toEqual(["docker stop -t 30 cze-explorer", "docker rm cze-explorer"]);
  });
});
