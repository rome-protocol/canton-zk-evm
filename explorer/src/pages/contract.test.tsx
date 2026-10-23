// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ContractDetail, ContractSource } from "../api.ts";
import { addr, addressDetail, contractDetail, contractSource, fakeApi, page, renderApp, reply, route, unverifiedSource } from "../test-utils.tsx";

const A = addr(0xcb);
const BAD = "Give an address as 0x and 40 hex digits.";
const derived = <T,>(items: T[]) => reply({ ...page(items), derived: true });
interface Seen { detail?: ContractDetail; source?: ContractSource; account?: Parameters<typeof addressDetail>[0] }
async function open(seen: Seen = {}, path = `/contract/${A}?tab=code`) {
  const d = seen.detail ?? contractDetail();
  const calls = fakeApi(route({
    contracts: (a, sub) => (a !== A ? reply({ error: "No contract is held at that address." }, 404) : sub === "source" ? reply(seen.source ?? contractSource()) : reply(d)),
    addresses: (_a, sub) => (sub === "" ? reply(addressDetail({ address: A, kind: "contract", ...seen.account })) : derived([])),
  }));
  renderApp(path);
  await screen.findByRole("heading", { name: "Contract" });
  return calls;
}
const row = (label: string) => screen.getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement;
const card = (name: string) => screen.getByRole("region", { name });

describe("the contract page: the head and the cards", () => {
  it("names the contract, links back to the list, and shows the address in full", async () => {
    await open();
    expect(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("link", { name: "Contracts" })).toHaveAttribute("href", "/contracts");
    expect(screen.getAllByText("TestUSD").length).toBeGreaterThan(0);
    expect(screen.getByText(A)).toBeInTheDocument();
    expect(screen.getByText("Source code verified")).toBeInTheDocument();
  });

  it("shows the coin balance read from reth, and the transactions the explorer counted", async () => {
    await open({ account: { balance: "2500000000000000000", balanceBlock: 21, sentCount: 1, receivedCount: 4, internalCount: 4 } });
    expect(await screen.findByText(/2\.5/)).toBeInTheDocument();
    expect(card("Overview")).toHaveTextContent("final block 21");
    expect(row("Transactions")).toHaveTextContent("5");
    expect(row("Internal calls")).toHaveTextContent("4");
  });

  it("links the token tracker when the contract is a token", async () => {
    await open({ account: { kind: "token", token: { name: "Test USD", symbol: "tUSD", decimals: 6 } } });
    expect(await within(card("Overview")).findByRole("link", { name: /Test USD/ })).toHaveAttribute("href", `/token/${A}`);
  });

  it("shows who made the contract, in which transaction and block", async () => {
    await open();
    const c = card("Creation");
    expect(within(c).getByRole("link", { name: "0xe3e3…e3e3" })).toHaveAttribute("href", `/address/${addr(0xe3)}`);
    expect(within(c).getByRole("link", { name: "0xd7d7…d7d7" })).toHaveAttribute("href", `/tx/${"0x" + "d7".repeat(32)}`);
    expect(within(c).getByRole("link", { name: "Block 18" })).toHaveAttribute("href", "/block/18");
    expect(row("Code")).toHaveTextContent("3,318 bytes");
  });

  it("shows a genesis contract by the genesis convention, with no creator and no creation transaction", async () => {
    await open({ detail: contractDetail(0xcb, { name: null, origin: "genesis", creator: null, creationBlock: null, creationTxHash: null, verified: false, matchType: null, verification: null }), source: unverifiedSource() });
    const c = card("Creation");
    expect(c).toHaveTextContent("GENESIS");
    expect(c).toHaveTextContent("set by the chain, no creation transaction");
    expect(within(c).queryByRole("link")).toBeNull();
  });

  it("says a destroyed contract is destroyed, and in which block", async () => {
    await open({ detail: contractDetail(0xcb, { destroyedBlock: 22 }) });
    expect(card("Creation")).toHaveTextContent("Destroyed in block 22");
  });

  it("shows the verification: the match kind and when it was verified", async () => {
    await open();
    const v = card("Verification");
    expect(v).toHaveTextContent("Full match");
    expect(row("Verified")).toHaveTextContent("2026-10-20 17:24:10 UTC");
    expect(row("Proxy")).toHaveTextContent("Not a proxy");
  });

  it("says a proxy is a proxy, and where it points", async () => {
    await open({ detail: contractDetail(0xcb, { proxy: { kind: "eip1967", implementation: addr(0xee), beacon: null, checkedBlock: 21 } }) });
    expect(row("Proxy")).toHaveTextContent("eip1967");
    expect(within(row("Proxy")).getByRole("link", { name: "0xeeee…eeee" })).toHaveAttribute("href", `/contract/${addr(0xee)}`);
  });

  it("says a contract that is not verified is not verified", async () => {
    await open({ detail: contractDetail(0xcb, { verified: false, matchType: null, verification: null }), source: unverifiedSource() });
    expect(screen.getByText("Source code not verified")).toBeInTheDocument();
    expect(card("Verification")).toHaveTextContent("Not verified");
  });

  it("shows the partial-match note with a partial match", async () => {
    await open({ detail: contractDetail(0xcb, { matchType: "partial" }), source: contractSource(0xcb, { matchType: "partial", matchNote: "Partial match: the metadata differs from this compile." }) });
    expect(card("Verification")).toHaveTextContent("Partial match");
    expect((await screen.findAllByText(/the metadata differs from this compile/)).length).toBeGreaterThan(0);
  });

  it("says a similar match is the same code verified at another address", async () => {
    await open({ detail: contractDetail(0xcb, { matchType: "similar" }), source: unverifiedSource() });
    expect(card("Verification")).toHaveTextContent("Similar match");
    expect(card("Verification")).toHaveTextContent(/same code is verified at another address/);
  });

  it("says when no contract is held at the address", async () => {
    fakeApi(route({ contracts: () => reply({ error: "No contract is held at that address." }, 404) }));
    renderApp(`/contract/${A}`);
    expect(await screen.findByText(/No contract is held at that address/)).toBeInTheDocument();
  });

  it("keeps a bad address as the server's own answer", async () => {
    fakeApi(route({ contracts: () => reply({ error: BAD }, 400) }));
    renderApp("/contract/nope");
    expect(await screen.findByText(BAD)).toBeInTheDocument();
  });
});

describe("the contract page: the tabs", () => {
  it("opens on the transactions, and marks the Code tab as verified", async () => {
    await open({}, `/contract/${A}`);
    expect(screen.getByRole("tab", { name: /Transactions/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /Code/ })).toHaveTextContent("✓");
  });

  it("opens the Code tab from the link, and from a click", async () => {
    await open({}, `/contract/${A}`);
    await userEvent.click(screen.getByRole("tab", { name: /Code/ }));
    expect(await screen.findByRole("region", { name: "Contract source code" })).toBeInTheDocument();
  });
});

describe("the Code tab of a verified contract", () => {
  it("shows the compile: name, compiler, optimization, EVM version, license and source format", async () => {
    await open();
    await screen.findByRole("region", { name: "Contract source code" });
    expect(row("Contract name")).toHaveTextContent("TestUSD");
    expect(row("Compiler")).toHaveTextContent("v0.8.28+commit.7893614a");
    expect(row("Optimization")).toHaveTextContent("Yes, 200 runs");
    expect(row("EVM version")).toHaveTextContent("cancun");
    expect(row("License")).toHaveTextContent("MIT");
    expect(row("Source format")).toHaveTextContent("Standard JSON input, 2 files");
  });

  it("shows the verified source of the contract's own file first, line by line, and another file when picked", async () => {
    await open();
    const src = await screen.findByRole("region", { name: "Contract source code" });
    expect(within(src).getByRole("button", { name: "src/TestUSD.sol" })).toHaveAttribute("aria-pressed", "true");
    expect(src.querySelector("pre")).toHaveTextContent("pragma solidity 0.8.28;");
    await userEvent.click(within(src).getByRole("button", { name: "@openzeppelin/contracts/token/ERC20/ERC20.sol" }));
    expect(src.querySelector("pre")).toHaveTextContent("contract ERC20 {}");
    expect(src.querySelector("pre")).not.toHaveTextContent("pragma solidity");
  });

  it("shows source as text, never as markup", async () => {
    await open({ source: contractSource(0xcb, { files: [{ path: "src/TestUSD.sol", content: "<img src=x onerror=alert(1)>\n<script>1</script>" }] }) });
    const src = await screen.findByRole("region", { name: "Contract source code" });
    expect(src.querySelector("img, script")).toBeNull();
    expect(src.querySelector("pre")).toHaveTextContent("<img src=x onerror=alert(1)>");
  });

  it("offers the sources as a download", async () => {
    await open();
    const link = await screen.findByRole("link", { name: "Download sources" });
    expect(link).toHaveAttribute("download", "TestUSD-sources.json");
    expect(decodeURIComponent(link.getAttribute("href")!)).toContain("pragma solidity 0.8.28;");
  });

  it("shows the ABI as JSON, as text, with the number of entries", async () => {
    await open();
    const abi = await screen.findByRole("region", { name: "Contract ABI" });
    expect(abi).toHaveTextContent("1 entry");
    expect(abi.querySelector("pre")).toHaveTextContent('"name": "balanceOf"');
    await userEvent.click(within(abi).getByRole("button", { name: "Text" }));
    expect(abi.querySelector("pre")).toHaveTextContent("function balanceOf(address account) view returns (uint256)");
  });

  it("shows the compiler settings as they were given at verification, and the constructor arguments decoded", async () => {
    await open({ source: contractSource(0xcb, { abi: [{ type: "constructor", stateMutability: "nonpayable", inputs: [{ name: "initialOwner", type: "address" }] }] }) });
    const s = await screen.findByRole("region", { name: "Compiler settings" });
    expect(s.querySelector("pre")).toHaveTextContent('"runs": 200');
    expect(s).toHaveTextContent("constructor(address initialOwner)");
    expect(within(s).getByRole("link", { name: "0xe3e3…e3e3" })).toHaveAttribute("href", `/address/${addr(0xe3)}`);
  });

  it("shows the constructor arguments as raw hex when the constructor takes a dynamic type", async () => {
    await open({ source: contractSource(0xcb, { abi: [{ type: "constructor", inputs: [{ name: "name", type: "string" }] }], constructorArgs: "0x1234" }) });
    const s = await screen.findByRole("region", { name: "Compiler settings" });
    expect(s).toHaveTextContent("0x1234");
  });

  it("shows the deployed code in hex and as opcodes, with its size and hash", async () => {
    await open();
    const code = await screen.findByRole("region", { name: "Deployed code" });
    expect(code).toHaveTextContent("13 bytes");
    expect(code.querySelector("pre")).toHaveTextContent("0x6080604052");
    await userEvent.click(within(code).getByRole("button", { name: "Opcodes" }));
    expect(code.querySelector("pre")).toHaveTextContent("PUSH1 0x80");
    expect(code.querySelector("pre")).toHaveTextContent("MSTORE");
  });

  it("shows the partial-match note on the Code tab", async () => {
    await open({ detail: contractDetail(0xcb, { matchType: "partial" }), source: contractSource(0xcb, { matchType: "partial", matchNote: "Partial match: the metadata differs from this compile." }) });
    const src = await screen.findByRole("region", { name: "Contract source code" });
    expect(src).toHaveTextContent("Partial match");
    expect(src).toHaveTextContent(/the metadata differs from this compile/);
  });
});

describe("the Code tab of a contract that is not verified", () => {
  const unverified = { detail: contractDetail(0xcb, { name: null, verified: false, matchType: null, verification: null }), source: unverifiedSource() };
  it("points to the forge command and the Etherscan door, with no form", async () => {
    await open(unverified);
    const how = await screen.findByRole("region", { name: "Verify this contract" });
    expect(how.querySelector("pre")).toHaveTextContent(`forge verify-contract ${A}`);
    expect(how.querySelector("pre")).toHaveTextContent(`--verifier-url ${window.location.origin}/api`);
    expect(within(how).getByRole("link", { name: "API" })).toHaveAttribute("href", "/docs/api");
    expect(how.querySelector("input, textarea, form")).toBeNull();
  });

  it("still shows the deployed code, and has no source, ABI or settings", async () => {
    await open(unverified);
    expect(await screen.findByRole("region", { name: "Deployed code" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Contract ABI" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Compiler settings" })).toBeNull();
    await waitFor(() => expect(screen.queryByRole("region", { name: "Contract source code" })).toBeNull());
  });
});

describe("the contract page at the address route", () => {
  it("opens the contract's own page at /address/<contract>, with its Code tab, as the design routes it", async () => {
    await open({}, `/address/${A}`);
    expect(screen.getByRole("tab", { name: /Code/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Read" })).toBeInTheDocument();
  });

  it("keeps an account's own page at /address/<account>", async () => {
    fakeApi(route({ addresses: (_a, sub) => (sub === "" ? reply(addressDetail({ address: A, kind: "account" })) : derived([])) }));
    renderApp(`/address/${A}`);
    await screen.findByRole("heading", { name: "Address" });
    expect(screen.queryByRole("tab", { name: "Read" })).toBeNull();
  });
});
