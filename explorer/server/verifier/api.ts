/**
 * What the API's two verification routes call: `submit` takes the JSON body of `POST /api/verify` and queues it, `status` answers `GET /api/verify/{guid}`.
 * The answers are the raw ones; the API picks their fields. A submission is answered 503 while no verifier role has refreshed its row `verifier/compilers` of
 * `health_checks` in the last minute, which is also what keeps the feature off wherever the role is not started.
 */
import type { Pool } from "pg";
import { clientKey } from "../faucet.ts";
import type { JobQueue } from "./jobs.ts";
import { SubmitRefused } from "./jobs.ts";
import { toolOf, type Via, type VerifyRequest } from "./request.ts";
import { refreshProxy, type ProxyProbe } from "../indexer/proxies.ts";

export interface VerifyAnswer { status: number; body: unknown }
export interface VerifyApi {
  submit(body: string | undefined, ip: string | undefined): Promise<VerifyAnswer>;
  status(guid: string): Promise<VerifyAnswer>;
  /** What `submit` does after the body is read: for the Etherscan door, which has parsed the request's fields itself. `via` is how it came in, which the job records. */
  enqueue(req: VerifyRequest, ip: string | undefined, via?: Via): Promise<VerifyAnswer>;
  /**
   * `verifyproxycontract`: answers 202 with a GUID of an ended job. The proxy's slots (EIP-1967 implementation and beacon, EIP-1822) and its beacon's `implementation()` are read
   * at block `head` (the final head) and written to `proxies` first, so a proxy upgraded without a log is seen; the answer is about what was read.
   */
  proxy(address: string, expected: string | null, ip: string | undefined, head: number): Promise<VerifyAnswer>;
  /** `checkproxyverification`: the same answer as `status`, for a proxy's GUID. */
  proxyStatus(guid: string): Promise<VerifyAnswer>;
}

/** The words of `checkproxyverification` (Etherscan's). */
export const PROXY_TEXTS = {
  none: "A corresponding implementation contract was unfortunately not detected for the proxy address.",
  mismatch: (found: string, expected: string) => `The implementation contract found at ${found} does not match the expected implementation address ${expected}.`,
  done: (proxy: string, impl: string) => `The proxy's (${proxy}) implementation contract is found at: ${impl} and is successfully updated.`,
};

export const ROLE_FRESH_SECONDS = 60;

const NO_SUCH = "No such verification. A finished one is kept for a while, and its GUID is the one the submission answered with.";
const fail = (status: number, error: string): VerifyAnswer => ({ status, body: { error } });
const text = (v: unknown): string | undefined => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : undefined);

/** The request and the tool it names (null when it names none). */
function parse(body: string | undefined): { req: VerifyRequest; tool: Via["tool"] } | string {
  let given: unknown;
  try { given = JSON.parse(body ?? ""); } catch { return "Send a JSON body with the address, codeFormat, sourceCode, contractName and compilerVersion of the contract."; }
  if (typeof given !== "object" || given === null || Array.isArray(given)) return "The body must be a JSON object.";
  const g = given as Record<string, unknown>;
  for (const k of ["address", "codeFormat", "sourceCode", "contractName", "compilerVersion"] as const) {
    if (typeof g[k] !== "string" || g[k] === "") return `${k} is needed, as text.`;
  }
  if (g.tool !== undefined && typeof g.tool !== "string") return "tool is the name of the tool that sent this, as text.";
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
  return { tool: toolOf(g.tool), req: {
    address: g.address as string, codeFormat: g.codeFormat as string, sourceCode: g.sourceCode as string, contractName: g.contractName as string, compilerVersion: g.compilerVersion as string,
    optimizationUsed: text(g.optimizationUsed), runs: text(g.runs), evmVersion: text(g.evmVersion), licenseType: text(g.licenseType), constructorArguments: text(g.constructorArguments), libraries,
  } };
}

export function createVerifyApi(o: { pool: Pool; queue: JobQueue; clientHash: (client: string) => string; probe: ProxyProbe }): VerifyApi {
  const self: VerifyApi = {
    async enqueue(req, ip, via) {
      const running = await o.pool.query("select 1 from health_checks where check_id = 'verifier/compilers' and checked_at > now() - make_interval(secs => $1)", [ROLE_FRESH_SECONDS]);
      if (running.rowCount === 0) return fail(503, "Verification is not running.");
      try {
        const guid = await o.queue.submit(req, Buffer.from(o.clientHash(clientKey(ip) ?? "unknown"), "hex"), via ?? null);
        return { status: 202, body: { guid } };
      } catch (e) {
        if (e instanceof SubmitRefused) return fail(e.status, e.message);
        throw e;
      }
    },
    async submit(body, ip) {
      const req = parse(body);
      return typeof req === "string" ? fail(400, req) : self.enqueue(req.req, ip, { method: "api", tool: req.tool });
    },
    async status(guid) {
      const job = await o.queue.status(guid);
      return job ? { status: 200, body: job } : fail(404, NO_SUCH);
    },
    async proxy(address, expected, ip, head) {
      const a = Buffer.from(address.slice(2), "hex");
      const known = (await o.pool.query("select 1 from contracts where address = $1", [a])).rowCount;
      if (!known) return fail(404, `Unable to locate ContractCode at ${address.toLowerCase()}`);
      const found = await refreshProxy(o.pool, address.toLowerCase(), head, o.probe);
      const impl = found?.implementation ?? null;
      let status: "pass" | "fail" = "fail", result = PROXY_TEXTS.none;
      if (impl && expected && expected.toLowerCase() !== impl) result = PROXY_TEXTS.mismatch(impl, expected.toLowerCase());
      else if (impl) { status = "pass"; result = PROXY_TEXTS.done(address.toLowerCase(), impl); }
      try {
        const guid = await o.queue.recordProxy(address, Buffer.from(o.clientHash(clientKey(ip) ?? "unknown"), "hex"), status, result);
        if (status === "pass") await o.pool.query("update proxies set verified_at = now() where proxy = $1", [a]);
        return { status: 202, body: { guid } };
      } catch (e) {
        if (e instanceof SubmitRefused) return fail(e.status, e.message);
        throw e;
      }
    },
    async proxyStatus(guid) {
      const job = await o.queue.status(guid, "proxy");
      return job ? { status: 200, body: job } : fail(404, NO_SUCH);
    },
  };
  return self;
}
