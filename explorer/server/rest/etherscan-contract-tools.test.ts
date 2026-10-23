import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createApi } from "../api.ts";
import { createChainDb } from "../chain-db.ts";
import { loadConfig } from "../config.ts";
import { migrate } from "../db/migrate.ts";
import { TEST_URL, checkRequired, makeDatabase, type TestDatabase } from "../db/testing.ts";
import { createHttpServer } from "../http.ts";
import { createIndexer } from "../indexer/indexer.ts";
import { createPublicRpc } from "../public-rpc.ts";
import type { Reth } from "../reth.ts";
import { CHAIN_ID, GATEWAY, PINS, makeChain } from "../../test/synthetic-chain.ts";
import { startFakeReth, type FakeReth } from "../../test/fake-reth.ts";
import { CompilerStore } from "../verifier/compilers.ts";
import { FakeMirror } from "../verifier/fake-mirror.ts";
import { createVerifyApi } from "../verifier/api.ts";
import { JobQueue } from "../verifier/jobs.ts";
import { DockerSandbox } from "../verifier/sandbox.ts";
import { SolcRunner } from "../verifier/solc.ts";
import { Verifier } from "../verifier/verify.ts";
import { addContract, fakeProbe } from "../verifier/verify-fixtures.ts";
import { VerifierWorker } from "../verifier/worker.ts";
import { createEtherscanRest } from "./etherscan-rest.ts";

/**
 * The tools that people point at an Etherscan API to verify a contract and to read its source, against the contract module of a server built here: the real HTTP
 * server, the real Etherscan door with its real verifier (the real compiler, in the real sandbox, a worker taking the jobs from the database), over a database. The
 * chain is made from each tool's own build: the code its compile wrote is what "is deployed" (with the constructor's argument after the creation code), and a fake reth
 * answers the tools' `eth_getCode` as a deployed chain does. Foundry's `forge verify-contract` (standard JSON, and flattened to one file), Hardhat's `hardhat verify`, and
 * `cast source` and `cast interface` are run as they are.
 *
 * Needs the database, Docker with the pinned sandbox image, and the compiler (EXPLORER_TEST_SOLC, the static solc 0.8.28 that the sandbox runs). The tools: Foundry's release
 * that tests/FOUNDRY pins (EXPLORER_TEST_FORGE and EXPLORER_TEST_CAST name its programs; without them these tests are skipped), and the Hardhat that explorer/clients/hardhat's
 * lockfile pins (`npm ci` there). EXPLORER_TEST_TOOLS_SOLC is the compiler the tools themselves run, when EXPLORER_TEST_SOLC does not run on this machine (the sandbox's is
 * a Linux program): the same release, so the same code. EXPLORER_TEST_REQUIRE_CLIENTS=1 makes a missing piece a failure.
 */
const root = resolve(import.meta.dirname, "../../..");
const pinned = (file: string, key: string): string => new RegExp(`^${key}=(\\S+)$`, "m").exec(readFileSync(join(root, file), "utf8"))![1]!;
const IMAGE = pinned("PINS", "SOLC_SANDBOX_IMAGE");
const FOUNDRY = pinned("tests/FOUNDRY", "FOUNDRY_VERSION").replace(/^v/, "");
const SOLC = process.env.EXPLORER_TEST_SOLC ?? join(root, "state/solc-0.8.28/solc");
const TOOLS_SOLC = process.env.EXPLORER_TEST_TOOLS_SOLC ?? SOLC;
const VERSION = "0.8.28+commit.7893614a";
const HARDHAT_DIR = join(root, "explorer/clients/hardhat");
const FIXTURE = join(HARDHAT_DIR, "contracts/Box.sol");

const attempt = (cmd: string, args: string[]): string | null => { try { return execFileSync(cmd, args, { stdio: "pipe", timeout: 20_000 }).toString(); } catch { return null; } };
const foundryTool = (path: string | undefined, name: string): string | null => (path && attempt(path, ["--version"])?.includes(`${name} Version: ${FOUNDRY}`) ? path : null);
const FORGE = foundryTool(process.env.EXPLORER_TEST_FORGE, "forge");
const CAST = foundryTool(process.env.EXPLORER_TEST_CAST, "cast");
const HARDHAT = existsSync(join(HARDHAT_DIR, "node_modules/.bin/hardhat")) ? join(HARDHAT_DIR, "node_modules/.bin/hardhat") : null;
// The script of tests/demo_etherscan_contract.sh needs bash, jq and curl: the CI job runs these tests in the alpine Node image, which has none of them, so there the
// rehearsal (tests/demo_rehearsal.sh, which runs the script on the runner) is what runs it.
const HAVE_SHELL = ["bash", "jq", "curl"].every((c) => attempt(c, ["--version"]) !== null);
const haveDocker = attempt("docker", ["image", "inspect", "--format", "{{.Id}}", IMAGE]) !== null;
const ready = Boolean(TEST_URL) && haveDocker && existsSync(SOLC) && existsSync(TOOLS_SOLC);
const require = process.env.EXPLORER_TEST_REQUIRE_CLIENTS === "1";
if (require && !(ready && FORGE && CAST && HARDHAT)) {
  const missing = [["the database", Boolean(TEST_URL)], ["Docker with the pinned sandbox image", haveDocker], ["EXPLORER_TEST_SOLC", existsSync(SOLC) && existsSync(TOOLS_SOLC)], ["the pinned forge", Boolean(FORGE)], ["the pinned cast", Boolean(CAST)], ["Hardhat (npm ci in explorer/clients/hardhat)", Boolean(HARDHAT)]].filter(([, ok]) => !ok).map(([n]) => n);
  throw new Error(`this run needs the database, Docker with the pinned sandbox image, EXPLORER_TEST_SOLC, the pinned Foundry (EXPLORER_TEST_FORGE and EXPLORER_TEST_CAST) and Hardhat (npm ci in explorer/clients/hardhat); missing: ${missing.join(", ")}`);
}
checkRequired();

const BOX = readFileSync(FIXTURE, "utf8");
const ARG = 42;
const ARG_HEX = ARG.toString(16).padStart(64, "0");
const address = (n: number): string => "0x" + n.toString(16).padStart(2, "0").repeat(20);

interface Ran { code: number; out: string }
const run = (cmd: string, args: string[], opts: { cwd: string; env?: Record<string, string> }): Promise<Ran> => new Promise((done) => {
  execFile(cmd, args, { cwd: opts.cwd, env: { PATH: process.env.PATH ?? "", ...opts.env }, timeout: 200_000, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
    done({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: `${stdout}${stderr}` });
  });
});

describe.skipIf(!ready || !(FORGE || HARDHAT))("Foundry and Hardhat against the Etherscan door's contract module", { timeout: 300_000 }, () => {
  let db: TestDatabase, pool: Pool, dir: string, base = "", reth: FakeReth, server: ReturnType<typeof createHttpServer>;
  const mirror = new FakeMirror();
  const codes = new Map<string, string>();
  const stop = new AbortController();
  let working: Promise<void>;

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "etherscan-tools-")));
    await mirror.start();
    mirror.entries = [{ longVersion: VERSION, body: readFileSync(SOLC) }];
    const runner = new SolcRunner(
      new CompilerStore({ listUrl: mirror.url, userAgent: "Test test@example.invalid", cacheDir: join(dir, "cache") }),
      new DockerSandbox({ image: IMAGE, namePrefix: `explorer-tools-test-${randomBytes(4).toString("hex")}`, timeoutMs: 200_000 }),
    );
    db = await makeDatabase();
    pool = db.pool;
    await migrate(pool);
    // Blocks and transactions for the contracts' creations to point at.
    const chain = makeChain([{ txs: 0 }, { txs: 5, leg: 2 }, { txs: 7 }]);
    const indexer = createIndexer({ pool, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline" });
    await indexer.open();
    try { await indexer.runOnce(); } finally { await indexer.close(); }

    reth = await startFakeReth({
      eth_getCode: (p: unknown[]) => codes.get(String(p[0]).toLowerCase()) ?? "0x",
      eth_chainId: "0x" + CHAIN_ID.toString(16),
      eth_getBlockByNumber: () => null,
    });
    const rpc = createPublicRpc({ rethUrl: reth.url, timeoutMs: 5000, chainId: CHAIN_ID, ratePerMinute: 100000, finalizedTtlMs: 0, tracker: { admit: () => null, track: () => undefined } });
    const settings = `programVK=${PINS.programVK}\nrootC=${PINS.rootC}\n`;
    const config = loadConfig({ READER_PARTY: "reader::1220" + "11".repeat(32), PINS_FILE: "pins.txt" }, () => settings);
    const api = createApi({
      config, reth: {} as unknown as Reth, ledger: { ledgerEnd: async () => 1 } as never, chain: createChainDb(pool), etherscanRest: createEtherscanRest(pool), rpc,
      verify: createVerifyApi({ pool, queue: new JobQueue(pool), clientHash: (c) => c.padEnd(64, "0").slice(0, 64), probe: fakeProbe().probe }),
    });
    server = createHttpServer(api, "/nonexistent", { handler: rpc, ipHeader: null });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const worker = new VerifierWorker(pool, new JobQueue(pool), new Verifier(pool, runner), { cacheUsable: async () => null, pollMs: 100, healthMs: 1000, log: () => undefined });
    working = worker.run(stop.signal);
    // The API answers a submission only while the role's health row is fresh.
    for (let i = 0; i < 100; i++) {
      const { rows } = await pool.query("select 1 from health_checks where check_id = 'verifier/compilers' and checked_at > now() - interval '30 seconds'");
      if (rows.length) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  });
  afterAll(async () => {
    stop.abort();
    await working;
    await reth?.close();
    await new Promise((ok) => (server ? server.close(ok) : ok(null)));
    await db?.drop();
    await mirror.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** "Deploys" what a tool's compile made: the creation code with the argument after it, and the runtime code. */
  async function deployed(at: string, creation: string, runtime: string): Promise<void> {
    const strip = (h: string): string => h.replace(/^0x/, "");
    await addContract(pool, at, Buffer.from(strip(runtime), "hex"), Buffer.from(strip(creation) + ARG_HEX, "hex"));
    codes.set(at, "0x" + strip(runtime));
  }
  const door = async (query: string): Promise<{ status: string; message: string; result: any }> => (await fetch(`${base}/api?${query}`)).json() as never; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** The door's own record of a verified contract, as a client reads it. */
  async function expectVerified(at: string): Promise<void> {
    const r = await door(`module=contract&action=getsourcecode&address=${at}`);
    expect(r).toMatchObject({ status: "1", message: "OK" });
    expect(r.result[0]).toMatchObject({ ContractName: "Box", CompilerVersion: `v${VERSION}`, OptimizationUsed: "1", Runs: "200", ConstructorArguments: ARG_HEX, Proxy: "0" });
    expect(r.result[0].SourceCode).toContain("contract Box");
    expect(JSON.parse(r.result[0].ABI).map((e: { name?: string }) => e.name)).toEqual(expect.arrayContaining(["set", "value"]));
    expect((await door(`module=contract&action=getabi&address=${at}`)).status).toBe("1");
  }

  describe.skipIf(!FORGE || !CAST)("Foundry", () => {
    let project = "";
    let artifact: { bytecode: { object: string }; deployedBytecode: { object: string } };
    const env = () => ({ HOME: join(project, "home"), FOUNDRY_DISABLE_NIGHTLY_WARNING: "1", NO_COLOR: "1" });
    // cast does not know this chain: `source` is told where the explorer's API and its pages are, `interface` has no such flags and reads foundry.toml's [etherscan] table.
    const where = (): string[] => ["--chain", String(CHAIN_ID), "--etherscan-api-key", "any"];
    const explorer = (): string[] => ["--explorer-api-url", `${base}/api`, "--explorer-url", base];
    const verifyArgs = (at: string, extra: string[]): string[] => [
      "verify-contract", at, "src/Box.sol:Box", "--chain", String(CHAIN_ID), "--verifier", "etherscan", "--verifier-url", `${base}/api`, "--etherscan-api-key", "any",
      "--constructor-args", ARG_HEX, "--rpc-url", `${base}/rpc`, "--compiler-version", VERSION, "--num-of-optimizations", "200", "--watch", ...extra,
    ];

    beforeAll(async () => {
      project = join(dir, "forge");
      mkdirSync(join(project, "src"), { recursive: true });
      mkdirSync(join(project, "home"));
      // `--flatten` compiles the flattened file once itself, with the compiler that svm keeps for the version: this one, so that nothing is downloaded (a downloaded
      // glibc build does not run in the alpine Node image).
      mkdirSync(join(project, "home/.svm/0.8.28"), { recursive: true });
      symlinkSync(TOOLS_SOLC, join(project, "home/.svm/0.8.28/solc-0.8.28"));
      writeFileSync(join(project, "src/Box.sol"), BOX);
      writeFileSync(join(project, "foundry.toml"), [
        "[profile.default]", 'src = "src"', 'out = "out"', "libs = []", `solc = "${TOOLS_SOLC}"`, "auto_detect_solc = false", "optimizer = true", "optimizer_runs = 200", 'evm_version = "cancun"',
        "", "[etherscan]", `ostia = { key = "any", chain = ${CHAIN_ID}, url = "${base}/api" }`, "",
      ].join("\n"));
      const built = await run(FORGE!, ["build"], { cwd: project, env: env() });
      expect(built.code, built.out).toBe(0);
      artifact = JSON.parse(readFileSync(join(project, "out/Box.sol/Box.json"), "utf8"));
    });

    it("forge verify-contract with --verifier etherscan, in the standard JSON format, and the verifier says Pass", async () => {
      const at = address(0xa1);
      await deployed(at, artifact.bytecode.object, artifact.deployedBytecode.object);
      const r = await run(FORGE!, verifyArgs(at, []), { cwd: project, env: env() });
      expect(r.code, r.out).toBe(0);
      expect(r.out).toMatch(/verified/i);
      await expectVerified(at);
      expect((await door(`module=contract&action=getsourcecode&address=${at}`)).result[0].SourceCode.startsWith("{{")).toBe(true);
    });

    it("forge verify-contract --flatten, the single file format, and the verifier says Pass", async () => {
      const at = address(0xa2);
      await deployed(at, artifact.bytecode.object, artifact.deployedBytecode.object);
      const r = await run(FORGE!, verifyArgs(at, ["--flatten"]), { cwd: project, env: env() });
      expect(r.code, r.out).toBe(0);
      expect(r.out).toMatch(/verified/i);
      await expectVerified(at);
      expect((await door(`module=contract&action=getsourcecode&address=${at}`)).result[0].SourceCode.startsWith("{{")).toBe(false);
    });

    it("forge verify-contract is told when a contract is already verified, and when its source is not the deployed one", async () => {
      const again = await run(FORGE!, verifyArgs(address(0xa1), []), { cwd: project, env: env() });
      expect(again.out).toMatch(/already verified/i);
      const other = address(0xa3);
      await deployed(other, "0x6001", "0x6002");
      const bad = await run(FORGE!, verifyArgs(other, []), { cwd: project, env: env() });
      expect(bad.code, bad.out).not.toBe(0);
      expect(bad.out).toMatch(/Unable to verify/);
      expect((await door(`module=contract&action=getabi&address=${other}`)).status).toBe("0");
    });

    it("cast source and cast interface read what was verified", async () => {
      const at = address(0xa1);
      const src = await run(CAST!, ["source", at, ...where(), ...explorer()], { cwd: project, env: env() });
      expect(src.code, src.out).toBe(0);
      expect(src.out).toContain("contract Box");
      expect(src.out).toContain("uint256 public value");
      const iface = await run(CAST!, ["interface", at, ...where()], { cwd: project, env: env() });
      expect(iface.code, iface.out).toBe(0);
      expect(iface.out, iface.out).toMatch(/interface Box \{/);
      expect(iface.out, iface.out).toMatch(/function set\(uint256 v\) external;/);
      expect(iface.out, iface.out).toMatch(/function value\(\) external view returns \(uint256\);/);
      // A contract that is not verified: cast is told so, as it is by Etherscan.
      const none = await run(CAST!, ["source", address(0xa3), ...where(), ...explorer()], { cwd: project, env: env() });
      expect(none.code).not.toBe(0);
      expect(none.out).toMatch(/not verified/i);
    });

    it.skipIf(!HAVE_SHELL)("tests/demo_etherscan_contract.sh, the script the rehearsal runs: forge in both formats, cast source and cast interface", async () => {
      const script = join(root, "tests/demo_etherscan_contract.sh");
      const tools = { SOLC: TOOLS_SOLC, FORGE: FORGE!, CAST: CAST! };
      // The script builds the two Box contracts (they differ in their optimizer runs, so neither is a similar match of the other) and says what to deploy.
      const boxes = join(dir, "boxes");
      const built = await run("bash", [script, "build", boxes], { cwd: root, env: tools });
      expect(built.code, built.out).toBe(0);
      const standard = address(0xc1), flat = address(0xc2);
      for (const [at, name] of [[standard, "standard"], [flat, "flat"]] as const) {
        const hex = (ext: string): string => "0x" + readFileSync(join(boxes, `${name}.${ext}`), "utf8").trim();
        await deployed(at, hex("creation"), hex("runtime"));
        expect(readFileSync(join(boxes, `${name}.deploy`), "utf8").trim()).toBe(hex("creation").slice(2) + ARG_HEX);
      }
      const r = await run("bash", [script, "verify"], { cwd: root, env: { ...tools, EXPLORER: base, CHAIN_ID: String(CHAIN_ID), BOX_STANDARD: standard, BOX_FLAT: flat } });
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("forge, cast and the contract module agree");
    });
  });

  describe.skipIf(!HARDHAT)("Hardhat", () => {
    let project = "";
    const env = () => ({
      HOME: join(project, "home"), XDG_CACHE_HOME: join(project, "home/cache"), XDG_CONFIG_HOME: join(project, "home/config"), XDG_DATA_HOME: join(project, "home/data"),
      HARDHAT_DISABLE_TELEMETRY_PROMPT: "true", OSTIA_SOLC: TOOLS_SOLC, OSTIA_RPC: `${base}/rpc`, OSTIA_API: `${base}/api`, OSTIA_CHAIN_ID: String(CHAIN_ID),
    });

    beforeAll(() => {
      project = join(dir, "hardhat");
      mkdirSync(join(project, "contracts"), { recursive: true });
      mkdirSync(join(project, "home"));
      copyFileSync(join(HARDHAT_DIR, "hardhat.config.cjs"), join(project, "hardhat.config.cjs"));
      copyFileSync(FIXTURE, join(project, "contracts/Box.sol"));
      writeFileSync(join(project, "package.json"), '{"name":"hardhat-run","private":true}\n');
      symlinkSync(join(HARDHAT_DIR, "node_modules"), join(project, "node_modules"));
    });

    it("hardhat verify, and the verifier says Pass; verifying again is told it is already verified", async () => {
      const built = await run(HARDHAT!, ["compile"], { cwd: project, env: env() });
      expect(built.code, built.out).toBe(0);
      const artifact = JSON.parse(readFileSync(join(project, "artifacts/contracts/Box.sol/Box.json"), "utf8")) as { bytecode: string; deployedBytecode: string };
      const at = address(0xb1);
      await deployed(at, artifact.bytecode, artifact.deployedBytecode);
      const r = await run(HARDHAT!, ["verify", "--network", "ostia", at, String(ARG)], { cwd: project, env: env() });
      expect(r.code, r.out).toBe(0);
      expect(r.out).toMatch(/Successfully verified|already been verified/i);
      await expectVerified(at);
      const again = await run(HARDHAT!, ["verify", "--network", "ostia", at, String(ARG)], { cwd: project, env: env() });
      expect(again.code, again.out).toBe(0);
      expect(again.out).toMatch(/already been verified/i);
    });
  });
});
