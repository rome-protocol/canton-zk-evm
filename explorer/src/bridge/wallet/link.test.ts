import { describe, expect, it, vi } from "vitest";
import { Unanswered } from "../canton/accounts.ts";
import { twinAcceptance } from "../canton/commands.ts";
import { Refused } from "../moves/moves.ts";
import { CHAIN, fakeWallet, id, WALLET_PARTY } from "./fake-wallet.ts";
import { linkWallet, WALLET_WORDS } from "./link.ts";

const built = (party = WALLET_PARTY, chain = CHAIN) => twinAcceptance(party, chain);

describe("a connected wallet", () => {
  describe("its account", () => {
    it("is the primary account's party, with the name the page gives the wallet", async () => {
      const w = fakeWallet();
      const link = await linkWallet(w.provider, { name: "Loop" });
      expect(link.party).toBe(WALLET_PARTY);
      expect(link.name).toBe("Loop");
      expect(link.closed).toBe(false);
    });
    it("falls back to the list of accounts when the wallet does not answer for a primary one", async () => {
      const w = fakeWallet();
      const request = w.provider.request;
      w.provider.request = async (args) => { if (args.method === "getPrimaryAccount") throw Object.assign(new Error("no"), { code: 4200 }); return request(args); };
      expect((await linkWallet(w.provider, { name: "W" })).party).toBe(WALLET_PARTY);
    });
    it("is refused, in words, when the wallet has not finished setting the account up, or the party is not a Canton party", async () => {
      const w = fakeWallet();
      w.setStatus("initialized");
      await expect(linkWallet(w.provider, { name: "W" })).rejects.toThrow(/not finished setting up/);
      await expect(linkWallet(fakeWallet({ party: "alice" }).provider, { name: "W" })).rejects.toThrow(Refused);
    });
    it("is refused when the wallet is not connected", async () => {
      const w = fakeWallet();
      w.provider.request = async () => { throw Object.assign(new Error("x"), { code: 4100 }); };
      await expect(linkWallet(w.provider, { name: "W" })).rejects.toThrow(WALLET_WORDS.notConnected);
    });
  });

  describe("a command", () => {
    it("goes to the wallet's prepare-and-execute with a fresh command id, the party to act as, and its disclosed contracts; the answer is the update id", async () => {
      const w = fakeWallet();
      const link = await linkWallet(w.provider, { name: "W", newCommandId: () => "cmd-1" });
      const b = built();
      b.disclosedContracts.push({ templateId: "t", contractId: "c1", createdEventBlob: "blob", synchronizerId: "s" });
      expect(await link.submit(b)).toBe("update-1");
      const sent = w.requests.find((r) => r.method === "prepareExecute")!.params;
      expect(sent).toEqual({ commandId: "cmd-1", commands: [b.command], actAs: [WALLET_PARTY], disclosedContracts: b.disclosedContracts });
      expect(w.commands()).toEqual([b.command]);
    });
    it("leaves disclosed contracts out of the request when there are none", async () => {
      const w = fakeWallet();
      await (await linkWallet(w.provider, { name: "W" })).submit(built());
      expect(w.requests.find((r) => r.method === "prepareExecute")!.params).not.toHaveProperty("disclosedContracts");
    });
    it("is not sent twice while it is on its way, and a different command waits for it", async () => {
      const w = fakeWallet();
      const link = await linkWallet(w.provider, { name: "W" });
      const a = built(), b = built(WALLET_PARTY, { ...CHAIN, gateway: id("gateway", 9) });
      const [one, two, three] = await Promise.all([link.submit(a), link.submit(a), link.submit(b)]);
      expect(one).toBe(two);
      expect(three).not.toBe(one);
      expect(w.requests.filter((r) => r.method === "prepareExecute")).toHaveLength(2);
    });
    it("gets each wallet's answer by its own command id, never another's", async () => {
      const w = fakeWallet({ silent: () => true });
      const link = await linkWallet(w.provider, { name: "W", waitMs: 20, newCommandId: () => "mine" });
      const waiting = link.submit(built());
      await new Promise((r) => setTimeout(r, 1));
      w.emit("txChanged", { status: "executed", commandId: "somebody-else", payload: { updateId: "wrong", completionOffset: 1 } });
      await expect(waiting).rejects.toBeInstanceOf(Unanswered);
    });
    it("says the person declined, in the page's words, when the wallet code is 4001", async () => {
      const w = fakeWallet({ refuse: () => 4001 });
      await expect((await linkWallet(w.provider, { name: "W" })).submit(built())).rejects.toThrow(WALLET_WORDS.declined);
    });
    it("says Canton did not accept it when the ledger refuses (-32003), and that the wallet cannot make it when the method is unsupported", async () => {
      const link = await linkWallet(fakeWallet({ refuse: () => -32003 }).provider, { name: "W" });
      await expect(link.submit(built())).rejects.toThrow(WALLET_WORDS.rejected);
      const link2 = await linkWallet(fakeWallet({ refuse: () => 4200 }).provider, { name: "W" });
      await expect(link2.submit(built())).rejects.toThrow(WALLET_WORDS.cannot);
    });
    it("stops the move with the wallet's own `failed` event as a refusal that changed nothing", async () => {
      const w = fakeWallet({ silent: () => true });
      const link = await linkWallet(w.provider, { name: "W", newCommandId: () => "c" });
      const done = link.submit(built());
      await new Promise((r) => setTimeout(r, 1));
      w.emit("txChanged", { status: "failed", commandId: "c" });
      await expect(done).rejects.toThrow(WALLET_WORDS.failed);
    });
    it("is `Unanswered` when the wallet says nothing in time, with the time the ledger may still take it by, so the move waits and looks before it signs again", async () => {
      const w = fakeWallet({ silent: () => true });
      const link = await linkWallet(w.provider, { name: "W", waitMs: 10, now: () => 1_000_000 });
      const e = await link.submit(built()).catch((x) => x);
      expect(e).toBeInstanceOf(Unanswered);
      expect(e.recordBy).toBe(1_000_000 + 11 * 60_000);
    });
    it("is `Unanswered` for an error that says nothing of whether the wallet took it", async () => {
      const w = fakeWallet();
      const link = await linkWallet(w.provider, { name: "W" });
      const request = w.provider.request;
      w.provider.request = async (args) => { if (args.method === "prepareExecute") throw new Error("socket closed"); return request(args); };
      expect(await link.submit(built()).catch((x) => x)).toBeInstanceOf(Unanswered);
    });
    it("stops listening for the wallet's events when it ends", async () => {
      const w = fakeWallet();
      const link = await linkWallet(w.provider, { name: "W" });
      const off = vi.spyOn(w.provider, "removeListener");
      await link.submit(built());
      expect(off).toHaveBeenCalledWith("txChanged", expect.any(Function));
    });
  });

  describe("reading the ledger", () => {
    it("is a call of the wallet, which answers for its own party", async () => {
      const w = fakeWallet();
      w.holding("5", { admin: "a", id: "Amulet" });
      const link = await linkWallet(w.provider, { name: "W" });
      const answer = (await link.ledgerApi({ requestMethod: "post", resource: "/v2/state/active-contracts-page", body: { eventFormat: { filtersByParty: { [WALLET_PARTY]: { cumulative: [] } } } } })) as { activeContracts: unknown[] };
      expect(answer.activeContracts).toEqual([]);
    });
  });

  describe("losing the account", () => {
    it("says so once when the wallet disconnects, and then sends nothing", async () => {
      const w = fakeWallet();
      const link = await linkWallet(w.provider, { name: "W" });
      const lost = vi.fn();
      link.onLost(lost);
      w.emit("statusChanged", { connection: { isConnected: false } });
      w.emit("statusChanged", { connection: { isConnected: false } });
      expect(lost).toHaveBeenCalledTimes(1);
      expect(link.closed).toBe(true);
      await expect(link.submit(built())).rejects.toThrow(WALLET_WORDS.notConnected);
      await expect(link.ledgerApi({ requestMethod: "get", resource: "/v2/version" })).rejects.toThrow(Refused);
      expect(w.requests.some((r) => r.method === "prepareExecute")).toBe(false);
    });
    it("says so when another account becomes the primary one, or there is none, and not when the same one is listed again", async () => {
      const w = fakeWallet();
      const link = await linkWallet(w.provider, { name: "W" });
      const lost = vi.fn();
      link.onLost(lost);
      w.emit("accountsChanged", [{ primary: true, partyId: WALLET_PARTY }]);
      expect(lost).not.toHaveBeenCalled();
      w.emit("accountsChanged", [{ primary: true, partyId: id("bob", 9) }]);
      expect(lost).toHaveBeenCalledTimes(1);
    });
    it("says so when the list of accounts is empty", async () => {
      const w = fakeWallet();
      const link = await linkWallet(w.provider, { name: "W" });
      const lost = vi.fn();
      link.onLost(lost);
      w.emit("accountsChanged", []);
      expect(lost).toHaveBeenCalledTimes(1);
    });
  });

  describe("disconnecting", () => {
    it("ends the connection through the library's own call when it has one, and the wallet is let go even when that fails", async () => {
      const w = fakeWallet();
      const link = await linkWallet(w.provider, { name: "W", disconnect: async () => { throw new Error("gone"); } });
      await expect(link.disconnect()).resolves.toBeUndefined();
      expect(link.closed).toBe(true);
    });
    it("asks the wallet to disconnect when the library has no call of its own, and stops listening", async () => {
      const w = fakeWallet();
      const link = await linkWallet(w.provider, { name: "W" });
      await link.disconnect();
      expect(w.requests.some((r) => r.method === "disconnect")).toBe(true);
      const lost = vi.fn();
      link.onLost(lost);
      await new Promise((r) => setTimeout(r, 1));
      expect(lost).toHaveBeenCalledTimes(1);   // the account is gone: a late listener is told at once
    });
    it("lets a link go without ending the wallet's connection: no disconnect is asked, the wallet's own events no longer reach it", async () => {
      const w = fakeWallet();
      const disconnect = vi.fn(async () => {});
      const link = await linkWallet(w.provider, { name: "W", disconnect });
      const lost = vi.fn();
      link.onLost(lost);
      link.release();
      expect(link.closed).toBe(true);
      expect(disconnect).not.toHaveBeenCalled();
      expect(w.requests.some((r) => r.method === "disconnect")).toBe(false);
      w.emit("statusChanged", { connection: { isConnected: false } });
      expect(lost).not.toHaveBeenCalled();
    });
  });
});
