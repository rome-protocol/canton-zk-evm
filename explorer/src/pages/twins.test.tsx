// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { StatsMetric, StatsWindow, TwinsOverview } from "../api.ts";
import { REST_FIELDS } from "../../server/rest/fields.ts";
import { addr, fakeApi, hash, renderApp, reply, route, type Reply } from "../test-utils.tsx";
import { series, summary, wave } from "./stats-fixtures.ts";
import { twinCanton, twinLeg, twinLine, twinsOverview } from "./twins-fixtures.ts";

const stats = (p: string): Reply => {
  const u = new URL(p, "http://x");
  return u.pathname === "/api/stats/summary" ? reply(summary()) : reply(series(u.searchParams.get("metric") as StatsMetric, wave(1), { window: u.searchParams.get("window") as StatsWindow }));
};
async function stat(over: Partial<TwinsOverview> | null = {}) {
  const calls = fakeApi(route({ stats, twins: over === null ? undefined : () => reply(twinsOverview(over)) }));
  renderApp("/stats?window=7d");
  await screen.findByRole("heading", { name: "Stats" });
  return calls;
}
async function twins(over: Partial<TwinsOverview> = {}, answer?: () => Reply) {
  const calls = fakeApi(route({ twins: answer ?? (() => reply(twinsOverview(over))) }));
  renderApp("/twins");
  await screen.findByRole("heading", { name: "Twins" });
  return calls;
}
const rowOf = (table: HTMLElement, name: string) => within(table).getAllByRole("row").find((r) => within(r).queryByRole("link", { name }))!;

describe("the recorded answer", () => {
  it("holds the fields the server's lists name, so that the pages are tested on what they will get", () => {
    const t = twinsOverview();
    expect(Object.keys(t).sort()).toEqual([...REST_FIELDS.twins].sort());
    expect(Object.keys(t.vaults[0]!).sort()).toEqual([...REST_FIELDS.twinVault].sort());
    expect(Object.keys(t.twins[0]!).sort()).toEqual([...REST_FIELDS.twinLine].sort());
    expect(Object.keys(t.canton[0]!).sort()).toEqual([...REST_FIELDS.twinCanton].sort());
    expect(Object.keys(t.legs[0]!).sort()).toEqual([...REST_FIELDS.twinLeg].sort());
  });
});

describe("the Canton assets card on Stats", () => {
  it("has a row for each pinned twin and each Canton token, with the supply, what backs it, the mark and the legs", async () => {
    await stat();
    const card = await screen.findByRole("region", { name: "Canton assets" });
    const table = within(card).getByRole("table", { name: "Canton assets" });
    const twin = rowOf(table, "TKA");
    expect(card).toHaveTextContent("2 tokens · twins on Canton and tokens wrapped on Ostia"); expect(twin).toHaveTextContent("500"); expect(twin).toHaveTextContent("twin supply"); expect(twin).toHaveTextContent("in vaults"); expect(twin).toHaveTextContent("matched"); expect(twin).toHaveTextContent("3 locks · 1 release");
    const wrapped = rowOf(table, "wTKB");
    expect(wrapped).toHaveTextContent("123"); expect(wrapped).toHaveTextContent("wrapped supply"); expect(wrapped).toHaveTextContent("123 TKB on Canton"); expect(wrapped).toHaveTextContent("matched"); expect(wrapped).toHaveTextContent("3 holdings");
  });

  it("links each row to its token page and the card to the twins page", async () => {
    await stat();
    const card = await screen.findByRole("region", { name: "Canton assets" });
    expect(within(card).getByRole("link", { name: "TKA" })).toHaveAttribute("href", `/token/${addr(0xb1)}`);
    expect(within(card).getByRole("link", { name: "wTKB" })).toHaveAttribute("href", `/token/${addr(0xd1)}`);
    expect(within(card).getByRole("link", { name: /Open the twins page/ })).toHaveAttribute("href", "/twins");
    expect(within(card).getByRole("tooltip")).toHaveTextContent("Each pair is read at the same block.");
  });

  it("marks a twin whose vaults hold a different amount, a Canton token whose custody differs, and a pair that was not read", async () => {
    await stat({
      twins: [twinLine({ vaultBalance: "480000000", matched: false }), twinLine({ token: addr(0xb2), symbol: "TKC", vaultBalance: null, matched: false })],
      canton: [twinCanton({ matched: false, custody: "1240000000000" }), twinCanton({ token: addr(0xd2), symbol: "wTKD", supply: null, matched: null })],
    });
    const table = within(await screen.findByRole("region", { name: "Canton assets" })).getByRole("table", { name: "Canton assets" });
    expect(rowOf(table, "TKA")).toHaveTextContent("differs");
    expect(rowOf(table, "TKC")).toHaveTextContent("not read"); expect(rowOf(table, "TKC")).toHaveTextContent("not compared");
    expect(rowOf(table, "wTKB")).toHaveTextContent("differs");
    expect(rowOf(table, "wTKD")).toHaveTextContent("not known"); expect(rowOf(table, "wTKD")).toHaveTextContent("not compared");
  });

  it("says plainly that nothing is pinned or wrapped yet", async () => {
    await stat({ twins: [], canton: [] });
    const card = await screen.findByRole("region", { name: "Canton assets" });
    expect(card).toHaveTextContent("No twins are pinned and no Canton tokens are on Ostia yet.");
    expect(within(card).getByRole("link", { name: /Open the twins page/ })).toBeInTheDocument();
  });

  it("names the part that is empty when only one is", async () => {
    await stat({ twins: [] });
    expect(await screen.findByText("No twins are pinned yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "wTKB" })).toBeInTheDocument();
  });

  it("leaves the card out, and the rest of the page alone, when the twins cannot be read", async () => {
    await stat(null);
    expect(screen.queryByRole("region", { name: "Canton assets" })).not.toBeInTheDocument();
    expect(await screen.findByText("Time to final", { selector: ".stat-k" })).toBeInTheDocument();
  });
});

describe("the twins page", () => {
  it("lists the registry: each vault with its code hash and each pinned twin with its decimals", async () => {
    await twins();
    const reg = await screen.findByRole("region", { name: "Registered vaults and twins" });
    expect(within(reg).getByRole("link", { name: /^0xc1c1/ })).toHaveAttribute("href", `/address/${addr(0xc1)}`);
    expect(reg).toHaveTextContent("code hash"); expect(reg.querySelector(`[title="${hash(0x0c)}"]`)).not.toBeNull();
    expect(within(reg).getByRole("link", { name: "TKA" })).toHaveAttribute("href", `/token/${addr(0xb1)}`);
    expect(reg).toHaveTextContent("6 decimals");
    expect(screen.getByRole("heading", { name: "Twins" }).parentElement).toHaveTextContent("through block 21");
  });

  it("has a card for each twin: the supply against the vaults, the check and the legs", async () => {
    await twins({ twins: [twinLine(), twinLine({ token: addr(0xb2), symbol: "TKC", supply: "7000000", vaultBalance: "9000000", matched: false, locks: 2, releases: 0 })] });
    const a = await screen.findByRole("region", { name: "TKA twin" });
    expect(a).toHaveTextContent("Equal: the vaults hold exactly what the twin has in issue."); expect(a).toHaveTextContent("3 locks · 1 release"); expect(a).toHaveTextContent("counted to block 21");
    expect(within(a).getByRole("link", { name: /View token/ })).toHaveAttribute("href", `/token/${addr(0xb1)}`);
    const c = screen.getByRole("region", { name: "TKC twin" });
    expect(c).toHaveTextContent("The vaults hold 2 TKC more than the twin has in issue.");
  });

  it("shows the Canton tokens' custody against the wrapped supply, with the mark and how far apart a pair is", async () => {
    await twins({ canton: [twinCanton(), twinCanton({ token: addr(0xd2), symbol: "wTKD", instrumentId: "TKD", matched: false, custody: "1240000000000" }), twinCanton({ token: addr(0xd3), symbol: "wTKE", instrumentId: "TKE", supply: null, matched: null })] });
    const table = await screen.findByRole("table", { name: "Canton token custody" });
    const ok = rowOf(table, "wTKB");
    expect(ok).toHaveTextContent("123 TKB"); expect(ok).toHaveTextContent("3 holdings"); expect(ok).toHaveTextContent("123 wTKB"); expect(ok).toHaveTextContent("matched"); expect(ok).toHaveTextContent("block 21");
    const off = rowOf(table, "wTKD");
    expect(off).toHaveTextContent("differs by 1"); expect(off).toHaveTextContent("124 TKD");
    expect(rowOf(table, "wTKE")).toHaveTextContent("not known"); expect(rowOf(table, "wTKE")).toHaveTextContent("not compared");
  });

  it("lists the newest locks and releases with their leg, transaction, block and Canton update, each a link", async () => {
    await twins();
    const table = await screen.findByRole("table", { name: "Lock and release legs" });
    const [lock, release] = within(table).getAllByRole("row").slice(1);
    expect(lock).toHaveTextContent("Lock"); expect(lock).toHaveTextContent("100 TKA");
    expect(within(lock!).getByRole("link", { name: "22" })).toHaveAttribute("href", "/block/22");
    expect(lock!.querySelector(`a[href="/leg/${hash(0x72)}"]`)).not.toBeNull();
    expect(lock!.querySelector(`a[href="/tx/${hash(2)}"]`)).not.toBeNull();
    expect(lock!.querySelector(`a[href="/canton/${twinLeg(2).updateId}"]`)).not.toBeNull();
    expect(release).toHaveTextContent("Release"); expect(release).toHaveTextContent("40 TKA");
    expect(release!.querySelector(`a[href="/canton/${twinLeg(1).updateId}"]`)).not.toBeNull();
  });

  it("says that a leg's transaction or Canton update is not there yet", async () => {
    await twins({ legs: [twinLeg(3, { txHash: null, updateId: null })] });
    const row = (await screen.findAllByRole("row")).find((r) => r.textContent?.includes("Lock"))!;
    expect(row).toHaveTextContent("not read yet");
    expect(row.querySelector('a[href^="/tx/"]')).toBeNull();
  });

  it("reads plainly when nothing is pinned, wrapped or locked yet", async () => {
    await twins({ vaults: [], twins: [], canton: [], legs: [], through: null });
    expect(await screen.findByText("No vaults are registered yet.")).toBeInTheDocument();
    expect(screen.getByText("No twins are pinned yet.")).toBeInTheDocument();
    expect(screen.getByText("No Canton tokens are on Ostia yet.")).toBeInTheDocument();
    expect(screen.getByText("No locks or releases yet.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /twin$/ })).not.toBeInTheDocument();
  });

  it("shows a registry service line with a link to its /healthz only when the deployment names it", async () => {
    await twins({ registryService: "https://twins.example.org" });
    const link = await screen.findByRole("link", { name: "https://twins.example.org/healthz" });
    expect(link).toHaveAttribute("href", "https://twins.example.org/healthz");
    expect(link.parentElement).toHaveTextContent("Registry service");
  });

  it("names no registry service when none is set", async () => {
    await twins();
    await screen.findByRole("region", { name: "Registered vaults and twins" });
    expect(screen.queryByText(/Registry service/)).not.toBeInTheDocument();
  });

  it("says that the twins cannot be read, and tries again", async () => {
    await twins({}, () => ({ status: 503, body: { error: "The explorer cannot read the database." } }));
    expect(await screen.findByText("Cannot read the chain")).toBeInTheDocument();
    expect(screen.getByText("The page tries again in a few seconds.")).toBeInTheDocument();
  });
});
