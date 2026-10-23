/**
 * A verification request (the fields of Etherscan's `verifysourcecode`, design section 6.3 point 1) made into what the compiler takes: standard JSON input.
 * A single file becomes one source with the settings the fields give; standard JSON is taken as it is, except for what must not be the submitter's to
 * choose (the output selection, and any source that names a file or an address instead of holding its text).
 */

import { isHexBytes } from "../hex.ts";

/** A request that cannot be run at all: the reason is for the person who sent it. */
export class RequestError extends Error {}

export interface VerifyRequest {
  address: string;
  codeFormat: string;
  sourceCode: string;
  /** `Name`, or `path/File.sol:Name`. */
  contractName: string;
  compilerVersion: string;
  optimizationUsed?: string | undefined;
  runs?: string | undefined;
  evmVersion?: string | undefined;
  licenseType?: string | undefined;
  constructorArguments?: string | undefined;
  /** For a single file: the libraries and their addresses (`libraryname1`/`libraryaddress1`, ...). */
  libraries?: { name: string; address: string }[] | undefined;
}

/** How a verification came in: through the Etherscan-compatible API (`etherscan`) or `POST /api/verify` (`api`). */
export type VerifyMethod = "etherscan" | "api";
export const VERIFY_METHODS: readonly VerifyMethod[] = ["etherscan", "api"];
/** The tool the submitter says it used, when it says: `unknown` for a tool that is none of the three. */
export type VerifyTool = "forge" | "hardhat" | "remix" | "unknown";
export const VERIFY_TOOLS: readonly VerifyTool[] = ["forge", "hardhat", "remix", "unknown"];
/** Where a verification came from, as the job records it and the contract serves it. `tool` is null when the submitter did not say. */
export interface Via { method: VerifyMethod; tool: VerifyTool | null }

/** The tool a submission names (a `tool` field, as text): null when it names none, and `unknown` when it names one that is not forge (or foundry), hardhat or remix. */
export function toolOf(v: unknown): VerifyTool | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  const t = v.trim().toLowerCase();
  if (/^(forge|foundry)\b/.test(t)) return "forge";
  if (/^hardhat\b/.test(t)) return "hardhat";
  if (/^remix\b/.test(t)) return "remix";
  return "unknown";
}

export const MAX_SOURCE_BYTES = 500 * 1024;

export interface Prepared {
  address: string;
  version: string;
  format: "solidity-single-file" | "solidity-standard-json-input";
  input: { language: "Solidity"; sources: Record<string, { content: string }>; settings: Record<string, unknown> };
  /** The contract to take from the output: its path when the request gave one, and its name. */
  path: string | null;
  name: string;
  /** The arguments the request gave, as bytes; null when it gave none. */
  given: Buffer | null;
  /** The settings as the submitter gave them, without the output selection, as stored. */
  settings: Record<string, unknown>;
  sources: Record<string, string>;
  license: string | null;
}

const OUTPUT = ["evm.deployedBytecode.object"];
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Etherscan's own answers wrap standard JSON in a second pair of braces; tools may send either. */
export function unwrapStandardJson(text: string): string {
  const t = text.trim();
  return t.startsWith("{{") && t.endsWith("}}") ? t.slice(1, -1) : t;
}

function parseArguments(raw: string | undefined): Buffer | null {
  const h = (raw ?? "").trim().replace(/^0x/i, "");
  if (h === "") return null;
  if (!isHexBytes(h, { prefix: "none", upper: true, empty: false })) throw new RequestError("the constructor arguments are not hex");
  return Buffer.from(h, "hex");
}

function spdx(text: string): string | null {
  const m = /SPDX-License-Identifier:\s*([^\s*]+)/.exec(text);
  return m ? m[1]! : null;
}

/** Checks a request and builds the compiler input. Throws RequestError. */
export function prepare(req: VerifyRequest, maxBytes = MAX_SOURCE_BYTES): Prepared {
  if (!ADDRESS.test(req.address)) throw new RequestError("the contract address is not an address");
  const version = req.compilerVersion.trim();
  if (!/^v?\d+\.\d+\.\d+([-+.\w]*)$/.test(version)) throw new RequestError(`the compiler version "${req.compilerVersion}" is not a Solidity version`);
  if (req.contractName.trim() === "") throw new RequestError("the contract name is missing");
  if (Buffer.byteLength(req.sourceCode, "utf8") > maxBytes) throw new RequestError(`the source is over ${Math.floor(maxBytes / 1024)} KB`);
  const given = parseArguments(req.constructorArguments);
  const colon = req.contractName.lastIndexOf(":");
  const path = colon >= 0 ? req.contractName.slice(0, colon) : null;
  const name = colon >= 0 ? req.contractName.slice(colon + 1) : req.contractName.trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new RequestError("the contract name is not a Solidity name");
  const address = req.address.toLowerCase();

  if (req.codeFormat === "solidity-single-file") {
    const file = path ?? `${name}.sol`;
    const settings: Record<string, unknown> = { optimizer: { enabled: req.optimizationUsed === "1" || req.optimizationUsed === "true" } };
    if (req.optimizationUsed === "1" || req.optimizationUsed === "true") {
      const runs = req.runs === undefined || req.runs === "" ? 200 : Number(req.runs);
      if (!Number.isInteger(runs) || runs < 0 || runs > 2 ** 32 - 1) throw new RequestError("runs is not a whole number");
      (settings.optimizer as Record<string, unknown>).runs = runs;
    }
    const evm = (req.evmVersion ?? "").trim();
    if (evm !== "" && evm !== "default") {
      if (!/^[a-z0-9]+$/.test(evm)) throw new RequestError("the EVM version is not a name");
      settings.evmVersion = evm;
    }
    const libs = (req.libraries ?? []).filter((l) => l.name !== "" || l.address !== "");
    if (libs.length > 10) throw new RequestError("at most ten libraries");
    if (libs.length > 0) {
      const byFile: Record<string, Record<string, string>> = {};
      for (const l of libs) {
        if (!ADDRESS.test(l.address)) throw new RequestError(`the address of the library ${l.name} is not an address`);
        const c = l.name.lastIndexOf(":");
        const lf = c >= 0 ? l.name.slice(0, c) : file;
        const ln = c >= 0 ? l.name.slice(c + 1) : l.name;
        if (!/^[A-Za-z_$][\w$]*$/.test(ln)) throw new RequestError(`the library name "${l.name}" is not a Solidity name`);
        (byFile[lf] ??= {})[ln] = l.address;
      }
      settings.libraries = byFile;
    }
    return {
      address, version, format: "solidity-single-file", path, name, given, settings, sources: { [file]: req.sourceCode },
      license: (req.licenseType ?? "").trim() || spdx(req.sourceCode),
      input: { language: "Solidity", sources: { [file]: { content: req.sourceCode } }, settings: { ...settings, outputSelection: { "*": { "*": OUTPUT } } } },
    };
  }

  if (req.codeFormat !== "solidity-standard-json-input") throw new RequestError(`the code format "${req.codeFormat}" is not supported (solidity-single-file or solidity-standard-json-input)`);
  let json: unknown;
  try { json = JSON.parse(unwrapStandardJson(req.sourceCode)); } catch { throw new RequestError("the source code is not standard JSON input"); }
  if (!isObject(json)) throw new RequestError("the source code is not standard JSON input");
  if (json.language !== "Solidity") throw new RequestError('only "language": "Solidity" is supported');
  if (!isObject(json.sources) || Object.keys(json.sources).length === 0) throw new RequestError("the standard JSON input has no sources");
  const sources: Record<string, string> = {};
  for (const [p, s] of Object.entries(json.sources)) {
    if (!isObject(s) || typeof s.content !== "string") throw new RequestError(`the source ${p} has no content (a source that names a file or an address is not accepted)`);
    sources[p] = s.content;
  }
  const given_settings = json.settings === undefined ? {} : json.settings;
  if (!isObject(given_settings)) throw new RequestError("settings is not an object");
  const { outputSelection: _dropped, ...settings } = given_settings;
  void _dropped;
  const main = path !== null ? sources[path] : undefined;
  return {
    address, version, format: "solidity-standard-json-input", path, name, given, settings, sources,
    license: (req.licenseType ?? "").trim() || spdx(main ?? Object.values(sources).find((t) => spdx(t)) ?? ""),
    input: { language: "Solidity", sources: Object.fromEntries(Object.entries(sources).map(([p, c]) => [p, { content: c }])), settings: { ...settings, outputSelection: { "*": { "*": OUTPUT } } } },
  };
}

/** The contract a request names, found in the compiler's output. */
export interface Picked { path: string; name: string }

/** The compiler's errors (not its warnings), as one text for the person who submitted, or null when there are none. */
export function compilerErrors(output: Record<string, unknown>): string | null {
  const errors = Array.isArray(output.errors) ? (output.errors as { severity?: string; formattedMessage?: string; message?: string }[]) : [];
  const bad = errors.filter((e) => e.severity === "error");
  if (bad.length === 0) return null;
  return bad.slice(0, 3).map((e) => (e.formattedMessage ?? e.message ?? "an error").trim()).join("\n").slice(0, 1500);
}

/** The contract the request names, from the compiler's output (the path when the request gave only the name). Throws RequestError when it is not there, is ambiguous, or has no code. */
export function pickContract(output: Record<string, unknown>, p: Pick<Prepared, "path" | "name">): Picked {
  const contracts = isObject(output.contracts) ? output.contracts : {};
  const found: { path: string; c: Record<string, unknown> }[] = [];
  for (const [file, byName] of Object.entries(contracts)) {
    if (p.path !== null && file !== p.path) continue;
    const c = isObject(byName) ? byName[p.name] : undefined;
    if (isObject(c)) found.push({ path: file, c });
  }
  if (found.length === 0) throw new RequestError(`the compiler output has no contract ${p.path ? `${p.path}:` : ""}${p.name}`);
  if (found.length > 1) throw new RequestError(`there is more than one contract named ${p.name} (${found.map((f) => f.path).join(", ")}): give the contract name as path:Name`);
  const { path, c } = found[0]!;
  const evm = isObject(c.evm) ? c.evm : {};
  const dc = isObject(evm.deployedBytecode) ? evm.deployedBytecode : {};
  if (typeof dc.object !== "string" || dc.object === "") throw new RequestError(`${p.name} has no code (an interface or an abstract contract cannot be deployed)`);
  return { path, name: p.name };
}
