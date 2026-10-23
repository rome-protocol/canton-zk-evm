// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { addr, contractDetail, contractSource, fakeApi, labelsOf, renderApp, reply, route, tokenLabel, tx, unverifiedSource } from "../test-utils.tsx";
import { TOKEN_ABI } from "./contract-harness.tsx";

const A = addr(0xcb), IMPL = addr(0xdd);
async function open(sources: Record<string, ReturnType<typeof contractSource>>, details: Record<string, unknown> = { [A]: contractDetail() }, input?: string, labels: ReturnType<typeof tokenLabel>[] = []) {
  fakeApi(route({
    tx: () => reply(input ? tx({ input }) : tx()),
    labels: labelsOf(labels),
    contracts: (a, sub) => (sub === "source" ? reply(sources[a] ?? unverifiedSource()) : details[a] ? reply(details[a]) : reply({ error: "none" }, 404)),
  }));
  renderApp(`/tx/${tx().hash}`);
  await screen.findByRole("heading", { name: "Transaction" });
  return screen.getByRole("region", { name: "Input data" });
}

describe("the transaction page: decoded input", () => {
  it("reads the input with the verified ABI of the contract it called, each argument by name, an address as a link", async () => {
    const card = await open({ [A]: contractSource(0xcb, { abi: TOKEN_ABI }) });
    expect(await within(card).findByText("transfer")).toBeInTheDocument();
    expect(within(card).getByRole("columnheader", { name: "Name" })).toBeInTheDocument();
    expect(within(card).getByRole("cell", { name: "to" })).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: new RegExp(`^${addr(0x5a).slice(0, 8)}`) })).toHaveAttribute("href", `/address/${addr(0x5a)}`);
    expect(within(card).getByText("10000000000000000000")).toBeInTheDocument();
    expect(within(card).getByText("0xa9059cbb")).toBeInTheDocument();
    expect(within(card).queryByText(/is not decoded/)).toBeNull();
  });

  it("uses the implementation's ABI for a call to a proxy", async () => {
    const proxy = contractDetail(0xcb, { proxy: { kind: "eip1967", implementation: IMPL, beacon: null, checkedBlock: 20 } });
    const card = await open({ [A]: unverifiedSource(), [IMPL]: contractSource(0xdd, { abi: TOKEN_ABI }) }, { [A]: proxy });
    expect(await within(card).findByText("transfer")).toBeInTheDocument();
  });

  it("says the input is not decoded when the contract is not verified and the standard interface does not have the call", async () => {
    const card = await open({ [A]: unverifiedSource() }, undefined, "0x12345678" + "0".repeat(64));
    expect(await within(card).findByText(/is not decoded/)).toBeInTheDocument();
    expect(within(card).getByText("0x12345678")).toBeInTheDocument();
  });

  it("reads a call to an unverified token with the standard interface, and says so", async () => {
    const card = await open({ [A]: unverifiedSource() });
    expect(await within(card).findByText("decoded with the standard token interface")).toBeInTheDocument();
    expect(within(card).getByText(/transfer/, { selector: ".fn-name" })).toBeInTheDocument();
  });

  it("says which verified ABI read the call, and switches between Decoded and Raw", async () => {
    const user = userEvent.setup();
    const card = within(await open({ [A]: contractSource(0xcb, { abi: TOKEN_ABI }) }, undefined, undefined, [tokenLabel({ address: A, name: "Test USD", symbol: "tUSD", decimals: 6 })]));
    expect(await card.findByText("decoded with the verified ABI of Test USD (tUSD)")).toBeInTheDocument();
    expect(card.getByRole("button", { name: "Decoded" })).toHaveAttribute("aria-pressed", "true");
    await user.click(card.getByRole("button", { name: "Raw" }));
    expect(card.getByRole("button", { name: "Raw" })).toHaveAttribute("aria-pressed", "true");
    expect(card.queryByRole("table")).toBeNull();
    expect(card.getByText("Method id", { selector: "dt" }).nextElementSibling).toHaveTextContent("0xa9059cbb");
    await user.click(card.getByRole("button", { name: "Decoded" }));
    expect(card.getByRole("table")).toBeInTheDocument();
  });

  it("shows an amount argument in whole units of the token beside its raw digits, and a list of addresses one a line", async () => {
    const abi = [{ type: "function", name: "disperseToken", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }, { name: "recipients", type: "address[]" }, { name: "values", type: "uint256[]" }], outputs: [] }];
    const { encodeFunctionData } = await import("viem");
    const input = encodeFunctionData({ abi, functionName: "disperseToken", args: [A as `0x${string}`, [addr(0x5a), addr(0x5b)] as `0x${string}`[], [1500000000000000000000n, 2500000000000000000000n]] });
    const card = within(await open({ [A]: contractSource(0xcb, { abi }) }, undefined, input, [tokenLabel({ address: A, name: "Test USD", symbol: "tUSD", decimals: 18 })]));
    expect(await card.findByText("= 1,500 tUSD")).toBeInTheDocument();
    expect(card.getByText("1500000000000000000000")).toBeInTheDocument();
    expect(card.getByText("= 2,500 tUSD")).toBeInTheDocument();
    expect(card.getByRole("link", { name: new RegExp(`^${addr(0x5a)}$`, "i") })).toBeInTheDocument();
    expect(card.getByText(/Function:/)).toHaveTextContent("disperseToken(address token, address[] recipients, uint256[] values)");
  });

  it("says the same for a call to an address that is not a contract", async () => {
    const card = await open({}, {});
    expect(await within(card).findByText(/is not decoded/)).toBeInTheDocument();
  });

  it("says the call is not in the verified ABI, not that the ABI is missing, when the input matches none of its functions", async () => {
    const card = await open({ [A]: contractSource(0xcb, { abi: TOKEN_ABI.filter((e) => e.name !== "transfer") }) });
    expect(await within(card).findByText(/not one of the functions of the verified interface/)).toBeInTheDocument();
    expect(within(card).queryByText(/interface is not held/)).toBeNull();
  });
});
