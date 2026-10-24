// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contractDetail, contractItem, fakeApi, page, renderApp, reply, route, status, type Reply } from "../test-utils.tsx";

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
async function open(h: { openapi?: () => Reply; rpc?: boolean; faucet?: () => Reply; contracts?: (arg: string, sub: string, path: string) => Reply } = {}) {
  const calls = fakeApi(route({ faucet: h.faucet, contracts: h.contracts, openapi: h.openapi ?? (() => reply(doc())), status: () => reply(status({ publicRpc: h.rpc ?? true })) }));
  renderApp("/docs/api");
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

describe("the Etherscan-compatible header", () => {
  it("is one head row across the card with the note beside the title, above the modules and the example", async () => {
    await open({ openapi: () => reply(doc({ paths: { ...doc().paths, ...door } })) });
    const section = (await screen.findByRole("region", { name: "Etherscan-compatible API" }));
    const head = section.querySelector(":scope > .card-head")!;
    expect(head).not.toBeNull();
    const title = head.querySelector(".card-title")!;
    expect(within(title as HTMLElement).getByRole("heading", { name: "Etherscan-compatible API", level: 2 })).toBeInTheDocument();
    // a sibling of the other cards: every card heading on the page is an h2, under the one h1
    const levels = screen.getAllByRole("heading").map((h) => h.tagName);
    expect(levels.filter((t) => t === "H1")).toHaveLength(1);
    expect(levels.filter((t) => t !== "H1" && t !== "H2")).toEqual([]);
    expect(title.querySelector(".muted")!.textContent).toMatch(/apikey is accepted and ignored/);
    expect(section.querySelector(":scope > .api-eth-grid table")).not.toBeNull();
  });
});

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

  it("tells the wallet's details in a table: network name, RPC, chain id with its hex, coin, explorer, and that only final blocks are served", async () => {
    await open();
    const card = await screen.findByRole("region", { name: /to your wallet/ });
    const t = within(card).getByRole("table", { name: "Wallet details" });
    const row = (k: string) => within(t).getByText(k).closest("tr")!;
    expect(row("Network name")).toHaveTextContent("Ostia DevNet");
    expect(row("RPC address")).toHaveTextContent(`${location.origin}/rpc`);
    expect(row("Chain id")).toHaveTextContent("770101 · 0xbc035");
    expect(row("Coin")).toHaveTextContent("tROME, 18 decimals");
    expect(row("Explorer")).toHaveTextContent(location.origin);
    expect(row("Final only")).toHaveTextContent('"latest" is the newest final block; a block being proven is not served');
    expect(within(card).getByRole("button", { name: /Add .* to your wallet/ })).toBeInTheDocument();
  });

  it("marks the wallet table's URLs with break points after '//', each '.' and each '/', so a narrow cell wraps between words", async () => {
    await open();
    const card = await screen.findByRole("region", { name: /to your wallet/ });
    const t = within(card).getByRole("table", { name: "Wallet details" });
    for (const k of ["RPC address", "Explorer"]) {
      const m = within(t).getByText(k).closest("tr")!.querySelector(".mono")!;
      const wbrs = m.querySelectorAll("wbr").length;
      expect(wbrs, k).toBeGreaterThanOrEqual(1);
      expect(m.innerHTML.replace(/<wbr>/g, "")).toBe(m.textContent);
      expect(m.innerHTML).toMatch(/\/\/<wbr>/);
    }
  });

  it("uses the faucet's own address and balance in the balance example, and a placeholder where the faucet is off", async () => {
    const addr = "0x" + "fa".repeat(20);
    await open({ openapi: () => reply(doc({ paths: { ...doc().paths, ...door } })), faucet: () => reply({ on: true, address: addr, balance: "998996990000000000000000", amount: "1", perAddressSeconds: 1, balanceBlock: 21 }) });
    await waitFor(() => expect(screen.getByLabelText("Example request").textContent).toContain(`&address=${addr}`));
    expect(screen.getByLabelText("Example answer").textContent).toContain('"result": "998996990000000000000000"');
    cleanup();
    await open({ openapi: () => reply(doc({ paths: { ...doc().paths, ...door } })) });
    await screen.findByLabelText("Example request");
    expect(screen.getByLabelText("Example request").textContent).toContain("&address=<address>");
    expect(screen.getByLabelText("Example answer").textContent).toContain("<balance in wei");
  });

  it("fills the Foundry example with a verified contract of the chain, and keeps the placeholders where there is none", async () => {
    const A = "0x" + "cb".repeat(20);
    const held = (over = {}) => (arg: string) => (arg === "" ? reply(page([contractItem(0xcb)])) : arg === A ? reply(contractDetail(0xcb, over)) : reply({ error: "No contract is held at that address." }, 404));
    const path = (h: Parameters<typeof open>[0]) => open({ openapi: () => reply(doc({ paths: { ...doc().paths, ...door } })), ...h });
    const calls = await path({ contracts: held() });
    await waitFor(() => expect(screen.getByLabelText("Foundry setup").textContent).toContain(`forge verify-contract ${A}`));
    expect(screen.getByLabelText("Foundry setup").textContent).toContain("src/TestUSD.sol:TestUSD");
    expect(screen.getByLabelText("Foundry setup").textContent).not.toMatch(/<address>|<File>|<Contract>/);
    expect(calls).toContain("/api/contracts?sort=interactions&limit=1&verified=true");
    cleanup();
    await path({});
    await screen.findByLabelText("Foundry setup");
    expect(screen.getByLabelText("Foundry setup").textContent).toContain("forge verify-contract <address>");
    expect(screen.getByLabelText("Foundry setup").textContent).toContain("src/<File>.sol:<Contract>");
    cleanup();
    // A source path or name that is not plain text is not put into the example.
    await path({ contracts: held({ verification: { ...contractDetail().verification!, contractPath: "src/a.sol; rm -rf /", contractName: "<b>" } }) });
    await screen.findByLabelText("Foundry setup");
    expect(screen.getByLabelText("Foundry setup").textContent).toContain("src/<File>.sol:<Contract>");
    expect(screen.getByLabelText("Foundry setup").textContent).not.toContain("rm -rf");
  });

  it("keeps the placeholder answer when the faucet's balance is not of a final block, because the route answers from the final head", async () => {
    const addr = "0x" + "fa".repeat(20);
    for (const balanceBlock of [null, undefined]) {
      await open({ openapi: () => reply(doc({ paths: { ...doc().paths, ...door } })), faucet: () => reply({ on: true, address: addr, balance: "998996990000000000000000", amount: "1", perAddressSeconds: 1, balanceBlock }) });
      await waitFor(() => expect(screen.getByLabelText("Example request").textContent).toContain(`&address=${addr}`));
      expect(screen.getByLabelText("Example answer").textContent).toContain("<balance in wei");
      expect(screen.getByLabelText("Example answer").textContent).not.toContain("998996990000000000000000");
      cleanup();
    }
  });

  it("does not put a hostile or long faucet address or chain name into the examples", async () => {
    await open({ openapi: () => reply(doc({ paths: { ...doc().paths, ...door } })), faucet: () => reply({ on: true, address: "0x<script>" + "z".repeat(500), balance: "12", amount: "1", perAddressSeconds: 1 }) });
    await screen.findByLabelText("Example request");
    await waitFor(() => expect(screen.getByLabelText("Example request").textContent).toContain("&address=<address>"));
    expect(document.body.textContent).not.toContain("<script>");
    expect(screen.getByLabelText("Example answer").textContent).toContain("<balance in wei");
  });

  it("puts the routes table in a scroll box, so a long path never widens the page", async () => {
    await open();
    const t = await screen.findByRole("table", { name: "REST routes" });
    expect(t.parentElement).toHaveClass("scroll");
  });
});
