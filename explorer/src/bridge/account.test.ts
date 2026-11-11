import { describe, expect, it, vi } from "vitest";
import { AccountsClient, AccountsError } from "./canton/accounts.ts";
import type { Built } from "./canton/commands.ts";
import { keyFromSignature } from "./canton/key.ts";
import { getTestCoin, oneAtATime, openAccount, optIn } from "./account.ts";

vi.mock("./canton/key.ts", async (original) => ({ ...(await original<typeof import("./canton/key.ts")>()), openKey: vi.fn(async () => ({ publicKey: new Uint8Array(32) })), confirmKey: vi.fn(async () => {}) }));

const id = (tag: string, n: number) => `${tag}::1220${n.toString(16).padStart(2, "0").repeat(32)}`;
const PARTY = id("rome", 0xab), chain = { operator: id("operator", 1), confirmer: id("confirmer", 2), gateway: id("gateway", 3), builder: id("builder", 4), chainId: 770101 };
const DISCLOSED = { templateId: "t", contractId: "d1", createdEventBlob: "blob", synchronizerId: "sync" };
const templates = (submitted: Built[]) => submitted.map((b) => ("CreateCommand" in b.command ? b.command.CreateCommand.templateId : b.command.ExerciseCommand.choice));

const nowait = async () => {};
const acceptance = { contractId: "00aa", arguments: {} };
const open = (twin: boolean, withdrawal: boolean) => ({ depositRequests: [], redeemRequests: [], twinAcceptance: twin ? acceptance : null, withdrawalAcceptance: withdrawal ? acceptance : null });
const key = { publicKey: new Uint8Array(32) };
/** An account whose service has `reads` for the open acceptances, one for each read (the last one repeats). */
const optable = (reads: ReturnType<typeof open>[], submit: (b: Built) => Promise<string>) => {
  let n = 0;
  const client = { openRequests: vi.fn(async () => reads[Math.min(n++, reads.length - 1)]!) };
  return { client, a: { key, party: PARTY, chain, client: client as never, submit } };
};
const conflict = (code: string) => new AccountsError("conflict", 409, "plain words", undefined, code);

describe("opting in", () => {
  it("makes the two standing acceptances, twins first, and is done only when a second read shows both", async () => {
    const submitted: Built[] = [];
    const { a, client } = optable([open(false, false), open(true, true)], async (b) => { submitted.push(b); return "u"; });
    await optIn(a, nowait);
    expect(templates(submitted)).toEqual(["#ostia-twin:Twin.Twin:TwinAcceptance", "#canton-zk-evm:Zk.Chain:WithdrawalAcceptance"]);
    expect((submitted[1]!.command as any).CreateCommand.createArguments).toMatchObject({ party: PARTY, gateway: chain.gateway, chainId: "770101" });
    expect(client.openRequests).toHaveBeenCalledTimes(2);
  });
  it("makes only the acceptance that is missing, and nothing when both are there", async () => {
    const submitted: Built[] = [];
    await optIn(optable([open(true, false), open(true, true)], async (b) => { submitted.push(b); return "u"; }).a, nowait);
    expect(templates(submitted)).toEqual(["#canton-zk-evm:Zk.Chain:WithdrawalAcceptance"]);
    const none: Built[] = [];
    await optIn(optable([open(true, true)], async (b) => { none.push(b); return "u"; }).a, nowait);
    expect(none).toHaveLength(0);
  });
  it("takes already_accepted, for either acceptance, as having it, and still wants to read both", async () => {
    const submitted: Built[] = [];
    await optIn(optable([open(false, false), open(true, true)], async (b) => { submitted.push(b); throw conflict("already_accepted"); }).a, nowait);
    expect(submitted).toHaveLength(2);
  });
  it("does not take any other 409 as having it", async () => {
    for (const code of ["too_many_open", "waiting_for_signature", "account_key_unknown"]) {
      const submit = vi.fn(async () => { throw conflict(code); });
      await expect(optIn(optable([open(false, false)], submit).a, nowait), code).rejects.toMatchObject({ code });
      expect(submit).toHaveBeenCalledTimes(1);
    }
    await expect(optIn(optable([open(false, false)], async () => { throw new AccountsError("conflict", 409, "an old service, no code"); }).a, nowait)).rejects.toMatchObject({ kind: "conflict" });
  });
  it("is not done while either acceptance is still missing from the read: it looks again, then gives up", async () => {
    const sleeps: number[] = [];
    const { a, client } = optable([open(false, false), open(true, false), open(true, false)], async () => "u");
    await expect(optIn(a, async (ms) => { sleeps.push(ms); }, 4)).rejects.toMatchObject({ code: "acceptances_missing" });
    expect(client.openRequests).toHaveBeenCalledTimes(5);   // the first read, then four looks
    expect(sleeps).toHaveLength(3);
    const late = optable([open(false, false), open(true, false), open(true, true)], async () => "u");
    await expect(optIn(late.a, nowait, 4)).resolves.toBeUndefined();   // a read that lags behind the ledger catches up
  });
  it("stops reading, and signs nothing more, once the wallet's account is no longer the one being opened", async () => {
    let live = true;
    const client = { openRequests: vi.fn(async () => { live = false; return open(true, true); }) };
    const a = { key, party: PARTY, chain, client: client as never, submit: vi.fn(async () => "u") };
    await expect(optIn(a, nowait, 8, () => live)).rejects.toMatchObject({ code: "account_closed" });
    expect(client.openRequests).toHaveBeenCalledTimes(1);
  });
  it("stops on any other refusal", async () => {
    const submit = vi.fn(async () => { throw new AccountsError("forbidden", 403, "not on the list"); });
    await expect(optIn(optable([open(false, false)], submit).a, nowait)).rejects.toMatchObject({ kind: "forbidden" });
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

describe("one command of an account at a time", () => {
  const built = (n: number): Built => ({ command: { CreateCommand: { templateId: "t", createArguments: { n } } }, intent: {} as never, disclosedContracts: [] });
  it("sends the same command once while it is on its way, and gives the second press the same answer", async () => {
    let release!: (id: string) => void;
    const run = vi.fn(() => new Promise<string>((done) => { release = done; }));
    const send = oneAtATime(run);
    const first = send(built(1)), second = send(built(1));
    expect(second).toBe(first);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    release("update-1");
    expect(await Promise.all([first, second])).toEqual(["update-1", "update-1"]);
    expect(run).toHaveBeenCalledTimes(1);
    const again = send(built(1));   // once it is over, the same command is a new attempt (it is retried after a failure)
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    release("update-2");
    expect(await again).toBe("update-2");
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("runs a different command only after the one before it ends, whether it ends well or not", async () => {
    const order: string[] = [];
    let release!: () => void;
    const send = oneAtATime(async (b) => {
      const n = (b.command as any).CreateCommand.createArguments.n;
      order.push(`start ${n}`);
      if (n === 1) { await new Promise<void>((done) => { release = done; }); throw new Error("failed"); }
      order.push(`end ${n}`);
      return "u";
    });
    const one = send(built(1)).catch(() => "failed"), two = send(built(2));
    await Promise.resolve();
    expect(order).toEqual(["start 1"]);
    release();
    expect(await one).toBe("failed");
    expect(await two).toBe("u");
    expect(order).toEqual(["start 1", "start 2", "end 2"]);
  });
});

describe("test Canton Coin", () => {
  const acceptContext = async () => ({ choiceContextData: { values: { round: 1 } }, disclosedContracts: [DISCLOSED] });
  const account = (faucet: () => Promise<unknown>, accept: () => Promise<unknown> = acceptContext) => {
    const submitted: Built[] = [];
    const client = { faucet: vi.fn(faucet), acceptContext: vi.fn(accept) };
    const a = { key, party: PARTY, client: client as never, submit: async (b: Built) => { submitted.push(b); return "u"; }, offer: undefined as string | undefined, closed: false };
    return { client, submitted, a };
  };
  it("accepts the offer the faucet makes, with the registry's top-level choice context and contracts", async () => {
    const { a, client, submitted } = account(async () => ({ transferInstructionCid: "00ab" }));
    await expect(getTestCoin(a, "DSO::1220cc")).resolves.toBe("done");
    expect(client.acceptContext).toHaveBeenCalledWith(key, "DSO::1220cc", "00ab", PARTY);
    expect(submitted[0]!.command).toMatchObject({ ExerciseCommand: { contractId: "00ab", choice: "TransferInstruction_Accept", choiceArgument: { extraArgs: { context: { values: { round: 1 } } } } } });
    expect(submitted[0]!.disclosedContracts).toEqual([DISCLOSED]);
    expect(submitted[0]!.intent).toMatchObject({ party: PARTY, kind: "exercise", implementation: "splice-amulet", ignore: ["extraArgs.context"] });
    expect(a.offer).toBeUndefined();
  });
  it("refuses an accept context without choiceContextData at its top level, and signs nothing", async () => {
    for (const answer of [{ choiceContext: { choiceContextData: { values: {} }, disclosedContracts: [] } }, { values: { round: 1 } }, {}]) {
      const { a, submitted } = account(async () => ({ transferInstructionCid: "00ab" }), async () => answer);
      await expect(getTestCoin(a, "DSO::1220cc")).rejects.toMatchObject({ code: "no_choice_context" });
      expect(submitted).toHaveLength(0);
    }
  });
  it("has nothing to accept when the faucet has already completed it", async () => {
    const { a, submitted } = account(async () => ({ completed: true }));
    await expect(getTestCoin(a, "DSO::1220cc")).resolves.toBe("done");
    expect(submitted).toHaveLength(0);
  });
  it("says the faucet is off on a 404, and passes on any other refusal", async () => {
    await expect(getTestCoin(account(async () => { throw new AccountsError("not-found", 404, "no faucet") }).a, "DSO::1220cc")).resolves.toBe("off");
    await expect(getTestCoin(account(async () => { throw new AccountsError("rate-limited", 429, "later") }).a, "DSO::1220cc")).rejects.toMatchObject({ kind: "rate-limited" });
    await expect(getTestCoin(account(async () => ({})).a, "DSO::1220cc")).rejects.toMatchObject({ code: "faucet_no_offer" });
  });
  it("retries a failed accept with the offer it already got, and does not ask the faucet again", async () => {
    let tries = 0;
    const { a, client, submitted } = account(async () => ({ transferInstructionCid: "00ab" }), async () => { if (tries++ === 0) throw new AccountsError("unavailable", 503, "busy"); return acceptContext(); });
    await expect(getTestCoin(a, "DSO::1220cc")).rejects.toMatchObject({ kind: "unavailable" });
    expect(a.offer).toBe("00ab");   // kept
    await expect(getTestCoin(a, "DSO::1220cc")).resolves.toBe("done");
    expect(client.faucet).toHaveBeenCalledTimes(1);
    expect(client.acceptContext).toHaveBeenCalledTimes(2);
    expect(submitted).toHaveLength(1);
    expect(a.offer).toBeUndefined();
    await getTestCoin(a, "DSO::1220cc");   // a later call is a new offer
    expect(client.faucet).toHaveBeenCalledTimes(2);
  });
  it("lets an offer go that the registry no longer knows, so the next call asks for a new one", async () => {
    const { a } = account(async () => ({ transferInstructionCid: "00ab" }), async () => { throw new AccountsError("not-found", 404, "gone"); });
    await expect(getTestCoin(a, "DSO::1220cc")).rejects.toMatchObject({ kind: "not-found" });
    expect(a.offer).toBeUndefined();
  });
  it("lets an offer go when the service relays a registry 404 (a 502 with the registry's status), but keeps it on any other 502 or 503", async () => {
    const relayed = (status: number, body: unknown) => async () => { const c = new AccountsClient("", (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch); return c.acceptContext(await keyFromSignature("0x" + "11".repeat(32) + "22".repeat(32) + "1b"), "DSO::1220cc", "00ab", PARTY); };
    const gone = account(async () => ({ transferInstructionCid: "00ab" }), relayed(502, { error: "the token registry answered HTTP 404", registryStatus: 404 }));
    await expect(getTestCoin(gone.a, "DSO::1220cc")).rejects.toMatchObject({ kind: "unavailable", registryStatus: 404 });
    expect(gone.a.offer).toBeUndefined();
    for (const [status, body] of [[502, { error: "the token registry answered HTTP 500", registryStatus: 500 }], [502, { error: "unreachable" }], [503, { error: "busy" }]] as const) {
      const kept = account(async () => ({ transferInstructionCid: "00ab" }), relayed(status, body));
      await expect(getTestCoin(kept.a, "DSO::1220cc")).rejects.toMatchObject({ kind: "unavailable" });
      expect(kept.a.offer, String(status)).toBe("00ab");
    }
  });
  it("does nothing for an account that was let go", async () => {
    const { a, client, submitted } = account(async () => ({ transferInstructionCid: "00ab" }));
    a.closed = true;
    await expect(getTestCoin(a, "DSO::1220cc")).rejects.toMatchObject({ code: "account_closed" });
    expect(client.faucet).not.toHaveBeenCalled();
    expect(submitted).toHaveLength(0);
  });
});

describe("opening the account", () => {
  const settings = { chain, participant: "PAR::p", partyHint: "rome", accountsBase: "", origin: "https://ostia.example" };
  const fake = (reads: ReturnType<typeof open>[]) => {
    let n = 0;
    return { open: vi.fn(async () => PARTY), openRequests: vi.fn(async () => reads[Math.min(n++, reads.length - 1)]!), prepare: vi.fn(async () => { throw conflict("already_accepted"); }) } as never;
  };
  it("is Ready only when a read of the account shows both acceptances", async () => {
    const account = await openAccount({} as never, "0x1", settings, () => {}, fake([open(true, true), open(true, true)]));
    expect(account).toMatchObject({ party: PARTY, closed: false });
  });
  it("is not Ready while an acceptance is missing from the account", async () => {
    vi.useFakeTimers();
    try {
      const done = openAccount({} as never, "0x1", settings, () => {}, fake([open(true, false)])).catch((e) => e);
      await vi.runAllTimersAsync();
      expect(await done).toMatchObject({ code: "acceptances_missing" });
    } finally { vi.useRealTimers(); }
  });
  it("does nothing more once the wallet's account has changed: no read, no signature, no command", async () => {
    let live = true;
    const client = fake([open(true, true)]) as any;
    client.open = vi.fn(async () => { live = false; return PARTY; });   // the wallet's account changes while the account is being opened
    await expect(openAccount({} as never, "0x1", settings, () => {}, client, () => live)).rejects.toMatchObject({ code: "account_closed" });
    expect(client.openRequests).not.toHaveBeenCalled();
  });
  const history = (account: string, party: string) => {
    const kv = new Map<string, string>([["bridge-history", JSON.stringify([{ ref: "r1", kind: "deposit", asset: "0xa", amount: "1", account, party, at: 1, tx: null, block: null, done: true, stage: null }])]]);
    return { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => void kv.set(k, v), removeItem: (k: string) => void kv.delete(k) };
  };
  /** A service that has no account for this key yet: it asks for the confirm signature before it makes one. */
  const making = (reads: ReturnType<typeof open>[]) => {
    const client = fake(reads) as any;
    client.open = vi.fn(async (_k: unknown, _p: unknown, _h: unknown, confirm: () => Promise<void>) => { await confirm(); return PARTY; });
    return client;
  };
  it("says what is about to happen before the confirm signature: no account yet for this wallet, and what to do if there was one", async () => {
    const notes: string[] = [];
    await openAccount({} as never, "0x1", settings, (n) => notes.push(n), making([open(true, true)]), () => true, undefined, history("0x2", "rome::1220other"));
    expect(notes.find((n) => /has no Canton account on Ostia yet/.test(n))).toMatch(/If you opened one with this wallet before, reject the next pop-up.*second, empty account/);
  });
  it("refuses to make a second account when this browser's records show another account for this wallet address, and signs nothing more", async () => {
    const client = making([open(true, true)]);
    await expect(openAccount({} as never, "0x1", settings, () => {}, client, () => true, undefined, history("0X1", "rome::1220other"))).rejects.toMatchObject({ name: "PageError", code: "second_account" });
    expect(client.openRequests).not.toHaveBeenCalled();
  });

  it("lets an account go: close() stops every command of it", async () => {
    const client = fake([open(true, true)]) as any;
    const account = await openAccount({} as never, "0x1", settings, () => {}, client);
    account.close();
    await expect(account.submit({ command: { CreateCommand: { templateId: "t", createArguments: {} } }, intent: {} as never, disclosedContracts: [] })).rejects.toMatchObject({ code: "account_closed" });
    expect(client.prepare).not.toHaveBeenCalled();
  });
  it("does not start a command that waited its turn when the account is let go while the one before it runs", async () => {
    const client = fake([open(true, true)]) as any;
    const account = await openAccount({} as never, "0x1", settings, () => {}, client);
    let release: () => void = () => {};
    client.prepare = vi.fn(() => new Promise((_, reject) => { release = () => reject(new Error("stopped")); }));
    const cmd = (n: string) => ({ command: { CreateCommand: { templateId: n, createArguments: {} } }, intent: {} as never, disclosedContracts: [] });
    const first = account.submit(cmd("one")).catch((e) => e);
    const second = account.submit(cmd("two")).catch((e) => e);
    await vi.waitFor(() => expect(client.prepare).toHaveBeenCalled());
    account.close();
    release();
    await first;
    expect(await second).toMatchObject({ code: "account_closed" });
    expect(client.prepare).toHaveBeenCalledTimes(1);
  });
});
