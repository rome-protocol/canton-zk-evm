// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters } from "viem";
import { addr, contractDetail, contractSource, unverifiedSource } from "../test-utils.tsx";
import { open, TOKEN_ABI } from "./contract-harness.tsx";

const A = addr(0xcb), IMPL = addr(0xdd), ME = addr(0xe3);
afterEach(() => vi.unstubAllGlobals());
const word = (t: string, v: unknown) => encodeAbiParameters([{ type: t }], [v as never]);

describe("the contract page: Read", () => {
  it("reads the final block again on Read again, and calls every function at the new block", async () => {
    let head = 0x15;
    const { rpcCalls } = await open("read", { rpc: (c) => c.method === "eth_blockNumber" ? "0x" + (head).toString(16) : word("string", "x") });
    await within(await screen.findByRole("region", { name: "name" })).findByText("answered at block 21");
    head = 0x16;
    await userEvent.click(screen.getByRole("button", { name: "Read again" }));
    await within(screen.getByRole("region", { name: "name" })).findByText("answered at block 22");
    expect(rpcCalls.filter((c) => c.method === "eth_blockNumber")).toHaveLength(2);
    expect(rpcCalls.filter((c) => c.method === "eth_call" && (c.params[1] as string) === "0x16")).toHaveLength(2);
  });

  it("calls the functions that take nothing at once, through /rpc at the final block, and shows the decoded answers", async () => {
    const { rpcCalls } = await open("read", { rpc: (c) => c.method === "eth_blockNumber" ? "0x15" : (c.params[0] as { data: string }).data === "0x06fdde03" ? word("string", "Test USD") : word("address", ME) });
    const name = await screen.findByRole("region", { name: "name" });
    expect(await within(name).findByText("Test USD")).toBeInTheDocument();
    expect(within(name).getByText("answered at block 21")).toBeInTheDocument();
    const owner = screen.getByRole("region", { name: "owner" });
    expect(await within(owner).findByRole("link", { name: ME })).toHaveAttribute("href", `/address/${ME}`);
    const calls = rpcCalls.filter((c) => c.method === "eth_call");
    expect(calls.length).toBe(2);
    expect(rpcCalls.filter((c) => c.method === "eth_blockNumber")).toHaveLength(1); // the final block is read once for the whole tab
    for (const c of calls) expect(c.params).toEqual([{ to: A, data: expect.stringMatching(/^0x[0-9a-f]{8}$/) }, "0x15"]);
    expect(screen.queryByRole("region", { name: "transfer" })).toBeNull(); // a write is on the Write tab
    expect(screen.getByText(/Nothing is signed and nothing is sent/)).toBeInTheDocument();
  });

  it("asks for typed inputs, encodes them, and shows the answer under the Query button", async () => {
    const { rpcCalls } = await open("read", { rpc: (c) => (c.method === "eth_blockNumber" ? "0x15" : word("uint256", 5000n)) });
    const box = screen.getByRole("region", { name: "allowance" });
    await userEvent.click(within(box).getByRole("button", { name: /allowance/ }));
    await userEvent.type(within(box).getByLabelText("owner (address)"), ME);
    await userEvent.type(within(box).getByLabelText("spender (address)"), addr(0xe6));
    await userEvent.click(within(box).getByRole("button", { name: "Query" }));
    expect(await within(box).findByText("5000")).toBeInTheDocument();
    const call = rpcCalls.find((c) => c.method === "eth_call" && (c.params[0] as { data: string }).data.startsWith("0xdd62ed3e"))!;
    expect((call.params[0] as { data: string }).data).toBe("0xdd62ed3e" + ME.slice(2).padStart(64, "0") + addr(0xe6).slice(2).padStart(64, "0"));
  });

  it("says what is wrong with a field and sends nothing", async () => {
    const { rpcCalls } = await open("read");
    const box = screen.getByRole("region", { name: "allowance" });
    await userEvent.click(within(box).getByRole("button", { name: /allowance/ }));
    await userEvent.type(within(box).getByLabelText("owner (address)"), "0x12");
    await userEvent.click(within(box).getByRole("button", { name: "Query" }));
    expect(await within(box).findByRole("alert")).toHaveTextContent(/address is 0x and 40 hex digits/);
    expect(rpcCalls.filter((c) => c.params[0] && (c.params[0] as { data?: string }).data?.startsWith("0xdd62ed3e"))).toHaveLength(0);
  });

  it("shows a revert as the node worded it, and reads again on request", async () => {
    let n = 0;
    const { rpcCalls } = await open("read", { rpc: (c) => (c.method === "eth_blockNumber" ? "0x15" : ++n <= 2 ? new Error("execution reverted: not today") : word("string", "Test USD")) });
    expect((await screen.findAllByRole("alert"))[0]).toHaveTextContent("execution reverted: not today");
    await userEvent.click(screen.getByRole("button", { name: "Read again" }));
    expect(await screen.findByText("Test USD")).toBeInTheDocument();
    expect(rpcCalls.filter((c) => c.method === "eth_call").length).toBeGreaterThan(2);
  });

  it("reads a proxy with the implementation's ABI, at the proxy's address", async () => {
    const detail = contractDetail(0xcb, { proxy: { kind: "eip1967", implementation: IMPL, beacon: null, checkedBlock: 21 } });
    const { rpcCalls } = await open("read", {
      detail, sources: { [A]: contractSource(0xcb, { abi: [] }), [IMPL]: contractSource(0xdd, { abi: TOKEN_ABI }) },
      rpc: (c) => (c.method === "eth_blockNumber" ? "0x15" : word("string", "Via proxy")),
    });
    expect(await screen.findByText(/Read and Write as proxy/)).toBeInTheDocument();
    expect((await screen.findAllByText("Via proxy")).length).toBeGreaterThan(0);
    for (const c of rpcCalls.filter((x) => x.method === "eth_call")) expect((c.params[0] as { to: string }).to).toBe(A);
  });

  it("says so when a proxy's implementation is not verified and lists the proxy's own functions", async () => {
    const detail = contractDetail(0xcb, { proxy: { kind: "eip1967", implementation: IMPL, beacon: null, checkedBlock: 21 } });
    await open("read", { detail, sources: { [A]: contractSource(0xcb, { abi: TOKEN_ABI }), [IMPL]: unverifiedSource(0xdd) } });
    await waitFor(() => expect(document.body.textContent).toMatch(/is not verified, so the implementation's functions are not known\. These are the proxy's own functions/));
    expect(screen.getByRole("region", { name: "name" })).toBeInTheDocument();
  });

  it("labels the fields of two overloaded functions each its own", async () => {
    const abi = [
      { type: "function", name: "get", stateMutability: "view", inputs: [{ name: "a", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
      { type: "function", name: "get", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
    ];
    await open("read", { sources: { [A]: contractSource(0xcb, { abi }) } });
    await userEvent.click(screen.getByRole("button", { name: "Expand all" }));
    const one = screen.getByLabelText("a (uint256)"), two = screen.getByLabelText("a (address)");
    expect(one.id).not.toBe(two.id);
    await userEvent.type(one, "7");
    expect(two).toHaveValue("");
  });

  it("says the functions are not known while the source is not verified", async () => {
    const { rpcCalls } = await open("read", { sources: { [A]: unverifiedSource(0xcb) }, detail: contractDetail(0xcb, { verified: false, matchType: null, verification: null }) });
    expect(await screen.findByText(/not verified, so its functions are not known/)).toBeInTheDocument();
    expect(rpcCalls.filter((c) => c.method === "eth_call")).toHaveLength(0);
  });

  it("shows every answer as text, never as markup", async () => {
    await open("read", { rpc: (c) => (c.method === "eth_blockNumber" ? "0x15" : word("string", "<img src=x onerror=alert(1)>")) });
    expect((await screen.findAllByText("<img src=x onerror=alert(1)>"))[0]).toBeInTheDocument();
    expect(document.querySelector("img[src='x']")).toBeNull();
  });

  it("opens every function that takes input on Expand all", async () => {
    await open("read");
    expect(screen.queryByLabelText("owner (address)")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Expand all" }));
    await waitFor(() => expect(screen.getByLabelText("owner (address)")).toBeInTheDocument());
  });
});
