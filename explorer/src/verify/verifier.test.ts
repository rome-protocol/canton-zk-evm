import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePins } from "../../server/config.ts";
import { fetchVerifier, loadVerifier, parseAnswer, pinBytes, type BlockFields, type Verifier } from "./verifier.ts";

const fixture = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url));
const pins = parsePins(fixture("prover/fixtures/session.txt").toString(), "session.txt");
const proofHex = fixture("prover/fixtures/wrapped-proof.hex").toString().trim();
// A real block, but not the one the session proof is for.
const other = JSON.parse(fixture("sidecar/tests/fixtures/block.json").toString()) as { header: string; txs: string };
const block: BlockFields = { proofHex, headerHex: other.header, txsHex: other.txs };

describe("pinBytes", () => {
  it("reads 0x and bare hex, any case, into the program key and then the root", () => {
    const bytes = pinBytes({ programVK: "0x" + "01".repeat(32), rootC: "AB".repeat(32) });
    expect([...bytes.slice(0, 32)]).toEqual(Array(32).fill(1));
    expect([...bytes.slice(32)]).toEqual(Array(32).fill(0xab));
  });
  it("refuses a pin that is not 32 bytes of hex", () => {
    for (const bad of ["", "0x12", "zz".repeat(32), "00".repeat(33)]) {
      expect(() => pinBytes({ programVK: bad, rootC: "00".repeat(32) })).toThrow("64 hex digits");
    }
  });
});

describe("parseAnswer", () => {
  it("reads a refusal with its reason", () => {
    expect(parseAnswer("no the proof does not verify")).toEqual({ ok: false, reason: "the proof does not verify" });
  });
  it("reads a pass with its ten facts", () => {
    const a = parseAnswer("ok vk root hash parent 7 state 12 30000000 21000 1");
    expect(a).toEqual({ ok: true, programVK: "vk", rootC: "root", blockHash: "hash", parentHash: "parent", number: "7", stateRoot: "state", timestamp: "12", gasLimit: "30000000", gasUsed: "21000", txCount: "1" });
  });
  it("refuses an answer that is in neither form", () => {
    for (const bad of ["", "no", "ok a b", "maybe"]) expect(() => parseAnswer(bad)).toThrow("not in its form");
  });
});

// The built module, from the explorer's CI job (VERIFY_WASM is the path of the .wasm file). The same cases as the Rust tests in
// explorer/verify/tests/verify.rs: the answers must be the sidecar's.
describe.skipIf(!process.env.VERIFY_WASM)("the built module, through the loader", () => {
  const load = (): Promise<Verifier> => loadVerifier(readFileSync(process.env.VERIFY_WASM!));

  it("passes the proof and refuses a header that is not its block's", async () => {
    expect((await load())(block, pins)).toBe("no the header does not hash to the proven block hash");
  });
  it("refuses a proof with one byte flipped", async () => {
    const flipped = proofHex.slice(0, 20) + (proofHex[20] === "0" ? "1" : "0") + proofHex.slice(21);
    expect((await load())({ ...block, proofHex: flipped }, pins)).toBe("no the proof does not verify");
  });
  it("refuses a proof made for other pins", async () => {
    const wrong = { ...pins, programVK: "0x" + "00".repeat(32) };
    expect((await load())(block, wrong)).toBe("no the proof was made by another program or ZisK release");
  });
  it("answers a malformed line, and keeps answering after one", async () => {
    const verify = await load();
    expect(verify({ ...block, txsHex: "xyz" }, pins)).toBe("no malformed input");
    expect(verify({ proofHex: "", headerHex: "", txsHex: "" }, pins)).toBe("no the proof is not 1,344 bytes");
    expect(verify(block, pins)).toBe("no the header does not hash to the proven block hash");
  });
  it("turns what it answers into a refusal the page can show", async () => {
    expect(parseAnswer((await load())(block, pins))).toEqual({ ok: false, reason: "the header does not hash to the proven block hash" });
  });
  it("is timed once, for the README (printed, not asserted)", async () => {
    const verify = await load();
    const time = () => { const t = performance.now(); verify(block, pins); return Math.round(performance.now() - t); };
    console.log(`one check in Node: first ${time()} ms, second ${time()} ms`);
  });
});

describe("fetchVerifier", () => {
  it("says so when the file is not there", async () => {
    const fetcher = (async () => new Response("no", { status: 404 })) as typeof fetch;
    await expect(fetchVerifier("/verify.wasm", fetcher)).rejects.toThrow("could not be downloaded (404)");
  });
  it("refuses a file that is not the module", async () => {
    const fetcher = (async () => new Response(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))) as typeof fetch;
    await expect(fetchVerifier("/verify.wasm", fetcher)).rejects.toThrow();
  });
  it.skipIf(!process.env.VERIFY_WASM)("downloads the built file, reports its size and answers as the loader does", async () => {
    const file = readFileSync(process.env.VERIFY_WASM!);
    const fetcher = (async () => new Response(file)) as typeof fetch;
    const { verify, bytes } = await fetchVerifier("/verify.wasm", fetcher);
    expect(bytes).toBe(file.length);
    expect(verify(block, pins)).toBe("no the header does not hash to the proven block hash");
  });
});
