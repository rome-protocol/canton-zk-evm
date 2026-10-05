import { encodeAbiParameters, keccak256 } from "viem";
import { createdEvent, recordFields, transaction } from "./fake-ledger.ts";

type Json = Record<string, unknown>;

const hex = (n: number, digits: number) => "0x" + n.toString(16).padStart(digits, "0");
const strip = (h: string) => h.replace(/^0x/, "");
const GENESIS = "0x" + "90".repeat(32);

/** The header bytes of block n. Its hash is their Keccak, as a real block's is. */
export const headerHex = (n: number) => "f9".repeat(39) + n.toString(16).padStart(2, "0");
export const hashOf = (n: number) => keccak256(("0x" + headerHex(n)) as `0x${string}`);
export const txHash = (block: number, i: number) => hex(block * 16 + i + 1, 64);
export const updateIdOf = (n: number) => "1220" + n.toString(16).padStart(64, "0");

export interface Made { txs?: number; creates?: string; onCanton?: boolean }

/**
 * A small chain that reth and the Ledger API both answer from. `blocks` is what reth holds (block 0 is the genesis), and `items`
 * what Canton shows the reader: `add` can leave a block off Canton, like a block still being proven.
 */
export class FakeChain {
  blocks: Json[] = [];
  receipts: Json[][] = [];
  items: Json[] = [];
  tokens = new Map<string, [string, string, number]>();
  calls: string[] = [];

  genesis = GENESIS;

  constructor() { this.restart(); }

  restart(genesis = GENESIS) {
    this.genesis = genesis;
    this.blocks = [this.raw(0, genesis, "0x" + "00".repeat(32), 0)];
    this.receipts = [[]];
    this.items.length = 0;
  }

  private raw(n: number, hash: string, parent: string, txs: number) {
    return {
      number: hex(n, 1), hash, parentHash: parent, timestamp: hex(1_000_000 + n * 8, 1), gasUsed: hex(txs * 21000, 1), gasLimit: "0x1c9c380",
      baseFeePerGas: "0x7", miner: "0x" + "11".repeat(20), stateRoot: "0x" + "22".repeat(32), transactions: Array.from({ length: txs }, (_, i) => txHash(n, i)),
    };
  }

  /** The next block. `creates` is the address of a contract that the block's first transaction makes. */
  add({ txs = 0, creates, onCanton = true }: Made = {}) {
    const n = this.blocks.length;
    this.blocks.push(this.raw(n, hashOf(n), n === 1 ? this.genesis : hashOf(n - 1), txs));
    this.receipts.push(Array.from({ length: txs }, (_, i) => ({
      transactionHash: txHash(n, i), status: "0x1", gasUsed: "0x5208", effectiveGasPrice: "0x7", contractAddress: i === 0 && creates ? creates : null, logs: [],
    })));
    if (onCanton) this.commit(n);
  }

  /** Canton commits block n's record, with the fields overridden as given. */
  commit(n: number, over: Json = {}) {
    const fields = recordFields({
      number: String(n), blockHash: strip(hashOf(n)), parentHash: strip(n === 1 ? this.genesis : hashOf(n - 1)), headerHex: headerHex(n), ...over,
    });
    this.items.push(transaction(n * 2, updateIdOf(n), [createdEvent(n * 2, fields)], `2026-10-04T01:37:${String(10 + n).padStart(2, "0")}.412Z`));
  }

  get rethHandlers() {
    const block = (tag: string) => this.blocks[Number(tag)] ?? null;
    return {
      eth_getBlockByNumber: (p: unknown[]) => (this.calls.push("block"), block(p[0] as string)),
      eth_getBlockReceipts: (p: unknown[]) => (this.calls.push("receipts"), this.receipts[Number(p[0])] ?? null),
      eth_call: (p: unknown[]) => {
        this.calls.push("token");
        const { to, data } = p[0] as { to: string; data: string };
        const t = this.tokens.get(to);
        if (!t) throw new Error("execution reverted");
        return data === "0x06fdde03" ? encodeAbiParameters([{ type: "string" }], [t[0]]) : data === "0x95d89b41" ? encodeAbiParameters([{ type: "string" }], [t[1]]) : encodeAbiParameters([{ type: "uint8" }], [t[2]]);
      },
    };
  }
}
