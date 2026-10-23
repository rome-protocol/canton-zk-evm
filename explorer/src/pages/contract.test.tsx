// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressTransferItem, ContractDetail, ContractSource, TokenDetail } from "../api.ts";
import { addr, addressDetail, contractDetail, contractSource, fakeApi, page, renderApp, reply, route, tick, tokenDetail, tokenTransfer, unverifiedSource } from "../test-utils.tsx";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const A = addr(0xcb);
const BAD = "Give an address as 0x and 40 hex digits.";
const derived = <T,>(items: T[]) => reply({ ...page(items), derived: true });
interface Seen { detail?: ContractDetail; source?: ContractSource; account?: Parameters<typeof addressDetail>[0]; token?: TokenDetail; tokenError?: number; transfers?: AddressTransferItem[]; addressError?: number; hold?: Promise<unknown> }
async function open(seen: Seen = {}, path = `/contract/${A}?tab=code`) {
  const d = seen.detail ?? contractDetail();
  const calls = fakeApi(route({
    contracts: (a, sub) => (a !== A ? reply({ error: "No contract is held at that address." }, 404) : sub === "source" ? reply(seen.source ?? contractSource()) : reply(d)),
    addresses: (_a, sub) => (sub === "" ? (seen.addressError ? reply({ error: "Try again shortly." }, seen.addressError) : reply(addressDetail({ address: A, kind: "contract", ...seen.account }))) : derived([])),
    tokenPages: (_a, sub) => (sub === "" ? (seen.tokenError ? reply({ error: "Try again shortly." }, seen.tokenError) : seen.token ? reply(seen.token) : reply({ error: "No token is held at that address." }, 404)) : derived(sub === "transfers" ? (seen.transfers ?? []) : [])),
  }));
  // A held reply: the address-detail request is sent at once but answered only when the test lets it go.
  if (seen.hold) { const answer = globalThis.fetch; vi.stubGlobal("fetch", async (input: string) => { if (input === `/api/addresses/${A}`) { calls.push(`sent ${input}`); await seen.hold; } return answer(input); }); }
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
    expect(row("Verified")).toHaveTextContent("20 Oct 2026, 17:24:10 UTC");
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

describe("the contract page: the chip and the counts", () => {
  it("names a token's standard in the head and counts the transactions and the token transfers on their tabs", async () => {
    await open({ account: { sentCount: 5, receivedCount: 2, tokenTransferCount: 6 } });
    expect(screen.getByRole("heading", { name: "Contract" }).parentElement).toHaveTextContent("ERC-20");
    await waitFor(() => expect(screen.getByRole("tab", { name: "Transactions 7" })).toBeInTheDocument());
    expect(screen.getByRole("tab", { name: "Token transfers 6" })).toBeInTheDocument();
  });

  it("says it is reading the balance, not that it is not known, while the address is being read", async () => {
    fakeApi(route({ contracts: (_a, sub) => (sub === "source" ? reply(contractSource()) : reply(contractDetail())) }));
    const answered = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string, init?: RequestInit) => (input.startsWith("/api/addresses/") ? new Promise<Response>(() => {}) : answered(input, init)));
    renderApp(`/contract/${A}`);
    await screen.findByRole("heading", { name: "Contract" });
    expect(screen.getByRole("region", { name: "Overview" })).toHaveTextContent("Reading…");
    expect(screen.getByRole("region", { name: "Overview" })).not.toHaveTextContent("Not known yet");
  });
});

describe("the contract page: a token contract", () => {
  const token = { account: { kind: "token" as const, token: { name: "Test USD", symbol: "tUSD", decimals: 6 }, tokenTransferCount: 6 } };

  it("shows the holder count on the token tracker row, from the token's own page", async () => {
    await open({ ...token, token: tokenDetail(0xcb, { holderCount: 5 }) });
    await waitFor(() => expect(row("Token tracker")).toHaveTextContent("5 holders"));
    expect(row("Token tracker")).toHaveTextContent("Test USD (tUSD)");
  });

  it("shows the token tracker row as the screen does: the document icon, the name, and a tick when the source is verified", async () => {
    await open({ ...token, detail: contractDetail(0xcb, { verified: true }), token: tokenDetail(0xcb, { holderCount: 5 }) });
    const cell = await within(card("Overview")).findByRole("link", { name: /Test USD \(tUSD\)/ });
    expect(cell.querySelector("svg")).not.toBeNull();
    expect(cell).toHaveAttribute("href", `/token/${A}`);
    expect(within(row("Token tracker")).getByRole("img", { name: "Verified" })).toBeInTheDocument();
    expect(row("Token tracker")).toHaveTextContent("5 holders");
  });

  it("shows no tick on the token tracker row while the source is not verified", async () => {
    await open({ ...token, detail: contractDetail(0xcb, { verified: false }) });
    await within(card("Overview")).findByRole("link", { name: /Test USD/ });
    expect(within(row("Token tracker")).queryByRole("img", { name: "Verified" })).toBeNull();
  });

  it("says one holder in the singular, and shows no count while the token page has not answered", async () => {
    await open({ ...token, token: tokenDetail(0xcb, { holderCount: 1 }) });
    await waitFor(() => expect(row("Token tracker")).toHaveTextContent("1 holder"));
    expect(row("Token tracker")).not.toHaveTextContent("1 holders");
  });

  it("shows no holder count for a token the token route does not know", async () => {
    await open(token);
    await within(card("Overview")).findByRole("link", { name: /Test USD/ });
    expect(row("Token tracker")).not.toHaveTextContent("holder");
  });

  it("shows the token's own transfers on the Token transfers tab, read from the token's route", async () => {
    const calls = await open({ ...token, token: tokenDetail(0xcb), transfers: [tokenTransfer(1, { amount: "2500000" })] }, `/contract/${A}?tab=token-transfers`);
    await screen.findByRole("region", { name: "Transfers" });
    await waitFor(() => expect(calls.some((c) => c.startsWith(`/api/tokens/${A}/transfers`))).toBe(true));
    expect(calls.some((c) => c.startsWith(`/api/addresses/${A}/token-transfers`))).toBe(false);
    expect(await screen.findByText(/2\.5/)).toBeInTheDocument();
  });

  it("counts the token's own transfers on the tab of a token contract", async () => {
    await open({ ...token, token: tokenDetail(0xcb, { transferCount: 42 }) });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Token transfers 42" })).toBeInTheDocument());
  });

  it.each([429, 503])("shows neither a count nor the address's list on a token's Token transfers tab when the token route answers %i", async (code) => {
    const calls = await open({ account: { kind: "token", token: { name: "Test USD", symbol: "tUSD", decimals: 6 }, tokenTransferCount: 0 }, tokenError: code }, `/contract/${A}?tab=token-transfers`);
    expect(await screen.findByText("Cannot read the chain")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Token transfers" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Token transfers 0" })).toBeNull();
    expect(calls.some((c) => c.startsWith(`/api/addresses/${A}/token-transfers`))).toBe(false);
  });

  it("falls back to the address's own transfers and count when the token route answers 404 for a token-kind contract", async () => {
    const calls = await open({ account: { kind: "token", token: { name: "Test USD", symbol: "tUSD", decimals: 6 }, tokenTransferCount: 2 } }, `/contract/${A}?tab=token-transfers`);
    await waitFor(() => expect(calls.some((c) => c.startsWith(`/api/addresses/${A}/token-transfers`))).toBe(true));
    expect(screen.getByRole("tab", { name: "Token transfers 2" })).toBeInTheDocument();
  });

  it("mounts no transfers list while the address-detail reply is held, and the right one when it comes", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    const calls = await open({ account: { kind: "token", token: { name: "Test USD", symbol: "tUSD", decimals: 6 }, tokenTransferCount: 0 }, token: tokenDetail(), hold }, `/contract/${A}?tab=token-transfers`);
    expect(await screen.findByText("Reading the transfers…")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toContain(`sent /api/addresses/${A}`);
    expect(calls.some((c) => c.includes("/token-transfers") || c.includes("/transfers"))).toBe(false);
    release();
    await waitFor(() => expect(calls.some((c) => c.startsWith(`/api/tokens/${A}/transfers`))).toBe(true));
    await waitFor(() => expect(screen.queryByText("Reading the transfers…")).toBeNull());
    expect(calls.some((c) => c.startsWith(`/api/addresses/${A}/token-transfers`))).toBe(false);
  });

  it("shows the error card, not an endless 'Reading the transfers…', when address-detail fails", async () => {
    await open({ addressError: 503 }, `/contract/${A}?tab=token-transfers`);
    expect(await screen.findByText("Cannot read the chain")).toBeInTheDocument();
    expect(screen.getByText("The page tries again in a few seconds.")).toBeInTheDocument();
    expect(screen.queryByText("Reading the transfers…")).toBeNull();
  });

  it("reads address-detail again by itself after an error, and the list mounts when it answers", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const seen: Seen = { addressError: 503, account: { kind: "token", token: { name: "Test USD", symbol: "tUSD", decimals: 6 } }, token: tokenDetail(0xcb) };
    const calls = await open(seen, `/contract/${A}?tab=token-transfers`);
    expect(await screen.findByText("Cannot read the chain")).toBeInTheDocument();
    const reads = () => calls.filter((c) => c === `/api/addresses/${A}`).length;
    const before = reads();
    seen.addressError = 0;
    await tick(5000);
    expect(reads()).toBeGreaterThan(before);
    await waitFor(() => expect(screen.queryByText("Cannot read the chain")).toBeNull());
    await waitFor(() => expect(calls.some((c) => c.startsWith(`/api/tokens/${A}/transfers`))).toBe(true));
  });

  it("keeps a working Token transfers list when a later read of address-detail fails", async () => {
    const seen: Seen = { account: { kind: "token", token: { name: "Test USD", symbol: "tUSD", decimals: 6 } }, token: tokenDetail(0xcb) };
    const calls = await open(seen, `/contract/${A}?tab=token-transfers`);
    await waitFor(() => expect(calls.some((c) => c.startsWith(`/api/tokens/${A}/transfers`))).toBe(true));
    await waitFor(() => expect(screen.queryByText("Reading the transfers…")).toBeNull());
    const reads = () => calls.filter((c) => c === `/api/addresses/${A}`).length;
    const before = reads();
    seen.addressError = 503;
    // The window comes back into view: the stale address-detail is read again, and the read fails.
    await act(async () => { window.dispatchEvent(new Event("visibilitychange")); await new Promise((r) => setTimeout(r, 50)); });
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    expect(screen.queryByText("Cannot read the chain")).toBeNull();
    expect(screen.queryByText("Reading the transfers…")).toBeNull();
  });

  it("keeps the address's own transfers on the Token transfers tab of a contract that is not a token", async () => {
    const calls = await open({ account: { tokenTransferCount: 2 } }, `/contract/${A}?tab=token-transfers`);
    await waitFor(() => expect(calls.some((c) => c.startsWith(`/api/addresses/${A}/token-transfers`))).toBe(true));
    expect(calls.some((c) => c.startsWith(`/api/tokens/${A}/transfers`))).toBe(false);
  });
});

describe("the contract page: when and how it was made and verified", () => {
  it("says how long ago the contract was made, beside its block", async () => {
    await open({ detail: contractDetail(0xcb, { createdAt: new Date(Date.now() - 35.5 * 60_000).toISOString() }) });
    expect(row("Created in")).toHaveTextContent("Block 18");
    expect(row("Created in")).toHaveTextContent("35 min ago");
  });

  it("gives no age for a genesis contract, and none when the explorer did not see it made", async () => {
    await open({ detail: contractDetail(0xcb, { createdAt: null }) });
    expect(row("Created in")).not.toHaveTextContent("ago");
  });

  const verifiedVia = (method: "etherscan" | "api" | null, tool: "forge" | "hardhat" | "remix" | "unknown" | null) =>
    contractDetail(0xcb, { verification: { ...contractDetail().verification!, method, tool } });

  it("says how it was verified: the Etherscan-compatible API with the tool the submitter named", async () => {
    await open({ detail: verifiedVia("etherscan", "forge") });
    expect(row("How")).toHaveTextContent("Etherscan-compatible API · forge verify-contract");
  });

  it("says the tool was not given, and never guesses one, when the submitter named none", async () => {
    await open({ detail: verifiedVia("etherscan", null) });
    expect(row("How")).toHaveTextContent("Etherscan-compatible API · tool not given");
    expect(row("How")).not.toHaveTextContent("forge");
  });

  it("names the explorer's own verify endpoint, and Hardhat, Remix or another tool as given", async () => {
    await open({ detail: verifiedVia("api", "hardhat") });
    expect(row("How")).toHaveTextContent("/api/verify · Hardhat");
  });

  it("says another tool when the tool is none of the three it knows", async () => {
    await open({ detail: verifiedVia("api", "unknown") });
    expect(row("How")).toHaveTextContent("/api/verify · another tool");
  });

  it("says it did not record how a source verified earlier was sent", async () => {
    await open({ detail: verifiedVia(null, null) });
    expect(row("How")).toHaveTextContent("Not recorded");
  });

  it("has no How row for a contract that is not verified", async () => {
    await open({ detail: contractDetail(0xcb, { verification: null, verified: false, matchType: null }) });
    expect(screen.queryByText("How", { selector: "dt" })).toBeNull();
  });
});

describe("the contract page: the EVM version note on the Code tab", () => {
  const evm = (v: string | null) => contractSource(0xcb, { evmVersion: v });

  it("says the chain runs Prague rules and an older version's code runs unchanged", async () => {
    await open({ source: evm("cancun") });
    await screen.findByRole("region", { name: "Contract source code" });
    expect(row("EVM version")).toHaveTextContent(/cancun.*Prague rules; cancun code runs unchanged/);
  });

  it.each([["prague"], [null], ["frontier-next"]])("adds no note for prague itself, for the compiler's default, or for a version it does not know (%s)", async (v) => {
    await open({ source: evm(v) });
    await screen.findByRole("region", { name: "Contract source code" });
    expect(row("EVM version")).not.toHaveTextContent("Prague rules");
  });
});
