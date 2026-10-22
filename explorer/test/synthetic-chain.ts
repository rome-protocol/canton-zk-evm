/**
 * A made-up chain for the indexer's tests: blocks of any size with valid hashes, transaction lists, receipts and proofs, served through a
 * fake of reth's final reads and a fake of the Ledger API. Nothing here is a real transaction; every hash and every link is checked the way
 * the indexer checks a real one, so the checks can be broken one at a time.
 */
import { encodeAbiParameters, keccak256, serializeTransaction } from "viem";
import type { Pins } from "../server/config.ts";
import type { BlockRecord, Ledger } from "../server/ledger.ts";
import { LEG_TOPIC } from "../server/indexer/legs.ts";
import { RethError } from "../server/reth.ts";
import { answerOfCall, type FinalBlock, type FinalReads, type FinalReceipt, type FinalTx, type TraceFrame, type TxTrace } from "../server/indexer/reads.ts";

export const GATEWAY = "0x" + "9a".repeat(20);
export const PINS: Pins = { programVK: "0x" + "a1".repeat(32), rootC: "0x" + "b2".repeat(32), file: "test-pins.txt" };
export const GENESIS_HASH = "0x" + "00".repeat(31) + "01";
export const PARTICIPANT = "PAR::participant::1220" + "aa".repeat(32);
export const OPERATOR = "operator::1220" + "cd".repeat(32);
export const CONFIRMER = "confirmer::1220" + "ef".repeat(32);
export const CHAIN_ID = 770101;
const TRANSFER_TOPIC = keccak256(new TextEncoder().encode("Transfer(address,address,uint256)"));
const hex = (n: number, bytes = 20) => "0x" + n.toString(16).padStart(bytes * 2, "0");

export interface BlockShape {
  /** How many transactions. They cycle through: a transfer, an ERC-20 transfer, a contract creation, a call with many logs, a failed call. */
  txs: number;
  /** The gateway records a Leg of this kind (1 to 3) in the first transaction. */
  leg?: number;
}

/** The leg hash of README.md's formula, written out here on its own so that a mistake in the indexer's copy shows up as a failing test. */
export function expectedLegHash(kind: number, id: string, token: string, account: string, amount: bigint, party: string): string {
  const words = [("0x" + "00".repeat(32)), hex(kind, 32), id, hex(0, 12) + token.slice(2), hex(0, 12) + account.slice(2), hex(Number(amount), 32), keccak256(new TextEncoder().encode(party))];
  return keccak256(("0x" + words.map((w) => w.slice(2)).join("")) as `0x${string}`);
}

export interface SyntheticBlock {
  block: FinalBlock;
  receipts: FinalReceipt[];
  traces: TxTrace[];
  record: BlockRecord;
  legsHash: string | null;
}

function proofHex(blockHash: string, pins: Pins): string {
  const b = Buffer.alloc(1344);
  Buffer.from(pins.programVK.slice(2), "hex").copy(b, 768);
  Buffer.from(pins.rootC.slice(2), "hex").copy(b, 800);
  const words = Buffer.alloc(256);
  words[0] = 0x20;
  Buffer.from(blockHash.slice(2), "hex").copy(words, 1);
  for (let slot = 0; slot < 64; slot++) words.copy(b, 832 + slot * 8, slot * 4, slot * 4 + 4);
  return b.toString("hex");
}

/** The RLP list of the transactions, a typed one as a byte string, as a block record holds it. */
function txList(serialized: string[]): string {
  const head = (base: number, n: number) =>
    n < 56 ? Buffer.from([base + n]) : n < 256 ? Buffer.from([base + 55 + 1, n]) : n < 65536 ? Buffer.from([base + 55 + 2, n >> 8, n & 255]) : Buffer.from([base + 55 + 3, n >> 16, (n >> 8) & 255, n & 255]);
  const items = serialized.map((s) => {
    const b = Buffer.from(s.slice(2), "hex");
    return Buffer.concat([head(0x80, b.length), b]);
  });
  const body = Buffer.concat(items);
  return body.length === 0 ? "" : Buffer.concat([head(0xc0, body.length), body]).toString("hex");
}

/** `instance` tells two chains from the same genesis apart: a reset of the network gives the same genesis, chain id and pins, and different blocks. */
export function makeBlock(number: number, parentHash: string, shape: BlockShape, pins: Pins = PINS, instance = 0): SyntheticBlock {
  const txs: FinalTx[] = [], receipts: FinalReceipt[] = [], traces: TxTrace[] = [], serialized: string[] = [];
  let cumulative = 0;
  for (let k = 0; k < shape.txs; k++) {
    const kind = k % 5;
    const to = kind === 2 ? null : hex(0xc000 + (k % 97));
    const input = kind === 1 ? "0xa9059cbb" + "00".repeat(64) : kind === 2 ? "0x6080" + "60".repeat(30) : kind === 3 ? "0x12345678" + "ab".repeat(100) : "0x";
    const ser = serializeTransaction({
      type: "eip1559", chainId: CHAIN_ID, nonce: k, maxFeePerGas: 9n, maxPriorityFeePerGas: 1n, gas: 100000n, to: (to ?? undefined) as `0x${string}` | undefined,
      value: BigInt(k), data: input as `0x${string}`,
    }, { r: ("0x" + (number % 250 + 1).toString(16).padStart(2, "0").repeat(32)) as `0x${string}`, s: ("0x" + "22".repeat(32)) as `0x${string}`, yParity: k % 2 as 0 | 1 });
    const hash = keccak256(ser);
    serialized.push(ser);
    const failed = kind === 4;
    const logs: FinalReceipt["logs"] = [];
    if (kind === 1) logs.push({ address: hex(0xd000), topics: [TRANSFER_TOPIC, "0x" + "00".repeat(12) + "11".repeat(20), "0x" + "00".repeat(12) + "22".repeat(20)], data: "0x" + "00".repeat(31) + "05" });
    if (kind === 3) for (let l = 0; l < 6; l++) logs.push({ address: hex(0xe000 + l), topics: ["0x" + "77".repeat(32)], data: "0x" + "00".repeat(32) });
    if (k === 0 && shape.leg) {
      const data = encodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "string" }],
        [shape.leg, ("0x" + "01".repeat(32)) as `0x${string}`, hex(0xd000) as `0x${string}`, hex(0xa11ce) as `0x${string}`, 42n, "alice::1220" + "ab".repeat(32)]);
      logs.push({ address: GATEWAY, topics: [LEG_TOPIC], data });
    }
    const gasUsed = failed ? 30000 : kind === 3 ? 90000 : 21000 + (kind === 2 ? 50000 : 0);
    cumulative += gasUsed;
    txs.push({ hash, type: 2, from: hex(0xf000 + (k % 53)), to, nonce: k, value: BigInt(k), gas: 100000, gasPrice: null, maxFeePerGas: 9n, maxPriorityFeePerGas: 1n, input, accessList: [], authorizationList: null });
    receipts.push({ transactionHash: hash, status: failed ? 0 : 1, gasUsed, cumulativeGasUsed: cumulative, effectiveGasPrice: 8n, contractAddress: kind === 2 && !failed ? hex(0xcafe00 + k) : null, logs });
    const reason = "0x08c379a0" + encodeAbiParameters([{ type: "string" }], ["not allowed"]).slice(2);
    const sender = hex(0xf000 + (k % 53));
    const top: TraceFrame = kind === 2
      ? { traceAddress: [], type: "create", callType: "create", from: sender, to: failed ? null : hex(0xcafe00 + k), value: BigInt(k), gas: 100000, gasUsed, input, error: null,
          created: failed ? null : { address: hex(0xcafe00 + k), code: "0x6001600055" } }
      : { traceAddress: [], type: "call", callType: "call", from: sender, to, value: BigInt(k), gas: 100000, gasUsed, input, error: failed ? "Reverted" : null, created: null };
    // A transaction of kind 3 makes three calls that move no value, so none is stored as an internal call.
    const subs: TraceFrame[] = kind === 3 ? [0, 1, 2].map((i) => ({ traceAddress: [i], type: "call", callType: "staticcall", from: to as string, to: hex(0xe000 + i), value: 0n, gas: 5000, gasUsed: 100, input: "0x", error: null, created: null })) : [];
    traces.push({ transactionHash: hash, output: failed ? reason : "0x", calls: 1 + subs.length, error: failed ? "Reverted" : null, frames: [top, ...subs] });
  }
  const legsHash = shape.leg ? expectedLegHash(shape.leg, "0x" + "01".repeat(32), hex(0xd000), hex(0xa11ce), 42n, "alice::1220" + "ab".repeat(32)) : null;
  const headerHex = number.toString(16).padStart(8, "0") + instance.toString(16).padStart(2, "0") + "f9".repeat(39);
  const hash = keccak256(`0x${headerHex}`);
  const block: FinalBlock = {
    number, hash, parentHash, timestamp: 1_790_000_000 + number * 3, gasLimit: 30_000_000, gasUsed: cumulative, baseFeePerGas: 7n, miner: hex(0xbeef),
    stateRoot: "0x" + "01".repeat(32), transactionsRoot: "0x" + "02".repeat(32), receiptsRoot: "0x" + "03".repeat(32), extraData: "0x", size: 1000 + shape.txs * 150, transactions: txs,
  };
  const at = new Date(Date.UTC(2026, 9, 21, 0, 0, 0) + number * 3000).toISOString();
  const record: BlockRecord = {
    updateId: `1220${number.toString(16).padStart(8, "0")}${instance.toString(16).padStart(2, "0")}${"ee".repeat(27)}`, offset: number * 10, recordTime: at, chainId: CHAIN_ID, number, blockHash: hash, parentHash,
    headerHex, txsHex: txList(serialized), proofHex: proofHex(hash, pins), operator: OPERATOR, confirmer: CONFIRMER, synchronizerId: "sync::1220" + "99".repeat(32),
    effectiveAt: at, contractId: "00" + number.toString(16).padStart(8, "0"), template: { packageId: "abc123def456", module: "Zk.Chain", entity: "BlockRecord" },
    signatories: [OPERATOR, CONFIRMER],
  };
  return { block, receipts, traces, record, legsHash };
}

export interface SyntheticChain {
  blocks: SyntheticBlock[];
  /** reth, serving blocks 0 to `rethHead`. */
  reads: FinalReads & { calls: Record<string, number>; rethHead: number; rethFinalized: number | null; /** The code at block 0, by lowercase address; an account not named has none. */ codes: Record<string, string>; storage: Record<string, string>; liveCode: Record<string, string>; callResults: Record<string, string>; /** The coin balance of an account at a block, by "address:block"; else by the address alone, else 0. */ balances: Record<string, bigint> };
  /** The Ledger API, serving the records of blocks 1 to `ledgerHead`. */
  ledger: Ledger & { ledgerHead: number; pageSize: number; failAfterPages: number | null };
  genesisHash: string;
}

/** `shapes[i]` is block i + 1. Both `rethHead` and `ledgerHead` are properties a test may move. */
export function makeChain(shapes: BlockShape[], pins: Pins = PINS, instance = 0): SyntheticChain {
  const blocks: SyntheticBlock[] = [];
  let parent = GENESIS_HASH;
  shapes.forEach((s, i) => {
    const b = makeBlock(i + 1, parent, s, pins, instance);
    blocks.push(b);
    parent = b.block.hash;
  });
  const genesis: FinalBlock = {
    number: 0, hash: GENESIS_HASH, parentHash: "0x" + "00".repeat(32), timestamp: 1_790_000_000, gasLimit: 30_000_000, gasUsed: 0, baseFeePerGas: 7n, miner: hex(0xbeef),
    stateRoot: "0x" + "01".repeat(32), transactionsRoot: "0x" + "02".repeat(32), receiptsRoot: "0x" + "03".repeat(32), extraData: "0x", size: 500, transactions: [],
  };
  const calls: Record<string, number> = {};
  const count = (m: string) => { calls[m] = (calls[m] ?? 0) + 1; };
  const reads = {
    calls, rethHead: shapes.length, rethFinalized: null as number | null, codes: {} as Record<string, string>,
    /** Storage words by "address:slot" (the gateway's legs are served for it), the code an account holds after block 0, and eth_call answers by "address:input". */
    storage: {} as Record<string, string>, liveCode: {} as Record<string, string>, callResults: {} as Record<string, string>, balances: {} as Record<string, bigint>,
    block: async (n: number) => { count("block"); return n === 0 ? genesis : n <= reads.rethHead ? (blocks[n - 1]!.block) : null; },
    hashAt: async (n: number) => { count("hashAt"); return n === 0 ? genesis.hash : n <= reads.rethHead ? blocks[n - 1]!.block.hash : null; },
    /** reth's finalized number: `rethFinalized` when a test sets it, else its head. */
    finalized: async () => { count("finalized"); return reads.rethFinalized ?? reads.rethHead; },
    receipts: async (n: number) => { count("receipts"); return n >= 1 && n <= reads.rethHead ? blocks[n - 1]!.receipts : null; },
    traces: async (n: number) => { count("traces"); return n >= 1 && n <= reads.rethHead ? blocks[n - 1]!.traces : null; },
    storageAt: async (a: string, slot: string, n: number) => {
      count("storageAt");
      return reads.storage[`${a}:${slot}`] ?? (a === GATEWAY ? blocks[n - 1]?.legsHash : null) ?? "0x" + "00".repeat(32);
    },
    code: async (a: string, n: number) => { count("code"); return (n >= 1 ? reads.liveCode[a] : undefined) ?? reads.codes[a] ?? "0x"; },
    call: async (to: string, input: string) => {
      count("call");
      const r = reads.callResults[`${to}:${input}`];
      if (r === undefined) throw new RethError("eth_call: reth answered \"execution reverted\"", true);
      return answerOfCall(r); // the bound on an answer is the real one
    },
    balance: async (a: string, n: number) => { count("balance"); return reads.balances[`${a}:${n}`] ?? reads.balances[a] ?? 0n; },
    rpc: async () => { throw new Error("not used"); },
  } as unknown as SyntheticChain["reads"];
  const ledger = {
    ledgerHead: shapes.length,
    ledgerEnd: async () => ledger.ledgerHead * 10,
    participantId: async () => PARTICIPANT,
    /** Records a page at a time, as the Ledger API walk does; `failAfterPages` makes the read after that many pages fail, as a Canton timeout would. */
    pageSize: 1000, failAfterPages: null as number | null,
    recordPages: async function* (after: number, upTo: number) {
      const all = blocks.map((b) => b.record).filter((r) => r.offset > after && r.offset <= upTo);
      for (let i = 0, page = 0; i < all.length; i += ledger.pageSize, page++) {
        if (ledger.failAfterPages !== null && page >= ledger.failAfterPages) throw new Error("Canton timed out");
        yield all.slice(i, i + ledger.pageSize);
      }
    },
    call: async () => { throw new Error("not used"); },
  } as unknown as SyntheticChain["ledger"];
  return { blocks, reads, ledger, genesisHash: GENESIS_HASH };
}
