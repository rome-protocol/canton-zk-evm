import type { ApiStatus } from "./api.ts";

/** The pins a block is checked under: the key of the last range that starts at or before its number, with the file the pins came from. */
export function pinsAt(pins: ApiStatus["pins"], blockNumber: number): { programVK: string; rootC: string; file: string; fromBlock: number } {
  let key = { fromBlock: 0, programVK: pins.programVK, rootC: pins.rootC };
  for (const k of pins.keys ?? []) if (k.fromBlock <= blockNumber) key = k;
  return { ...key, file: pins.file };
}
