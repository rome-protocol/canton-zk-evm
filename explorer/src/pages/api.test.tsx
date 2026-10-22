// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeApi, renderApp, reply, route, status, type Reply } from "../test-utils.tsx";

const doc = (over: Record<string, unknown> = {}) => ({
  openapi: "3.1.0", info: { title: "Ostia explorer API", version: "1", "x-limits": { pageSize: 100, rpcPerMinute: 300 } },
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

  it("lists the Etherscan modules, and says of each that it comes with E8a, since none is built", async () => {
    await open();
    const table = await screen.findByRole("table", { name: "Etherscan-compatible modules" });
    const rows = within(table).getAllByRole("row");
    expect(rows.map((r) => within(r).getAllByRole("cell")[0]?.textContent)).toEqual(["account", "contract", "transaction", "block", "logs", "token", "stats", "proxy", "gastracker"]);
    expect(within(rows[0]!).getByText("txlist")).toBeInTheDocument();
    for (const r of rows) expect(within(r).getByText("coming with E8a")).toBeInTheDocument();
    expect(screen.getByText(/apikey is accepted and ignored/)).toBeInTheDocument();
  });

  it("shows an example request and answer with the chain's id, and says that the example is not served yet", async () => {
    await open();
    const ex = await screen.findByLabelText("Example request");
    expect(ex.textContent).toContain(`${location.origin}/api`);
    expect(ex.textContent).toContain("module=account&action=balance");
    expect(screen.getByLabelText("Example answer").textContent).toContain('"status": "1"');
  });

  it("gives Foundry and Hardhat blocks with the explorer's own address and chain id, each with a Copy button that copies its text", async () => {
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, "writeText");
    await open();
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
    expect(screen.getByRole("table", { name: "Etherscan-compatible modules" })).toBeInTheDocument();
  });

  it("shows the add-to-wallet card where the public RPC is on, and the limits the server states; no rate that the server did not state", async () => {
    await open();
    const card = await screen.findByRole("region", { name: "Rate limits" });
    expect(await within(card).findByText("JSON-RPC")).toBeInTheDocument();
    expect(within(card).getByText("300 a minute")).toBeInTheDocument();
    expect(within(card).getByText("Page size")).toBeInTheDocument();
    expect(within(card).getByText("at most 100 a page")).toBeInTheDocument();
    expect(within(card).getByText(/HTTP 429 with Retry-After/)).toBeInTheDocument();
    expect(within(card).queryByText(/a second/)).toBeNull();
    expect(screen.getByRole("button", { name: /Add .* to your wallet/ })).toBeInTheDocument();
  });

  it("leaves out the JSON-RPC rate and the wallet card where the explorer does not serve the public RPC", async () => {
    await open({ rpc: false, openapi: () => reply(doc({ info: { title: "t", version: "1", "x-limits": { pageSize: 100 } } })) });
    const card = await screen.findByRole("region", { name: "Rate limits" });
    expect(await within(card).findByText("at most 100 a page")).toBeInTheDocument();
    expect(within(card).queryByText("JSON-RPC")).toBeNull();
    expect(screen.queryByRole("button", { name: /to your wallet/ })).toBeNull();
  });
});
