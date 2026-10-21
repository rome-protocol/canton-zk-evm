import { keccak256 } from "viem";
import { IndexerStop } from "./errors.ts";

interface Item { start: number; end: number; payload: number; list: boolean }

/** The RLP item that starts at `i`: where it starts and ends, where its payload starts, and whether it is a list. */
function item(b: Uint8Array, i: number): Item {
  const p = b[i];
  if (p === undefined) throw new Error("the RLP ends inside an item");
  let item: Item;
  if (p < 0x80) item = { start: i, end: i + 1, payload: i, list: false };
  else if (p < 0xb8) item = { start: i, end: i + 1 + p - 0x80, payload: i + 1, list: false };
  else if (p < 0xc0 || p >= 0xf8) {
    const n = p - (p < 0xc0 ? 0xb7 : 0xf7);
    if (i + 1 + n > b.length) throw new Error("the RLP ends inside an item's length");
    let len = 0;
    for (let k = 0; k < n; k++) len = len * 256 + (b[i + 1 + k] as number);
    item = { start: i, end: i + 1 + n + len, payload: i + 1 + n, list: p >= 0xc0 };
  } else item = { start: i, end: i + 1 + p - 0xc0, payload: i + 1, list: true };
  if (item.end > b.length) throw new Error("the RLP ends inside an item");
  return item;
}

/**
 * The hashes of the transactions in a block record's `txsHex`, in order. The field is the RLP list of the block's transactions, as the block
 * holds it: a legacy transaction is a list of its own and is hashed whole; a typed transaction (EIP-2718) is a byte string whose content is
 * the type byte and the payload, and that content is what is hashed. An empty field is a block with no transactions.
 */
export function transactionHashes(txsHex: string, number: number): string[] {
  if (txsHex === "") return [];
  const bytes = Uint8Array.from(Buffer.from(txsHex, "hex"));
  const hashes: string[] = [];
  try {
    const top = item(bytes, 0);
    if (!top.list || top.end !== bytes.length) throw new Error("it is not one RLP list");
    for (let at = top.payload; at < top.end; ) {
      const it = item(bytes, at);
      hashes.push(keccak256(bytes.subarray(it.list ? it.start : it.payload, it.end)));
      at = it.end;
    }
  } catch (e) {
    throw new IndexerStop("C3", `block ${number}: the record's transaction list cannot be read (${(e as Error).message})`, number);
  }
  return hashes;
}
