/**
 * What the API's two verification routes call: `submit` takes the JSON body of `POST /api/verify` and queues it, `status` answers `GET /api/verify/{guid}`.
 * The answers are the raw ones; the API picks their fields. A submission is answered 503 while no verifier role has refreshed its row `verifier/compilers` of
 * `health_checks` in the last minute, which is also what keeps the feature off wherever the role is not started.
 */
import type { Pool } from "pg";
import { clientKey } from "../faucet.ts";
import type { JobQueue } from "./jobs.ts";
import { SubmitRefused } from "./jobs.ts";
import type { VerifyRequest } from "./request.ts";

export interface VerifyAnswer { status: number; body: unknown }
export interface VerifyApi {
  submit(body: string | undefined, ip: string | undefined): Promise<VerifyAnswer>;
  status(guid: string): Promise<VerifyAnswer>;
}

export const ROLE_FRESH_SECONDS = 60;

const fail = (status: number, error: string): VerifyAnswer => ({ status, body: { error } });
const text = (v: unknown): string | undefined => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : undefined);

function parse(body: string | undefined): VerifyRequest | string {
  let given: unknown;
  try { given = JSON.parse(body ?? ""); } catch { return "Send a JSON body with the address, codeFormat, sourceCode, contractName and compilerVersion of the contract."; }
  if (typeof given !== "object" || given === null || Array.isArray(given)) return "The body must be a JSON object.";
  const g = given as Record<string, unknown>;
  for (const k of ["address", "codeFormat", "sourceCode", "contractName", "compilerVersion"] as const) {
    if (typeof g[k] !== "string" || g[k] === "") return `${k} is needed, as text.`;
  }
  let libraries: { name: string; address: string }[] | undefined;
  if (g.libraries !== undefined) {
    if (!Array.isArray(g.libraries) || g.libraries.length > 50) return "libraries must be a list of at most 50 {name, address}.";
    libraries = [];
    for (const l of g.libraries as unknown[]) {
      const o = l as { name?: unknown; address?: unknown } | null;
      if (typeof o !== "object" || o === null || typeof o.name !== "string" || typeof o.address !== "string") return "Each library is {name, address}, both as text.";
      libraries.push({ name: o.name, address: o.address });
    }
  }
  return {
    address: g.address as string, codeFormat: g.codeFormat as string, sourceCode: g.sourceCode as string, contractName: g.contractName as string, compilerVersion: g.compilerVersion as string,
    optimizationUsed: text(g.optimizationUsed), runs: text(g.runs), evmVersion: text(g.evmVersion), licenseType: text(g.licenseType), constructorArguments: text(g.constructorArguments), libraries,
  };
}

export function createVerifyApi(o: { pool: Pool; queue: JobQueue; clientHash: (client: string) => string }): VerifyApi {
  return {
    async submit(body, ip) {
      const req = parse(body);
      if (typeof req === "string") return fail(400, req);
      const running = await o.pool.query("select 1 from health_checks where check_id = 'verifier/compilers' and checked_at > now() - make_interval(secs => $1)", [ROLE_FRESH_SECONDS]);
      if (running.rowCount === 0) return fail(503, "Verification is not running.");
      try {
        const guid = await o.queue.submit(req, Buffer.from(o.clientHash(clientKey(ip) ?? "unknown"), "hex"));
        return { status: 202, body: { guid } };
      } catch (e) {
        if (e instanceof SubmitRefused) return fail(e.status, e.message);
        throw e;
      }
    },
    async status(guid) {
      const job = await o.queue.status(guid);
      return job ? { status: 200, body: job } : fail(404, "No such verification. A finished one is kept for a while, and its GUID is the one the submission answered with.");
    },
  };
}
