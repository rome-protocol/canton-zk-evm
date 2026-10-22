/**
 * node server/verifier/cli.ts
 * The verifier role (design section 6.3): takes the verification jobs the API queued, one at a time, compiles each in the sandbox and writes the result.
 * It runs only where it is started, and the API answers 503 to a submission while no role has refreshed its row `verifier/compilers` in health_checks.
 * Reads SOLC_LIST_URL, OUTSIDE_USER_AGENT, SOLC_CACHE_DIR and SANDBOX_IMAGE (no defaults; see settings.ts) and EXPLORER_DATABASE_URL (or the password-file
 * settings) for the database. Needs the Docker program and its socket for the sandbox. It stops at SIGTERM or SIGINT, after the job in hand, and exits 0.
 * Exit codes: 0 told to stop, 1 refused to start or failed.
 */
import { access, constants } from "node:fs/promises";
import { Pool } from "pg";
import { connectionConfig } from "../db/connect.ts";
import { CompilerStore } from "./compilers.ts";
import { JobQueue } from "./jobs.ts";
import { DockerSandbox } from "./sandbox.ts";
import { loadVerifierSettings, VerifierSettingsError } from "./settings.ts";
import { SolcRunner } from "./solc.ts";
import { Verifier } from "./verify.ts";
import { VerifierWorker } from "./worker.ts";

const HOUR = 3_600_000;

async function main(): Promise<number> {
  const s = loadVerifierSettings();
  const pool = new Pool(connectionConfig());
  pool.on("error", (e) => console.error(`verifier: database connection: ${e.message}`));
  const store = new CompilerStore({ listUrl: s.listUrl, userAgent: s.userAgent, cacheDir: s.cacheDir, maxCacheBytes: s.cacheMaxBytes });
  const sandbox = new DockerSandbox({
    image: s.sandboxImage, dockerBin: s.dockerBin, timeoutMs: s.compileTimeoutMs, memoryBytes: s.compileMemoryBytes,
    maxOutputBytes: s.compileMaxOutputBytes, maxInputBytes: s.compileMaxInputBytes,
  });
  const queue = new JobQueue(pool);
  const worker = new VerifierWorker(pool, queue, new Verifier(pool, new SolcRunner(store, sandbox), s.compileMaxInputBytes), {
    cacheUsable: () => access(s.cacheDir, constants.W_OK).then(() => null, (e: Error) => `the compiler cache folder cannot be written: ${e.message}`),
    jobTimeoutMs: s.compileTimeoutMs * 2 + 30_000,
  });
  const stop = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => stop.abort());
  const prune = setInterval(() => { queue.prune().catch((e: Error) => console.error(`verifier: prune: ${e.message}`)); }, HOUR);
  console.log("verifier: running");
  try {
    await worker.run(stop.signal);
  } finally {
    clearInterval(prune);
    await pool.end();
  }
  return 0;
}

main().then((code) => process.exit(code), (e: Error) => {
  console.error(e instanceof VerifierSettingsError ? `verifier: ${e.message}` : `explorer verifier: ${e.message}`);
  process.exit(1);
});
