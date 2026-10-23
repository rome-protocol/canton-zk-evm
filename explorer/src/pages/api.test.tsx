// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeApi, renderApp, reply, route, status, type Reply } from "../test-utils.tsx";

const LIMITS = { pageSize: 100, rpcPerMinute: 300, rest: { perSecond: 20, burst: 60 }, etherscan: { perSecond: 10, perMinute: 600 }, verification: { perHour: 30, maxBodyKb: 500 }, streams: { perClient: 4 } };
const door = { "/api": { get: { summary: "Etherscan-compatible: the module and the action are in the query.", "x-modules": {
  account: ["balance", "txlist"], contract: ["getabi", "verifysourcecode"], proxy: ["eth_blockNumber"] } } },
  "/v2/api": { get: { summary: "The same door at Etherscan's v2 path." }, post: { summary: "The same door at Etherscan's v2 path." } } };
const doc = (over: Record<string, unknown> = {}) => ({
  openapi: "3.1.0", info: { title: "Ostia explorer API", version: "1", "x-limits": LIMITS },
  paths: {
    "/api/status": { get: { summary: "The status strip: heads, checks, pins." } },
    "/api/blocks/{id}": { get: { summary: "One block. Longer words follow the first sentence." } },
    "/api/faucet": { get: { summary: "The faucet's address and balance." }, post: { summary: "Asks the faucet for coin." } },
    "/api/openapi.json": { get: { summary: "The description of every route." } },
  },
  ...over,
});
async function open(h: { openapi?: () => Reply; rpc?: boolean } = {}) {
  const calls = fakeApi(route({ openapi: h.openapi ?? (() => reply(doc())), status: () => reply(status({ publicRpc: h.rpc ?? true })) }));
  renderApp("/docs/api");
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

describe("the API page", () => {
  it("opens at /docs/api with the three ways in, and the header link to it is marked", async () => {
    await open();
    expect(await screen.findByRole("heading", { name: "API" })).toBeInTheDocument();
    for (const name of ["Etherscan-compatible", "REST", "JSON-RPC"]) expect(screen.getAllByText(name).length).toBeGreaterThan(0);
    expect(within(screen.getByRole("navigation", { name: "Pages" })).getByRole("link", { name: "API" })).toHaveClass("active");
  });

  it("says in plain words, once, that the Etherscan-compatible API is not served, and shows no module table, example or verify setup, while the description does not list /api", async () => {
    await open();
    await screen.findByRole("table", { name: "REST routes" });
    expect(screen.getAllByText("The Etherscan-compatible API is not served yet.")).toHaveLength(1);
    expect(screen.queryByRole("table", { name: "Etherscan-compatible modules" })).toBeNull();
    expect(screen.queryByLabelText("Example request")).toBeNull();
    expect(screen.queryByLabelText("Foundry setup")).toBeNull();
    expect(screen.queryByLabelText("Hardhat setup")).toBeNull();
    expect(document.body.textContent).not.toMatch(/E8a|coming with/);
    expect(screen.getByLabelText("REST routes").textContent).not.toContain("Etherscan-compatible: the module");
  });

  it("draws the module table from the server's description where it lists /api, with an example and no internal ids", async () => {
    await open({ openapi: () => reply(doc({ paths: { ...doc().paths, ...door } })) });
    const table = await screen.findByRole("table", { name: "Etherscan-compatible modules" });
    const rows = within(table).getAllByRole("row");
    expect(rows.map((r) => within(r).getAllByRole("cell")[0]?.textContent)).toEqual(["account", "contract", "proxy"]);
    expect(within(rows[0]!).getByText("txlist")).toBeInTheDocument();
    expect(screen.getByText(/apikey is accepted and ignored/)).toBeInTheDocument();
    const ex = screen.getByLabelText("Example request");
    expect(ex.textContent).toContain(`${location.origin}/api`);
    expect(ex.textContent).toContain("module=account&action=balance");
    expect(screen.getByLabelText("Example answer").textContent).toContain('"status": "1"');
    expect(screen.queryByText("The Etherscan-compatible API is not served yet.")).toBeNull();
    expect(document.body.textContent).not.toMatch(/E8a|coming with/);
    // The /api door is not a REST route.
    expect(within(screen.getByRole("table", { name: "REST routes" })).queryByText("/api")).toBeNull();
    expect(within(screen.getByRole("table", { name: "REST routes" })).queryByText("/v2/api")).toBeNull();
  });

  it("gives Foundry and Hardhat blocks with the explorer's own address and chain id, each with a Copy button that copies its text", async () => {
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, "writeText");
    await open({ openapi: () => reply(doc({ paths: { ...doc().paths, ...door } })) });
    const foundry = await screen.findByLabelText("Foundry setup");
    expect(foundry.textContent).toContain(`--chain-id ${status().chainId}`);
    expect(foundry.textContent).toContain(`--verifier-url ${location.origin}/api`);
    const hardhat = screen.getByLabelText("Hardhat setup");
    expect(hardhat.textContent).toContain(`chainId: ${status().chainId}`);
    await user.click(within(screen.getByRole("region", { name: "Foundry" })).getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(write).toHaveBeenCalledWith(foundry.textContent));
    await user.click(within(screen.getByRole("region", { name: "Hardhat" })).getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(write).toHaveBeenLastCalledWith(hardhat.textContent));
  });

  it("builds the REST table from the fetched description: method, path with :id, the first sentence, and a download link", async () => {
    await open();
    const table = await screen.findByRole("table", { name: "REST routes" });
    const rows = within(table).getAllByRole("row").map((r) => within(r).getAllByRole("cell").map((c) => c.textContent));
    expect(rows).toEqual([
      ["GET", "/api/status", "The status strip: heads, checks, pins."],
      ["GET", "/api/blocks/:id", "One block."],
      ["GET", "/api/faucet", "The faucet's address and balance."],
      ["POST", "/api/faucet", "Asks the faucet for coin."],
      ["GET", "/api/openapi.json", "The description of every route."],
    ]);
    expect(screen.getByRole("link", { name: /openapi\.json/ })).toHaveAttribute("href", "/api/openapi.json");
    expect(screen.getByText(/lists are keyset-paginated, at most 100 a page/)).toBeInTheDocument();
  });

  it("says that the routes cannot be read, instead of drawing an empty table, when the description fails", async () => {
    await open({ openapi: () => reply({ error: "down" }, 502) });
    expect(await screen.findByText(/the routes cannot be read right now/i)).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "REST routes" })).toBeNull();
    expect(screen.getByText("The Etherscan-compatible API is not served yet.")).toBeInTheDocument();
  });

  it("shows the add-to-wallet card where the public RPC is on, and the limits the server states; no rate that the server did not state", async () => {
    await open();
    const card = await screen.findByRole("region", { name: "Rate limits" });
    expect(await within(card).findByText("JSON-RPC")).toBeInTheDocument();
    expect(within(card).getByText("300 a minute")).toBeInTheDocument();
    expect(within(card).getByText("Page size")).toBeInTheDocument();
    expect(within(card).getByText("at most 100 a page")).toBeInTheDocument();
    expect(within(card).getByText(/HTTP 429 with Retry-After/)).toBeInTheDocument();
    // The limits the server applies, as its description states them; the Etherscan ones only while it serves that door.
    expect(within(card).getByText("20 a second, bursts of 60")).toBeInTheDocument();
    expect(within(card).getByText("4 open at a time")).toBeInTheDocument();
    expect(within(card).queryByText("Etherscan-compatible")).toBeNull();
    expect(within(card).queryByText("Verification")).toBeNull();
    expect(screen.getByRole("button", { name: /Add .* to your wallet/ })).toBeInTheDocument();
  });

  it("adds the Etherscan-compatible and verification limits to the card where the description lists /api", async () => {
    await open({ openapi: () => reply(doc({ paths: { ...doc().paths, ...door } })) });
    const card = await screen.findByRole("region", { name: "Rate limits" });
    expect(await within(card).findByText("10 a second and 600 a minute")).toBeInTheDocument();
    expect(within(card).getByText("30 an hour, 500 KB a request")).toBeInTheDocument();
  });

  it("leaves out the JSON-RPC rate and the wallet card where the explorer does not serve the public RPC", async () => {
    await open({ rpc: false, openapi: () => reply(doc({ info: { title: "t", version: "1", "x-limits": { pageSize: 100 } } })) });
    const card = await screen.findByRole("region", { name: "Rate limits" });
    expect(await within(card).findByText("at most 100 a page")).toBeInTheDocument();
    expect(within(card).queryByText("JSON-RPC")).toBeNull();
    expect(screen.queryByRole("button", { name: /to your wallet/ })).toBeNull();
  });
});
