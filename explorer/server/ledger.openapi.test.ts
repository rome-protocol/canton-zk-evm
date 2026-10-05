import { afterEach, describe, expect, it } from "vitest";
import { ALLOWED_ENDPOINTS, createLedger } from "./ledger.ts";
import { checkpoint, createdEvent, FAKE_READER, startFakeLedger, transaction, type FakeLedger } from "../test/fake-ledger.ts";
import { loadSpec, validate } from "../test/openapi.ts";

// CANTON_OPENAPI names the OpenAPI document of the pinned Canton, as JSON. CI sets it (explorer/check-ledger-api.sh); without it these tests skip.
const file = process.env.CANTON_OPENAPI;
let fake: FakeLedger | undefined;
afterEach(async () => { await fake?.close(); fake = undefined; });

describe.skipIf(!file)("the Ledger API calls, against Canton's own OpenAPI document", () => {
  const spec = () => loadSpec(file!);
  const answer = (path: string, method: string) => spec().paths[path]![method].responses["200"].content["application/json"].schema;

  it("has both endpoints the explorer calls", () => {
    for (const route of ALLOWED_ENDPOINTS) {
      const [method, path] = route.split(" ") as [string, string];
      expect(spec().paths[path]?.[method.toLowerCase()], route).toBeDefined();
    }
  });

  it("sends a request body that the document accepts, field for field, and a limit it names", async () => {
    fake = await startFakeLedger([transaction(7, "u1", [createdEvent(7)])]);
    await createLedger(fake.url, 2000, FAKE_READER).records(0, 7);
    const post = spec().paths["/v2/updates"]!.post;
    const body = fake.requests[0]!.body;
    expect(validate(spec(), post.requestBody.content["application/json"].schema, body, true)).toEqual([]);
    expect(post.parameters.map((p: { name: string }) => p.name)).toContain("limit");
  });

  it("is given answers of the documented shape by the fake, so the reader's tests are about the real thing", async () => {
    const updates = [transaction(7, "u1", [createdEvent(7)]), checkpoint(8)];
    expect(validate(spec(), answer("/v2/updates", "post"), updates, true)).toEqual([]);
    expect(validate(spec(), answer("/v2/state/ledger-end", "get"), { offset: 8 }, true)).toEqual([]);
  });

  it("would catch a field the document does not have, and a required field that is missing", () => {
    const ev = createdEvent(7);
    delete (ev.CreatedEvent as Record<string, unknown>).contractId;
    expect(validate(spec(), answer("/v2/updates", "post"), [transaction(7, "u1", [ev])], false)).not.toEqual([]);
    const bad = { beginExclusive: 0, endInclusive: 1, updateFormat: {}, begin: 0 };
    expect(validate(spec(), spec().paths["/v2/updates"]!.post.requestBody.content["application/json"].schema, bad, true)).toEqual(["$: begin is not a field of this object"]);
  });
});
