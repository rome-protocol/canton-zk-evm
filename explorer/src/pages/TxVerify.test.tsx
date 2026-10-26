// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TxVerify } from "./TxVerify.tsx";
import type { Verifier } from "../verify/verifier.ts";

vi.mock("../api.ts", async (orig) => ({ ...(await orig<typeof import("../api.ts")>()), getBlockRecord: async (n: number) => ({ number: n, hash: "0x00", contractId: "c", header: "bb", txs: "cc", proof: "aa" }) }));
afterEach(cleanup);

const AA = "0x" + "aa".repeat(32), CD = "0x" + "cd".repeat(32);
const pins = { programVK: CD, rootC: CD, file: "p.txt", keys: [{ fromBlock: 0, programVK: AA, rootC: AA }, { fromBlock: 500, programVK: CD, rootC: CD }] };

describe("Verify on a transaction's page with more than one program key", () => {
  it.each([[499, AA], [500, CD]])("hands the check the key for block %i", async (number, key) => {
    const verify = vi.fn<Verifier>(() => "fail the proof does not verify");
    render(<TxVerify number={number} blockHash="0x00" pins={pins} final proofBytes={1344} load={async () => ({ verify, bytes: 1 })} />);
    await userEvent.click(screen.getByRole("button", { name: new RegExp(`Verify block ${number}`) }));
    await vi.waitFor(() => expect(verify).toHaveBeenCalled());
    expect(verify.mock.calls[0]![1]).toEqual({ programVK: key, rootC: key });
  });
});
