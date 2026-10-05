// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderApp } from "../src/test-utils.tsx";
import { loadVerifier } from "../src/verify/verifier.ts";

/**
 * The pages, running against an explorer that is running with a chain: the real server, the real pages, the real Verify file. They run only when
 * EXPLORER_URL (where the explorer listens) and RUN1_FILE (the demo's results for its first run, which names the block to look at) are set.
 * tests/demo_rehearsal.sh sets them. Nothing here names a block number or a hash: all of it comes from RUN1_FILE.
 */
const explorer = process.env.EXPLORER_URL, resultsFile = process.env.RUN1_FILE;
const WAIT = { timeout: 30_000 };

/** The `key=value` lines of a results file. */
const facts = (text: string) => new Map(text.split("\n").flatMap((line) => { const m = /^([a-z_0-9]+)=(.*)$/.exec(line); return m ? [[m[1]!, m[2]!] as const] : []; }));

/** The pages ask the server they came from, with a path alone: here that server is the explorer under test. */
function useExplorer() {
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", (input: string, init?: RequestInit) => real(new URL(input, explorer), init));
}

/** The value beside a label in one of the page's lists of facts. */
const row = (scope: ReturnType<typeof within>, label: string) => within(scope.getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement);

describe.skipIf(!explorer || !resultsFile)("the pages, with the explorer running against the chain", () => {
  const run1 = facts(resultsFile ? readFileSync(resultsFile, "utf8") : "");

  async function openRun1Block() {
    useExplorer();
    renderApp(`/block/${run1.get("block")}`);
    await screen.findByRole("heading", { name: `Block ${run1.get("block")}` }, WAIT);
    return within(await screen.findByRole("region", { name: "On Canton" }, WAIT));
  }

  it("shows run 1's block with its hash, its Canton side and the update id the demo recorded", async () => {
    expect(run1.get("block"), "the results file names a block").toMatch(/^\d+$/);
    const canton = await openRun1Block();
    // Both are shortened on the page; the button beside each shows the whole value.
    const update = row(canton, "Canton update");
    await userEvent.click(update.getByRole("button", { name: "Show in full" }));
    expect(update.getByText(run1.get("canton_update")!)).toBeInTheDocument();
    const evm = within(screen.getByRole("region", { name: "On the EVM" }));
    const hash = row(evm, "Hash");
    await userEvent.click(hash.getByRole("button", { name: "Show in full" }));
    expect(hash.getByText(run1.get("block_hash")!)).toBeInTheDocument();
    expect(row(canton, "Hashes").getByText(/give the same hash/)).toBeInTheDocument();
    // The claim the demo made is one of the block's transactions, and links to its page.
    expect(screen.getAllByRole("link").map((a) => a.getAttribute("href"))).toContain(`/tx/${run1.get("evm_claim_tx")}`);
  }, 90_000);

  it("shows the proof's own facts against this explorer's pins, which came from the run's guest.txt, with each mismatch said", async () => {
    await openRun1Block();
    // The rehearsal's proof is a stand-in made of one repeated byte, and its pins are 0xcd... and 0xef..., so every fact here is red. If the explorer
    // had fallen back to the pins it carries, the pins named here and the file they came from would be different.
    const group = screen.getByRole("group", { name: "Facts read from the proof" });
    const read = (label: string) => within(group).getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement;
    const verdict = (label: string) => read(label).nextElementSibling as HTMLElement;
    expect(read("Program key")).toHaveTextContent("0xeeee…eeee");
    expect(verdict("Program key")).toHaveTextContent("does not match this explorer's pin 0xcdcd…cdcd");
    expect(read("ZisK release")).toHaveTextContent("0xeeee…eeee");
    expect(verdict("ZisK release")).toHaveTextContent("does not match this explorer's pin 0xefef…efef");
    expect(verdict("Block hash")).toHaveTextContent("not this block's hash");
    expect(screen.getByText(/Read from the proof's own bytes and compared with this explorer's pins, from/)).toHaveTextContent(/compared with this explorer's pins, from guest\.txt\./);
  }, 90_000);

  it("shows the claim's own page, with a link back to the block that holds it", async () => {
    useExplorer();
    renderApp(`/tx/${run1.get("evm_claim_tx")}`);
    await screen.findByRole("heading", { name: /Transaction/ }, WAIT);
    const links = await screen.findAllByRole("link", { name: run1.get("block")! }, WAIT);
    expect(links.map((a) => a.getAttribute("href"))).toContain(`/block/${run1.get("block")}`);
  }, 90_000);

  it("answers Verify on that block with a no: the rehearsal's proof is a stand-in, so it does not verify", async () => {
    await openRun1Block();
    await userEvent.click(await screen.findByRole("button", { name: "Verify" }, WAIT));
    expect(await screen.findByText("Failed: the proof does not verify.", { exact: false }, WAIT)).toBeInTheDocument();
  }, 90_000);

  it("gives the same no from the check itself, run through the pages' own loader on the block's record and the explorer's pins", async () => {
    const get = async (path: string) => (await fetch(new URL(path, explorer))) as Response;
    const { canton } = await (await get(`/api/block/${run1.get("block")}`)).json() as { canton: { proofHex: string; headerHex: string; txsHex: string } };
    const { pins } = await (await get("/api/status")).json() as { pins: { programVK: string; rootC: string } };
    const verify = await loadVerifier(await get("/verify/zk_explorer_verify.wasm"));
    expect(verify({ proofHex: canton.proofHex, headerHex: canton.headerHex, txsHex: canton.txsHex }, pins)).toBe("no the proof does not verify");
  }, 90_000);
});
