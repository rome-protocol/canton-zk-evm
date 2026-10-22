/**
 * One verification (design section 6.3): the request is checked, the contract is looked up, the source is compiled in the sandbox, the compiled code is matched
 * with the code on chain, and what verified is stored with its match kind. A contract that is already verified with a full match answers so before anything is compiled.
 * One that is verified with a partial match can still be verified again: a full match replaces it (the first submission is not final), and anything else answers
 * "already".
 */
import type { Pool, PoolClient } from "pg";
import { CompilerError } from "./compilers.ts";
import { pickContract, prepare, RequestError, type VerifyRequest } from "./request.ts";
import { SandboxError } from "./sandbox.ts";
import { MatchFailure, matchWithSourcify, SandboxSolc, type Matched } from "./sourcify.ts";
import type { Compiled } from "./solc.ts";

/** What the verifier needs of the compiler: `SolcRunner` has it. */
export interface Compile { compile(version: string, input: object | string, signal?: AbortSignal): Promise<Compiled> }

export type Outcome =
  /** The address is not a contract the index knows (its block may not be final yet): the tools try again later. */
  | { status: "unknown"; result: string }
  | { status: "already"; result: string }
  | { status: "pass"; result: string; match: "full" | "partial"; creationMatch: "full" | "partial" | null; sourceId: number; similar: number }
  | { status: "fail"; result: string }
  /** The compiler or the sandbox could not be had (not the submitter's fault): the job is tried again. */
  | { status: "retry"; result: string };

export class Verifier {
  private readonly pool: Pool;
  private readonly runner: Compile;
  private readonly maxSourceBytes: number | undefined;
  private readonly reserved: Set<string>;
  /**
   * `reserved` are addresses whose source only the operator publishes (the bridge gateway, a genesis contract compiled without a metadata hash, so that no
   * match of it is ever `full`): a submission for one is refused, and `verify(req, { operator: true })` is how the deployment seeds it.
   */
  constructor(pool: Pool, runner: Compile, maxSourceBytes?: number, reserved: string[] = []) {
    this.pool = pool;
    this.runner = runner;
    this.maxSourceBytes = maxSourceBytes;
    this.reserved = new Set(reserved.map((a) => a.toLowerCase()));
  }

  /**
   * Verifies a request. When `opts.signal` aborts, the compile is stopped and nothing is written (it throws the signal's reason). A request that cannot be run at all (a bad address, nonsense JSON) throws RequestError; every other answer is an Outcome. */
  async verify(req: VerifyRequest, opts: { operator?: boolean; signal?: AbortSignal } = {}): Promise<Outcome> {
    const p = prepare(req, this.maxSourceBytes);
    if (!opts.operator && this.reserved.has(p.address.toLowerCase())) {
      return { status: "fail", result: "Fail - Unable to verify. The source of this contract is published by the operator of the network, and cannot be submitted." };
    }
    const addr = Buffer.from(p.address.slice(2), "hex");
    const found = await this.pool.query<{ runtime_code_hash: Buffer; runtime: Buffer; creation: Buffer | null; verified: number | null; verified_match: string | null }>(
      `select c.runtime_code_hash, rb.code as runtime, cb.code as creation, (select v.id from verified_sources v where v.address = c.address and v.runtime_code_hash = c.runtime_code_hash) as verified,
         (select v.match_type from verified_sources v where v.address = c.address and v.runtime_code_hash = c.runtime_code_hash) as verified_match
       from contracts c join bytecodes rb on rb.code_hash = c.runtime_code_hash left join bytecodes cb on cb.code_hash = c.creation_code_hash
       where c.address = $1`,
      [addr],
    );
    const row = found.rows[0];
    if (!row) return { status: "unknown", result: `Unable to locate ContractCode at ${p.address}` };
    if (row.verified !== null && row.verified_match === "full") return { status: "already", result: "Already Verified" };

    // The library compiles and matches (sourcify.ts): the compile runs in the sandbox, through `solc`, and the chain it reads is this row.
    const solc = new SandboxSolc(this.runner, opts.signal);
    let m: Matched;
    let target: { path: string; name: string };
    try {
      let path = p.path;
      // A request that names only the contract: one compile finds its file (and refuses a name that is in two files).
      if (path === null) path = pickContract(await solc.compile(p.version, p.input) as unknown as Record<string, unknown>, p).path;
      target = { path, name: p.name };
      m = await matchWithSourcify(solc, p.version, p.input, target, { runtimeCode: row.runtime, creationInput: row.creation }, p.given);
    } catch (e) {
      // A job that was told to stop writes nothing: its result is already given as a failure.
      opts.signal?.throwIfAborted();
      if (solc.reported) return { status: "fail", result: `Fail - Unable to verify. The compiler reported errors:\n${solc.reported}` };
      const f = solc.failure ?? e;
      if (f instanceof CompilerError) {
        if (f.kind === "unknown" || f.kind === "refused") return { status: "fail", result: `Fail - Unable to verify. ${f.message}` };
        return { status: "retry", result: `The compiler could not be had: ${f.message}` };
      }
      if (f instanceof SandboxError) {
        if (f.kind === "unavailable") return { status: "retry", result: `The sandbox is not available: ${f.message}` };
        const why = f.kind === "timeout" ? "the compile took too long" : f.kind === "output-too-large" ? "the compiler's output is too large" : f.kind === "input-too-large" ? "the input is too large to compile" : f.message;
        return { status: "fail", result: `Fail - Unable to verify. ${why}` };
      }
      if (e instanceof RequestError || e instanceof MatchFailure) return { status: "fail", result: `Fail - Unable to verify. ${e.message}` };
      throw e;
    }
    opts.signal?.throwIfAborted();

    // The libraries the request named (the compiler linked them) and the ones read from the chain, by file and name.
    const libraries: Record<string, Record<string, string>> = {};
    const named = (p.settings.libraries ?? {}) as Record<string, Record<string, string>>;
    for (const src of [named, m.libraries]) for (const [file, names] of Object.entries(src)) libraries[file] = { ...libraries[file], ...names };
    const optimizer = (p.settings.optimizer ?? {}) as { enabled?: unknown; runs?: unknown };
    opts.signal?.throwIfAborted();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const ins = await client.query<{ id: string }>(
        `insert into verified_sources (address, runtime_code_hash, language, compiler_version, code_format, contract_path, contract_name, optimizer_enabled, optimizer_runs,
           evm_version, settings, sources, abi, compiler_metadata, constructor_args, libraries, license, match_type, creation_match, verified_at)
         values ($1, $2, 'solidity', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, now())
         on conflict (address, runtime_code_hash) do update set language = excluded.language, compiler_version = excluded.compiler_version,
           code_format = excluded.code_format, contract_path = excluded.contract_path, contract_name = excluded.contract_name, optimizer_enabled = excluded.optimizer_enabled,
           optimizer_runs = excluded.optimizer_runs, evm_version = excluded.evm_version, settings = excluded.settings, sources = excluded.sources, abi = excluded.abi,
           compiler_metadata = excluded.compiler_metadata, constructor_args = excluded.constructor_args, libraries = excluded.libraries, license = excluded.license,
           match_type = excluded.match_type, creation_match = excluded.creation_match, verified_at = excluded.verified_at
           where verified_sources.match_type <> 'full' and excluded.match_type = 'full'
         returning id`,
        [addr, row.runtime_code_hash, solc.version, p.format, target.path, target.name, typeof optimizer.enabled === "boolean" ? optimizer.enabled : null,
          typeof optimizer.runs === "number" ? optimizer.runs : null, typeof p.settings.evmVersion === "string" ? p.settings.evmVersion : null, JSON.stringify(p.settings),
          JSON.stringify(m.sources), JSON.stringify(m.abi), m.metadata ? JSON.stringify(m.metadata) : null, m.constructorArgs, Object.keys(libraries).length > 0 ? JSON.stringify(libraries) : null,
          p.license, m.kind, m.creationKind],
      );
      if (ins.rowCount === 0) { await client.query("rollback"); return { status: "already", result: "Already Verified" }; }
      const id = Number(ins.rows[0]!.id);
      // Keyed on the code that was matched: if the address was made again with other code while the compile ran, the contracts row is left alone (the source stays with its code).
      await client.query("update contracts set name = $2, verified_source = $3, match_type = $4 where address = $1 and runtime_code_hash = $5", [addr, target.name, id, m.kind, row.runtime_code_hash]);
      let similar = await markSimilar(client, row.runtime_code_hash, id, target.name, this.reserved);
      await client.query("commit");
      // Under READ COMMITTED a clone the indexer committed while this transaction ran was seen by neither side: once more, now that the source is committed.
      similar += await markSimilar(this.pool, row.runtime_code_hash, id, target.name, this.reserved);
      return { status: "pass", result: "Pass - Verified", match: m.kind, creationMatch: m.creationKind, sourceId: id, similar };
    } catch (e) {
      await client.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
}

/**
 * Every other contract with the same runtime code, and no verified source of its own, shows a similar match with the verified one (design 6.3 point 6). The
 * indexer calls this for a contract that it writes after the code was verified. Returns how many contracts it marked. A reserved address (the gateway) is never marked: only
 * the deployment's own seed gives it a source, whatever a byte-identical clone at another address had verified.
 */
export async function markSimilar(c: Pick<PoolClient, "query">, runtimeCodeHash: Buffer, sourceId: number, name: string, reserved: ReadonlySet<string> = new Set()): Promise<number> {
  const r = await c.query(
    `update contracts c set verified_source = $2, match_type = 'similar', name = coalesce(c.name, $3)
     where c.runtime_code_hash = $1 and c.verified_source is null and not exists (select 1 from verified_sources v where v.address = c.address and v.runtime_code_hash = c.runtime_code_hash)
       and c.address <> all($4::bytea[])`,
    [runtimeCodeHash, sourceId, name, [...reserved].map((a) => Buffer.from(a.slice(2), "hex"))],
  );
  return r.rowCount ?? 0;
}
