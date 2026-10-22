/** A contract made after its code was verified shows a similar match from the start (design 6.3, point 6). */
import { describe, expect, it } from "vitest";
import { migrate } from "../db/migrate.ts";
import { TEST_URL, checkRequired, withDatabase } from "../db/testing.ts";
import { codeHash, type CreatedContract } from "./calls.ts";
import { writeContracts } from "./contracts.ts";

checkRequired();
const suite = TEST_URL ? describe : describe.skip;

const A = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const bytea = (h: string) => Buffer.from(h.slice(2), "hex");
const RUNTIME = "0x6080604052600080fd";
const OTHER = "0x6080604052600180fd";
const made = (address: string, runtimeCode: string): CreatedContract => ({ address, creator: A(1), txIndex: 0, traceAddress: [], runtimeCode, initCode: "0x6001" + runtimeCode.slice(2) });
const noReads = { code: async () => "0x" };

suite("contracts made after their code was verified", () => {
  it("get a similar match with the verified source, and others are left alone", async () => {
    await withDatabase(async (pool) => {
      await migrate(pool);
      const c = await pool.connect();
      try {
        // The first copy is made and verified.
        await writeContracts(c, 5, [made(A(10), RUNTIME)], [], noReads);
        const id = (await c.query(
          `insert into verified_sources (address, runtime_code_hash, language, compiler_version, code_format, contract_path, contract_name, settings, sources, abi, match_type, creation_match, verified_at)
           values ($1, $2, 'solidity', '0.8.28+commit.7893614a', 'solidity-single-file', 'Box.sol', 'Box', '{}', '{}', '[]', 'full', 'full', now()) returning id`,
          [bytea(A(10)), bytea(codeHash(RUNTIME))],
        )).rows[0].id;
        await c.query("update contracts set verified_source = $2, match_type = 'full', name = 'Box' where address = $1", [bytea(A(10)), id]);
        // A clone and a contract with other code are made later.
        await writeContracts(c, 9, [made(A(11), RUNTIME), made(A(12), OTHER)], [], noReads);
        const row = async (n: number) => (await c.query("select name, match_type, verified_source from contracts where address = $1", [bytea(A(n))])).rows[0];
        expect(await row(11)).toMatchObject({ name: "Box", match_type: "similar", verified_source: id });
        expect(await row(12)).toMatchObject({ name: null, match_type: null, verified_source: null });
        // The verified contract itself keeps its own match when its block is written again.
        await writeContracts(c, 5, [made(A(10), RUNTIME)], [], noReads);
        expect(await row(10)).toMatchObject({ match_type: "full", verified_source: id });
      } finally {
        c.release();
      }
    });
  });
  it("loses the source of the old code when an address is made again with other code, and shows a similar match when the new code is verified elsewhere", async () => {
    await withDatabase(async (pool) => {
      await migrate(pool);
      const c = await pool.connect();
      try {
        const verify = async (address: string, code: string, name: string) => {
          const id = (await c.query(
            `insert into verified_sources (address, runtime_code_hash, language, compiler_version, code_format, contract_path, contract_name, settings, sources, abi, match_type, creation_match, verified_at)
             values ($1, $2, 'solidity', '0.8.28+commit.7893614a', 'solidity-single-file', 'X.sol', $3, '{}', '{}', '[]', 'full', 'full', now()) returning id`,
            [bytea(address), bytea(codeHash(code)), name],
          )).rows[0].id;
          await c.query("update contracts set verified_source = $2, match_type = 'full', name = $3 where address = $1", [bytea(address), id, name]);
          return id;
        };
        const row = async (n: number) => (await c.query("select name, match_type, verified_source from contracts where address = $1", [bytea(A(n))])).rows[0];
        await writeContracts(c, 5, [made(A(20), RUNTIME), made(A(21), OTHER)], [], noReads);
        const old = await verify(A(20), RUNTIME, "Old");
        const other = await verify(A(21), OTHER, "Other");
        // The address is made again with the code that is verified at the other address.
        await writeContracts(c, 9, [made(A(20), OTHER)], [], noReads);
        expect(await row(20)).toMatchObject({ name: "Other", match_type: "similar", verified_source: other });
        expect(old).not.toBe(other);
        // And again with code nobody verified: unverified, no name.
        await writeContracts(c, 12, [made(A(20), "0x6080604052600280fd")], [], noReads);
        expect(await row(20)).toMatchObject({ name: null, match_type: null, verified_source: null });
      } finally {
        c.release();
      }
    });
  });
});
