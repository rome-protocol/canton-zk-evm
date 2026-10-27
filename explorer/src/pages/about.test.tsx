// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fakeApi, renderApp, route } from "../test-utils.tsx";

describe("the About page", () => {
  it("holds what the home page and the footer used to say: what the chain is, what is shown and not, and where the numbers come from", async () => {
    fakeApi(route({}));
    renderApp("/about");
    const page = within(await screen.findByRole("heading", { level: 1, name: "What this explorer shows" }).then((h) => h.closest("section")!));
    expect(page.getByText("Ostia is an EVM chain on Canton. Every block is proven with ZisK and then committed to Canton as one transaction, so a transaction is final when its block is final on Canton.")).toBeInTheDocument();
    expect(page.getByText("Every EVM block, transaction and address, and for each final block its record on Canton: update id, record time, synchronizer, offset and the proof.")).toBeInTheDocument();
    expect(page.getByText("Anything else on Canton. Daml legs settled with a block are seen only by their parties, the chain's operator, confirmer, gateway and builder, and each token's registry.")).toBeInTheDocument();
    expect(page.getByText(/reads Canton as the chain's reader party, which is shown the record of every block and nothing else on Canton\. Every number on this site is read from the chain/)).toBeInTheDocument();
  });
});
