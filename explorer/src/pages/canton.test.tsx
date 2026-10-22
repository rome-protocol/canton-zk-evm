// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { UpdateDetail, UpdateItem } from "../api.ts";
import { fakeApi, hash, NOT_FOUND, page, renderApp, reply, route, update } from "../test-utils.tsx";

const SYNC = "da::1220" + "e8".repeat(32);
const item = (n: number, over: Partial<UpdateItem> = {}): UpdateItem => ({
  updateId: update(n), recordTime: `2026-10-04T01:37:${10 + n}.230583Z`, effectiveAt: null, participant: "reader-1", offset: 60 + n, synchronizer: SYNC, block: n, ...over,
});
const detail = (over: Partial<UpdateDetail> = {}): UpdateDetail => ({
  ...item(3), template: { packageId: "ccd743bc", packageName: "zk-chain", module: "Zk.Chain", entity: "BlockRecord" }, contractId: "00be6996af" + "25".repeat(30), blockHash: hash(3),
  signatories: [{ role: "the chain's operator", party: "operator::1220" + "ab".repeat(32) }, { role: "the chain's confirmer", party: "confirmer::1220" + "cd".repeat(32) }],
  producerRecord: { template: "Zk.Chain:ZkChain", choice: "Advance", commandId: "advance-3-1", argumentBytes: 2080, trafficBytes: null }, ...over,
});
const NOW = Date.parse("2026-10-04T02:00:00Z");

describe("the Canton updates page", () => {
  const open = async (h: Parameters<typeof route>[0] = {}) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const calls = fakeApi(route({ updates: () => reply(page([item(4), item(3)])), ...h }));
    renderApp("/canton");
    await screen.findByRole("table");
    return calls;
  };
  const rows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1);

  it("lists the updates newest first, with the reader's offset, the record time and the block each carries", async () => {
    await open();
    expect(rows()).toHaveLength(2);
    const r = within(rows()[0]!);
    expect(rows()[0]).toHaveTextContent("64");
    expect(rows()[0]).toHaveTextContent("2026-10-04T01:37:14.230583Z");
    expect(r.getByRole("link", { name: "1220 0404…0404" })).toHaveAttribute("href", `/canton/${update(4)}`);
    expect(r.getByRole("link", { name: "Block 4" })).toHaveAttribute("href", "/block/4");
  });

  it("says that the offsets are the reader's participant's, not the builder's completion offset", async () => {
    await open();
    expect(screen.getAllByText("on the reader's participant", { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getByText("not the builder's own completion offset", { exact: false })).toBeInTheDocument();
  });

  it("pages by the server's cursor", async () => {
    const user = userEvent.setup();
    const calls = await open({ updates: (path) => reply(path.includes("before=u1") ? page([item(1)]) : page([item(4), item(3)], "u1")) });
    await user.click(screen.getByRole("button", { name: "Older page" }));
    await screen.findByText("Page 2");
    expect(calls).toContain("/api/canton/updates?limit=25&before=u1");
    expect(rows()).toHaveLength(1);
  });
});

describe("one Canton update", () => {
  const open = async (h: Parameters<typeof route>[0] = {}, id = update(3)) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const calls = fakeApi(route({ update: () => reply(detail()), ...h }));
    renderApp(`/canton/${id}`);
    await screen.findByRole("heading", { name: "Canton update" });
    return calls;
  };
  const side = (name: string) => within(screen.getByRole("region", { name }));
  const row = (scope: ReturnType<typeof within>, label: string) => scope.getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement;

  it("shows the update as the reader party sees it: id, record time, synchronizer, offset and template", async () => {
    const calls = await open();
    expect(calls).toContain(`/api/canton/updates/${update(3)}`);
    const c = side("On Canton");
    expect(row(c, "Update id")).toHaveTextContent(update(3));
    expect(row(c, "Record time")).toHaveTextContent("2026-10-04T01:37:13.230583Z");
    expect(row(c, "Record time")).toHaveTextContent("22 min 47 s ago");
    expect(row(c, "Synchronizer id")).toHaveTextContent(SYNC);
    expect(row(c, "Offset")).toHaveTextContent("63");
    expect(row(c, "Offset")).toHaveTextContent("on the reader's participant");
    expect(row(c, "Template")).toHaveTextContent("Zk.Chain:BlockRecord · package zk-chain");
    expect(row(c, "Signed by")).toHaveTextContent("the chain's operator operator::1220…abab");
  });

  it("labels what comes from the producer's log, and leaves it out when the journal does not hold the update", async () => {
    await open();
    const c = side("On Canton");
    expect(row(c, "Command id")).toHaveTextContent("advance-3-1");
    expect(row(c, "Command id")).toHaveTextContent("producer log");
    expect(row(c, "Submitted")).toHaveTextContent("Zk.Chain:ZkChain · choice Advance");
    expect(row(c, "Carried")).toHaveTextContent("2,080 bytes in the argument");
  });

  it("has no producer facts when the journal does not hold the update", async () => {
    await open({ update: () => reply(detail({ producerRecord: null })) });
    expect(screen.queryByText("Command id")).toBeNull();
  });

  it("links to the block it carries, and to its neighbours", async () => {
    await open();
    expect(screen.getByText("the record of block 3")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open block 3 →" })).toHaveAttribute("href", "/block/3");
    const nav = within(screen.getByRole("navigation", { name: "Neighbouring blocks" }));
    expect(nav.getByRole("link", { name: "block 2" })).toHaveAttribute("href", "/block/2");
    expect(nav.getByRole("link", { name: "block 4" })).toHaveAttribute("href", "/block/4");
    expect(row(side("On the EVM"), "Block hash")).toHaveTextContent(hash(3));
  });

  it("says Not found with the server's words for an update it does not hold", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    fakeApi(route({ update: () => reply({ error: NOT_FOUND }, 404) }));
    renderApp(`/canton/${update(9)}`);
    expect(await screen.findByRole("heading", { name: "Not found" })).toBeInTheDocument();
  });
});
