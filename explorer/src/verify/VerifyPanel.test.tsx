// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VerifyPanel, formatSize, formatTime, type VerifyPanelProps } from "./VerifyPanel.tsx";
import type { BlockFields, Verifier } from "./verifier.ts";

afterEach(cleanup);

const VK = "0xdb79" + "11".repeat(28) + "6d3f";
const ROOT = "0xc3f1" + "22".repeat(28) + "1ac4";
const HASH = "0x35f4" + "33".repeat(28) + "bbb7";
const block: BlockFields = { proofHex: "aa", headerHex: "bb", txsHex: "cc" };
const pass = (txCount = 1, hash = HASH.slice(2)) => `ok ${VK.slice(2)} ${ROOT.slice(2)} ${hash} ${"0".repeat(64)} 3 ${"1".repeat(64)} 1700000000 30000000 21000 ${txCount}`;

/** A check that answers with `line`, and the clock it is timed by: each reading is 12 ms after the one before. */
function fakes(line: string, bytes = 166_000) {
  const verify = vi.fn<Verifier>(() => line);
  const load = vi.fn(async () => ({ verify, bytes }));
  let t = 1000;
  const now = () => (t += 12);
  return { verify, load, now };
}

function panel(over: Partial<VerifyPanelProps> & { line?: string } = {}) {
  const { line = pass(), ...props } = over;
  const f = fakes(line);
  const all: VerifyPanelProps = {
    block, blockHash: HASH, pins: { programVK: VK, rootC: ROOT, file: "prover/fixtures/session.txt" }, proving: false,
    moduleUrl: "/verify.wasm", moduleSize: 170_260, load: f.load, now: f.now, ...props,
  };
  const view = render(<VerifyPanel {...all} />);
  return { ...f, ...view, all };
}

describe("not run", () => {
  it("offers Verify, names the pins and the file, says what the download is, and loads nothing yet", () => {
    const { load } = panel();
    expect(screen.getByRole("heading", { name: "Verify this block in your browser" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verify" })).toBeEnabled();
    expect(screen.getByText("0xdb79…6d3f")).toBeInTheDocument();
    expect(screen.getByText("0xc3f1…1ac4")).toBeInTheDocument();
    expect(screen.getByText("prover/fixtures/session.txt")).toBeInTheDocument();
    expect(screen.getByText(/downloads once, about 170 KB, when you press Verify/)).toBeInTheDocument();
    expect(load).not.toHaveBeenCalled();
  });
  it("keeps the sentence about the download when the page does not know the size, and leaves out only the size", () => {
    panel({ moduleSize: undefined });
    expect(screen.getByText(/The check downloads once when you press Verify\./)).toBeInTheDocument();
    expect(screen.queryByText(/about/)).not.toBeInTheDocument();
  });
});

describe("running", () => {
  it("shows the moment between: the button off and the line that says what is happening", async () => {
    let release: (v: { verify: Verifier; bytes: number }) => void = () => {};
    const load = vi.fn(() => new Promise<{ verify: Verifier; bytes: number }>((r) => { release = r; }));
    panel({ load });
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
    expect(screen.getByText("Running the check in your browser…")).toBeInTheDocument();
    release({ verify: () => pass(), bytes: 1 });
    await screen.findByText("Passed.");
  });
});

describe("passed", () => {
  it("says passed, gives the time measured in the browser and not the download size, and lists what was checked", async () => {
    const { verify } = panel();
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByText("Passed.")).toBeInTheDocument();
    expect(screen.getByText(/Ran in your browser in 12 ms/)).toBeInTheDocument();
    expect(screen.queryByText(/downloaded/)).not.toBeInTheDocument();
    expect(screen.getByText(/the proof verifies under ZisK 1\.3\.1's key/)).toBeInTheDocument();
    expect(screen.getByText(/made it \(this explorer's pins, from/)).toBeInTheDocument();
    expect(screen.getByText(/it commits to block hash/)).toHaveTextContent("it commits to block hash 0x35f4…bbb7, which is this block;");
    expect(screen.getByText(/the header and the 1 transaction are that block's/)).toBeInTheDocument();
    expect(screen.getByText(/Not checked here: the Daml legs, the head and gas-cap checks Daml makes, and that Canton committed the block\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run again" })).toBeEnabled();
    expect(verify).toHaveBeenCalledWith(block, { programVK: VK, rootC: ROOT });
  });
  it("words the transaction count for none, one and many", async () => {
    for (const [n, text] of [[0, "the header is that block's, and it holds no transactions."], [2, "the header and the 2 transactions are that block's."]] as const) {
      const { unmount } = panel({ line: pass(n) });
      await userEvent.click(screen.getByRole("button", { name: "Verify" }));
      expect(await screen.findByText(new RegExp(text.replace(/[.]/g, "\\.")))).toBeInTheDocument();
      unmount();
    }
  });
  it("measures only the check, not the download", async () => {
    // The clock moves 12 ms on each reading. The page reads it twice around the check, whatever the download took.
    const f = fakes(pass());
    const slow = vi.fn(async () => { await new Promise((r) => setTimeout(r, 30)); return { verify: f.verify, bytes: 5 }; });
    panel({ load: slow, now: f.now });
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByText(/Ran in your browser in 12 ms/)).toBeInTheDocument();
  });
});

describe("failed", () => {
  it("shows the check's own reason and says where the check stops", async () => {
    panel({ line: "no the proof does not verify" });
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByText("Failed: the proof does not verify.")).toBeInTheDocument();
    expect(screen.getByText(/That is the check's own answer/)).toBeInTheDocument();
    expect(screen.getByText(/Not checked here/)).toBeInTheDocument();
    expect(screen.queryByText("Passed.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run again" })).toBeEnabled();
  });
  it("gives the time, and not the size", async () => {
    panel({ line: "no the proof does not verify" });
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByText(/Ran in your browser in 12 ms/)).toBeInTheDocument();
    expect(screen.queryByText(/downloaded/)).not.toBeInTheDocument();
  });
  it("does not pass a proof that commits to another block than this one, and does not call that the check's own answer", async () => {
    panel({ line: pass(1, "99".repeat(32)) });
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    await screen.findByText(/The check passed, but/);
    expect(screen.getByRole("status")).toHaveTextContent("The check passed, but the proof is for block 0x9999…9999, not this block (0x35f4…bbb7).");
    expect(screen.queryByText("Passed.")).not.toBeInTheDocument();
    expect(screen.queryByText(/Failed:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/check's own answer/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run again" })).toBeEnabled();
  });
  it("shows both full hashes for a proof that is for another block", async () => {
    const { container } = panel({ line: pass(1, "99".repeat(32)) });
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    await screen.findByText(/The check passed, but/);
    const facts = container.querySelector(".v-facts")!;
    expect(facts).toHaveTextContent("The proof is for" + "0x" + "99".repeat(32));
    expect(facts).toHaveTextContent("This block is" + HASH.toLowerCase());
    expect(screen.getByText(/Ran in your browser in 12 ms/)).toBeInTheDocument();
  });
  it("compares the hash without regard to case or the 0x", async () => {
    panel({ line: pass(1, HASH.slice(2).toUpperCase()) });
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByText("Passed.")).toBeInTheDocument();
  });
  it("says so when the check could not be loaded, and tries the download again on the next press", async () => {
    const good = fakes(pass());
    const load = vi.fn().mockRejectedValueOnce(new Error("The check could not be downloaded (404).")).mockImplementation(good.load);
    panel({ load });
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByText(/Could not run the check here: The check could not be downloaded \(404\)\./)).toBeInTheDocument();
    expect(screen.queryByText(/That is the check's own answer/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Passed.")).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("says so when the answer is not in the check's form", async () => {
    panel({ line: "maybe" });
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByText(/Could not run the check here: .*not in its form/)).toBeInTheDocument();
  });
  it("says so when the pins are not hex", async () => {
    panel({ pins: { programVK: "nope", rootC: ROOT, file: "x" }, load: async () => ({ verify: () => { throw new Error("A pin must be 64 hex digits, with or without 0x."); }, bytes: 1 }) });
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByText(/Could not run the check here: A pin must be 64 hex digits/)).toBeInTheDocument();
  });
});

describe("Checking… is drawn before the check runs", () => {
  it("waits for a frame, then a turn of the event loop, before it calls the check", async () => {
    const order: string[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { order.push("frame"); setTimeout(() => cb(0), 5); return 1; });
    try {
      const f = fakes(pass());
      const verify = vi.fn<Verifier>((...a) => { order.push("check"); return f.verify(...a); });
      panel({ load: async () => ({ verify, bytes: 1 }) });
      await userEvent.click(screen.getByRole("button", { name: "Verify" }));
      await screen.findByText("Passed.");
      expect(order).toEqual(["frame", "check"]);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("downloads once", () => {
  it("loads the module on the first press and reuses it for Run again", async () => {
    const { load, verify } = panel();
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    await userEvent.click(await screen.findByRole("button", { name: "Run again" }));
    await screen.findByText("Passed.");
    expect(load).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(2);
  });
});

describe("while the block is being proven", () => {
  it("is greyed: the button is off, nothing loads, and it says why", async () => {
    const { load, container } = panel({ proving: true, block: null });
    const button = screen.getByRole("button", { name: "Verify" });
    expect(button).toBeDisabled();
    expect(screen.getByText("Verify works on the block record, so it opens once this block is final on Canton.")).toBeInTheDocument();
    expect(container.querySelector(".verify")).toHaveClass("muted-card");
    await userEvent.click(button);
    expect(load).not.toHaveBeenCalled();
    expect(screen.queryByText(/downloads once/)).not.toBeInTheDocument();
  });
  it("is greyed even when a record's fields are passed, and wakes when the block becomes final", async () => {
    const f = fakes(pass());
    const props = (proving: boolean): VerifyPanelProps => ({ block, blockHash: HASH, pins: { programVK: VK, rootC: ROOT, file: "f" }, proving, moduleUrl: "/v.wasm", load: f.load, now: f.now });
    const { rerender } = render(<VerifyPanel {...props(true)} />);
    expect(screen.getByRole("button", { name: "Verify" })).toBeDisabled();
    rerender(<VerifyPanel {...props(false)} />);
    expect(screen.getByRole("button", { name: "Verify" })).toBeEnabled();
  });
});

describe("another block", () => {
  it("goes back to not run, and a late answer for the old block is dropped", async () => {
    let release: (v: { verify: Verifier; bytes: number }) => void = () => {};
    const load = vi.fn(() => new Promise<{ verify: Verifier; bytes: number }>((r) => { release = r; }));
    const { rerender, all } = panel({ load });
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    rerender(<VerifyPanel {...all} blockHash={"0x" + "77".repeat(32)} />);
    expect(screen.getByRole("button", { name: "Verify" })).toBeEnabled();
    release({ verify: () => pass(), bytes: 1 });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("Passed.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verify" })).toBeEnabled();
  });
});

describe("formatTime and formatSize", () => {
  it("give milliseconds under a second, then seconds", () => {
    expect(formatTime(0.2)).toBe("under 1 ms");
    expect(formatTime(12.4)).toBe("12 ms");
    expect(formatTime(999.4)).toBe("999 ms");
    expect(formatTime(1250)).toBe("1.3 s");
  });
  it("give kilobytes, then megabytes", () => {
    expect(formatSize(170_260)).toBe("170 KB");
    expect(formatSize(400)).toBe("1 KB");
    expect(formatSize(2_450_000)).toBe("2.5 MB");
  });
});

// The built module, from the explorer's CI job (VERIFY_WASM is the path of the .wasm file): the panel, with its own loader, fetching the real file.
// The page's fetch is answered with the file's bytes. This runs in Node's WebAssembly, in a jsdom page; a browser test is not part of this.
describe.skipIf(!process.env.VERIFY_WASM)("the panel with the built module", () => {
  const fixture = (path: string) => readFileSync(resolve(import.meta.dirname, "../../..", path));
  const wasm = process.env.VERIFY_WASM ? readFileSync(process.env.VERIFY_WASM) : Buffer.alloc(0);
  const other = JSON.parse(fixture("sidecar/tests/fixtures/block.json").toString()) as { header: string; txs: string };
  // The server's own reader of this file cannot load in a page-like environment, so the two lines are read here.
  const line = (key: string) => new RegExp(`^${key}=(.*)$`, "m").exec(fixture("prover/fixtures/session.txt").toString())![1]!.trim();
  const pins = { programVK: line("programVK"), rootC: line("rootC"), file: "prover/fixtures/session.txt" };

  it("downloads the file, runs the check on a block that is not the proof's, and shows the check's own reason, the time and the size", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(wasm, { headers: { "content-type": "application/wasm" } })));
    try {
      render(<VerifyPanel block={{ proofHex: fixture("prover/fixtures/wrapped-proof.hex").toString().trim(), headerHex: other.header, txsHex: other.txs }} blockHash={HASH}
        pins={pins} proving={false} moduleUrl="/verify.wasm" />);
      await userEvent.click(screen.getByRole("button", { name: "Verify" }));
      await waitFor(() => expect(screen.getByText("Failed: the header does not hash to the proven block hash.")).toBeInTheDocument(), { timeout: 10_000 });
      expect(screen.getByText(/Ran in your browser in/)).toBeInTheDocument();
      expect(screen.queryByText(/downloaded/)).not.toBeInTheDocument();
    } finally { vi.unstubAllGlobals(); }
  });
});
