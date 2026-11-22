import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { decodeFunctionData, keccak256, parseAbi, encodeAbiParameters } from "viem";
import { createApi, type Answer } from "../api.ts";
import { createChainDb } from "../chain-db.ts";
import { loadConfig } from "../config.ts";
import { PINS } from "../../test/synthetic-chain.ts";
import { DOCS } from "../rest/openapi.ts";
import { REST_FIELDS as F } from "../rest/fields.ts";
import { RethError } from "../reth.ts";
import { emergencyStateCall, noteOfCall } from "./abi.ts";
import { AGGLAYER_MESSAGE_PATHS, AGGLAYER_PATHS, MESSAGES_OFF, TOO_LARGE, agglayerRoutes, createAgglayerBridge } from "./bridge.ts";
import { AggkitError, type AggkitReader, type BridgeLeaf } from "./aggkit.ts";
import { SIMULATE_FROM, SepoliaBusy, type SepoliaReader } from "./sepolia.ts";
import { agglayerSettings } from "./settings.ts";

const OSTIA = "0x53a0ce7242b616fe706b03b464e5c32ed16e0998", SEPOLIA = "0x528e26b25a34a4a5d0dbda1d57d318153d2ed582";
const BOARD_OSTIA = "0x1111111111111111111111111111111111111111", BOARD_SEPOLIA = "0x2222222222222222222222222222222222222222";
const H = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const A = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const WALLET = A(0xab);
const baseEnv = { AGGLAYER_BRIDGE: "1", AGGLAYER_SEPOLIA_RPC_URL: "https://sepolia.example.invalid/hidden-part-1234", AGGLAYER_OSTIA_BRIDGE: OSTIA, AGGLAYER_SEPOLIA_BRIDGE: SEPOLIA };
const onEnv = { ...baseEnv, AGGLAYER_MESSAGES: "1", AGGLAYER_NOTE_BOARDS: JSON.stringify({ ostia: BOARD_OSTIA, sepolia: BOARD_SEPOLIA }) };
const settings = (env: Record<string, string>) => agglayerSettings(env, (m) => new Error(m))!;
const why = (env: Record<string, string | undefined>) => { try { agglayerSettings(env, (m) => new Error(m)); return null; } catch (e) { return (e as Error).message; } };

const message = (over: Partial<BridgeLeaf> = {}): BridgeLeaf => ({ depositCount: 7, txHash: H(1), blockTimestamp: 1_700_000_000, leafType: 1, globalIndex: "18446744073709551623", originNetwork: 0, originAddress: WALLET, destinationNetwork: 75, destinationAddress: A(0xbeef), amount: "0", metadata: "0x68656c6c6f", ...over });
const token = (over: Partial<BridgeLeaf> = {}): BridgeLeaf => message({ leafType: 0, originAddress: A(0), amount: "2000000000000000", metadata: "0x", ...over });
const proof = { proofLocal: Array.from({ length: 32 }, (_, i) => H(100 + i)), proofRollup: Array.from({ length: 32 }, (_, i) => H(200 + i)), mainnetExitRoot: H(2), rollupExitRoot: H(3) };

interface World {
  leaf?: BridgeLeaf;
  sepoliaClaimed?: boolean; ostiaClaimed?: boolean;
  paused?: boolean; hasCode?: boolean; accepted?: boolean;
  /** What a call to Ostia's reth answers: by default "no" (a word of zero) for the claimed read, and a revert for a simulation when `accepted` is false. */
  note?: string | null; noteReverts?: boolean; ostiaDown?: boolean; sepoliaBusy?: number;
  list?: { in?: BridgeLeaf[]; out?: BridgeLeaf[] }; listDown?: boolean;
}
function build(w: World = {}, env: Record<string, string> = onEnv) {
  const log: string[] = [];
  const aggkit = {
    bridge: async () => w.leaf,
    l1InfoTreeIndex: async () => 5,
    injectedLeaf: async (n: number) => (n === 0 ? { index: 5, blockNumber: 1, timestamp: 1_700_000_100, injectedAt: undefined } : { index: 6, blockNumber: 1, timestamp: 1_700_000_200, injectedAt: 1_700_000_300 }),
    claimProof: async () => proof,
    settlements: async () => [], syncStatus: async () => null, healthy: async () => true,
    messagesFrom: async (network: number, wallet: string, to: number, want: number) => {
      log.push(`list ${network} ${wallet} ${to} ${want}`);
      if (w.listDown) throw new AggkitError("the bridge service cannot be reached");
      return (network === 0 ? w.list?.in : w.list?.out) ?? [];
    },
  } as unknown as AggkitReader;
  const busy = () => { if (w.sepoliaBusy) throw new SepoliaBusy(w.sepoliaBusy); };
  const sepolia = {
    isClaimed: async () => { busy(); return w.sepoliaClaimed ?? false; },
    attached: async () => true,
    paused: async () => { busy(); log.push("sepolia paused"); return w.paused ?? false; },
    hasCode: async (a: string) => { log.push(`sepolia code ${a}`); return w.hasCode ?? true; },
    wouldPass: async (d: string) => { log.push(`sepolia simulate ${d.slice(0, 10)}`); return w.accepted ?? true; },
    noteOf: async (board: string, origin: number, sender: string) => { log.push(`sepolia note ${board} ${origin} ${sender}`); if (w.noteReverts) return null; return w.note ?? null; },
  } as unknown as SepoliaReader;
  const reth = {
    block: async () => ({ number: 500 }),
    callAt: async () => "0x" + (w.ostiaClaimed ? "1" : "0").padStart(64, "0"),
    code: async (a: string) => { log.push(`ostia code ${a}`); return w.hasCode === false ? "0x" : "0x6080"; },
    rpc: async (method: string, params: [{ from?: string; to: string; data: string; gas?: string }, string]) => {
      if (w.ostiaDown) throw new RethError("eth_call: cannot reach reth (down)");
      const p = params[0];
      log.push(`ostia ${method} ${p.from ?? "-"} ${p.to} ${p.data.slice(0, 10)}`);
      if (p.data === noteOfCall(0, WALLET)) { if (w.noteReverts) throw new RethError("eth_call: reth answered \"execution reverted\"", true); return w.note ?? "0x"; }
      if (p.from) { if (w.accepted === false) throw new RethError("eth_call: reth answered \"execution reverted\"", true); return "0x"; }
      return "0x" + (w.paused ? "1" : "0").padStart(64, "0");
    },
  };
  const bridge = createAgglayerBridge({ settings: settings(env), chainId: 770101, chainName: "Ostia", aggkit, sepolia, reth: reth as never });
  const get = async (path: string, ip = "1.2.3.4") => {
    const [p, qs] = path.split("?");
    const served = bridge.routes(p!.split("/").slice(1), new URLSearchParams(qs), ip);
    return served ? served() : undefined;
  };
  return { bridge, get, log };
}
const body = (a: Answer | undefined) => a!.body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const same = (o: object, fields: readonly string[]) => expect(Object.keys(o).sort()).toEqual([...fields].sort());
const claimAbi = parseAbi(["function claimMessage(bytes32[32] a, bytes32[32] b, uint256 globalIndex, bytes32 mainnetExitRoot, bytes32 rollupExitRoot, uint32 originNetwork, address originAddress, uint32 destinationNetwork, address destinationAddress, uint256 amount, bytes metadata)"]);

describe("the message settings", () => {
  it("are off by default, and then read nothing about messages, so a wrong value there stops no one", () => {
    expect(settings(baseEnv).messages).toBeNull();
    expect(settings({ ...baseEnv, AGGLAYER_MESSAGES: "0", AGGLAYER_NOTE_BOARDS: "not json", AGGLAYER_MESSAGE_MAX_BYTES: "x" }).messages).toBeNull();
    expect(settings({ ...baseEnv, AGGLAYER_MESSAGES: "" }).messages).toBeNull();
  });

  it("have defaults: 280 bytes sent, 4096 read, no boards", () => {
    expect(settings({ ...baseEnv, AGGLAYER_MESSAGES: "1" }).messages).toEqual({ maxBytes: 280, readMaxBytes: 4096, noteBoards: { ostia: null, sepolia: null } });
    expect(settings(onEnv).messages!.noteBoards).toEqual({ ostia: BOARD_OSTIA, sepolia: BOARD_SEPOLIA });
    expect(settings({ ...onEnv, AGGLAYER_NOTE_BOARDS: JSON.stringify({ sepolia: BOARD_SEPOLIA.toUpperCase().replace("0X", "0x") }) }).messages!.noteBoards).toEqual({ ostia: null, sepolia: BOARD_SEPOLIA });
  });

  it("take the caps from the environment, and refuse a send cap above the read cap", () => {
    expect(settings({ ...onEnv, AGGLAYER_MESSAGE_MAX_BYTES: "500", AGGLAYER_MESSAGE_READ_MAX_BYTES: "8192" }).messages).toMatchObject({ maxBytes: 500, readMaxBytes: 8192 });
    expect(why({ ...onEnv, AGGLAYER_MESSAGE_MAX_BYTES: "5000" })).toContain("AGGLAYER_MESSAGE_MAX_BYTES must not be above AGGLAYER_MESSAGE_READ_MAX_BYTES");
    expect(why({ ...onEnv, AGGLAYER_MESSAGE_MAX_BYTES: "0" })).toContain("AGGLAYER_MESSAGE_MAX_BYTES must be a whole number from 1");
    expect(why({ ...onEnv, AGGLAYER_MESSAGE_READ_MAX_BYTES: "99999" })).toContain("AGGLAYER_MESSAGE_READ_MAX_BYTES must be a whole number from 1 to 16384");
  });

  it("stop the server at start for a wrong switch, a wrong board or messages without the bridge", () => {
    expect(why({ ...baseEnv, AGGLAYER_MESSAGES: "yes" })).toBe('AGGLAYER_MESSAGES must be 1 or 0, not "yes"');
    expect(why({ AGGLAYER_MESSAGES: "1" })).toBe("AGGLAYER_MESSAGES needs AGGLAYER_BRIDGE=1");
    expect(why({ AGGLAYER_BRIDGE: "0", AGGLAYER_MESSAGES: "1" })).toBe("AGGLAYER_MESSAGES needs AGGLAYER_BRIDGE=1");
    expect(why({ AGGLAYER_MESSAGES: "0" })).toBeNull();
    expect(why({ ...onEnv, AGGLAYER_NOTE_BOARDS: "nope" })).toBe("AGGLAYER_NOTE_BOARDS must be JSON");
    expect(why({ ...onEnv, AGGLAYER_NOTE_BOARDS: JSON.stringify({ ostia: "0x12" }) })).toContain('"ostia" must be 0x and 40 hex digits');
    expect(why({ ...onEnv, AGGLAYER_NOTE_BOARDS: JSON.stringify({ hadrian: BOARD_OSTIA }) })).toContain("which it does not know");
    expect(why({ ...onEnv, AGGLAYER_NOTE_BOARDS: JSON.stringify([BOARD_OSTIA]) })).toContain("not an object");
  });
});

describe("with messages off, as today", () => {
  it("leaves `messages` out of the setup, serves no message deposit, and answers the two new routes 404 in words", async () => {
    const { get, bridge, log } = build({ leaf: message() }, baseEnv);
    expect(JSON.stringify(body(await get("/api/agglayer/setup")))).not.toContain("messages");
    expect(await get("/api/agglayer/deposit?network=0&count=7")).toMatchObject({ status: 404, body: { error: "That deposit is not on a route this page serves." } });
    expect(await get("/api/agglayer/claim?network=0&count=7")).toMatchObject({ status: 404 });
    for (const p of ["messages?wallet=" + WALLET, "note?network=0&sender=" + WALLET]) expect(await get("/api/agglayer/" + p)).toMatchObject({ status: 404, body: { error: MESSAGES_OFF } });
    expect(bridge.messagePaths).toEqual([]);
    expect(log).toEqual([]);
  });

  it("answers the new paths 404 'off' while the whole bridge is off", async () => {
    const off = agglayerRoutes(null);
    for (const p of ["messages", "note"]) expect(await off(["api", "agglayer", p], new URLSearchParams(), "1.1.1.1")!()).toMatchObject({ status: 404, body: { error: "The AggLayer bridge is off on this explorer." } });
  });
});

describe("the setup with messages on", () => {
  it("carries the switch, the send cap and the two note boards, and nothing else new", async () => {
    const b = body(await build().get("/api/agglayer/setup"));
    same(b, F.agglayerSetup);
    same(b.messages, F.agglayerMessages);
    same(b.messages.noteBoards, F.agglayerNoteBoards);
    expect(b.messages).toEqual({ on: true, maxBytes: 280, noteBoards: { ostia: BOARD_OSTIA, sepolia: BOARD_SEPOLIA } });
    expect(JSON.stringify(b)).not.toMatch(/hidden-part-1234|127\.0\.0\.1/);
  });

  it("says null for a board that is not set", async () => {
    const b = body(await build({}, { ...baseEnv, AGGLAYER_MESSAGES: "1" }).get("/api/agglayer/setup"));
    expect(b.messages.noteBoards).toEqual({ ostia: null, sepolia: null });
  });
});

describe("the deposit route for a message", () => {
  it("serves a message leaf with its sender, value and bytes, and the keccak-256 hash of the bytes", async () => {
    const { get } = build({ leaf: message({ amount: "30", metadata: "0x68656c6c6f" }) });
    const b = body(await get("/api/agglayer/deposit?network=0&count=7"));
    expect(b.stage).toBe("ready");
    same(b.leaf, F.agglayerMessageLeaf);
    expect(b.leaf).toEqual({ kind: "message", txHash: H(1), originNetwork: 0, sender: WALLET, destinationNetwork: 75, destinationAddress: A(0xbeef), value: "30", dataHash: keccak256("0x68656c6c6f"), data: "0x68656c6c6f", tooLarge: false });
  });

  it("serves a message with no bytes (its hash is the hash of nothing) and one that is too large with neither bytes nor hash", async () => {
    expect(body(await build({ leaf: message({ metadata: "0x" }) }).get("/api/agglayer/deposit?network=0&count=7")).leaf).toMatchObject({ data: "0x", dataHash: keccak256("0x") });
    expect(body(await build({ leaf: message({ metadata: "0x", tooLarge: true }) }).get("/api/agglayer/deposit?network=0&count=7")).leaf).toMatchObject({ data: null, dataHash: null, tooLarge: true });
  });

  it("serves a message from Ostia to Ethereum too, and not one to a chain this page does not serve", async () => {
    const out = body(await build({ leaf: message({ originNetwork: 75, destinationNetwork: 0 }) }).get("/api/agglayer/deposit?network=75&count=7"));
    expect(out.leaf).toMatchObject({ kind: "message", destinationNetwork: 0 });
    expect(await build({ leaf: message({ destinationNetwork: 9 }) }).get("/api/agglayer/deposit?network=0&count=7")).toMatchObject({ status: 404 });
  });

  it("still serves a token exactly as before, with no message field", async () => {
    const b = body(await build({ leaf: token() }).get("/api/agglayer/deposit?network=0&count=7"));
    same(b.leaf, F.agglayerLeaf);
    expect(b.leaf).toMatchObject({ amount: "2000000000000000" });
  });
});

describe("the claim route for a message", () => {
  const url = "/api/agglayer/claim?network=0&count=7";

  it("hands out claimMessage calldata from the same proof parts, to the bridge on the destination, after every check passed", async () => {
    const { get, log } = build({ leaf: message({ originNetwork: 75, destinationNetwork: 0, destinationAddress: A(0xbeef), amount: "9", metadata: "0x6869" }) });
    const b = body(await get("/api/agglayer/claim?network=75&count=7"));
    expect(b).toMatchObject({ claimed: false, destinationNetwork: 0, chainId: 11155111, to: SEPOLIA, l1InfoTreeIndex: 5 });
    same(b, F.agglayerClaim);
    const d = decodeFunctionData({ abi: claimAbi, data: b.data });
    expect(d.functionName).toBe("claimMessage");
    expect(d.args.slice(2).map((x) => (typeof x === "string" && x.length === 42 ? x.toLowerCase() : x))).toEqual([18446744073709551623n, H(2), H(3), 75, WALLET, 0, A(0xbeef), 9n, "0x6869"]);
    expect(d.args[0]).toEqual(proof.proofLocal);
    expect(b.args).toMatchObject({ originNetwork: 75, originTokenAddress: WALLET, amount: "9", metadata: "0x6869" });
    expect(log).toEqual(["sepolia paused", `sepolia code ${A(0xbeef)}`, `sepolia simulate ${b.data.slice(0, 10)}`]);
  });

  it("runs the checks in a fixed order and stops at the first that fails: too large, paused, no code, would fail", async () => {
    const big = message({ metadata: "0x", tooLarge: true, originNetwork: 75, destinationNetwork: 0 });
    const sep = "/api/agglayer/claim?network=75&count=7";
    const tooLarge = await build({ leaf: big, paused: true, hasCode: false, accepted: false }).get(sep);
    expect(tooLarge).toMatchObject({ status: 409, body: { error: TOO_LARGE, code: "message_too_large" } });
    const one = message({ originNetwork: 75, destinationNetwork: 0 });
    const paused = build({ leaf: one, paused: true, hasCode: false, accepted: false });
    expect(await paused.get(sep)).toMatchObject({ status: 503, body: { error: "Ethereum Sepolia is not available right now. Nothing is lost.", code: "bridge_paused" } });
    expect(paused.log).toEqual(["sepolia paused"]);
    const noCode = build({ leaf: one, hasCode: false, accepted: false });
    expect(await noCode.get(sep)).toMatchObject({ status: 409, body: { error: "There is no contract at this address on Ethereum Sepolia yet. The message can be claimed once one is there.", code: "receiver_has_no_code" } });
    expect(noCode.log.map((l) => l.split(" ")[1])).toEqual(["paused", "code"]);
    const fails = build({ leaf: one, accepted: false });
    expect(await fails.get(sep)).toMatchObject({ status: 409, body: { code: "message_would_fail" } });
    expect(body(await fails.get(sep)).error).toBe("The claim would fail on Ethereum Sepolia, so nothing was sent. The message stays ready to claim.");
    expect(fails.log.map((l) => l.split(" ")[1])).toEqual(["paused", "code", "simulate", "paused", "code", "simulate"]);
  });

  it("answers an already claimed message with claimed true and no calldata, before any of those checks", async () => {
    const { get, log } = build({ leaf: message({ originNetwork: 75, destinationNetwork: 0 }), sepoliaClaimed: true, paused: true });
    expect(body(await get("/api/agglayer/claim?network=75&count=7"))).toMatchObject({ claimed: true, data: null, args: null });
    expect(log).toEqual([]);
  });

  it("claims into Ostia with reth: the pause state, the code, and the simulation from the fixed address", async () => {
    const ok = build({ leaf: message() });
    const b = body(await ok.get(url));
    expect(b).toMatchObject({ claimed: false, destinationNetwork: 75, chainId: 770101, to: OSTIA });
    expect(ok.log).toEqual([`ostia eth_call - ${OSTIA} ${emergencyStateCall().slice(0, 10)}`, `ostia code ${A(0xbeef)}`, `ostia eth_call ${SIMULATE_FROM} ${OSTIA} ${b.data.slice(0, 10)}`]);
    expect(await build({ leaf: message(), accepted: false }).get(url)).toMatchObject({ status: 409, body: { code: "message_would_fail", error: "The claim would fail on Ostia, so nothing was sent. The message stays ready to claim." } });
    expect(await build({ leaf: message(), hasCode: false }).get(url)).toMatchObject({ status: 409, body: { code: "receiver_has_no_code" } });
    expect(await build({ leaf: message(), paused: true }).get(url)).toMatchObject({ status: 503, body: { code: "bridge_paused", error: "Ostia is not available right now. Nothing is lost." } });
  });

  it("is a 503 in words, never a 500, when reth or Ethereum Sepolia cannot be read for a check", async () => {
    expect(await build({ leaf: message(), ostiaDown: true }).get(url)).toMatchObject({ status: 503, body: { error: "The bridge cannot be read right now." } });
    const busy = await build({ leaf: message({ originNetwork: 75, destinationNetwork: 0 }), sepoliaBusy: 3 }).get("/api/agglayer/claim?network=75&count=7");
    expect(busy).toMatchObject({ status: 503, headers: { "retry-after": "3" } });
  });

  it("still hands out claimAsset for a token and runs none of the message checks", async () => {
    const { get, log } = build({ leaf: token() });
    const b = body(await get(url));
    expect(b.claimed).toBe(false);
    expect(b.data.slice(0, 10)).not.toBe(body(await build({ leaf: message() }).get(url)).data.slice(0, 10));
    expect(log).toEqual([]);
  });

  it("never carries a code on the answers that have none (a code is only on the message refusals)", async () => {
    const miss = await build({ leaf: undefined }).get(url);
    expect(miss).toMatchObject({ status: 404 });
    expect(miss!.body).not.toHaveProperty("code");
  });
});

describe("the messages route", () => {
  it("lists a wallet's messages from both chains, newest first, asking for 20 each way", async () => {
    const { get, log } = build({ list: {
      in: [message({ depositCount: 5, blockTimestamp: 1_700_000_050 }), message({ depositCount: 4, blockTimestamp: 1_700_000_010 })],
      out: [message({ originNetwork: 75, destinationNetwork: 0, depositCount: 2, blockTimestamp: 1_700_000_030, metadata: "0x", tooLarge: true })],
    } });
    const a = await get(`/api/agglayer/messages?wallet=${WALLET.toUpperCase().replace("0X", "0x")}`);
    expect(a!.status).toBe(200);
    const b = body(a);
    same(b, F.agglayerMessageList);
    expect(b.wallet).toBe(WALLET);
    expect(b.items.map((r: { network: number; count: number }) => [r.network, r.count])).toEqual([[0, 5], [75, 2], [0, 4]]);
    same(b.items[0], F.agglayerMessage);
    expect(b.items[0]).toEqual({ network: 0, count: 5, txHash: H(1), destinationNetwork: 75, receiver: A(0xbeef), sentAt: new Date(1_700_000_050_000).toISOString(), dataHash: keccak256("0x68656c6c6f"), data: "0x68656c6c6f", tooLarge: false });
    expect(b.items[1]).toMatchObject({ data: null, dataHash: null, tooLarge: true });
    expect(log).toEqual(expect.arrayContaining([`list 0 ${WALLET.toUpperCase().replace("0X", "0x")} 75 20`, `list 75 ${WALLET.toUpperCase().replace("0X", "0x")} 0 20`]));
  });

  it("answers an empty list for a wallet with no messages", async () => {
    expect(body(await build({}).get(`/api/agglayer/messages?wallet=${WALLET}`))).toEqual({ wallet: WALLET, items: [] });
  });

  it("refuses a wallet that is missing or not an address, 400 in words, and reads nothing", async () => {
    const { get, log } = build({});
    for (const q of ["", "?wallet=", "?wallet=0x12", `?wallet=${WALLET}00`, "?wallet=" + "z".repeat(42)]) expect(await get("/api/agglayer/messages" + q)).toMatchObject({ status: 400, body: { error: "wallet is 0x and 40 hex digits." } });
    expect(log).toEqual([]);
  });

  it("is a 503 in words when the bridge service cannot be read, and shares the deposit route's limit", async () => {
    expect(await build({ listDown: true }).get(`/api/agglayer/messages?wallet=${WALLET}`)).toMatchObject({ status: 503, body: { error: "The bridge cannot be read right now." } });
    const { get } = build({});
    for (let i = 0; i < 10; i++) expect((await get(`/api/agglayer/messages?wallet=${WALLET}`, "9.9.9.9"))!.status).toBe(200);
    expect((await get(`/api/agglayer/messages?wallet=${WALLET}`, "9.9.9.9"))!.status).toBe(429);
    expect((await get("/api/agglayer/deposit?network=0&count=1", "9.9.9.9"))!.status).toBe(429);
  });
});

describe("the note route", () => {
  const note = (text: string, at: number, number: number) => encodeAbiParameters([{ type: "bytes" }, { type: "uint64" }, { type: "uint256" }], [text as `0x${string}`, BigInt(at), BigInt(number)]);

  it("reads the board on Ostia for a sender from Ethereum, with the origin network 0", async () => {
    const { get, log } = build({ note: note("0x68656c6c6f", 1_700_000_000, 3) });
    const b = body(await get(`/api/agglayer/note?network=75&sender=${WALLET}`));
    same(b, F.agglayerNote);
    expect(b).toEqual({ network: 75, sender: WALLET, board: BOARD_OSTIA, found: true, data: "0x68656c6c6f", tooLarge: false, at: new Date(1_700_000_000_000).toISOString(), number: "3" });
    expect(log).toEqual([`ostia eth_call - ${BOARD_OSTIA} ${noteOfCall(0, WALLET).slice(0, 10)}`]);
  });

  it("reads the board on Ethereum for a sender from Ostia, with the origin network 75", async () => {
    const { get, log } = build({ note: note("0x6869", 1_700_000_000, 1) });
    expect(body(await get(`/api/agglayer/note?network=0&sender=${WALLET}`))).toMatchObject({ network: 0, board: BOARD_SEPOLIA, found: true, data: "0x6869", number: "1" });
    expect(log).toEqual([`sepolia note ${BOARD_SEPOLIA} 75 ${WALLET}`]);
  });

  it("says found false while the sender has left no note, and flags a note longer than the page reads", async () => {
    expect(body(await build({ note: note("0x", 0, 0) }).get(`/api/agglayer/note?network=75&sender=${WALLET}`))).toEqual({ network: 75, sender: WALLET, board: BOARD_OSTIA, found: false, data: null, tooLarge: false, at: null, number: "0" });
    const big = body(await build({ note: note("0x" + "ab".repeat(5000), 1_700_000_000, 2) }, onEnv).get(`/api/agglayer/note?network=75&sender=${WALLET}`));
    expect(big).toMatchObject({ found: true, data: null, tooLarge: true, number: "2" });
  });

  it("is 404 where no board is set, 400 for a wrong network or sender, 503 when the board does not answer a note", async () => {
    const none = build({}, { ...baseEnv, AGGLAYER_MESSAGES: "1" });
    expect(await none.get(`/api/agglayer/note?network=75&sender=${WALLET}`)).toMatchObject({ status: 404, body: { error: "There is no note board on Ostia." } });
    expect(await none.get(`/api/agglayer/note?network=0&sender=${WALLET}`)).toMatchObject({ status: 404, body: { error: "There is no note board on Ethereum Sepolia." } });
    const { get, log } = build({});
    for (const q of ["", "?network=9&sender=" + WALLET, "?network=x&sender=" + WALLET, "?network=0", "?network=0&sender=0x12", `?sender=${WALLET}`]) expect((await get("/api/agglayer/note" + q))!.status).toBe(400);
    expect(log).toEqual([]);
    for (const w of [{ noteReverts: true }, { note: "0x1234" }, { ostiaDown: true }]) expect(await build(w).get(`/api/agglayer/note?network=75&sender=${WALLET}`)).toMatchObject({ status: 503, body: { error: "The bridge cannot be read right now." } });
    expect(await build({ noteReverts: true }).get(`/api/agglayer/note?network=0&sender=${WALLET}`)).toMatchObject({ status: 503 });
  });
});

describe("the message routes in the API", () => {
  const settingsText = `programVK=${PINS.programVK}\nrootC=${PINS.rootC}\n`;
  const env = { READER_PARTY: "reader::1220" + "11".repeat(32), PINS_FILE: "pins.txt", ...baseEnv };
  const unreachable = new Proxy({}, { get: (_t, name) => () => { throw new Error(`the database was read (${String(name)})`); } }) as unknown as Pool;
  function make(extra: Record<string, string>) {
    const config = loadConfig({ ...env, ...extra }, () => settingsText);
    const bridge = createAgglayerBridge({ settings: config.agglayer!, chainId: config.chainId, chainName: config.chainName, aggkit: { messagesFrom: async () => [], healthy: async () => true } as never, sepolia: {} as never, reth: {} as never });
    return createApi({ config, reth: {} as never, ledger: {} as never, chain: createChainDb(unreachable), agglayer: bridge });
  }
  const doc = async (api: ReturnType<typeof make>) => body(await api("GET", "/api/openapi.json"));

  it("are registered and described only while messages are on, and each field list is its answer's", async () => {
    const on = make({ AGGLAYER_MESSAGES: "1" });
    for (const p of [...AGGLAYER_PATHS, ...AGGLAYER_MESSAGE_PATHS]) { expect(on.routes).toContain(p); expect(DOCS[p]).toBeDefined(); }
    const d = await doc(on);
    const props = (p: string) => Object.keys(d.paths[p].get.responses["200"].content["application/json"].schema.properties).sort();
    expect(props("/api/agglayer/note")).toEqual([...F.agglayerNote].sort());
    expect(d.paths["/api/agglayer/messages"].get.parameters.map((q: { name: string }) => q.name)).toEqual(["wallet"]);
    expect(d.paths["/api/agglayer/note"].get.parameters.map((q: { name: string }) => q.name)).toEqual(["network", "sender"]);
    expect(JSON.stringify(d.paths["/api/agglayer/claim"])).toContain("message_would_fail");
  });

  it("are not in the route list or the description while messages are off, though the bridge is on, and still answer 404", async () => {
    const off = make({});
    for (const p of AGGLAYER_MESSAGE_PATHS) expect(off.routes).not.toContain(p);
    for (const p of AGGLAYER_PATHS) expect(off.routes).toContain(p);
    const d = await doc(off);
    expect(Object.keys(d.paths).filter((p) => /agglayer\/(messages|note)/.test(p))).toEqual([]);
    expect(await off("GET", `/api/agglayer/messages?wallet=${WALLET}`, undefined, "1.1.1.1")).toMatchObject({ status: 404, body: { error: MESSAGES_OFF } });
  });

  it("answer GET only", async () => {
    const on = make({ AGGLAYER_MESSAGES: "1" });
    expect((await on("POST", `/api/agglayer/messages?wallet=${WALLET}`)).status).toBe(405);
    expect(await on("GET", `/api/agglayer/messages?wallet=${WALLET}`, undefined, "1.1.1.1")).toMatchObject({ status: 200, body: { wallet: WALLET, items: [] } });
  });
});
