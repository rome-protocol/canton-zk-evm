/**
 * The bridge gateway's verified source. Its address is reserved: a public submission for it is refused (Verifier's `reserved` list), and the verifier role
 * publishes the source itself, from the gateway sources in the repository and the settings gateway/build.sh compiles with, so no third party can claim it first.
 */
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import type { VerifierSettings } from "./settings.ts";
import type { Verifier } from "./verify.ts";

type Gateway = NonNullable<VerifierSettings["gateway"]>;

/** The addresses only the operator publishes the source of. */
export const reservedAddresses = (g: Gateway | null): string[] => (g ? [g.address] : []);

/**
 * Verifies the gateway from its sources when its contract is known and has no verified source. The settings are gateway/build.sh's: Cancun, the optimizer at
 * 200 runs, no metadata at the end of the code (so the match is partial, never full). "waiting" when the contract is not in the database yet or the compiler could
 * not be had (try again later), "done" when it has a verified source, "failed" when the sources do not match the code on chain (a deployment fault: not retried).
 */
export async function seedGateway(pool: Pool, verifier: Verifier, g: Gateway, signal?: AbortSignal): Promise<"done" | "waiting" | "failed"> {
  const addr = Buffer.from(g.address.slice(2), "hex");
  const { rows } = await pool.query<{ verified: boolean }>(
    "select exists (select 1 from verified_sources v where v.address = c.address) as verified from contracts c where c.address = $1", [addr],
  );
  if (rows.length === 0) return "waiting";
  if (rows[0]!.verified) return "done";
  const sourceCode = JSON.stringify({
    language: "Solidity", sources: { "Gateway.sol": { content: await readFile(g.sourceFile, "utf8") } },
    settings: { evmVersion: "cancun", optimizer: { enabled: true, runs: 200 }, metadata: { appendCBOR: false } },
  });
  const o = await verifier.verify(
    { address: g.address, codeFormat: "solidity-standard-json-input", sourceCode, contractName: "Gateway.sol:Gateway", compilerVersion: g.compiler },
    { operator: true, ...(signal ? { signal } : {}) },
  );
  if (o.status === "pass" || o.status === "already") return "done";
  if (o.status === "retry" || o.status === "unknown") return "waiting";
  console.error(`verifier: the gateway's sources do not verify at ${g.address}: ${o.result}`);
  return "failed";
}
