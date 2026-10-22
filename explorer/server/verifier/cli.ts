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
import { reservedAddresses, seedGateway } from "./gateway.ts";
import { JobQueue } from "./jobs.ts";
import { DockerSandbox } from "./sandbox.ts";
import { loadVerifierSettings, VerifierSettingsError } from "./settings.ts";
import { SolcRunner } from "./solc.ts";
import { Verifier } from "./verify.ts";
import { VerifierWorker } from "./worker.ts";

const HOUR = 3_600_000;
/** The compiler list and the download each may take this long; a job gets both, a compile, and a margin. */
const FETCH_MS = 120_000;

async function main(): Promise<number> {
  const s = loadVerifierSettings();
  const pool = new Pool(connectionConfig());
  pool.on("error", (e) => console.error(`verifier: database connection: ${e.message}`));
  const store = new CompilerStore({ listUrl: s.listUrl, userAgent: s.userAgent, cacheDir: s.cacheDir, maxCacheBytes: s.cacheMaxBytes, fetchTimeoutMs: FETCH_MS });
  const sandbox = new DockerSandbox({
    image: s.sandboxImage, dockerBin: s.dockerBin, timeoutMs: s.compileTimeoutMs, memoryBytes: s.compileMemoryBytes,
    maxOutputBytes: s.compileMaxOutputBytes, maxInputBytes: s.compileMaxInputBytes,
  });
  const queue = new JobQueue(pool);
  const verifier = new Verifier(pool, new SolcRunner(store, sandbox), s.compileMaxInputBytes, reservedAddresses(s.gateway));
  // One verification at a time, a job's or the gateway seed's: two compiles never run at once (a verification is a few compiles, one after another).
  let line: Promise<unknown> = Promise.resolve();
  const serial: Pick<Verifier, "verify"> = {
    verify: (req, opts) => { const r = line.then(() => verifier.verify(req, opts)); line = r.catch(() => undefined); return r; },
  };
  const worker = new VerifierWorker(pool, queue, serial, {
    cacheUsable: () => access(s.cacheDir, constants.W_OK).then(() => null, (e: Error) => `the compiler cache folder cannot be written: ${e.message}`),
    // A verification is two compiles (the source, and the source with a space added, to find the metadata) and, for an old compiler with viaIR, two more.
    jobTimeoutMs: FETCH_MS * 2 + 4 * s.compileTimeoutMs + 30_000,
  });
  const stop = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => stop.abort());
  const prune = setInterval(() => { queue.prune().catch((e: Error) => console.error(`verifier: prune: ${e.message}`)); }, HOUR);
  // The gateway's source is published here, not by a submission: tried now, and each minute until the gateway has one (its contract may not be indexed yet).
  let seeding: NodeJS.Timeout | undefined;
  if (s.gateway) {
    const g = s.gateway;
    const seed = (): Promise<void> => {
      return seedGateway(pool, serial, g, stop.signal).then((r) => { if (r !== "waiting") clearInterval(seeding); }, (e: Error) => console.error(`verifier: gateway source: ${e.message}`));
    };
    seeding = setInterval(() => void seed(), 60_000);
    // The first attempt is finished before the worker takes its first job.
    await seed();
  }
  console.log("verifier: running");
  try {
    await worker.run(stop.signal);
  } finally {
    clearInterval(prune);
    clearInterval(seeding);
    await pool.end();
  }
  return 0;
}

main().then((code) => process.exit(code), (e: Error) => {
  console.error(e instanceof VerifierSettingsError ? `verifier: ${e.message}` : `explorer verifier: ${e.message}`);
  process.exit(1);
});
