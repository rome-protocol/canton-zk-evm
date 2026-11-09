// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWallet } from "./wallet.ts";

const chain = { chainId: 770101, chainName: "Ostia", coin: { symbol: "tROME", decimals: 18 } };

/** A wallet that answers eth_accounts with `accounts` and records every method it is asked. */
function fakeWallet(accounts: string[]) {
  const asked: string[] = [];
  const w = {
    request: vi.fn(async ({ method }: { method: string }) => {
      asked.push(method);
      if (method === "eth_accounts") return accounts;
      if (method === "eth_chainId") return "0x" + chain.chainId.toString(16);
      if (method === "eth_requestAccounts") return accounts;
      throw Object.assign(new Error("unexpected"), { code: 4200 });
    }),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  (window as unknown as { ethereum: unknown }).ethereum = w;
  return asked;
}

afterEach(() => { delete (window as unknown as { ethereum?: unknown }).ethereum; });

describe("useWallet after a reload", () => {
  it("picks up the account the site is already connected to, without asking for a connection", async () => {
    const asked = fakeWallet(["0xAbCdEf0000000000000000000000000000000001"]);
    const { result } = renderHook(() => useWallet(chain));
    await waitFor(() => expect(result.current.account).toBe("0xabcdef0000000000000000000000000000000001"));
    await waitFor(() => expect(result.current.chainId).toBe(chain.chainId));
    expect(result.current.canSend).toBe(true);
    expect(asked).not.toContain("eth_requestAccounts");
  });

  it("stays disconnected when the site is not connected", async () => {
    const asked = fakeWallet([]);
    const { result } = renderHook(() => useWallet(chain));
    await waitFor(() => expect(asked).toContain("eth_accounts"));
    expect(result.current.account).toBeNull();
    expect(asked).not.toContain("eth_requestAccounts");
  });
});
