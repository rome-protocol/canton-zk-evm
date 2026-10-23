// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { addr, contractDetail, contractSource, fakeApi, renderApp, reply, route, tx, unverifiedSource } from "../test-utils.tsx";
import { TOKEN_ABI } from "./contract-harness.tsx";

const A = addr(0xcb), IMPL = addr(0xdd);
async function open(sources: Record<string, ReturnType<typeof contractSource>>, details: Record<string, unknown> = { [A]: contractDetail() }) {
  fakeApi(route({
    tx: () => reply(tx()),
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
    expect(within(card).getByText("to", { exact: false })).toBeInTheDocument();
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

  it("says the input is not decoded when the contract is not verified, or the call is not in its ABI", async () => {
    const card = await open({ [A]: unverifiedSource() });
    expect(await within(card).findByText(/is not decoded/)).toBeInTheDocument();
    expect(within(card).getByText("0xa9059cbb")).toBeInTheDocument();
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
