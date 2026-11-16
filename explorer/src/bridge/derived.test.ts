import { afterEach, describe, expect, it, vi } from "vitest";
import { accountCode, keystoreCode, senderCode } from "./derived.ts";

afterEach(() => vi.unstubAllGlobals());

describe("the Bridge account's code", () => {
  it("is loaded in a build that has the account", async () => {
    vi.stubGlobal("__BRIDGE_ACCOUNT__", true);
    expect(await accountCode()).toHaveProperty("openAccount");
    expect(await senderCode()).toHaveProperty("createSender");
    expect(await keystoreCode()).toHaveProperty("browserKeyStore");
  });
  it("is not loaded, and answers null, in a build without it", async () => {
    vi.stubGlobal("__BRIDGE_ACCOUNT__", false);
    expect(await accountCode()).toBeNull();
    expect(await senderCode()).toBeNull();
    expect(await keystoreCode()).toBeNull();
  });
});
