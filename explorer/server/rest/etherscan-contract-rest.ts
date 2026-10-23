/**
 * The reads behind the `contract` module of the Etherscan-compatible `/api` (design 6.2 and 6.3): what is verified at an address, what proxy the indexer found there,
 * and how a contract was created. Nothing here writes; verification itself is the verifier's (`../verifier`), and a proxy check is recorded by its API.
 */
import { bytes, hex, hexOrNull } from "./chain-rest.ts";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Query = (sql: string, values?: unknown[]) => Promise<Row[]>;

/** What `getsourcecode` and `getabi` read: the verified source of the contract at an address (the code may have been verified at another address: a similar match), and its proxy. */
export interface ContractSourceRow {
  held: boolean;
  verified: null | {
    matchType: string; format: string; contractName: string; compilerVersion: string; optimizer: boolean | null; runs: number | null; evmVersion: string | null; license: string | null;
    settings: Record<string, unknown>; sources: Record<string, string>; abi: unknown; constructorArgs: string | null; libraries: Record<string, Record<string, string>> | null;
  };
  implementation: string | null;
}

/** How one contract was made. `creator` is whoever sent the transaction; `factory` is the contract that executed the creation when it was not the transaction itself. Null for a genesis contract. */
export interface CreationRow {
  address: string; genesis: boolean; creator: string | null; factory: string | null; txHash: string | null; block: number | null; timestamp: number | null; creationCode: string | null;
}

export function createContractRest(query: Query) {
  /** The contract at `address`: whether the index holds one, its verified source if it has one, and the implementation behind it if it is a proxy. */
  async function source(address: string): Promise<ContractSourceRow> {
    const [r] = await query(
      `select v.match_type, v.code_format, v.contract_name, v.compiler_version, v.optimizer_enabled, v.optimizer_runs, v.evm_version, v.license, v.settings, v.sources, v.abi,
         v.constructor_args, v.libraries, c.match_type as contract_match, p.implementation, v.id as source_id
       from contracts c left join verified_sources v on v.id = c.verified_source left join proxies p on p.proxy = c.address where c.address = $1`,
      [bytes(address)],
    );
    if (!r) return { held: false, verified: null, implementation: null };
    const implementation = hexOrNull(r.implementation);
    if (r.source_id === null) return { held: true, verified: null, implementation };
    return {
      held: true, implementation,
      verified: {
        // The match of this contract: `similar` when the source was verified at another address with the same code (its constructor arguments are that address's, not this one's).
        matchType: r.contract_match ?? r.match_type, format: r.code_format, contractName: r.contract_name, compilerVersion: r.compiler_version, optimizer: r.optimizer_enabled,
        runs: r.optimizer_runs, evmVersion: r.evm_version, license: r.license, settings: r.settings, sources: r.sources, abi: r.abi,
        constructorArgs: r.contract_match === "similar" ? null : r.constructor_args === null ? null : r.constructor_args.toString("hex"), libraries: r.libraries,
      },
    };
  }

  /** The creation of each contract the index holds among `addresses`, in the order asked; an address that is no contract is left out. */
  async function creations(addresses: string[]): Promise<CreationRow[]> {
    const rows = await query(
      `select c.address, c.origin, c.creator, c.creation_trace_address, t.hash as tx_hash, t.from_address as tx_from, c.creation_block, extract(epoch from b.timestamp)::bigint as ts, bc.code as creation_code
       from contracts c left join transactions t on t.block_number = c.creation_block and t.tx_index = c.creation_tx_index left join blocks b on b.number = c.creation_block
         left join bytecodes bc on bc.code_hash = c.creation_code_hash where c.address = any($1::bytea[])`,
      [addresses.map(bytes)],
    );
    const byAddress = new Map(rows.map((r) => [hex(r.address), r]));
    const [first] = await query("select extract(epoch from timestamp)::bigint as ts from blocks order by number limit 1");
    const out: CreationRow[] = [];
    for (const a of addresses) {
      const r = byAddress.get(a.toLowerCase());
      if (!r) continue;
      if (r.origin === "genesis") { out.push({ address: a.toLowerCase(), genesis: true, creator: null, factory: null, txHash: null, block: 0, timestamp: first ? Number(first.ts) : null, creationCode: null }); continue; }
      const viaFactory = (r.creation_trace_address as number[]).length > 0;
      out.push({
        address: a.toLowerCase(), genesis: false, creator: hexOrNull(viaFactory ? r.tx_from : r.creator), factory: viaFactory ? hexOrNull(r.creator) : null, txHash: hexOrNull(r.tx_hash),
        block: Number(r.creation_block), timestamp: Number(r.ts), creationCode: r.creation_code === null ? null : hex(r.creation_code),
      });
    }
    return out;
  }

  return { contractSource: source, contractCreations: creations };
}

/** The fields of one `getsourcecode` answer, as Etherscan writes them (design 6.3 point 8). */
export interface SourceCodeFields {
  SourceCode: string; ABI: string; ContractName: string; CompilerVersion: string; OptimizationUsed: string; Runs: string; ConstructorArguments: string; EVMVersion: string; Library: string;
  LicenseType: string; Proxy: string; Implementation: string; SwarmSource: string;
}

/** What Etherscan answers for an address whose source is not verified: the same fields, empty, with the text in `ABI`. */
export const NOT_VERIFIED = "Contract source code not verified";

/**
 * The fields for a contract. `SourceCode` is the file itself for a single file, and the standard JSON input between a second pair of braces (`{{ ... }}`) as Etherscan
 * writes it; `Library` is `Name:0xaddress` for each library, joined by `;`.
 */
export function sourceCodeFields(s: ContractSourceRow): SourceCodeFields {
  const proxy = { Proxy: s.implementation === null ? "0" : "1", Implementation: s.implementation ?? "" };
  const v = s.verified;
  if (v === null) {
    return { SourceCode: "", ABI: NOT_VERIFIED, ContractName: "", CompilerVersion: "", OptimizationUsed: "", Runs: "", ConstructorArguments: "", EVMVersion: "Default", Library: "", LicenseType: "", ...proxy, SwarmSource: "" };
  }
  const files = Object.entries(v.sources);
  const code = v.format === "solidity-standard-json-input"
    ? "{" + JSON.stringify({ language: "Solidity", sources: Object.fromEntries(files.map(([path, content]) => [path, { content }])), settings: v.settings }) + "}"
    : (files[0]?.[1] ?? "");
  const libraries = Object.values(v.libraries ?? {}).flatMap((names) => Object.entries(names).map(([name, address]) => `${name}:${address}`)).join(";");
  return {
    SourceCode: code, ABI: JSON.stringify(v.abi), ContractName: v.contractName, CompilerVersion: v.compilerVersion.startsWith("v") ? v.compilerVersion : `v${v.compilerVersion}`, OptimizationUsed: v.optimizer ? "1" : "0", Runs: String(v.runs ?? 0),
    ConstructorArguments: v.constructorArgs ?? "", EVMVersion: v.evmVersion ?? "Default", Library: libraries, LicenseType: v.license ?? "None", ...proxy, SwarmSource: "",
  };
}
