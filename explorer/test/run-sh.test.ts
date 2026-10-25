import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const RUN = resolve(import.meta.dirname, "../run.sh");
// The tests job runs in the pinned Node image, which has no bash. tests/demo_explorer_static.sh runs the same checks of run.sh on the host.
const HAS_BASH = spawnSync("bash", ["-c", "true"]).status === 0;
let state: string;
beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "run-sh-"));
  mkdirSync(join(state, "canton"), { recursive: true });
  writeFileSync(join(state, "canton", "parties.env"), "READER_PARTY=reader::1220abcd\n");
  // What network/make-state.sh and network/explorer-db.sh leave in a run's state folder, as tests/demo_explorer_static.sh writes them: start needs both.
  writeFileSync(join(state, "genesis.json"), '{"alloc":{}}\n');
  writeFileSync(join(state, "explorer-db.env"), "POSTGRES_PASSWORD=x\n");
});
afterEach(() => rmSync(state, { recursive: true, force: true }));

/** The Docker command `run.sh start` would run for the explorer (the indexer's is the one before it). Nothing is run: EXPLORER_DRY_RUN=1 prints it. */
function start(env: Record<string, string> = {}): string {
  const r = spawnSync("bash", [RUN, "start"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", EXPLORER_DRY_RUN: "1", CZE_STATE_DIR: state, ...env },
  });
  expect(r.status, `${r.error ?? ""} ${r.signal ?? ""} ${r.stderr}`).toBe(0);
  return r.stdout.split("\n").find((l) => l.startsWith("docker run -d") && l.includes("--name cze-explorer ")) ?? "";
}

/** The Docker command for the indexer, the one that reads the producer's journal. */
function indexerCommand(env: Record<string, string> = {}): { cmd: string; stderr: string } {
  const r = spawnSync("bash", [RUN, "start"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", EXPLORER_DRY_RUN: "1", CZE_STATE_DIR: state, ...env },
  });
  expect(r.status, `${r.error ?? ""} ${r.signal ?? ""} ${r.stderr}`).toBe(0);
  return { cmd: r.stdout.split("\n").find((l) => l.startsWith("docker run -d") && l.includes("--name cze-explorer-indexer ")) ?? "", stderr: r.stderr };
}

describe.skipIf(!HAS_BASH)("explorer/run.sh start", () => {
  it("gives the indexer the producer's work folder read-only, with its journal and status file named, when the folder is there", () => {
    mkdirSync(join(state, "builder"));
    const { cmd, stderr } = indexerCommand();
    expect(cmd).toContain(` -v ${join(state, "builder")}:/run/explorer/producer:ro`);
    expect(cmd).toContain(" -e JOURNAL_DIR=/run/explorer/producer/journal");
    expect(cmd).toContain(" -e PRODUCER_STATUS_FILE=/run/explorer/producer/status.json");
    expect(stderr).not.toContain("producer work folder");
    // CZE_WORK_DIR names another folder, as it does for the builder
    const other = mkdtempSync(join(tmpdir(), "run-sh-work-"));
    try {
      expect(indexerCommand({ CZE_WORK_DIR: other }).cmd).toContain(` -v ${other}:/run/explorer/producer:ro`);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("gives the indexer, and only the indexer, the gateway party and its token file for the custody read, the file mounted read-only and its value never on the command", () => {
    const file = join(state, "gateway.token");
    writeFileSync(file, "tok.secret-value-for-the-test\n", { mode: 0o600 });
    const env = { GATEWAY_PARTY: "gateway::1220cd", GATEWAY_LEDGER_TOKEN_FILE: file, CUSTODY_MS: "5000", CUSTODY_LIMIT: "150" };
    const cmd = indexerCommand(env).cmd;
    expect(cmd).toContain(" -e GATEWAY_PARTY=gateway::1220cd");
    expect(cmd).toContain(` -v ${file}:/run/explorer/gateway-ledger-token:ro -e GATEWAY_LEDGER_TOKEN_FILE=/run/explorer/gateway-ledger-token`);
    expect(cmd).toContain(" -e CUSTODY_MS=5000");
    expect(cmd).toContain(" -e CUSTODY_LIMIT=150");
    expect(cmd).not.toContain("secret-value");
    // Neither is set for the explorer's own container, which never reads as the gateway.
    expect(start(env)).not.toContain("GATEWAY_PARTY");
    expect(start(env)).not.toContain("gateway.token");
    expect(start(env)).not.toContain("gateway-ledger-token");
    expect(indexerCommand().cmd).not.toContain("GATEWAY_PARTY");
  });

  it("mounts the gateway's token under a name of its own, so a reader's token file of the same name cannot take its place", () => {
    const a = join(state, "reader"), b = join(state, "gateway");
    mkdirSync(a); mkdirSync(b);
    writeFileSync(join(a, "token"), "tok.reader\n", { mode: 0o600 });
    writeFileSync(join(b, "token"), "tok.gateway\n", { mode: 0o600 });
    const cmd = indexerCommand({ LEDGER_TOKEN_FILE: join(a, "token"), GATEWAY_PARTY: "gateway::1220cd", GATEWAY_LEDGER_TOKEN_FILE: join(b, "token") }).cmd;
    const mounts = [...cmd.matchAll(/ -v \S+:(\/run\/explorer\/\S+):ro/g)].map((m) => m[1]);
    expect(mounts).toContain("/run/explorer/token");
    expect(mounts).toContain("/run/explorer/gateway-ledger-token");
    expect(new Set(mounts).size).toBe(mounts.length);
  });

  it("starts the indexer without a journal, and says so, when the producer has no work folder", () => {
    const { cmd, stderr } = indexerCommand();
    expect(cmd).not.toContain("JOURNAL_DIR");
    expect(cmd).not.toContain("/run/explorer/producer");
    expect(stderr).toContain("no producer work folder");
  });

  it("passes the public RPC's and the tracker's settings to the container when they are set", () => {
    const cmd = start({
      PUBLIC_RPC: "1", RPC_RATE_PER_MINUTE: "120", RPC_HEAVY_CONCURRENCY: "6", RPC_HEAVY_QUEUE: "10", TRUSTED_IP_HEADER: "x-real-ip", TRACKER_MAX: "500", TRACKER_MAX_BYTES: "4096", TRACKER_PER_SENDER: "8", TRACKER_MAX_PENDING_MINUTES: "30",
    });
    for (const flag of ["PUBLIC_RPC=1", "RPC_RATE_PER_MINUTE=120", "RPC_HEAVY_CONCURRENCY=6", "RPC_HEAVY_QUEUE=10", "TRUSTED_IP_HEADER=x-real-ip", "TRACKER_MAX=500", "TRACKER_MAX_BYTES=4096", "TRACKER_PER_SENDER=8", "TRACKER_MAX_PENDING_MINUTES=30"]) {
      expect(cmd).toContain(` -e ${flag}`);
    }
  });

  it("leaves them out when they are not set, so the explorer's own defaults and the RPC being off stand", () => {
    const cmd = start();
    for (const name of ["PUBLIC_RPC", "RPC_RATE_PER_MINUTE", "RPC_HEAVY_CONCURRENCY", "RPC_HEAVY_QUEUE", "TRUSTED_IP_HEADER", "TRACKER_MAX", "TRACKER_MAX_BYTES", "TRACKER_PER_SENDER", "TRACKER_MAX_PENDING_MINUTES"]) {
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

  it("starts no verifier unless EXPLORER_VERIFIER=1, and stops one that an earlier run left", () => {
    const r = spawnSync("bash", [RUN, "start"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", EXPLORER_DRY_RUN: "1", CZE_STATE_DIR: state, SOLC_LIST_URL: "https://lists.example/list.json" } });
    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.split("\n");
    expect(lines.some((l) => l.includes("server/verifier/cli.ts"))).toBe(false);
    expect(lines).toContain("docker stop -t 90 cze-explorer-verifier");
  });

  it("starts the verifier with the pinned image, its own cache folder, the Docker program and socket, and the project's contact, when EXPLORER_VERIFIER=1", () => {
    const r = spawnSync("bash", [RUN, "start"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", EXPLORER_DRY_RUN: "1", CZE_STATE_DIR: state, EXPLORER_VERIFIER: "1", SOLC_LIST_URL: "https://lists.example/list.json", SOLC_TIMEOUT_MS: "30000", EXPLORER_DB_HOST: "10.1.2.3" },
    });
    expect(r.status, r.stderr).toBe(0);
    const cmd = r.stdout.split("\n").find((l) => l.includes("--name cze-explorer-verifier ")) ?? "";
    const pins = Object.fromEntries(readFileSync(resolve(import.meta.dirname, "../../PINS"), "utf8").split("\n").filter((l) => /^[A-Z_0-9]+=/.test(l)).map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1)]));
    expect(cmd).toContain("--read-only");
    expect(cmd).toContain("--cap-drop ALL");
    expect(cmd).toContain(" --group-add ");
    expect(cmd).toContain(" -v /var/run/docker.sock:/var/run/docker.sock");
    expect(cmd).toContain(` -v ${join(state, "explorer-verifier", "bin", "docker")}:/usr/local/bin/docker:ro`);
    expect(cmd).toContain(` -v ${join(state, "explorer-verifier", "solc")}:${join(state, "explorer-verifier", "solc")}`);
    expect(cmd).toContain(` -e SOLC_CACHE_DIR=${join(state, "explorer-verifier", "solc")}`);
    expect(cmd).toContain(` -e SANDBOX_IMAGE=${pins.SOLC_SANDBOX_IMAGE}`);
    expect(cmd).toContain(" -e SOLC_LIST_URL=https://lists.example/list.json");
    expect(cmd).toContain(" -e OUTSIDE_USER_AGENT=Rome Protocol rome@romeprotocol.com");
    expect(cmd).toContain(" -e SOLC_TIMEOUT_MS=30000");
    // the gateway's source is seeded by the operator's verifier: its address and compiler from PINS, its source from the image
    expect(cmd).toContain(` -e GATEWAY_ADDRESS=${pins.GATEWAY_ADDRESS}`);
    expect(cmd).toContain(" -e GATEWAY_SOURCE_FILE=/repo/gateway/Gateway.sol");
    expect(cmd).toContain(` -e GATEWAY_COMPILER=${pins.SOLC_VERSION}`);
    expect(cmd).toContain(" -e EXPLORER_DB_HOST=10.1.2.3");
    expect(cmd.trim().endsWith("node server/verifier/cli.ts")).toBe(true);
    // the old verifier is stopped before the new one starts
    const lines = r.stdout.split("\n");
    expect(lines.indexOf("docker stop -t 60 cze-explorer-verifier")).toBeLessThan(lines.indexOf(cmd));
  });

  it("refuses to start the verifier without the compiler list's address", () => {
    const r = spawnSync("bash", [RUN, "start"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", EXPLORER_DRY_RUN: "1", CZE_STATE_DIR: state, EXPLORER_VERIFIER: "1" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("SOLC_LIST_URL");
  });

  it("stops the old container gracefully before it starts the new one, never with rm -f (SIGKILL)", () => {
    const r = spawnSync("bash", [RUN, "start"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", EXPLORER_DRY_RUN: "1", CZE_STATE_DIR: state },
    });
    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.split("\n").filter((l) => l.startsWith("docker "));
    const stopAt = lines.findIndex((l) => /^docker stop -t 30 /.test(l));
    const runAt = lines.findIndex((l) => l.startsWith("docker run -d") && l.includes("--name cze-explorer "));
    expect(stopAt).toBeGreaterThanOrEqual(0);
    expect(stopAt).toBeLessThan(runAt);
    expect(lines.some((l) => /^docker rm /.test(l) && !/ -f/.test(l))).toBe(true);
    expect(lines.some((l) => /^docker rm .*-f/.test(l))).toBe(false);
  });
});

describe.skipIf(!HAS_BASH)("explorer/run.sh stop", () => {
  const stop = () =>
    spawnSync("bash", [RUN, "stop"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", EXPLORER_DRY_RUN: "1", CZE_STATE_DIR: state },
    });

  it("lets the explorer and the indexer finish (docker stop -t 30), then removes the containers without -f", () => {
    const r = stop();
    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.split("\n").filter((l) => l.startsWith("docker "));
    expect(lines).toEqual(["docker stop -t 30 cze-explorer", "docker rm cze-explorer", "docker stop -t 30 cze-explorer-indexer", "docker rm cze-explorer-indexer", "docker stop -t 90 cze-explorer-verifier", "docker rm cze-explorer-verifier"]);
  });

  it("removes the database it started when the network is not persistent, and keeps it when the network is", () => {
    expect(stop().stdout).toContain("network/explorer-db.sh wipe");
    writeFileSync(join(state, "persist.env"), "CZE_PERSIST=1\n");
    expect(stop().stdout).not.toContain("explorer-db.sh wipe");
  });
});
